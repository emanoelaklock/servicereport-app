// Edge Function: lembrete-devolvida — push pras tarefas DEVOLVIDAS sem retorno há +1 dia.
// Chamada pelo pg_cron (a cada 4h), NÃO por um usuário → verify_jwt=false + segredo compartilhado.
// O segredo vive em public.app_secrets (chave 'cron_secret'); o cron passa no header x-cron-secret.
//
// Seleciona: status='devolvida' AND devolvida_em < now-24h AND (devolvida_notif_em IS NULL OR
// devolvida_notif_em < now-24h) → envia web push aos técnicos da tarefa (tarefa_tecnicos →
// push_subscriptions, VAPID de app_secrets, igual ao notify-push) → carimba devolvida_notif_em.
// Efeito: no máx 1 push/dia por tarefa, até o técnico retornar (sai de 'devolvida' → sai do filtro).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── auth: segredo compartilhado do cron ──
    // P1a: env-first (Function Secret CRON_SECRET) com fallback TEMPORÁRIO à tabela (removido no 3º PR)
    const esperado = Deno.env.get('CRON_SECRET')
      || (await admin.from('app_secrets').select('valor').eq('chave', 'cron_secret').maybeSingle()).data?.valor
    if (!esperado || req.headers.get('x-cron-secret') !== esperado) return json({ error: 'unauthorized' }, 401)

    // ── 1) devolvidas vencidas (>24h) e não notificadas no último dia ──
    const corte = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const { data: tarefas, error: e1 } = await admin.from('tarefas')
      .select('id,numero,cliente_id,devolvida_em')
      .eq('status', 'devolvida')
      .lt('devolvida_em', corte)
      .or(`devolvida_notif_em.is.null,devolvida_notif_em.lt.${corte}`)
    if (e1) return json({ error: e1.message }, 500)
    if (!tarefas || !tarefas.length) return json({ tarefas: 0, sent: 0 })

    // ── 2) técnicos de cada tarefa + nomes de cliente ──
    const ids = tarefas.map((t: any) => t.id)
    const { data: rels } = await admin.from('tarefa_tecnicos').select('tarefa_id,tecnico_id').in('tarefa_id', ids)
    const tecsPorTarefa: Record<string, string[]> = {}
    for (const r of (rels || [])) (tecsPorTarefa[r.tarefa_id] ||= []).push(r.tecnico_id)
    const cliIds = [...new Set(tarefas.map((t: any) => t.cliente_id).filter(Boolean))]
    const { data: clis } = cliIds.length ? await admin.from('clientes').select('id,nome').in('id', cliIds) : { data: [] }
    const nomeCli: Record<string, string> = {}
    for (const c of (clis || [])) nomeCli[c.id] = c.nome

    // ── VAPID ──
    // P1a: env-first (Function Secrets) com fallback TEMPORÁRIO à tabela app_secrets (removido no 3º PR)
    let pub = Deno.env.get('VAPID_PUBLIC'), prv = Deno.env.get('VAPID_PRIVATE')
    if (!pub || !prv) {
      const { data: secrets } = await admin.from('app_secrets').select('chave,valor').in('chave', ['vapid_public', 'vapid_private'])
      pub = pub || secrets?.find((s: any) => s.chave === 'vapid_public')?.valor
      prv = prv || secrets?.find((s: any) => s.chave === 'vapid_private')?.valor
    }
    if (!pub || !prv) return json({ error: 'vapid ausente' }, 500)
    webpush.setVapidDetails('mailto:contato@tsrv.com.br', pub, prv)

    // ── 3) envia e carimba ──
    let sent = 0
    const carimbar: string[] = []
    for (const t of tarefas) {
      const tecs = [...new Set(tecsPorTarefa[t.id] || [])]
      if (!tecs.length) continue   // sem técnico atribuído → nada a notificar; NÃO carimba (tenta de novo quando houver)
      carimbar.push(t.id)          // tem técnico → conta como "lembrado hoje" (mesmo se sub inativa)
      const dias = Math.max(1, Math.floor((Date.now() - new Date(t.devolvida_em).getTime()) / 86400000))
      const no = String(t.numero ?? '').padStart(5, '0')
      const cli = nomeCli[t.cliente_id] ? ' — ' + nomeCli[t.cliente_id] : ''
      const payload = JSON.stringify({
        title: 'Tarefa devolvida — corrija',
        body: `Tarefa Nº ${no}${cli} · devolvida há ${dias} dia${dias > 1 ? 's' : ''}`,
        url: 'tecnico.html',
      })
      const { data: subs } = await admin.from('push_subscriptions').select('*').in('user_id', tecs)
      for (const s of (subs || [])) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++ }
        catch (e: any) { const c = e?.statusCode; if (c === 404 || c === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint) }
      }
    }
    if (carimbar.length) await admin.from('tarefas').update({ devolvida_notif_em: new Date().toISOString() }).in('id', carimbar)
    return json({ tarefas: tarefas.length, carimbadas: carimbar.length, sent })
  } catch (e) { return json({ error: String(e) }, 500) }
})
