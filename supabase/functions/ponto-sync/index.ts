// Edge Function: ponto-sync — importa marcações do Sólides/Tangerino para o espelho
// ponto_marcacoes. SOMENTE LEITURA da API (só GET — nenhuma rota de escrita entra aqui,
// nem por precaução). Desenho: docs/ponto-fase-c-desenho.md §2.
//
// Chamada pelo pg_cron (futuro PR-C4) ou manualmente pela gestão → verify_jwt=false
// (deploy com --no-verify-jwt) + segredo compartilhado x-cron-secret (padrão lembrete-*).
// TANGERINO_TOKEN: SÓ Function Secret (Deno.env) — nunca em tabela, log, erro ou resposta.
//
// Modos (body JSON): { "modo": "delta" }          → delta por lastUpdate + janela D-7 (default)
//                    { "modo": "reconhecimento" } → diagnóstico R1/R2/R3 (não grava marcações)
// Idempotência: upsert por tangerino_punch_id; o cursor só avança com execução OK —
// falha no meio ⇒ próxima rodada repete o delta inteiro (autocorretivo).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  normalizarPunch, calcularCursorNovo, janelaMs, sanitizarErro,
} from './logic.mjs'

const API_BASE = 'https://api.tangerino.com.br/api/punch'
const PAGE_SIZE = 200
const MAX_PAGINAS = 300           // guarda de runaway (300×200 = 60k marcações/rodada)
const PAUSA_ENTRE_PAGINAS_MS = 250 // conservador até a Sólides confirmar rate limit
const JANELA_DIAS = 7

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// GET com retry (3 tentativas, backoff 1s/5s/25s) para 429/5xx/rede.
// 401/403 NÃO re-tenta: é token/permissão — precisa de humano.
async function getComRetry(url: string, token: string): Promise<any> {
  const backoff = [1000, 5000, 25000]
  let ultimo: unknown = null
  for (let t = 0; t <= backoff.length; t++) {
    try {
      const res = await fetch(url, { method: 'GET', headers: { Authorization: `Basic ${token}` } })
      if (res.ok) return await res.json()
      if (res.status === 401 || res.status === 403) throw new Error(`API negou acesso (HTTP ${res.status})`)
      ultimo = new Error(`API HTTP ${res.status}`)
      if (res.status !== 429 && res.status < 500) throw ultimo
    } catch (e) {
      if (String((e as Error).message || '').includes('negou acesso')) throw e
      ultimo = e
    }
    if (t < backoff.length) await sleep(backoff[t])
  }
  throw ultimo
}

// Coleta paginada (Page«Punch» estilo Spring: content[] + last).
async function coletar(token: string, params: Record<string, string | number>) {
  const punches: any[] = []
  let paginas = 0
  for (let page = 0; page < MAX_PAGINAS; page++) {
    const q = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      page: String(page), size: String(PAGE_SIZE),
    })
    const body = await getComRetry(`${API_BASE}/?${q}`, token)
    paginas++
    const content = Array.isArray(body?.content) ? body.content : []
    punches.push(...content)
    if (body?.last === true || content.length === 0) break
    await sleep(PAUSA_ENTRE_PAGINAS_MS)
  }
  return { punches, paginas }
}

