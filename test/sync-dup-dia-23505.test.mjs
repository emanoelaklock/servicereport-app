// Gates da Fase C do F3 — "RAT duplicada do dia × 23505 do uq_rats_tarefa_dia_tecnico (0146)".
// Roda o js/sync.js REAL em Node com ambiente stub (molde do sync-rls-42501.test.mjs).
// Uso: node test/sync-dup-dia-23505.test.mjs   (sai com código 1 se algum gate falhar)
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
window.DBLocal = new Proxy(db, { get(t, k) { return k in t ? t[k] : (async () => undefined) } })

// ── supabase falso: upsert de 'rats' controlável por teste ──
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
    then(res) { return fim({ data: [], error: null }).then(res) },
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

// ── helpers ──
const TEC = 'uuid-tecnico'
const MSG_DUP = 'Já existe uma RAT sua para esta tarefa neste dia (enviada de outro aparelho ou com a data ajustada). Continue na RAT do dia; este registro permanece salvo neste aparelho.'
const ok200 = () => ({ data: { id: 'srv-1', recebido_em: '2026-08-07T18:00:00Z' }, error: null })
const dup23505 = () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_rats_tarefa_dia_tecnico"' } })
const seq23505 = () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_rats_tarefa_seq"' } })
function novaRat(uuid) {
  rats.set(uuid, { client_uuid: uuid, tecnico_id: TEC, tecnico_nome: 'Técnico', tarefa_id: null, cliente_id: 'c1', status: 'registrado', sync_status: STATUS.SALVO_LOCAL })
}
let falhas = 0
const gate = (nome, cond, extra) => { const okG = !!cond; if (!okG) falhas++; console.log((okG ? 'PASS' : 'FAIL') + '  ' + nome + (extra ? '  [' + extra + ']' : '')) }
const limpar = () => rats.clear()

// ── G1: 23505 do índice de dia bloqueia nomeado, íntegro e FORA do toast ──
estado.meId = TEC; estado.ratsUpsert = dup23505; estado.upsertsRats = 0
novaRat('rat-dup')
let res = await sync.syncAll()
let r1 = rats.get('rat-dup')
gate('G1a bloqueio 23505/dia: status ERRO + item íntegro (uuid/tecnico_id intactos)',
  r1 && r1.client_uuid === 'rat-dup' && r1.tecnico_id === TEC && r1.sync_status === STATUS.ERRO)
gate('G1b registro local: envio_bloqueado_dup = {em, usuario}',
  r1.envio_bloqueado_dup && typeof r1.envio_bloqueado_dup === 'object'
  && !!r1.envio_bloqueado_dup.em && r1.envio_bloqueado_dup.usuario === TEC
  && JSON.stringify(Object.keys(r1.envio_bloqueado_dup).sort()) === JSON.stringify(['em', 'usuario']))
gate('G1c mensagem exata do bloqueio', r1.sync_motivo === MSG_DUP)
gate('G1d fora do toast: fail=0', res.fail === 0)

// ── G2: sem retry automático (sem loop — a lição do F22) ──
estado.upsertsRats = 0
await sync.syncAll(); await sync.syncAll()
gate('G2 zero tentativas em 2 syncs automáticos seguintes', estado.upsertsRats === 0, 'upserts=' + estado.upsertsRats)

// ── G2b: "reinício do app" — recarrega o sync.js; estado persistido continua suprimindo ──
new Function(readFileSync(join(raiz, 'js', 'sync.js'), 'utf8'))()
const sync2 = window.SyncEngine
estado.upsertsRats = 0
await sync2.syncAll()
gate('G2b reinício do app: bloqueado NÃO volta a re-tentar', estado.upsertsRats === 0, 'upserts=' + estado.upsertsRats)

// ── G3: manual re-tenta exatamente 1x; auto seguinte suprime de novo ──
estado.upsertsRats = 0
await sync.syncAll({ manual: true })
const aposManual = estado.upsertsRats
await sync.syncAll()
gate('G3 manual re-tenta 1x e o automático volta a suprimir',
  aposManual === 1 && estado.upsertsRats === 1, 'upserts=' + estado.upsertsRats)

// ── G4: duplicata resolvida (ex.: Data corrigida) → manual envia, confirma e limpa o flag ──
estado.ratsUpsert = ok200; estado.upsertsRats = 0
await sync.syncAll({ manual: true })
const r4 = rats.get('rat-dup')
gate('G4 resolvida: envia, confirma e limpa envio_bloqueado_dup',
  estado.upsertsRats === 1 && r4.sync_status === STATUS.CONFIRMADO && !r4.envio_bloqueado_dup)

// ── G5: 23505 de OUTRO índice (uq_rats_tarefa_seq/F22) segue o retry padrão ──
limpar()
estado.ratsUpsert = seq23505; estado.upsertsRats = 0
novaRat('rat-seq')
res = await sync.syncAll()
const r5 = rats.get('rat-seq')
gate('G5a 23505 de outro índice: SEM flag de dup e fail conta (retry padrão)',
  !r5.envio_bloqueado_dup && res.fail === 1 && r5.sync_status === STATUS.ERRO)
await sync.syncAll()
gate('G5b 23505 de outro índice re-tenta no sync seguinte', estado.upsertsRats === 2, 'upserts=' + estado.upsertsRats)

console.log(falhas ? `\n${falhas} gate(s) FALHARAM` : '\nTodos os gates PASSARAM')
process.exit(falhas ? 1 : 0)
