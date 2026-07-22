// Testes da lógica pura do ponto-sync — `node --test supabase/functions/ponto-sync/`
// Fixtures modelam o schema Punch REAL do Swagger (docs/ponto-fase-c-desenho.md §1).
// Nada de rede, nada de segredo: o token jamais aparece aqui.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizarData, diaLocalDe, normalizarPunch, calcularCursorNovo, janelaMs, sanitizarErro, ianaDe,
  validarRequisicao, decidirRetry, coletarPaginado, corsPara, sugerirVinculo, soDigitos, classificarPunch, esquemaDe,
  qsEmployerFindAll, unirColaboradores,
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

test('fuso: enum desconhecido NÃO tem fallback silencioso (null); typo RECIVE mapeado; SAO_PAULO ok', () => {
  assert.equal(ianaDe('ENUM_QUE_NAO_EXISTE'), null)
  assert.equal(ianaDe(null), null)
  assert.equal(ianaDe('RECIVE'), 'America/Recife')
  assert.equal(ianaDe('SAO_PAULO'), 'America/Sao_Paulo')
})

test('diaLocalDe: string sem offset usa a própria parede', () => {
  assert.equal(diaLocalDe('2026-07-20T23:59:00', 'America/Sao_Paulo'), '2026-07-20')
})

test('preservação temporal: lastModifiedDate CRU acompanha o normalizado (nada irreversível)', () => {
  const r = normalizarPunch(FX_PAR_SEM_OFFSET, MAPA)
  assert.equal(r.row.origem_modificado_raw, '2026-07-20T12:02:00')
  assert.ok(r.row.origem_modificado_em)   // normalizado coexiste com o cru
  const s = normalizarPunch(FX_SEM_SAIDA, MAPA)
  assert.equal(s.row.origem_modificado_raw, null)
})

// ── autorização (auditoria C1: POST-only, anônimo nunca, reconhecimento só admin) ──
test('auth: GET operacional rejeitado com 405 (mesmo com cron secret ou admin)', () => {
  assert.equal(validarRequisicao({ metodo: 'GET', cronOk: true, papel: 'admin', modo: 'delta', reconhecimentoAtivo: true }).status, 405)
  assert.equal(validarRequisicao({ metodo: 'OPTIONS', cronOk: false, papel: null, modo: 'delta', reconhecimentoAtivo: true }).status, 405)
})
test('auth: chamada anônima (sem cron secret, sem JWT) → 401', () => {
  const r = validarRequisicao({ metodo: 'POST', cronOk: false, papel: null, modo: 'delta', reconhecimentoAtivo: true })
  assert.deepEqual([r.ok, r.status], [false, 401])
})
test('auth: técnico autenticado NÃO executa (403/401 — sem acesso ao sync)', () => {
  const r = validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'tecnico_campo', modo: 'delta', reconhecimentoAtivo: true })
  assert.equal(r.ok, false)
})
test('auth: POST com cron secret roda delta; POST de admin/gestor roda manual', () => {
  const cron = validarRequisicao({ metodo: 'POST', cronOk: true, papel: null, modo: 'delta', reconhecimentoAtivo: true })
  assert.deepEqual([cron.ok, cron.autorizadoPor], [true, 'cron'])
  const adm = validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'admin', modo: 'delta', reconhecimentoAtivo: true })
  assert.deepEqual([adm.ok, adm.autorizadoPor], [true, 'admin'])
  const ges = validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'gestor_axis', modo: 'delta', reconhecimentoAtivo: true })
  assert.equal(ges.ok, true)
})
test('auth: reconhecimento exige admin (cron sozinho não basta) e respeita o desligamento', () => {
  const soCron = validarRequisicao({ metodo: 'POST', cronOk: true, papel: null, modo: 'reconhecimento', reconhecimentoAtivo: true })
  assert.deepEqual([soCron.ok, soCron.status], [false, 403])
  const desligado = validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'admin', modo: 'reconhecimento', reconhecimentoAtivo: false })
  assert.deepEqual([desligado.ok, desligado.status], [false, 403])
  const ok = validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'admin', modo: 'reconhecimento', reconhecimentoAtivo: true })
  assert.equal(ok.ok, true)
})

