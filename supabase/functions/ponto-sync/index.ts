// Edge Function: ponto-sync — importa marcações do Sólides/Tangerino para o espelho
// ponto_marcacoes. SOMENTE LEITURA da API do Tangerino (só GET — nenhuma rota de escrita
// entra aqui, nem por precaução). Desenho: docs/ponto-fase-c-desenho.md §2 + auditoria C1.
//
// A EXECUÇÃO grava no espelho do SR → a chamada é POST (GET operacional = 405; sem CORS:
// esta função não é chamada por navegador). verify_jwt=false (deploy com --no-verify-jwt),
// mas NINGUÉM anônimo passa:
//   · cron (futuro PR-C4): header x-cron-secret com o segredo compartilhado da casa —
//     nunca por parâmetro de URL; roda só o modo delta;
//   · manual: JWT de admin/gestor_axis (portal_acessos do service_report) no Authorization.
// Reconhecimento (R1/R2/R3): só admin autenticado E ponto_config.reconhecimento_ativo=true.
// TANGERINO_TOKEN: SÓ Function Secret (Deno.env) — nunca em URL, resposta, log ou tabela.
// Idempotência: upsert por tangerino_punch_id; cursor só avança com execução 100% OK —
// falha em página intermediária aborta a rodada inteira (erro na trilha, cursor parado).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  normalizarPunch, calcularCursorNovo, janelaMs, sanitizarErro,
  validarRequisicao, decidirRetry, coletarPaginado, corsPara,
} from './logic.mjs'

const API_BASE = 'https://api.tangerino.com.br/api/punch'
const PAGE_SIZE = 200
const MAX_PAGINAS = 300              // guarda de runaway (300×200 = 60k marcações/rodada)
const PAUSA_ENTRE_PAGINAS_MS = 250   // conservador até a Sólides confirmar rate limit
const ESPERAS_RETRY_MS = [1000, 3000, 9000]   // soma 13s — dentro do limite de execução da Edge
const DEADLINE_MS = 100_000          // teto da rodada; estourou → aborta SEM avançar cursor
const JANELA_DIAS = 7

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// GET na API do Tangerino com a política de retry de logic.decidirRetry
// (401/403 não re-tenta; 429 respeita Retry-After com teto; 5xx/rede backoff).
// Header: token CRU em `Authorization` — forma comprovada empiricamente em 22/07 nas duas
// APIs (Employer /test 200 e Punch 200 no teste same-origin do navegador do admin). A doc
// narrativa dizia "Basic <token>", mas o teste real mandou sem prefixo e funcionou.
async function getComRetry(url: string, token: string): Promise<any> {
  for (let tentativa = 0; ; tentativa++) {
    let status = 0, retryAfter: number | null = null
    try {
      const res = await fetch(url, { method: 'GET', headers: { Authorization: token } })
      if (res.ok) return await res.json()
      status = res.status
      const ra = res.headers.get('Retry-After')
      retryAfter = ra != null && ra !== '' ? Number(ra) : null
    } catch (_e) { status = 0 }
    const espera = decidirRetry(status, tentativa, ESPERAS_RETRY_MS, retryAfter)
    if (espera == null) {
      throw new Error(status === 401 || status === 403
        ? `API do ponto negou acesso (HTTP ${status})` : `API do ponto falhou (HTTP ${status || 'rede'})`)
    }
    await sleep(espera)
  }
}

function urlPagina(params: Record<string, string | number>, page: number, size: number): string {
  const q = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    page: String(page), size: String(size),
  })
  return `${API_BASE}/?${q}`
}

