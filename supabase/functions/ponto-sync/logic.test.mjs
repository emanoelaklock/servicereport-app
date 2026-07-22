// Testes da lógica pura do ponto-sync — `node --test supabase/functions/ponto-sync/`
// Fixtures modelam o schema Punch REAL do Swagger (docs/ponto-fase-c-desenho.md §1).
// Nada de rede, nada de segredo: o token jamais aparece aqui.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizarData, diaLocalDe, normalizarPunch, calcularCursorNovo, janelaMs, sanitizarErro, ianaDe,
} from './logic.mjs'

const MAPA = new Map([[101, 'uuid-tec-101'], [102, 'uuid-tec-102']])

// ── fixtures no formato do Swagger (par entrada/saída em UM registro) ──
const FX_PAR_SEM_OFFSET = {
  id: 5001, employeeId: 101, employee: { id: 101, timezone: 'SAO_PAULO' },
  dateIn: '2026-07-20T08:02:11', dateOut: '2026-07-20T12:01:40',
  status: 'APPROVED', excluded: false, edited: false, adjust: false,
  pendingType: null, lastModifiedDate: '2026-07-20T12:02:00',
}
const FX_PAR_COM_OFFSET = {
  ...FX_PAR_SEM_OFFSET, id: 5002,
  dateIn: '2026-07-20T08:02:11.000-0300'.replace('-0300', '-03:00'),
  dateOut: '2026-07-20T12:01:40.000-03:00',
}
const FX_SEM_SAIDA = {
  id: 5003, employeeId: 101, employee: { id: 101, timezone: 'SAO_PAULO' },
  dateIn: '2026-07-20T13:00:00', dateOut: null,
  status: 'PENDING', pendingType: 'SAIDA', excluded: false, lastModifiedDate: null,
}
const FX_SEM_VINCULO = { ...FX_PAR_SEM_OFFSET, id: 5004, employeeId: 999, employee: { id: 999, timezone: 'SAO_PAULO' } }
const FX_EXCLUIDO = { ...FX_PAR_SEM_OFFSET, id: 5005, excluded: true }
const FX_EDITADO = { ...FX_PAR_SEM_OFFSET, id: 5006, edited: true, adjust: false }
const FX_NOTURNO = {
  id: 5007, employeeId: 102, employee: { id: 102, timezone: 'MANAUS' },
  dateIn: '2026-07-20T23:30:00', dateOut: '2026-07-21T02:10:00',
  status: 'APPROVED', excluded: false, lastModifiedDate: '2026-07-21T02:11:00',
}

test('R1 — sem offset: hora de parede vira UTC pelo fuso do colaborador (SP = -03)', () => {
  assert.equal(normalizarData('2026-07-20T08:02:11', 'America/Sao_Paulo'), '2026-07-20T11:02:11.000Z')
})
test('R1 — com offset explícito: confia no offset', () => {
  assert.equal(normalizarData('2026-07-20T08:02:11.000-03:00', 'America/Sao_Paulo'), '2026-07-20T11:02:11.000Z')
})
test('R1 — Manaus (-04) difere de SP: mesmo texto, instante diferente', () => {
  assert.equal(normalizarData('2026-07-20T08:00:00', 'America/Manaus'), '2026-07-20T12:00:00.000Z')
})
test('dia local: par noturno pertence ao dia da ENTRADA', () => {
  const r = normalizarPunch(FX_NOTURNO, MAPA)
  assert.ok('row' in r)
  assert.equal(r.row.dia, '2026-07-20')
})

test('normalização: par completo mapeia todas as colunas do espelho', () => {
  const r = normalizarPunch(FX_PAR_SEM_OFFSET, MAPA)
  assert.ok('row' in r)
  const row = r.row
  assert.equal(row.tangerino_punch_id, 5001)
  assert.equal(row.tecnico_id, 'uuid-tec-101')
  assert.equal(row.dia, '2026-07-20')
  assert.equal(row.entrada, '2026-07-20T11:02:11.000Z')
  assert.equal(row.saida, '2026-07-20T15:01:40.000Z')
  assert.equal(row.entrada_raw, '2026-07-20T08:02:11')   // cru preservado p/ auditar o parser
  assert.equal(row.status_origem, 'APPROVED')
  assert.equal(row.excluido_origem, false)
  assert.equal(row.editado_origem, false)
  assert.equal(row.pendente_metade, null)
  assert.equal(row.tz_origem, 'SAO_PAULO')
})
test('normalização: com e sem offset produzem o MESMO instante', () => {
  const a = normalizarPunch(FX_PAR_SEM_OFFSET, MAPA)
  const b = normalizarPunch(FX_PAR_COM_OFFSET, MAPA)
  assert.equal(a.row.entrada, b.row.entrada)
  assert.equal(a.row.saida, b.row.saida)
})
test('metade pendente: sem saída vira saida=null + pendente_metade', () => {
  const r = normalizarPunch(FX_SEM_SAIDA, MAPA)
  assert.equal(r.row.saida, null)
  assert.equal(r.row.pendente_metade, 'SAIDA')
  assert.equal(r.row.status_origem, 'PENDING')
})
test('sem vínculo no map: descartada (minimização — nunca importa desconhecido)', () => {
  assert.deepEqual(normalizarPunch(FX_SEM_VINCULO, MAPA), { descartada: true })
})
test('excluded/edited da origem chegam como flags no espelho', () => {
  assert.equal(normalizarPunch(FX_EXCLUIDO, MAPA).row.excluido_origem, true)
  assert.equal(normalizarPunch(FX_EDITADO, MAPA).row.editado_origem, true)
})

test('cursor: avança pro maior lastModifiedDate; sem novidade, mantém', () => {
  const antes = Date.parse('2026-07-19T00:00:00Z')
  const novo = calcularCursorNovo([FX_PAR_SEM_OFFSET, FX_NOTURNO, FX_SEM_SAIDA], antes)
  assert.equal(novo, Date.parse(normalizarData('2026-07-21T02:11:00', 'America/Sao_Paulo')))
  assert.equal(calcularCursorNovo([], antes), antes)
  assert.equal(calcularCursorNovo([FX_SEM_SAIDA], antes), antes)   // lastModifiedDate null não regride
})

test('janela D-7 cobre exatamente 7 dias', () => {
  const agora = Date.parse('2026-07-22T12:00:00Z')
  const { inicioMs, fimMs } = janelaMs(7, agora)
  assert.equal(fimMs - inicioMs, 7 * 24 * 3600 * 1000)
  assert.equal(fimMs, agora)
})

test('sanitização: token e headers de auth NUNCA sobrevivem na mensagem', () => {
  const token = 'tok_super_secreto_ABC123'
  const casos = [
    new Error(`falha chamando api com Authorization: Basic ${token} na url`),
    new Error(`erro bruto contendo ${token} no meio`),
    `bearer ${token} rejeitado`,
  ]
  for (const c of casos) {
    const s = sanitizarErro(c, [token])
    assert.ok(!s.includes(token), `token vazou em: ${s}`)
  }
  assert.equal(sanitizarErro(new Error('x'.repeat(2000)), []).length, 500)   // cap
})

test('fuso: enum desconhecido cai no fallback SP; typo RECIVE mapeado', () => {
  assert.equal(ianaDe('ENUM_QUE_NAO_EXISTE'), 'America/Sao_Paulo')
  assert.equal(ianaDe('RECIVE'), 'America/Recife')
})

test('diaLocalDe: string sem offset usa a própria parede', () => {
  assert.equal(diaLocalDe('2026-07-20T23:59:00', 'America/Sao_Paulo'), '2026-07-20')
})