// ── retry (429 com Retry-After; 401/403 nunca re-tenta; esgotamento desiste) ──
test('retry: 429 respeita Retry-After com teto de 30s', () => {
  assert.equal(decidirRetry(429, 0, [1000, 3000, 9000], 7), 7000)
  assert.equal(decidirRetry(429, 0, [1000, 3000, 9000], 999), 30_000)
  assert.equal(decidirRetry(429, 1, [1000, 3000, 9000], null), 3000)   // sem header → backoff
})
test('retry: 401/403 não re-tenta; 5xx/rede usam backoff; tentativas esgotadas desistem', () => {
  assert.equal(decidirRetry(401, 0, [1000], 5), null)
  assert.equal(decidirRetry(403, 0, [1000], null), null)
  assert.equal(decidirRetry(503, 0, [1000, 3000, 9000], null), 1000)
  assert.equal(decidirRetry(0, 2, [1000, 3000, 9000], null), 9000)
  assert.equal(decidirRetry(500, 3, [1000, 3000, 9000], null), null)   // esgotou
  assert.equal(decidirRetry(404, 0, [1000, 3000, 9000], null), null)   // 4xx não re-tenta
})

// ── coleta paginada (falha intermediária aborta tudo; deadline; sem parcial) ──
const pagina = (itens, last) => ({ content: itens, last })
test('paginação: percorre até last=true e junta tudo', async () => {
  const paginas = [pagina([{ id: 1 }, { id: 2 }], false), pagina([{ id: 3 }], true)]
  const r = await coletarPaginado(async (p) => paginas[p], { pausaMs: 0 })
  assert.equal(r.paginas, 2)
  assert.deepEqual(r.punches.map((x) => x.id), [1, 2, 3])
})
test('paginação: falha na página intermediária PROPAGA — nenhum resultado parcial', async () => {
  const fetchPagina = async (p) => {
    if (p === 1) throw new Error('API do ponto falhou (HTTP 500)')
    return pagina([{ id: p }], false)
  }
  await assert.rejects(() => coletarPaginado(fetchPagina, { pausaMs: 0 }), /HTTP 500/)
})
test('paginação: deadline estourado aborta a rodada (sem avanço de cursor)', async () => {
  let t = 0
  const fetchPagina = async () => { t += 60_000; return pagina([{ id: t }], false) }
  await assert.rejects(
    () => coletarPaginado(fetchPagina, { deadlineMs: 100_000, agora: () => t, pausaMs: 0 }),
    /tempo limite/,
  )
})
test('CORS: só a origem exata do portal recebe headers; qualquer outra recebe {}', () => {
  const ok = corsPara('https://servicereport-app.vercel.app')
  assert.equal(ok['Access-Control-Allow-Origin'], 'https://servicereport-app.vercel.app')
  assert.equal(ok['Access-Control-Allow-Methods'], 'POST, OPTIONS')
  assert.equal(ok['Access-Control-Allow-Headers'], 'authorization, apikey, content-type, x-client-info')   // preflight do functions.invoke
  assert.deepEqual(corsPara('https://malicioso.example.com'), {})
  assert.deepEqual(corsPara(''), {})
  assert.deepEqual(corsPara('http://servicereport-app.vercel.app'), {})   // http ≠ https
})

test('cursor: falha na coleta significa que calcularCursorNovo nem roda — repetição da mesma janela re-normaliza idêntico (dedup é o unique do banco)', () => {
  const a = normalizarPunch(FX_PAR_SEM_OFFSET, MAPA).row
  const b = normalizarPunch(FX_PAR_SEM_OFFSET, MAPA).row
  assert.deepEqual(a, b)   // mesmo punch → mesma linha → upsert por tangerino_punch_id é no-op
})

// ═══════ Compatibilidade com os DADOS REAIS da Punch API (reconhecimento 22/07) ═══════
// A API retorna EPOCH MILLIS NUMÉRICOS (o Swagger documentava string). Fixtures sanitizadas
// no formato real observado — ids/instantes plausíveis, nenhum dado pessoal.
const MS_ENTRADA = Date.UTC(2026, 6, 22, 11, 2, 11)          // 08:02:11 em SP (-03)
const MS_SAIDA = Date.UTC(2026, 6, 22, 15, 1, 40)            // 12:01:40 em SP
const MS_MOD = Date.UTC(2026, 6, 22, 15, 2, 0, 889)
const FX_NUM_COMPLETO = {
  id: 1726610737, employeeId: 101, employee: { id: 101, timezone: 'SAO_PAULO' },
  dateIn: MS_ENTRADA, dateOut: MS_SAIDA,
  status: 'APPROVED', excluded: false, pendingType: null, lastModifiedDate: MS_MOD,
}
const FX_NUM_ABERTO = {   // formato real observado: dateOut null E pendingType null
  id: 1726599406, employeeId: 101, employee: { id: 101, timezone: 'SAO_PAULO' },
  dateIn: MS_ENTRADA, dateOut: null,
  status: 'APPROVED', excluded: false, pendingType: null, lastModifiedDate: MS_MOD,
}
const FX_NUM_MISTO = { ...FX_NUM_COMPLETO, id: 1726600001, dateOut: '2026-07-22T12:01:40' }  // número + string
const FX_TZ_DESCONHECIDO = { ...FX_NUM_COMPLETO, id: 1726600002, employee: { id: 101, timezone: 'LISBOA_X' } }