Deno.serve(async (req: Request) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const token = Deno.env.get('TANGERINO_TOKEN') || ''
  const segredos = [token, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', Deno.env.get('CRON_SECRET') || '']

  // CORS restrito: só a origem do portal recebe os headers (achado do reconhecimento — o
  // JWT admin vive no navegador do portal). Preflight OPTIONS da origem certa → 204; de
  // qualquer outra origem cai no 405 do validarRequisicao. Auth continua toda na função.
  const cors = corsPara(req.headers.get('Origin') || '')
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...cors } })
  if (req.method === 'OPTIONS' && Object.keys(cors).length) return new Response(null, { status: 204, headers: cors })

  try {
    // ── fatos de autenticação (a decisão é pura, em validarRequisicao) ──
    const esperado = Deno.env.get('CRON_SECRET')
      || (await admin.from('app_secrets').select('valor').eq('chave', 'cron_secret').maybeSingle()).data?.valor
    const cronOk = !!esperado && req.headers.get('x-cron-secret') === esperado   // header, nunca URL

    let papel: string | null = null
    const authz = req.headers.get('Authorization') || ''
    if (authz.startsWith('Bearer ')) {
      const { data: u } = await admin.auth.getUser(authz.slice(7))
      if (u?.user?.id) {
        const { data: pa } = await admin.from('portal_acessos').select('role_chave')
          .eq('usuario_id', u.user.id).eq('app_chave', 'service_report').maybeSingle()
        papel = pa?.role_chave ?? null
      }
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const modo = body?.modo === 'reconhecimento' ? 'reconhecimento' : 'delta'
    const { data: cfg } = await admin.from('ponto_config').select('reconhecimento_ativo').eq('id', 1).maybeSingle()

    const auth = validarRequisicao({
      metodo: req.method, cronOk, papel, modo,
      reconhecimentoAtivo: cfg?.reconhecimento_ativo === true,
    })
    if (!auth.ok) return json({ error: auth.motivo }, auth.status)

    if (!token) return json({ error: 'TANGERINO_TOKEN não provisionado (Function Secret)' }, 503)

    const agora = Date.now()
    const deadline = agora + DEADLINE_MS

    // ── vínculos confirmados: sem linha no map, a marcação é descartada (minimização) ──
    const { data: vincs, error: eMap } = await admin.from('ponto_colaboradores_map')
      .select('tecnico_id,tangerino_employee_id').eq('ativo', true)
    if (eMap) throw eMap
    const mapa = new Map<number, string>((vincs || []).map((v: any) => [Number(v.tangerino_employee_id), v.tecnico_id]))

    // ── modo reconhecimento: amostra mínima sanitizada, SEM gravar em ponto_marcacoes ──
    // Só o necessário p/ R1 (formato/fuso), R2 (exclusão), R3 (lastUpdate) e id estável.
    // Sem nome, CPF, PIS, e-mail, token ou payload bruto.
    if (modo === 'reconhecimento') {
      const { inicioMs, fimMs } = janelaMs(3, agora)
      const bodyApi = await getComRetry(urlPagina({ startDateInMillis: inicioMs, endDateInMillis: fimMs }, 0, 20), token)
      const content = Array.isArray(bodyApi?.content) ? bodyApi.content : []
      const amostra = content.slice(0, 5).map((p: any) => ({
        id: p.id, employeeId: p.employeeId ?? p.employee?.id,          // identificador estável
        dateIn: p.dateIn ?? null, dateOut: p.dateOut ?? null,          // formato/fuso (R1)
        employeeTimezone: p.employee?.timezone ?? null,                // fuso declarado (R1)
        lastModifiedDate: p.lastModifiedDate ?? null,                  // cursor (R3)
        excluded: p.excluded ?? null, status: p.status ?? null,        // exclusão/invalidação (R2)
        pendingType: p.pendingType ?? null,
      }))
      await admin.from('ponto_sync_execucoes').insert({
        tipo: 'reconhecimento', terminado_em: new Date().toISOString(),
        paginas: 1, novas: 0, atualizadas: 0, status: 'ok',
      })
      return json({
        modo, autorizadoPor: auth.autorizadoPor, vinculados: mapa.size,
        totalElements: bodyApi?.totalElements ?? null, totalPages: bodyApi?.totalPages ?? null,
        size: bodyApi?.size ?? null, amostra,
      })
    }

    // ── modo delta: (a) incremental por lastUpdate; (b) janela D-7 (correções tardias — a
    // suficiência da janela p/ exclusões/correções antigas AINDA depende do R2/R3) ──
    const { data: ult } = await admin.from('ponto_sync_execucoes')
      .select('cursor_novo').eq('status', 'ok').in('tipo', ['delta', 'janela7d'])
      .not('cursor_novo', 'is', null)
      .order('iniciado_em', { ascending: false }).limit(1).maybeSingle()
    const cursor: number | null = ult?.cursor_novo ?? null

    const resultados: Record<string, unknown>[] = []
    const rodadas: Array<{ tipo: 'delta' | 'janela7d'; params: Record<string, string | number> }> = []
    if (cursor) rodadas.push({ tipo: 'delta', params: { lastUpdate: cursor } })
    const { inicioMs, fimMs } = janelaMs(JANELA_DIAS, agora)
    rodadas.push({ tipo: 'janela7d', params: { startDateInMillis: inicioMs, endDateInMillis: fimMs } })

    for (const rodada of rodadas) {
      const iniciado = new Date().toISOString()
      try {
        // Falha em QUALQUER página aborta a rodada inteira (coletarPaginado propaga):
        // nada parcial vira "carga concluída" e o cursor não avança.
        const { punches, paginas } = await coletarPaginado(
          (page: number) => getComRetry(urlPagina(rodada.params, page, PAGE_SIZE), token),
          { maxPaginas: MAX_PAGINAS, deadlineMs: deadline, pausaMs: PAUSA_ENTRE_PAGINAS_MS, dorme: sleep },
        )
        let descartadas = 0
        const rows: any[] = []
        for (const p of punches) {
          const r = normalizarPunch(p, mapa)
          if ('descartada' in r) { descartadas++; continue }
          rows.push(r.row)
        }
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
    return json({ modo, autorizadoPor: auth.autorizadoPor, vinculados: mapa.size, resultados }, houveErro ? 500 : 200)
  } catch (e) {
    return json({ error: sanitizarErro(e, segredos) }, 500)
  }
})
