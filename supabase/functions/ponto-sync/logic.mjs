// ponto-sync/logic.js — lógica PURA da importação de ponto (sem rede, sem Deno, sem segredo).
// JS puro de propósito: o index.ts (Deno) importa daqui e o teste roda em Node (`node --test`).
// Regras: docs/ponto-fase-c-desenho.md §§1–4. NADA aqui escreve em lugar nenhum.

// Enum de fuso do Tangerino → IANA (mapeamento publicado na doc "Fuso horário / Time zone").
// Subconjunto dos usados no Brasil + fallback; inclui o typo real 'RECIVE' do enum deles.
export const TZ_TANGERINO_IANA = {
  SAO_PAULO: 'America/Sao_Paulo', BAHIA: 'America/Bahia', BELEM: 'America/Belem',
  FORTALEZA: 'America/Fortaleza', RECIVE: 'America/Recife', RECIFE: 'America/Recife',
  MACEIO: 'America/Maceio', MANAUS: 'America/Manaus', CUIABA: 'America/Cuiaba',
  CAMPO_GRANDE: 'America/Campo_Grande', PORTO_VELHO: 'America/Porto_Velho',
  RIO_BRANCO: 'America/Rio_Branco', BOA_VISTA: 'America/Boa_Vista', NORONHA: 'America/Noronha',
}
export const TZ_FALLBACK = 'America/Sao_Paulo'
// Timezone desconhecido NÃO recebe fallback silencioso (regra do PR pós-reconhecimento):
// enum fora do mapa → null; quem chama registra erro sanitizado e a marcação não é
// importada com fuso chutado. TZ_FALLBACK permanece só para o cursor (instantes absolutos).
export const ianaDe = (enumTz) => TZ_TANGERINO_IANA[enumTz] ?? null

// ── datas ──────────────────────────────────────────────────────────────────────
// REALIDADE DA API (reconhecimento 22/07): dateIn/dateOut/lastModifiedDate chegam como
// EPOCH MILLIS NUMÉRICOS — instantes absolutos, sem ambiguidade de fuso. O Swagger
// documenta `date-time` string, então a compatibilidade defensiva com strings fica:
// string COM offset → confia no offset; string SEM offset → hora de parede no fuso do
// colaborador. NUNCA inferir epoch em segundos; número fora de faixa/negativo/não-finito
// é rejeitado (null); string só-dígitos NÃO vira epoch (não inferir).
const RE_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/
const RE_WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/
const EPOCH_MIN_MS = Date.UTC(2000, 0, 1)   // faixa sã: rejeita segundos (1784746037 < min)
const EPOCH_MAX_MS = Date.UTC(2100, 0, 1)
export function epochMsValido(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= EPOCH_MIN_MS && v <= EPOCH_MAX_MS
}

function offsetMs(date, iana) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: iana, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return asUtc - date.getTime()
}

// Hora de parede num fuso IANA → instante UTC (ISO). Duas passadas cobrem borda de DST.
export function wallTimeParaUtc(s, iana) {
  const m = String(s).match(RE_WALL)
  if (!m) return null
  const ms = +((m[7] || '').padEnd(3, '0').slice(0, 3) || 0)
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms)
  let ts = guess - offsetMs(new Date(guess), iana)
  ts = guess - offsetMs(new Date(ts), iana)
  return new Date(ts).toISOString()
}

// Valor da API → instante UTC ISO (ou null se ausente/inválido).
// Número = epoch millis validado; string segue o caminho defensivo documentado.
export function normalizarData(raw, iana) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return epochMsValido(raw) ? new Date(raw).toISOString() : null
  const s = String(raw)
  if (RE_OFFSET.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  return wallTimeParaUtc(s, iana)   // string só-dígitos não casa RE_WALL → null (nunca inferir epoch)
}

// Dia LOCAL (no fuso do colaborador) de um instante da API — regra do desenho:
// o par pertence ao dia local da ENTRADA. Instante absoluto (número/offset) é convertido
// para o dia no fuso IANA do colaborador — nunca assume Brasília.
const diaEmTz = (instanteMsOuIso, iana) => {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: iana, year: 'numeric', month: '2-digit', day: '2-digit' })
  return dtf.format(new Date(instanteMsOuIso))   // en-CA → YYYY-MM-DD
}
export function diaLocalDe(raw, iana) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return epochMsValido(raw) ? diaEmTz(raw, iana) : null
  const s = String(raw)
  if (!RE_OFFSET.test(s)) {
    const m = s.match(RE_WALL)
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null   // sem offset: a própria parede é o dia local
  }
  const iso = normalizarData(s, iana)
  if (!iso) return null
  return diaEmTz(iso, iana)
}