test('epoch millis: entrada/saída numéricas normalizam para o instante UTC correto', () => {
  const r = normalizarPunch(FX_NUM_COMPLETO, MAPA)
  assert.ok('row' in r, 'marcação numérica NÃO pode ser descartada')
  assert.equal(r.row.entrada, '2026-07-22T11:02:11.000Z')
  assert.equal(r.row.saida, '2026-07-22T15:01:40.000Z')
  assert.equal(r.row.dia, '2026-07-22')                       // dia local via fuso do colaborador
  assert.equal(r.row.entrada_raw, String(MS_ENTRADA))         // original preservado no _raw
})
test('epoch millis: lastModifiedDate numérico alimenta cursor e campos *_raw', () => {
  const r = normalizarPunch(FX_NUM_COMPLETO, MAPA)
  assert.equal(r.row.origem_modificado_raw, String(MS_MOD))
  assert.ok(r.row.origem_modificado_em)
  assert.equal(calcularCursorNovo([FX_NUM_COMPLETO], 0), MS_MOD)
})
test('mistura número + string no mesmo punch: ambos normalizados coerentes', () => {
  const r = normalizarPunch(FX_NUM_MISTO, MAPA)
  assert.ok('row' in r)
  assert.equal(r.row.entrada, '2026-07-22T11:02:11.000Z')     // número
  assert.equal(r.row.saida, '2026-07-22T15:01:40.000Z')       // string de parede em SP
})
test('dateOut null (formato real): marcação ABERTA preservada, nunca descartada', () => {
  const r = normalizarPunch(FX_NUM_ABERTO, MAPA)
  assert.ok('row' in r, 'aberta não pode ser descartada')
  assert.equal(r.row.saida, null)
  assert.equal(r.row.saida_raw, null)
  assert.equal(r.row.pendente_metade, null)                   // pendingType null real: incompleto vem da AUSÊNCIA de saída
})
test('timezone desconhecido: erro sanitizado (só o enum), sem fallback e sem importação', () => {
  const r = normalizarPunch(FX_TZ_DESCONHECIDO, MAPA)
  assert.ok('erro' in r)
  assert.equal(r.erro, 'timezone desconhecido: LISBOA_X')     // nenhum dado pessoal na mensagem
})
test('valores inválidos rejeitados: negativo, não-finito, fora de faixa, segundos, string de dígitos', () => {
  const iana = 'America/Sao_Paulo'
  assert.equal(normalizarData(-1784737860000, iana), null)    // negativo
  assert.equal(normalizarData(NaN, iana), null)               // não-finito
  assert.equal(normalizarData(Infinity, iana), null)
  assert.equal(normalizarData(4102444800001, iana), null)     // > 2100 (fora de faixa)
  assert.equal(normalizarData(1784737860, iana), null)        // epoch em SEGUNDOS: nunca inferir
  assert.equal(normalizarData('1784737860000', iana), null)   // string só-dígitos: nunca inferir
  assert.equal(diaLocalDe(-5, iana), null)
  assert.equal(calcularCursorNovo([{ lastModifiedDate: -5 }, { lastModifiedDate: NaN }], 777), 777)  // inválido não regride nem avança
})
test('repetição idempotente com fixtures numéricas: mesma entrada → mesma linha', () => {
  assert.deepEqual(normalizarPunch(FX_NUM_COMPLETO, MAPA).row, normalizarPunch(FX_NUM_COMPLETO, MAPA).row)
})
test('correção com mesmo id: linha atualizada mantém a chave de dedup', () => {
  const antes = normalizarPunch(FX_NUM_ABERTO, MAPA).row
  const corrigido = { ...FX_NUM_ABERTO, dateOut: MS_SAIDA, lastModifiedDate: MS_MOD + 60000, edited: true }
  const depois = normalizarPunch(corrigido, MAPA).row
  assert.equal(antes.tangerino_punch_id, depois.tangerino_punch_id)   // mesmo id → upsert atualiza
  assert.equal(antes.saida, null)
  assert.equal(depois.saida, '2026-07-22T15:01:40.000Z')
  assert.equal(depois.editado_origem, true)
  assert.ok(calcularCursorNovo([corrigido], MS_MOD) > MS_MOD)         // correção avança o cursor
})
// ═══════ C2 — modo colaboradores + sugestão de vínculo (CPF só no servidor) ═══════
const USUARIOS = [
  { id: 'A1B2C3D4-0000-0000-0000-000000000001'.toLowerCase(), nome: 'Usuário Um', cpf: '123.456.789-01', ativo: true },
  { id: 'a1b2c3d4-0000-0000-0000-000000000002', nome: 'Usuário Dois', cpf: '98765432100', ativo: true },
]
test('C2 auth: modo colaboradores exige admin/gestor; cron sozinho não roda; independe do flag de reconhecimento', () => {
  assert.equal(validarRequisicao({ metodo: 'POST', cronOk: true, papel: null, modo: 'colaboradores', reconhecimentoAtivo: false }).status, 403)
  assert.equal(validarRequisicao({ metodo: 'POST', cronOk: false, papel: null, modo: 'colaboradores', reconhecimentoAtivo: true }).status, 401)
  assert.equal(validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'tecnico_campo', modo: 'colaboradores', reconhecimentoAtivo: true }).ok, false)
  assert.equal(validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'admin', modo: 'colaboradores', reconhecimentoAtivo: false }).ok, true)
  assert.equal(validarRequisicao({ metodo: 'POST', cronOk: false, papel: 'gestor_axis', modo: 'colaboradores', reconhecimentoAtivo: false }).ok, true)
})
test('C2 matching: externalId tem prioridade sobre CPF (case-insensitive)', () => {
  const colab = { externalId: 'A1B2C3D4-0000-0000-0000-000000000002'.toLowerCase(), cpf: '12345678901' }
  assert.deepEqual(sugerirVinculo(colab, USUARIOS), { tecnicoId: USUARIOS[1].id, origem: 'externalId' })
})
test('C2 matching: CPF normalizado casa com e sem máscara; curto/ausente → null', () => {
  assert.deepEqual(sugerirVinculo({ externalId: null, cpf: '12345678901' }, USUARIOS), { tecnicoId: USUARIOS[0].id, origem: 'cpf' })
  assert.deepEqual(sugerirVinculo({ externalId: '', cpf: '987.654.321-00' }, USUARIOS), { tecnicoId: USUARIOS[1].id, origem: 'cpf' })
  assert.equal(sugerirVinculo({ cpf: '123' }, USUARIOS), null)
  assert.equal(sugerirVinculo({ cpf: null }, USUARIOS), null)
  assert.equal(sugerirVinculo({ externalId: 'nao-e-uuid-de-ninguem', cpf: '00000000000' }, USUARIOS), null)
})
test('C2 sanitização: a sugestão NUNCA carrega CPF (só tecnicoId + origem)', () => {
  const s = sugerirVinculo({ externalId: null, cpf: '12345678901' }, USUARIOS)
  assert.deepEqual(Object.keys(s).sort(), ['origem', 'tecnicoId'])
  assert.ok(!JSON.stringify(s).includes('12345678901'), 'CPF vazou na sugestão')
  assert.ok(!('cpf' in s), 'propriedade cpf presente na sugestão')
})
test('C2 soDigitos: normalização de CPF', () => {
  assert.equal(soDigitos('123.456.789-01'), '12345678901')
  assert.equal(soDigitos(null), '')
})

