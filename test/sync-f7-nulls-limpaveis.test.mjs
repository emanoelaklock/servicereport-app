// Gates do F7 — "upsert pula null × colunas limpáveis (motivo de improdutiva)".
// Roda o js/sync.js REAL em Node com ambiente stub (molde do sync-rls-42501.test.mjs);
// o supabase falso CAPTURA o payload do upsert de rats pra inspecionar o que subiria.
// Uso: node test/sync-f7-nulls-limpaveis.test.mjs   (sai com código 1 se algum gate falhar)
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── ambiente browser mínimo ──
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
global.window = globalThis
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
global.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) }, removeItem(k) { delete this._m[k] } }

// ── DBLocal em memória ──
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

// ── supabase falso: CAPTURA o payload do upsert de rats ──
const estado = { capturas: [] }
function builder(tabela) {
  const fim = (res) => Promise.resolve(res)
  const alvo = {
    select() { return alvo }, eq() { return alvo }, gte() { return alvo }, lte() { return alvo },
    gt() { return alvo }, lt() { return alvo }, neq() { return alvo }, not() { return alvo },
    or() { return alvo }, contains() { return alvo }, range() { return alvo },
    order() { return alvo }, limit() { return alvo }, in() { return alvo }, is() { return alvo },
    maybeSingle() { return fim({ data: null, error: null }) },
    single() { return fim({ data: { id: 'srv-1', recebido_em: '2026-08-08T12:00:00Z' }, error: null }) },
    upsert(payload) { if (tabela === 'rats') estado.capturas.push(payload); return alvo },
    update() { return fim({ data: null, error: null }) },
    insert() { return alvo },
    then(res) { return fim({ data: [], error: null }).then(res) },
  }
  return alvo
}
window.getSupabase = () => ({
  from: (t) => builder(t),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  auth: { getUser: async () => ({ data: { user: { id: 'uuid-tecnico' } } }) },
})

// ── carrega o sync.js REAL ──
new Function(readFileSync(join(raiz, 'js', 'sync.js'), 'utf8'))()
const sync = window.SyncEngine

let falhas = 0
const gate = (nome, cond, extra) => { const okG = !!cond; if (!okG) falhas++; console.log((okG ? 'PASS' : 'FAIL') + '  ' + nome + (extra ? '  [' + extra + ']' : '')) }
const ultima = () => estado.capturas[estado.capturas.length - 1] || {}

// ── G1: improdutiva→produtiva LIMPA o motivo no servidor (null explícito) ──
rats.set('rat-produtiva', {
  client_uuid: 'rat-produtiva', tecnico_id: 'uuid-tecnico', tarefa_id: null, cliente_id: 'c1',
  status: 'registrado', atendimento_executado: true,
  motivo_improdutiva: 'cliente_ausente', motivo_texto: 'resíduo da improdutiva anterior',   // resíduo local
  sync_status: STATUS.SALVO_LOCAL,
})
await sync.syncAll()
let p = ultima()
gate('G1a produtiva envia motivo_improdutiva = null explícito', 'motivo_improdutiva' in p && p.motivo_improdutiva === null)
gate('G1b produtiva envia motivo_texto = null explícito', 'motivo_texto' in p && p.motivo_texto === null)
gate('G1c RAT confirmada normalmente', rats.get('rat-produtiva').sync_status === STATUS.CONFIRMADO)

// ── G2: improdutiva de verdade MANTÉM o motivo (nunca limpa o que vale) ──
rats.clear(); estado.capturas.length = 0
rats.set('rat-improdutiva', {
  client_uuid: 'rat-improdutiva', tecnico_id: 'uuid-tecnico', tarefa_id: null, cliente_id: 'c1',
  status: 'improdutiva', atendimento_executado: false,
  motivo_improdutiva: 'cliente_ausente', motivo_texto: null,
  sync_status: STATUS.SALVO_LOCAL,
})
await sync.syncAll()
p = ultima()
gate('G2 improdutiva mantém o motivo no payload', p.motivo_improdutiva === 'cliente_ausente')

// ── G3: atendimento_executado AUSENTE (registro antigo) não limpa nem inventa ──
rats.clear(); estado.capturas.length = 0
rats.set('rat-antiga', {
  client_uuid: 'rat-antiga', tecnico_id: 'uuid-tecnico', tarefa_id: null, cliente_id: 'c1',
  status: 'registrado',   // sem atendimento_executado (undefined)
  sync_status: STATUS.SALVO_LOCAL,
})
await sync.syncAll()
p = ultima()
gate('G3 sem atendimento_executado: payload NÃO carrega chaves de motivo (ambiguidade nunca apaga)',
  !('motivo_improdutiva' in p) && !('motivo_texto' in p))

console.log(falhas ? `\n${falhas} gate(s) FALHARAM` : '\nTodos os gates PASSARAM')
process.exit(falhas ? 1 : 0)