// ── normalização de um Punch da API → linha de ponto_marcacoes ────────────────
// `mapa`: Map(tangerino_employee_id → tecnico_id). Colaborador sem vínculo é DESCARTADO
// (minimização — desenho §3). Retorna { row } ou { descartada: true }.
export function normalizarPunch(punch, mapa) {
  const empId = punch.employeeId ?? punch.employee?.id
  const tecnico_id = mapa.get(Number(empId))
  if (!tecnico_id) return { descartada: true }

  // Timezone desconhecido/ausente → ERRO sanitizado (só o enum, nenhum dado pessoal);
  // nunca fallback silencioso — marcação não é importada com fuso chutado.
  const tzEnum = punch.employee?.timezone ?? null
  const iana = ianaDe(tzEnum)
  if (!iana) return { erro: `timezone desconhecido: ${String(tzEnum).slice(0, 40)}` }
  const entradaRaw = punch.dateIn ?? null
  const saidaRaw = punch.dateOut ?? null
  // dateOut null é MARCAÇÃO ABERTA — preservada (saida=null), jamais descartada.
  const dia = diaLocalDe(entradaRaw, iana) || diaLocalDe(saidaRaw, iana)
  if (!punch.id || !dia) return { descartada: true }   // sem id/sem dia não há como espelhar

  return {
    row: {
      tangerino_punch_id: Number(punch.id),
      tecnico_id,
      dia,
      entrada: normalizarData(entradaRaw, iana),
      saida: normalizarData(saidaRaw, iana),
      entrada_raw: entradaRaw == null ? null : String(entradaRaw),
      saida_raw: saidaRaw == null ? null : String(saidaRaw),
      status_origem: ['APPROVED', 'PENDING', 'REPROVED'].includes(punch.status) ? punch.status : 'PENDING',
      excluido_origem: punch.excluded === true,
      editado_origem: !!(punch.edited || punch.adjust || punch.editedIn || punch.editedOut),
      pendente_metade: ['ENTRADA', 'SAIDA', 'AMBOS'].includes(punch.pendingType) ? punch.pendingType : null,
      tz_origem: tzEnum,
      origem_modificado_em: normalizarData(punch.lastModifiedDate ?? null, iana),
      origem_modificado_raw: punch.lastModifiedDate == null ? null : String(punch.lastModifiedDate),
    },
  }
}

// ── autorização da requisição (decisão pura; o index.ts injeta os fatos) ──────
// Regras da auditoria final do PR-C1 (+C2):
//   · somente POST (a execução GRAVA no espelho do SR — GET operacional é 405);
//   · anônimo nunca passa (401);
//   · modo manual = só admin/gestor autenticado por JWT;
//   · cron autentica por segredo próprio (x-cron-secret) e só roda o delta;
//   · reconhecimento exige admin E o flag ponto_config.reconhecimento_ativo;
//   · colaboradores (C2, consulta read-only p/ tela de vínculos) exige admin/gestor
//     autenticado — cron NÃO roda (não é sync).
export function validarRequisicao({ metodo, cronOk, papel, modo, reconhecimentoAtivo }) {
  if (metodo !== 'POST') return { ok: false, status: 405, motivo: 'somente POST' }
  const ehAdmin = papel === 'admin' || papel === 'gestor_axis'
  if (!cronOk && !ehAdmin) return { ok: false, status: 401, motivo: 'unauthorized' }
  if (modo === 'reconhecimento' || modo === 'colaboradores') {
    if (!ehAdmin) return { ok: false, status: 403, motivo: `${modo} exige admin autenticado` }
    if (modo === 'reconhecimento' && !reconhecimentoAtivo) {
      return { ok: false, status: 403, motivo: 'reconhecimento desabilitado (R1/R2/R3 fechados)' }
    }
  }
  return { ok: true, status: 200, autorizadoPor: ehAdmin ? 'admin' : 'cron' }
}

// ── classificação da marcação na importação (nada desaparece em silêncio) ────
// 'importar' = colaborador vinculado · 'fora_escopo' = decisão intencional auditada
// (não bloqueia) · 'pendente_sem_vinculo' = ainda exige decisão humana (BLOQUEIA a
// execução: 'parcial', sem avanço de cursor — regra da 1ª carga).
export function classificarPunch(punch, mapa, foraEscopo) {
  const empId = Number(punch?.employeeId ?? punch?.employee?.id)
  if (mapa.has(empId)) return 'importar'
  if (foraEscopo.has(empId)) return 'fora_escopo'
  return 'pendente_sem_vinculo'
}