// ═══════ C2 — classificação da importação (nada some em silêncio) ═══════
test('classificação: vinculado importa; fora_escopo é intencional; sem decisão é PENDENTE (bloqueia)', () => {
  const mapa = new Map([[101, 'uuid-tec-101']])
  const fe = new Set([555])
  assert.equal(classificarPunch({ employeeId: 101 }, mapa, fe), 'importar')
  assert.equal(classificarPunch({ employeeId: 555 }, mapa, fe), 'fora_escopo')
  assert.equal(classificarPunch({ employeeId: 999 }, mapa, fe), 'pendente_sem_vinculo')
  assert.equal(classificarPunch({ employee: { id: 101 } }, mapa, fe), 'importar')   // id aninhado
  assert.equal(classificarPunch({ employeeId: '101' }, mapa, fe), 'importar')       // coerção numérica
})
test('classificação: vínculo tem precedência sobre fora_escopo (estado impossível no banco, defensivo aqui)', () => {
  const mapa = new Map([[101, 'uuid-tec-101']])
  const fe = new Set([101])
  assert.equal(classificarPunch({ employeeId: 101 }, mapa, fe), 'importar')
})

// ═══════ Duas dimensões: decisão × situação Tangerino (ajuste final C2) ═══════
// A classificação da importação é CEGA à situação (ativo/inativo) — inatividade nunca
// autoriza ignorar marcações (protege a carga histórica de ex-funcionários).
const MAPA2 = new Map([[201, 'uuid-tec-201']])
const FE2 = new Set([202])
const punchDe = (empId, fired) => ({ employeeId: empId, employee: { id: empId, timezone: 'SAO_PAULO', fired } })
test('inativo VINCULADO continua elegível para importação', () => {
  assert.equal(classificarPunch(punchDe(201, true), MAPA2, FE2), 'importar')
})
test('inativo FORA DO ESCOPO é ignorado e contabilizado como fora_escopo (nunca como "inativa")', () => {
  assert.equal(classificarPunch(punchDe(202, true), MAPA2, FE2), 'fora_escopo')
})
test('inativo PENDENTE com marcações na janela bloqueia (pendente_sem_vinculo)', () => {
  assert.equal(classificarPunch(punchDe(203, true), MAPA2, FE2), 'pendente_sem_vinculo')
})
test('inativo pendente SEM marcações na janela não gera contagem artificial', () => {
  // a contagem deriva SÓ das marcações da janela — cadastro inativo sem punch = zero em tudo
  const janela = [punchDe(201, true), punchDe(202, true)]   // nenhuma marcação do pendente 203
  const contagem = { importar: 0, fora_escopo: 0, pendente_sem_vinculo: 0 }
  for (const p of janela) contagem[classificarPunch(p, MAPA2, FE2)]++
  assert.deepEqual(contagem, { importar: 1, fora_escopo: 1, pendente_sem_vinculo: 0 })
})
test('situação nunca muda a decisão: mesmo colaborador, ativo ou inativo, classifica igual', () => {
  for (const empId of [201, 202, 203]) {
    assert.equal(classificarPunch(punchDe(empId, false), MAPA2, FE2), classificarPunch(punchDe(empId, true), MAPA2, FE2))
  }
})
test('ninguém vira fora_escopo automaticamente por inatividade (só o conjunto explícito decide)', () => {
  // punch de inativo NÃO listado no conjunto fora_escopo jamais classifica como fora_escopo
  assert.notEqual(classificarPunch(punchDe(999, true), MAPA2, FE2), 'fora_escopo')
})

