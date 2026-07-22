// Gates da correção "RAT de outra conta × RLS 42501" — roda o js/sync.js REAL em
// Node com ambiente stub (DBLocal em memória + supabase falso configurável).
// Uso: node test/sync-rls-42501.test.mjs   (sai com código 1 se algum gate falhar)
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── ambiente browser mínimo ──
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
global.window = globalThis
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
global.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) }, removeItem(k) { delete this._m[k] } }

// ── DBLocal em memória (só o que o fluxo de RAT usa; o resto é no-op) ──
const STATUS = { RASCUNHO: 'rascunho', SALVO_LOCAL: 'salvo_local', NA_FILA: 'na_fila', ENVIANDO: 'enviando', CONFIRMADO: 'confirmado', ERRO: 'erro' }
const rats = new Map()
const db = {
  STATUS,
  async listarRats() { return [...rats.values()].map(r => ({ ...r })) },
  async obterRat(u) { const r = rats.get(u); return r ? { ...r } : null },
  async salvarRat(u, patch) { const r = rats.get(u) || {}; rats.set(u, { ...r, ...patch }) },
  async definirStatus(u, st, motivo, apenasSe) {
    const r = rats.get(u); if (!r) return
    if (apenasSe && r.sync_status !== apenasSe) return
    rats.set(u, { ...r, sync_status: st, sync_motivo: motivo })
  },
  async listarFotos() { return [] }, async marcarFotoEnviada() {},
  async listarMateriais() { return [] },
  async listarEventos() { return [] }, async marcarEventoEnviado() {},
  async tarefasLocaisPendentes() { return [] },
  async listarPreorc() { return [] }, async definirStatusPreorc() {},
  async segmentosPendentes() { return [] }, async deslocamentosPendentes() { return [] },
}
// pullChanges usa outros métodos conforme o delta — Proxy devolve no-op p/ o que faltar
window.DBLocal = new Proxy(db, { get(t, k) { return k in t ? t[k] : (async () => undefined) } })

// ── supabase falso: builder encadeável; upsert de 'rats' controlável por teste ──
const estado = { meId: null, ratsUpsert: null, upsertsRats: 0 }
function builder(tabela) {
  const fim = (res) => Promise.resolve(res)
  const alvo = {
    select() { return alvo }, eq() { return alvo }, gte() { return alvo }, lte() { return alvo },
    gt() { return alvo }, lt() { return alvo }, neq() { return alvo }, not() { return alvo },
    or() { return alvo }, contains() { return alvo }, range() { return alvo },
    order() { return alvo }, limit() { return alvo }, in() { return alvo }, is() { return alvo },
    maybeSingle() { return fim({ data: null, error: null }) },
    single() {
      if (tabela === 'rats') { estado.upsertsRats++; return fim(estado.ratsUpsert()) }
      return fim({ data: null, error: null })
    },
    upsert() { return alvo }, update() { return fim({ data: null, error: null }) },
    insert() { return alvo },
    then(res) { return fim({ data: [], error: null }).then(res) },   // awaited sem single()
  }
  return alvo
}
window.getSupabase = () => ({
  from: (t) => builder(t),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  auth: { getUser: async () => ({ data: { user: estado.meId ? { id: estado.meId } : null } }) },
})

// ── carrega o sync.js REAL ──
new Function(readFileSync(join(raiz, 'js', 'sync.js'), 'utf8'))()
const sync = window.SyncEngine

// ── helpers de teste ──
const A = 'uuid-conta-a', M = 'uuid-conta-m'
const ok200 = () => ({ data: { id: 'srv-1', recebido_em: '2026-07-21T18:00:00Z' }, error: null })
const rls42501 = () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "rats"' } })
const erro500 = () => ({ data: null, error: { code: '500', message: 'erro transitorio qualquer' } })
function novaRat(uuid, dono) {
  rats.set(uuid, { client_uuid: uuid, tecnico_id: dono, tecnico_nome: dono === A ? 'Conta A' : 'Marcelo', tarefa_id: null, cliente_id: 'c1', status: 'registrado', sync_status: STATUS.SALVO_LOCAL })
}
let falhas = 0
const gate = (nome, cond, extra) => { const okG = !!cond; if (!okG) falhas++; console.log((okG ? 'PASS' : 'FAIL') + '  ' + nome + (extra ? '  [' + extra + ']' : '')) }
// isola cada grupo de cenários (a re-elegibilidade por troca de login é comportamento
// do produto — sem limpeza, RATs de cenários anteriores contaminariam os contadores)
const limpar = () => rats.clear()

