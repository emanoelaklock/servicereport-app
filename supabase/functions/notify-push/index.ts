// Edge Function: notify-push — envia Web Push.
// Destinatários definidos pelo "tipo": tarefa_atribuida (técnicos) | rat_registrada (admin/gestor)
// | rat_improdutiva (admin/gestor, reagendar) | tarefa_pendencia (admin/gestor, reagendar).
// 'rat_concluida' mantido por retrocompat (clientes antigos).
// VAPID lido de public.app_secrets (service role). Implantar via MCP/CLI.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: ures } = await admin.auth.getUser(jwt)
    if (!ures?.user) return json({ error: 'unauthorized' }, 401)

    const body = await req.json().catch(() => ({}))
    const tipo = body.tipo
    let targets: string[] = []
    let titulo = 'Service Report', msg = '', url = '/'

    if (tipo === 'tarefa_atribuida') {
      targets = (body.tecnicos || []).filter(Boolean)
      titulo = 'Nova tarefa atribuída'
      msg = body.texto || ('Tarefa Nº ' + (body.numero || '') + ' — ' + (body.cliente || '')).trim()
      url = 'tecnico.html'
    } else if (tipo === 'tarefa_reagendada') {
      // Mesma tarefa, nova data, técnico que já estava atribuído. Destinatários vêm do portal.
      targets = (body.tecnicos || []).filter(Boolean)
      titulo = 'Tarefa reagendada'
      msg = body.texto || ('Tarefa Nº ' + (body.numero || '') + ' — ' + (body.cliente || '')).trim()
      url = 'tecnico.html'
    } else if (tipo === 'rat_registrada' || tipo === 'rat_concluida') {
      // rat_registrada = RAT do dia encerrada (registrada). 'rat_concluida' segue aceito por
      // retrocompat com clientes em cache antigo, mas encerrar a RAT não conclui o serviço.
      const { data: admins } = await admin.from('usuarios').select('id').in('role', ['admin', 'gestor_axis']).eq('ativo', true)
      targets = (admins || []).map((a: any) => a.id)
      titulo = 'Atendimento realizado'
      msg = body.texto || ('Tarefa Nº ' + (body.numero || '') + ' — ' + (body.cliente || '')).trim()
      url = 'tarefa.html' + (body.tarefa_id ? ('?t=' + body.tarefa_id) : '')
    } else if (tipo === 'rat_improdutiva') {
      // Visita improdutiva: avisa admin/gestor pra reagendar (§ "RAT improdutiva").
      const { data: admins } = await admin.from('usuarios').select('id').in('role', ['admin', 'gestor_axis']).eq('ativo', true)
      targets = (admins || []).map((a: any) => a.id)
      titulo = 'Visita improdutiva — reagendar'
      msg = body.texto || ([('Tarefa Nº ' + (body.numero || '')).trim(), body.cliente, body.motivo].filter(Boolean).join(' — '))
      url = 'tarefa.html' + (body.tarefa_id ? ('?t=' + body.tarefa_id) : '')
    } else if (tipo === 'tarefa_pendencia') {
      // Tarefa concluída com pendência: o retorno é gerado no portal, então este é o gatilho p/ reagendar.
      const { data: admins } = await admin.from('usuarios').select('id').in('role', ['admin', 'gestor_axis']).eq('ativo', true)
      targets = (admins || []).map((a: any) => a.id)
      titulo = 'Concluída com pendência — reagendar'
      msg = body.texto || ([('Tarefa Nº ' + (body.numero || '')).trim(), body.cliente, body.pendencia].filter(Boolean).join(' — '))
      url = 'tarefa.html' + (body.tarefa_id ? ('?t=' + body.tarefa_id) : '')
    } else {
      return json({ error: 'tipo invalido' }, 400)
    }

    targets = [...new Set(targets)].filter((t) => t && t !== ures.user.id)
    if (!targets.length) return json({ sent: 0 })

    // P1a: env-first (Function Secrets) com fallback TEMPORÁRIO à tabela app_secrets (removido no 3º PR)
    let pub = Deno.env.get('VAPID_PUBLIC'), prv = Deno.env.get('VAPID_PRIVATE')
    if (!pub || !prv) {
      const { data: secrets } = await admin.from('app_secrets').select('chave,valor').in('chave', ['vapid_public', 'vapid_private'])
      pub = pub || secrets?.find((s: any) => s.chave === 'vapid_public')?.valor
      prv = prv || secrets?.find((s: any) => s.chave === 'vapid_private')?.valor
    }
    if (!pub || !prv) return json({ error: 'vapid ausente' }, 500)
    webpush.setVapidDetails('mailto:contato@tsrv.com.br', pub, prv)

    const { data: subs } = await admin.from('push_subscriptions').select('*').in('user_id', targets)
    const payload = JSON.stringify({ title: titulo, body: msg, url })
    let sent = 0
    for (const s of (subs || [])) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++ }
      catch (e: any) { const c = e?.statusCode; if (c === 404 || c === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint) }
    }
    return json({ sent })
  } catch (e) { return json({ error: String(e) }, 500) }
})