// ═══════ Diagnóstico Employer — esquema sanitizado (nenhum VALOR sai) ═══════

// ═══════ Consulta definitiva de colaboradores (diagnóstico 22/07) ═══════
const ATIVO = (id, extra = {}) => ({ id, name: `A${id}`, cpf: null, externalId: null, fired: false, ...extra })
const DEMITIDO = (id, extra = {}) => ({ id, name: `D${id}`, cpf: null, externalId: null, fired: true, resignationDate: 1780000000000, ...extra })
test('consulta: ativos SEM showFired; demitidos COM showFired=true (query pura)', () => {
  assert.ok(!qsEmployerFindAll(0, 200, false).includes('showFired'))
  assert.ok(qsEmployerFindAll(0, 200, true).includes('showFired=true'))
  assert.ok(qsEmployerFindAll(3, 200, true).includes('page=3'))
})
test('união: dois conjuntos paginados independentes, deduplicados por id', async () => {
  // paginação independente: 2 páginas de ativos + 1 de demitidos (via coletarPaginado real)
  const pagsAtivos = [{ content: [ATIVO(1), ATIVO(2)], last: false }, { content: [ATIVO(3)], last: true }]
  const pagsDem = [{ content: [DEMITIDO(9)], last: true }]
  const a = await coletarPaginado(async (p) => pagsAtivos[p], { pausaMs: 0 })
  const d = await coletarPaginado(async (p) => pagsDem[p], { pausaMs: 0 })
  assert.equal(a.paginas, 2); assert.equal(d.paginas, 1)
  const u = unirColaboradores(a.punches, d.punches)
  assert.ok('colaboradores' in u)
  assert.equal(u.colaboradores.length, 4)
  // duplicata idêntica entre páginas não duplica
  const u2 = unirColaboradores([ATIVO(1), ATIVO(1)], [DEMITIDO(9)])
  assert.equal(u2.colaboradores.length, 2)
})
test('situação: fired=false → ativo; fired=true → inativo (normalização explícita)', () => {
  const u = unirColaboradores([ATIVO(1)], [DEMITIDO(9)])
  const porId = Object.fromEntries(u.colaboradores.map((c) => [c.id, c.fired === true]))
  assert.equal(porId[1], false)
  assert.equal(porId[9], true)
})
test('fired ausente, string ou número → ERRO sanitizado (nunca classificação silenciosa)', () => {
  for (const ruim of [{ id: 5 }, { id: 5, fired: 'true' }, { id: 5, fired: 1 }]) {
    const u = unirColaboradores([ruim], [])
    assert.ok('erro' in u, `deveria falhar: ${JSON.stringify(Object.keys(ruim))}`)
    assert.ok(u.erro.includes('fired'))
    assert.ok(!u.erro.includes('A5') && !u.erro.includes('"5"'), 'valor vazou no erro')
  }
})
test('conflito: mesmo id como ativo E inativo → ERRO', () => {
  const u = unirColaboradores([ATIVO(7)], [DEMITIDO(7)])
  assert.ok('erro' in u)
  assert.ok(u.erro.includes('mesmo id'))
})
test('conjunto de demitidos com fired !== true → ERRO', () => {
  const u = unirColaboradores([], [{ id: 8, fired: false }])
  assert.ok('erro' in u)
  assert.ok(u.erro.includes('demitidos'))
})
test('resignationDate NUNCA altera a classificação (só fired decide)', () => {
  const ativoComResignation = ATIVO(2, { resignationDate: 1780000000000 })   // ruído: campo presente
  const demitidoSemResignation = { id: 3, name: 'D3', fired: true }          // ruído: campo ausente
  const u = unirColaboradores([ativoComResignation], [demitidoSemResignation])
  assert.ok('colaboradores' in u)
  const porId = Object.fromEntries(u.colaboradores.map((c) => [c.id, c.fired]))
  assert.equal(porId[2], false)   // resignationDate presente não torna inativo
  assert.equal(porId[3], true)    // resignationDate ausente não torna ativo
})