// ── G1: RAT do usuário atual sincroniza normalmente ──
estado.meId = A; estado.ratsUpsert = ok200; estado.upsertsRats = 0
novaRat('rat-propria', A)
let res = await sync.syncAll()
gate('G1 RAT própria sincroniza (confirmado, ok=1, fail=0)',
  rats.get('rat-propria').sync_status === STATUS.CONFIRMADO && res.ok === 1 && res.fail === 0)

// ── G2: item de outro dono bloqueia com registro completo e fica íntegro ──
limpar()
estado.meId = 'uuid-conta-teste'; estado.ratsUpsert = rls42501; estado.upsertsRats = 0
novaRat('rat-do-marcelo', M)
res = await sync.syncAll()
let r2 = rats.get('rat-do-marcelo')
gate('G2a bloqueio 42501: item permanece na fila, íntegro (uuid/tecnico_id intactos)',
  r2 && r2.client_uuid === 'rat-do-marcelo' && r2.tecnico_id === M && r2.sync_status === STATUS.ERRO)
gate('G2b registro local: em + usuario + provado=true',
  r2.envio_bloqueado_rls && typeof r2.envio_bloqueado_rls === 'object'
  && !!r2.envio_bloqueado_rls.em && r2.envio_bloqueado_rls.usuario === 'uuid-conta-teste' && r2.envio_bloqueado_rls.provado === true)
gate('G2b2 estado mínimo: SOMENTE {em, usuario, provado} — sem payload/conteúdo/e-mail/token',
  JSON.stringify(Object.keys(r2.envio_bloqueado_rls).sort()) === JSON.stringify(['em', 'provado', 'usuario']))
gate('G2c mensagem exata (propriedade comprovada)',
  r2.sync_motivo === 'Esta RAT foi criada por outro usuário neste aparelho. Entre com a conta original para sincronizá-la.')
gate('G2d sem alerta: fail=0 no bloqueio', res.fail === 0)

// ── G2e: propriedade NÃO comprovável (auth indisponível) → mensagem genérica + suprime ──
limpar()
estado.meId = null; estado.ratsUpsert = rls42501; estado.upsertsRats = 0
novaRat('rat-sem-prova', M)
await sync.syncAll()
const r2e = rats.get('rat-sem-prova')
gate('G2e sem prova local: provado=false + mensagem genérica exata',
  r2e.envio_bloqueado_rls && r2e.envio_bloqueado_rls.provado === false
  && r2e.sync_motivo === 'Esta RAT não pôde ser sincronizada por restrição de acesso. O conteúdo permanece salvo neste aparelho.')
await sync.syncAll()
gate('G2f sem prova: suprimido no sync seguinte (sem retry)', estado.upsertsRats === 1, 'upserts=' + estado.upsertsRats)

// ── G3: sem retry na mesma sessão (mesmo login) ──
limpar()
estado.meId = 'uuid-conta-teste'; estado.ratsUpsert = rls42501; estado.upsertsRats = 0
novaRat('rat-do-marcelo', M)
await sync.syncAll()
estado.upsertsRats = 0
estado.upsertsRats = 0
await sync.syncAll(); await sync.syncAll()
gate('G3 zero tentativas em 2 syncs seguintes sob o mesmo login', estado.upsertsRats === 0, 'upserts=' + estado.upsertsRats)

// ── G3b: "reinício do app" — recarrega o módulo sync.js do zero (estado só do storage) ──
new Function(readFileSync(join(raiz, 'js', 'sync.js'), 'utf8'))()
const sync2 = window.SyncEngine
estado.upsertsRats = 0
await sync2.syncAll()
gate('G3b reinício do app: item bloqueado NÃO volta a re-tentar (estado persistido decide)',
  estado.upsertsRats === 0, 'upserts=' + estado.upsertsRats)

// ── G4: troca para o login DONO permite e conclui a sincronização ──
estado.meId = M; estado.ratsUpsert = ok200; estado.upsertsRats = 0
res = await sync.syncAll()
r2 = rats.get('rat-do-marcelo')
gate('G4 dono logou: envia, confirma e limpa o flag',
  estado.upsertsRats === 1 && r2.sync_status === STATUS.CONFIRMADO && !r2.envio_bloqueado_rls)