// ── esquema sanitizado (diagnóstico C2 — NUNCA carrega valores) ──────────────
// A partir de uma lista de objetos constrói {caminho → {tipos, nulos, preenchidos,
// trues, falses}} até 2 níveis (objeto aninhado vira 'pai.filho'; array de objetos
// vira 'campo[].filho'). Saída contém SÓ nomes de campos, tipos e contagens —
// nenhum valor individual entra, por construção (só typeof/comparações).
export function esquemaDe(itens, maxNivel = 2) {
  const acc = {}
  const visita = (obj, prefixo, nivel) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const path = prefixo ? `${prefixo}.${k}` : k
      const e = (acc[path] ||= { tipos: new Set(), nulos: 0, preenchidos: 0, trues: 0, falses: 0 })
      if (v === null || v === undefined) { e.tipos.add('null'); e.nulos++ }
      else {
        e.preenchidos++
        if (Array.isArray(v)) {
          e.tipos.add('array')
          if (nivel < maxNivel && v[0] && typeof v[0] === 'object') visita(v[0], path + '[]', nivel + 1)
        } else if (typeof v === 'object') {
          e.tipos.add('object')
          if (nivel < maxNivel) visita(v, path, nivel + 1)
        } else {
          e.tipos.add(typeof v)
          if (v === true) e.trues++
          if (v === false) e.falses++
        }
      }
    }
  }
  for (const it of itens || []) visita(it, '', 0)
  const out = {}
  for (const [p, e] of Object.entries(acc)) {
    out[p] = { tipos: [...e.tipos].sort(), nulos: e.nulos, preenchidos: e.preenchidos,
      ...(e.trues + e.falses > 0 ? { trues: e.trues, falses: e.falses } : {}) }
  }
  return out
}

// ── sugestão de vínculo (C2 — roda SÓ NO SERVIDOR; CPF jamais sai daqui) ─────
// Prioridade: externalId (chave forte, se preenchido no Tangerino com o uuid do SR) >
// CPF normalizado (só dígitos, 11 posições). Nome NUNCA é chave. A sugestão é auxílio:
// quem confirma é humano na tela — nada aqui cria vínculo.
// ── consulta definitiva de colaboradores (diagnóstico 22/07 comprovou) ────────
// `showFired=true` retorna SOMENTE os demitidos ("mostrar OS demitidos", não incluir);
// sem o parâmetro vêm os ATIVOS. Logo: duas consultas independentes, unidas por id.
// A query string é pura para ser testável.
export function qsEmployerFindAll(page, size, somenteDemitidos) {
  const q = new URLSearchParams({ page: String(page), size: String(size) })
  if (somenteDemitidos) q.set('showFired', 'true')
  return q.toString()
}

// União por id com NORMALIZAÇÃO ESTRITA da situação (nunca truthy/falsy):
//   fired === true → inativo · fired === false → ativo · qualquer outra coisa → ERRO.
// Inconsistências BLOQUEIAM com erro sanitizado (sem classificar em silêncio):
//   · mesmo id presente como ativo E inativo · registro do conjunto de demitidos com
//   fired !== true · fired ausente/string/número. resignationDate NUNCA classifica.
export function unirColaboradores(ativos, demitidos) {
  const vistos = new Map()
  const problemas = new Set()
  const processa = (lista, conjuntoDemitidos) => {
    for (const p of lista || []) {
      const id = p?.id
      if (id == null) { problemas.add('registro sem id'); continue }
      if (typeof p.fired !== 'boolean') { problemas.add('fired ausente ou não-boolean'); continue }
      if (conjuntoDemitidos && p.fired !== true) { problemas.add('conjunto de demitidos contém registro com fired !== true'); continue }
      if (vistos.has(id)) {
        if (vistos.get(id).fired !== p.fired) problemas.add('mesmo id presente como ativo e inativo')
        continue   // duplicata idêntica: mantém a primeira (união por id)
      }
      vistos.set(id, p)
    }
  }
  processa(ativos, false)
  processa(demitidos, true)
  if (problemas.size) {
    return { erro: `inconsistência na lista de colaboradores: ${[...problemas].join('; ')}`.slice(0, 300) }
  }
  return { colaboradores: [...vistos.values()] }
}

export const soDigitos = (s) => String(s ?? '').replace(/\D+/g, '')
export function sugerirVinculo(colab, usuariosAtivos) {
  const ext = String(colab?.externalId ?? '').trim().toLowerCase()
  if (ext) {
    const u = (usuariosAtivos || []).find((x) => String(x.id).toLowerCase() === ext)
    if (u) return { tecnicoId: u.id, origem: 'externalId' }
  }
  const cpf = soDigitos(colab?.cpf)
  if (cpf.length === 11) {
    const u = (usuariosAtivos || []).find((x) => soDigitos(x.cpf) === cpf)
    if (u) return { tecnicoId: u.id, origem: 'cpf' }
  }
  return null
}