test('esquemaDe: caminhos, tipos e contagens — sem NENHUM valor da fixture na saída', () => {
  const fixtures = [
    { id: 987001, name: 'NomeSensivelTeste', cpf: '11122233344', fired: false, extra: null,
      workSchedule: { id: 55, label: 'EscalaTeste' }, tags: [{ t: 'TagTeste' }] },
    { id: 987002, name: 'OutroNomeTeste', cpf: null, fired: true, extra: 'ValorTeste',
      workSchedule: null, tags: [] },
  ]
  const e = esquemaDe(fixtures)
  assert.deepEqual(e['id'], { tipos: ['number'], nulos: 0, preenchidos: 2 })
  assert.deepEqual(e['cpf'], { tipos: ['null', 'string'], nulos: 1, preenchidos: 1 })
  assert.deepEqual(e['fired'], { tipos: ['boolean'], nulos: 0, preenchidos: 2, trues: 1, falses: 1 })
  assert.ok(e['workSchedule.id'])                       // caminho aninhado mapeado
  assert.ok(e['tags[].t'])                              // array de objetos mapeado
  const txt = JSON.stringify(e)
  for (const vazamento of ['NomeSensivelTeste', 'OutroNomeTeste', '11122233344', 'ValorTeste', 'EscalaTeste', 'TagTeste', '987001', '987002']) {
    assert.ok(!txt.includes(vazamento), `valor vazou no esquema: ${vazamento}`)
  }
})

test('dia local com fuso não-SP: mesmo instante numérico, dia local pode diferir', () => {
  const meiaNoiteSP = Date.UTC(2026, 6, 23, 2, 30)   // 23:30 do dia 22 em SP; 22:30 em Manaus
  assert.equal(diaLocalDe(meiaNoiteSP, 'America/Sao_Paulo'), '2026-07-22')
  assert.equal(diaLocalDe(meiaNoiteSP, 'America/Noronha'), '2026-07-23')   // -02: já virou o dia
})
