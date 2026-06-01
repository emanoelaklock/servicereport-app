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

const CACHE = 'sr-shell-v1'

const SHELL = [
  'index.html',
  'login.html',
  'painel.html',
  'relatorios.html',
  'tecnico.html',
  'css/theme.css',
  'js/utils.js',
  'js/supabase-client.js',
  'js/auth.js',
  'js/sidebar.js',
  'manifest.webmanifest',
  'assets/icon.svg',
]

// Precache resiliente (um 404 não derruba a instalação inteira)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.all(SHELL.map(async (path) => {
      try { await cache.add(new Request(path, { cache: 'reload' })) }
      catch (e) { console.warn('[SW] precache falhou:', path, e) }
    }))
    self.skipWaiting()
  })())
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

  // Same-origin: cache-first com atualização em background.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req)
      const fetchAndCache = fetch(req).then(res => {
        if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()))
        return res
      }).catch(() => null)
      if (cached) { fetchAndCache; return cached }
      const fresh = await fetchAndCache
      if (fresh) return fresh
      // Offline e sem cache: cai para o shell do app de campo.
      if (req.mode === 'navigate') return (await caches.match('tecnico.html')) || Response.error()
      return Response.error()
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