// ── CORS restrito à origem do portal (decisão pura) ──────────────────────────
// Achado do reconhecimento (22/07): o único portador de JWT admin é o navegador do
// portal — sem CORS o preflight morre e o modo manual/reconhecimento fica inexecutável.
// NÃO é CORS público: só a origem exata do portal recebe os headers; qualquer outra
// origem recebe {} (o navegador bloqueia). A autenticação continua 100% na função.
export const ORIGENS_PORTAL = ['https://servicereport-app.vercel.app']
export function corsPara(origin) {
  return ORIGENS_PORTAL.includes(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',   // supabase-js functions.invoke envia apikey/x-client-info
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin',
      }
    : {}
}

// ── política de retry (decisão pura) ─────────────────────────────────────────
// 401/403 nunca re-tenta (token/permissão — precisa de humano). 429 respeita
// Retry-After quando fornecido (teto de 30s). 5xx/rede usam o backoff. Demais: desiste.
export function decidirRetry(status, tentativa, esperasMs, retryAfterSeg) {
  if (status === 401 || status === 403) return null
  if (tentativa >= esperasMs.length) return null
  if (status === 429 && retryAfterSeg != null && isFinite(retryAfterSeg)) {
    return Math.min(Math.max(retryAfterSeg, 0) * 1000, 30_000)
  }
  if (status === 429 || status >= 500 || status === 0) return esperasMs[tentativa]   // 0 = erro de rede
  return null
}

// ── coleta paginada (controle puro; fetchPagina/dorme/relógio injetáveis) ────
// Falha em página intermediária PROPAGA (nenhum resultado parcial é devolvido —
// o chamador marca a execução como erro e o cursor NÃO avança). O deadline protege
// o limite de execução da Edge: estourou → aborta a rodada inteira, sem cursor.
export async function coletarPaginado(fetchPagina, {
  maxPaginas = 300, deadlineMs = null, agora = () => Date.now(),
  pausaMs = 250, dorme = async () => {},
} = {}) {
  const punches = []
  let paginas = 0
  for (let page = 0; page < maxPaginas; page++) {
    if (deadlineMs != null && agora() > deadlineMs) {
      throw new Error('tempo limite da rodada atingido — interrompida sem avanço de cursor')
    }
    const body = await fetchPagina(page)
    paginas++
    const content = Array.isArray(body?.content) ? body.content : []
    punches.push(...content)
    if (body?.last === true || content.length === 0) break
    if (pausaMs) await dorme(pausaMs)
  }
  return { punches, paginas }
}

// ── cursor incremental (millis) ───────────────────────────────────────────────
// Avança para o MAIOR lastModifiedDate VÁLIDO visto (número epoch validado ou string
// temporal válida); inválido é ignorado, nunca regride. O avanço efetivo continua sendo
// responsabilidade do chamador: só grava cursor_novo em execução integralmente concluída.
export function calcularCursorNovo(punches, cursorAnterior, iana = TZ_FALLBACK) {
  let max = cursorAnterior ?? 0
  for (const p of punches || []) {
    const lm = p.lastModifiedDate ?? null
    let ms = null
    if (typeof lm === 'number') ms = epochMsValido(lm) ? lm : null
    else { const iso = normalizarData(lm, iana); ms = iso ? Date.parse(iso) : null }
    if (ms != null && ms > max) max = ms
  }
  return max || null
}

// ── janela D-N (millis) para a varredura de correções tardias ────────────────
export function janelaMs(dias, agoraMs) {
  const fim = agoraMs
  const inicio = agoraMs - dias * 24 * 3600 * 1000
  return { inicioMs: inicio, fimMs: fim }
}

// ── sanitização de erro (trilha/log NUNCA carrega segredo) ───────────────────
export function sanitizarErro(err, segredos = []) {
  let msg = String((err && err.message) || err || 'erro desconhecido')
  for (const s of segredos) {
    if (s) msg = msg.split(s).join('[segredo]')
  }
  msg = msg.replace(/authorization\s*:\s*\S+/gi, 'authorization:[removido]')
  msg = msg.replace(/basic\s+[a-z0-9+/=._-]{8,}/gi, 'basic [removido]')
  msg = msg.replace(/bearer\s+[a-z0-9+/=._-]{8,}/gi, 'bearer [removido]')
  return msg.slice(0, 500)
}
