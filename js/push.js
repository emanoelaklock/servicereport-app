/* ═══════════════════════════════════════════════
   Service Report — push.js
   Inscrição em Web Push + disparo via Edge Function notify-push.
   Depende de supabase-client.js (getSupabase, SURL, AKEY).
   Exposto: window.ativarPush(), window.notificarPush(tipo, dados).
═══════════════════════════════════════════════ */
(function () {
  const VAPID_PUBLIC = 'BEpQzsljTyRV6m7HrNVCEwoHdRG0Iw_CL_gZnNGUnwWXiBDtNA_NABMjD6zTDHaGjSF7Y5rERT7stMqZgVgpqp0'

  function b64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4)
    const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(base); const arr = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
    return arr
  }

  // Registra o SW (se preciso), pede permissão e salva a inscrição. Idempotente.
  async function ativarPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
    try {
      const reg = await navigator.serviceWorker.register('service-worker.js')
      if (Notification.permission === 'denied') return
      if (Notification.permission === 'default') {
        const p = await Notification.requestPermission()
        if (p !== 'granted') return
      }
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID_PUBLIC) }))
      const j = sub.toJSON()
      const sb = getSupabase()
      const { data: { user } } = await sb.auth.getUser()
      if (!user) return
      await sb.from('push_subscriptions').upsert(
        { user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent },
        { onConflict: 'endpoint' }
      )
    } catch (e) { console.warn('[push] ativar', e) }
  }

  // Dispara uma notificação (a Edge Function decide os destinatários pelo tipo).
  async function notificarPush(tipo, dados) {
    try {
      const sb = getSupabase()
      const { data: { session } } = await sb.auth.getSession()
      if (!session) return
      await fetch(`${SURL}/functions/v1/notify-push`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + session.access_token, 'Content-Type': 'application/json', apikey: AKEY },
        body: JSON.stringify(Object.assign({ tipo }, dados || {})),
      })
    } catch (e) { console.warn('[push] notificar', e) }
  }

  window.ativarPush = ativarPush
  window.notificarPush = notificarPush
})()