// ── G4b: troca para TERCEIRO login (≠ do bloqueio) rende exatamente 1 nova tentativa ──
limpar()
estado.meId = 'uuid-conta-teste'; estado.ratsUpsert = rls42501; estado.upsertsRats = 0
novaRat('rat-do-marcelo-2', M)
await sync.syncAll()                       // bloqueia sob conta-teste
estado.meId = 'uuid-terceiro'; estado.upsertsRats = 0
await sync.syncAll()                       // login mudou → 1 tentativa (bloqueia de novo sob terceiro)
const t1 = estado.upsertsRats
await sync.syncAll()                       // mesmo login do novo bloqueio → suprimido
gate('G4b troca de login: 1 nova tentativa e depois suprime', t1 === 1 && estado.upsertsRats === 1, 'tentativas=' + estado.upsertsRats)

// ── G5: erro ≠ 42501 mantém retry e conta no toast ──
limpar()
estado.meId = A; estado.ratsUpsert = erro500; estado.upsertsRats = 0
novaRat('rat-erro-comum', A)
res = await sync.syncAll()
const r5 = rats.get('rat-erro-comum')
gate('G5a erro comum: fail conta e SEM flag de bloqueio', res.fail === 1 && !r5.envio_bloqueado_rls)
await sync.syncAll()
gate('G5b erro comum re-tenta no sync seguinte', estado.upsertsRats === 2, 'upserts=' + estado.upsertsRats)

// ── G6: ação manual re-tenta item bloqueado ──
limpar()
estado.meId = 'uuid-conta-teste'; estado.ratsUpsert = rls42501; estado.upsertsRats = 0
novaRat('rat-manual', M)
await sync.syncAll()                        // bloqueia
const antes = estado.upsertsRats
await sync.syncAll({ manual: true })        // manual → tenta de novo
gate('G6 sync manual re-tenta o bloqueado', estado.upsertsRats === antes + 1, 'upserts=' + estado.upsertsRats)
// manual libera SÓ UMA tentativa: o auto seguinte volta a suprimir (sem loop)
const aposManual = estado.upsertsRats
await sync.syncAll()
gate('G6b após o manual, o sync automático volta a suprimir (sem loop)',
  estado.upsertsRats === aposManual, 'upserts=' + estado.upsertsRats)

// ── G8: compatibilidade com flag LEGADO booleano (itens gravados pelo #120) ──
limpar()
estado.meId = 'uuid-conta-teste'; estado.ratsUpsert = rls42501; estado.upsertsRats = 0
novaRat('rat-flag-legado', M)
await db.salvarRat('rat-flag-legado', { envio_bloqueado_rls: true, sync_status: STATUS.ERRO })
await sync.syncAll()
gate('G8a flag legado booleano: suprimido sob login não-dono', estado.upsertsRats === 0, 'upserts=' + estado.upsertsRats)
estado.meId = M; estado.ratsUpsert = ok200; estado.upsertsRats = 0
await sync.syncAll()
const r8 = rats.get('rat-flag-legado')
gate('G8b flag legado: dono loga → sincroniza e limpa o flag',
  estado.upsertsRats === 1 && r8.sync_status === STATUS.CONFIRMADO && !r8.envio_bloqueado_rls)

// ── G7: 42501 SEM a marca do upsert de rats (outra origem) mantém comportamento padrão ──
// Simula 42501 vindo de OUTRA tabela: upsert de rats passa, mas o teste injeta um erro
// não-marcado no caminho (fotos) usando uma foto pendente com storage falhando com RLS.
limpar()
estado.meId = A; estado.ratsUpsert = ok200; estado.upsertsRats = 0
novaRat('rat-rls-outra-tabela', A)
db.listarFotos = async () => [{ id: 'f1', enviada: false, blob: { type: 'image/jpeg' } }]
window.getSupabase = ((orig) => () => { const s = orig(); s.storage = { from: () => ({ upload: async () => ({ error: { code: '42501', message: 'row-level security (storage)' } }) }) }; return s })(window.getSupabase)
res = await sync.syncAll()
const r7 = rats.get('rat-rls-outra-tabela')
gate('G7 42501 fora do upsert de rats: sem flag de bloqueio, fail conta (retry padrão)',
  !r7.envio_bloqueado_rls && res.fail === 1 && r7.sync_status === STATUS.ERRO)

console.log(falhas ? `\n${falhas} gate(s) FALHARAM` : '\nTodos os gates PASSARAM')
process.exit(falhas ? 1 : 0)
