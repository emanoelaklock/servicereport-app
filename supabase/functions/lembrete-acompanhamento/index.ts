// Edge Function: lembrete-acompanhamento — push pras tarefas EM EXECUÇÃO / EM PAUSA paradas há +5 dias.
// Serviço começou e travou (técnico não voltou pra concluir, ou pausa sem previsão). Chamada pelo
// pg_cron (1x/dia), não por um usuário → verify_jwt=false + segredo compartilhado (x-cron-secret).
//
// Fonte da "parada" = view vw_tarefas_acompanhamento (dias_parada = hoje − última atividade).
// Seleciona dias_parada >= 5 e não-notificadas no último dia (tarefas.acompanhamento_notif_em) →
// push aos técnicos da tarefa → carimba. Máx 1 push/dia por tarefa, até ela sair de execução/pausa.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const LIMITE_DIAS = 5
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── auth: segredo compartilhado do cron ──
    const { data: cs } = await admin.from('app_secrets').select('valor').eq('chave', 'cron_secret').maybeSingle()
    const esperado = cs?.valor
    if (!esperado || req.headers.get('x-cron-secret') !== esperado) return json({ error: 'unauthorized' }, 401)

    // ── 1) tarefas paradas há >= LIMITE_DIAS (da view) ──
    const { data: paradas, error: e1 } = await admin.from('vw_tarefas_acompanhamento')
      .select('id,numero,cliente_id,status,dias_parada').gte('dias_parada', LIMITE_DIAS)
    if (e1) return json({ error: e1.message }, 500)
    if (!paradas || !paradas.length) return json({ tarefas: 0, sent: 0 })

    // ── 2) filtra as não-notificadas no último dia (dedup do push) ──
    const corte = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const ids = paradas.map((t: any) => t.id)
    const { data: notifRows } = await admin.from('tarefas').select('id,acompanhamento_notif_em').in('id', ids)
    const notif: Record<string, string | null> = {}
    for (const r of (notifRows || [])) notif[r.id] = r.acompanhamento_notif_em
    const elegiveis = paradas.filter((t: any) => { const n = notif[t.id]; return !n || n < corte })
    if (!elegiveis.length) return json({ tarefas: paradas.length, elegiveis: 0, sent: 0 })

    // ── técnicos de cada tarefa + nomes de cliente ──
    const elIds = elegiveis.map((t: any) => t.id)
    const { data: rels } = await admin.from('tarefa_tecnicos').select('tarefa_id,tecnico_id').in('tarefa_id', elIds)
    const tecsPorTarefa: Record<string, string[]> = {}
    for (const r of (rels || [])) (tecsPorTarefa[r.tarefa_id] ||= []).push(r.tecnico_id)
    const cliIds = [...new Set(elegiveis.map((t: any) => t.cliente_id).filter(Boolean))]
    const { data: clis } = cliIds.length ? await admin.from('clientes').select('id,nome').in('id', cliIds) : { data: [] }
    const nomeCli: Record<string, string> = {}
    for (const c of (clis || [])) nomeCli[c.id] = c.nome

    // ── VAPID ──
    const { data: secrets } = await admin.from('app_secrets').select('chave,valor').in('chave', ['vapid_public', 'vapid_private'])
    const pub = secrets?.find((s: any) => s.chave === 'vapid_public')?.valor
    const prv = secrets?.find((s: any) => s.chave === 'vapid_private')?.valor
    if (!pub || !prv) return json({ error: 'vapid ausente' }, 500)
    webpush.setVapidDetails('mailto:contato@tsrv.com.br', pub, prv)

    // ── 3) envia e carimba ──
    let sent = 0
    const carimbar: string[] = []
    for (const t of elegiveis) {
      const tecs = [...new Set(tecsPorTarefa[t.id] || [])]
      if (!tecs.length) continue   // sem técnico atribuído → nada a notificar; NÃO carimba
      carimbar.push(t.id)
      const no = String(t.numero ?? '').padStart(5, '0')
      const cli = nomeCli[t.cliente_id] ? ' — ' + nomeCli[t.cliente_id] : ''
      const st = t.status === 'em_pausa' ? 'em pausa' : 'em execução'
      const payload = JSON.stringify({
        title: 'Serviço em aberto — retomar',
        body: `Tarefa Nº ${no}${cli} · ${st} há ${t.dias_parada} dias`,
        url: 'tecnico.html',
      })
      const { data: subs } = await admin.from('push_subscriptions').select('*').in('user_id', tecs)
      for (const s of (subs || [])) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++ }
        catch (e: any) { const c = e?.statusCode; if (c === 404 || c === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint) }
      }
    }
    if (carimbar.length) await admin.from('tarefas').update({ acompanhamento_notif_em: new Date().toISOString() }).in('id', carimbar)
    return json({ tarefas: paradas.length, elegiveis: elegiveis.length, carimbadas: carimbar.length, sent })
  } catch (e) { return json({ error: String(e) }, 500) }
})