Deno.serve(async (req: Request) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const token = Deno.env.get('TANGERINO_TOKEN') || ''
  const segredos = [token, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '']

  try {
    // ── auth: segredo compartilhado do cron (padrão da casa, env-first) ──
    const esperado = Deno.env.get('CRON_SECRET')
      || (await admin.from('app_secrets').select('valor').eq('chave', 'cron_secret').maybeSingle()).data?.valor
    if (!esperado || req.headers.get('x-cron-secret') !== esperado) return json({ error: 'unauthorized' }, 401)

    if (!token) return json({ error: 'TANGERINO_TOKEN não provisionado (Function Secret)' }, 503)

    const body = await req.json().catch(() => ({}))
    const modo = body?.modo === 'reconhecimento' ? 'reconhecimento' : 'delta'
    const agora = Date.now()

    // ── vínculos confirmados: sem linha no map, a marcação é descartada (minimização) ──
    const { data: vincs, error: eMap } = await admin.from('ponto_colaboradores_map')
      .select('tecnico_id,tangerino_employee_id').eq('ativo', true)
    if (eMap) throw eMap
    const mapa = new Map<number, string>((vincs || []).map((v: any) => [Number(v.tangerino_employee_id), v.tecnico_id]))

    // ── modo reconhecimento (R1/R2/R3): amostra crua sanitizada, SEM gravar marcações ──
    if (modo === 'reconhecimento') {
      const { inicioMs, fimMs } = janelaMs(3, agora)
      const q = new URLSearchParams({ startDateInMillis: String(inicioMs), endDateInMillis: String(fimMs), page: '0', size: '20' })
      const bodyApi = await getComRetry(`${API_BASE}/?${q}`, token)
      const content = Array.isArray(bodyApi?.content) ? bodyApi.content : []
      const amostra = content.slice(0, 8).map((p: any) => ({
        id: p.id, employeeId: p.employeeId ?? p.employee?.id,
        dateIn: p.dateIn ?? null, dateOut: p.dateOut ?? null,           // strings CRUAS → R1 (fuso)
        status: p.status ?? null, excluded: p.excluded ?? null,         // → R2 (exclusão)
        edited: p.edited ?? null, adjust: p.adjust ?? null,
        pendingType: p.pendingType ?? null,
        lastModifiedDate: p.lastModifiedDate ?? null,                   // → R3 (cursor)
        employeeTimezone: p.employee?.timezone ?? null,
      }))
      await admin.from('ponto_sync_execucoes').insert({
        tipo: 'reconhecimento', terminado_em: new Date().toISOString(),
        paginas: 1, novas: 0, atualizadas: 0, status: 'ok',
      })
      return json({
        modo, totalElements: bodyApi?.totalElements ?? null, totalPages: bodyApi?.totalPages ?? null,
        size: bodyApi?.size ?? null, vinculados: mapa.size, amostra,
      })
    }

    // ── modo delta: (a) incremental por lastUpdate; (b) janela D-7 (correções tardias) ──
    const { data: ult } = await admin.from('ponto_sync_execucoes')
      .select('cursor_novo').eq('status', 'ok').in('tipo', ['delta', 'janela7d'])
      .not('cursor_novo', 'is', null)
      .order('iniciado_em', { ascending: false }).limit(1).maybeSingle()
    const cursor: number | null = ult?.cursor_novo ?? null

    const resultados: Record<string, unknown>[] = []
    const rodadas: Array<{ tipo: 'delta' | 'janela7d'; params: Record<string, string | number> | null }> = []
    if (cursor) rodadas.push({ tipo: 'delta', params: { lastUpdate: cursor } })
    const { inicioMs, fimMs } = janelaMs(JANELA_DIAS, agora)
    rodadas.push({ tipo: 'janela7d', params: { startDateInMillis: inicioMs, endDateInMillis: fimMs } })

    for (const rodada of rodadas) {
      const iniciado = new Date().toISOString()
      try {
        const { punches, paginas } = await coletar(token, rodada.params!)
        let descartadas = 0
        const rows: any[] = []
        for (const p of punches) {
          const r = normalizarPunch(p, mapa)
          if ('descartada' in r) { descartadas++; continue }
          rows.push(r.row)
        }
        // novas × atualizadas: ids já existentes no espelho (em lotes de 500)
        let novas = 0, atualizadas = 0
        for (let i = 0; i < rows.length; i += 500) {
          const lote = rows.slice(i, i + 500)
          const ids = lote.map((r) => r.tangerino_punch_id)
          const { data: exist } = await admin.from('ponto_marcacoes')
            .select('tangerino_punch_id').in('tangerino_punch_id', ids)
          const jaTem = new Set((exist || []).map((e: any) => Number(e.tangerino_punch_id)))
          const { error: eUp } = await admin.from('ponto_marcacoes')
            .upsert(lote, { onConflict: 'tangerino_punch_id' })
          if (eUp) throw eUp
          for (const r of lote) (jaTem.has(r.tangerino_punch_id) ? atualizadas++ : novas++)
        }
        const cursorNovo = calcularCursorNovo(punches, cursor)
        await admin.from('ponto_sync_execucoes').insert({
          iniciado_em: iniciado, terminado_em: new Date().toISOString(), tipo: rodada.tipo,
          cursor_anterior: cursor, cursor_novo: cursorNovo,
          paginas, novas, atualizadas, descartadas_sem_vinculo: descartadas, status: 'ok',
        })
        resultados.push({ tipo: rodada.tipo, paginas, novas, atualizadas, descartadas })
      } catch (e) {
        await admin.from('ponto_sync_execucoes').insert({
          iniciado_em: iniciado, terminado_em: new Date().toISOString(), tipo: rodada.tipo,
          cursor_anterior: cursor, status: 'erro', erro_sanitizado: sanitizarErro(e, segredos),
        })
        resultados.push({ tipo: rodada.tipo, erro: sanitizarErro(e, segredos) })
      }
    }
    const houveErro = resultados.some((r) => 'erro' in r)
    return json({ modo, vinculados: mapa.size, resultados }, houveErro ? 500 : 200)
  } catch (e) {
    return json({ error: sanitizarErro(e, segredos) }, 500)
  }
})
