/* ═══════════════════════════════════════════════
   Service Report — service-worker.js
   Shell offline do app de campo (PWA). Fica na RAIZ para escopo "/".
   Estratégia:
     - estáticos same-origin  → cache-first (atualiza cache em background)
     - CDN (supabase-js,fontes)→ cache-first com fallback de rede
     - API Supabase (*.supabase.co) → SEMPRE rede (nunca cacheia dados/sessão)
   A fila offline de RATs é responsabilidade do IndexedDB (db-local.js, passo 3),
   não do cache do SW.
═══════════════════════════════════════════════ */

const CACHE = 'sr-shell-v392'

const SHELL = [
  'index.html',
  'login.html',
  'painel.html',
  'tecnico.html',
  'configuracoes.html',
  'orcamentos.html',
  'tarefa.html',
  'rat.html',
  'jornada.html',
  'deslocamentos.html',
  'css/theme.css',
  'css/tecnico-skin.css',
  'css/design-system-admin.css',
  'js/utils.js',
  'js/supabase-client.js',
  'js/auth.js',
  'js/sidebar.js',
  'js/db-local.js',
  'js/tecnico.js',
  'js/sync.js',
  'js/push.js',
  'js/painel.js',
  'js/rat-view.js',
  'js/rat-page.js',
  'js/jornada.js',
  'js/deslocamentos.js',
  'js/configuracoes.js',
  'js/orcamentos.js',
  'js/tarefa.js',
  'manifest.webmanifest',
  'assets/icon.svg',
]

// Precache resiliente (um 404 não derruba a instalação inteira).
// NÃO chama skipWaiting aqui: a página mostra "Atualizar" e decide quando trocar.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.all(SHELL.map(async (path) => {
      try { await cache.add(new Request(path, { cache: 'reload' })) }
      catch (e) { console.warn('[SW] precache falhou:', path, e) }
    }))
  })())
})

// A página pede a troca imediata do SW novo (botão "Atualizar").
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// ─────────── Notificações push ───────────
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch (e) { d = { title: 'Service Report', body: event.data && event.data.text() } }
  event.waitUntil(self.registration.showNotification(d.title || 'Service Report', {
    body: d.body || '', data: { url: d.url || '/' }, icon: 'assets/icon.svg', badge: 'assets/icon.svg', vibrate: [80, 40, 80],
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if ('focus' in w) { try { w.navigate && w.navigate(url) } catch (e) {} return w.focus() } }
    return self.clients.openWindow(url)
  }))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // API/Auth do Supabase: sempre rede, nunca cache.
  if (url.hostname.endsWith('supabase.co')) return

  // Same-origin.
  // IMPORTANTE: nunca cachear/servir resposta REDIRECIONADA — o browser recusa
  // usá-la numa navegação (causa ERR_FAILED). Só guarda respostas 'basic' ok.
  if (url.origin === self.location.origin) {
    // App shell (navegação, JS, CSS): NETWORK-FIRST — código sempre fresco quando
    // online; cache só como fallback offline. Acaba com o atraso de "2 reloads".
    const isShell = req.mode === 'navigate' || /\.(?:html|js|css)$/i.test(url.pathname)
    if (isShell) {
      event.respondWith((async () => {
        try {
          const res = await fetch(req)
          if (res && res.ok && !res.redirected && res.type === 'basic') {
            const c = await caches.open(CACHE); c.put(req, res.clone())
          }
          if (res && !res.redirected) return res
        } catch (e) { /* offline */ }
        const cached = await caches.match(req)
        if (cached && !cached.redirected) return cached
        if (req.mode === 'navigate') {
          const fb = await caches.match('tecnico.html')
          return (fb && !fb.redirected) ? fb : Response.error()
        }
        return Response.error()
      })())
      return
    }
    // Demais same-origin (ícones, manifest, imagens): cache-first c/ atualização.
    event.respondWith((async () => {
      const cached = await caches.match(req)
      const fetchAndCache = fetch(req).then(res => {
        if (res && res.ok && !res.redirected && res.type === 'basic') {
          caches.open(CACHE).then(c => c.put(req, res.clone()))
        }
        return res
      }).catch(() => null)
      if (cached && !cached.redirected) { fetchAndCache; return cached }
      const fresh = await fetchAndCache
      return fresh || Response.error()
    })())
    return
  }

  // Cross-origin (CDN do supabase-js, Google Fonts): cache-first.
  event.respondWith((async () => {
    const cached = await caches.match(req)
    if (cached) return cached
    try {
      const res = await fetch(req)
      if (res && (res.ok || res.type === 'opaque')) {
        const c = await caches.open(CACHE); c.put(req, res.clone())
      }
      return res
    } catch (e) {
      return cached || Response.error()
    }
  })())
})
