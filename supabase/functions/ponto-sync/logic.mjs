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
export const ianaDe = (enumTz) => TZ_TANGERINO_IANA[enumTz] || TZ_FALLBACK

// ── datas ──────────────────────────────────────────────────────────────────────
// O Swagger declara `date-time` sem documentar offset (R1 confirma na prática).
// Estratégia defensiva: string COM offset explícito → confia no offset;
// string SEM offset → interpreta como hora de parede no fuso do colaborador.
const RE_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/
const RE_WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/

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

// String da API → instante UTC ISO (ou null se ausente/inválida).
export function normalizarData(raw, iana) {
  if (raw == null || raw === '') return null
  const s = String(raw)
  if (RE_OFFSET.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  return wallTimeParaUtc(s, iana)
}

// Dia LOCAL (no fuso do colaborador) de um instante/string da API — regra do desenho:
// o par pertence ao dia local da ENTRADA.
export function diaLocalDe(raw, iana) {
  if (raw == null || raw === '') return null
  const s = String(raw)
  if (!RE_OFFSET.test(s)) {
    const m = s.match(RE_WALL)
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null   // sem offset: a própria parede é o dia local
  }
  const iso = normalizarData(s, iana)
  if (!iso) return null
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: iana, year: 'numeric', month: '2-digit', day: '2-digit' })
  return dtf.format(new Date(iso))   // en-CA → YYYY-MM-DD
}

// ── normalização de um Punch da API → linha de ponto_marcacoes ────────────────
// `mapa`: Map(tangerino_employee_id → tecnico_id). Colaborador sem vínculo é DESCARTADO
// (minimização — desenho §3). Retorna { row } ou { descartada: true }.
export function normalizarPunch(punch, mapa) {
  const empId = punch.employeeId ?? punch.employee?.id
  const tecnico_id = mapa.get(Number(empId))
  if (!tecnico_id) return { descartada: true }

  const tzEnum = punch.employee?.timezone || 'SAO_PAULO'
  const iana = ianaDe(tzEnum)
  const entradaRaw = punch.dateIn ?? null
  const saidaRaw = punch.dateOut ?? null
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
// Regras da auditoria final do PR-C1:
//   · somente POST (a execução GRAVA no espelho do SR — GET operacional é 405);
//   · anônimo nunca passa (401);
//   · modo manual = só admin/gestor autenticado por JWT;
//   · cron autentica por segredo próprio (x-cron-secret) e só roda o delta;
//   · reconhecimento exige admin E o flag ponto_config.reconhecimento_ativo
//     (desligável após fechar R1/R2/R3).
export function validarRequisicao({ metodo, cronOk, papel, modo, reconhecimentoAtivo }) {
  if (metodo !== 'POST') return { ok: false, status: 405, motivo: 'somente POST' }
  const ehAdmin = papel === 'admin' || papel === 'gestor_axis'
  if (!cronOk && !ehAdmin) return { ok: false, status: 401, motivo: 'unauthorized' }
  if (modo === 'reconhecimento') {
    if (!ehAdmin) return { ok: false, status: 403, motivo: 'reconhecimento exige admin autenticado' }
    if (!reconhecimentoAtivo) return { ok: false, status: 403, motivo: 'reconhecimento desabilitado (R1/R2/R3 fechados)' }
  }
  return { ok: true, status: 200, autorizadoPor: ehAdmin ? 'admin' : 'cron' }
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
        'Access-Control-Allow-Headers': 'authorization, content-type',
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
// Avança para o maior lastModifiedDate visto; sem nada novo, mantém o anterior.
export function calcularCursorNovo(punches, cursorAnterior, iana = TZ_FALLBACK) {
  let max = cursorAnterior ?? 0
  for (const p of punches || []) {
    const iso = normalizarData(p.lastModifiedDate ?? null, iana)
    if (!iso) continue
    const ms = Date.parse(iso)
    if (ms > max) max = ms
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
