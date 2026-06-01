/* ═══════════════════════════════════════════════
   Axis Inventory — utils.js
   Funções utilitárias globais (sem dependências)
   Carregar ANTES de auth.js em todos os HTMLs.
═══════════════════════════════════════════════ */

/* ─── HTML escape ────────────────────────────────────────── */
var esc = s => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/* ─── Status → classe CSS (definidas em theme.css) ───────── */
var SM = {
  'Estoque Novo':                  's-en',
  'Estoque EUA':                   's-eua',
  'Estoque Usado':                 's-eu',
  'Reservado':                     's-rv',
  'Vendido':                       's-vd',
  'Com Técnico':                   's-ct',
  'Locado':                        's-lc',
  'Em Demonstração':               's-dm',
  'Aguardando Inspeção':           's-ai',
  'Finalizada Inspeção':           's-fi',
  'Em RMA / Assistência Técnica':  's-rm',
  'Sucata':                        's-sc',
}

/* ─── Renderiza badge de status ──────────────────────────── */
/* opts.short = true  →  "Em RMA" no lugar de "Em RMA / Assistência Técnica" */
var sbadge = (s, opts = {}) => {
  const cls = SM[s] || 's-sc'
  let label = s || '—'
  if (opts.short && s === 'Em RMA / Assistência Técnica') label = 'Em RMA'
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(label)}</span>`
}

/* ─── Data absoluta em pt-BR ─────────────────────────────── */
/* opts.withTime = true  →  inclui hora */
/* opts.withYear = false →  omite ano */
var fdt = (iso, opts = {}) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  const dateOpts = {
    day: '2-digit',
    month: 'short',
    year: opts.withYear === false ? undefined : 'numeric',
  }
  const base = d.toLocaleDateString('pt-BR', dateOpts)
  if (opts.withTime) {
    const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    return base + ' ' + hm
  }
  return base
}

/* ─── Data relativa (Hoje / Ontem / Xd atrás / data) ─────── */
var fdata = iso => {
  if (!iso) return '<span class="dim">—</span>'
  const d = new Date(iso)
  if (isNaN(d)) return '<span class="dim">—</span>'
  const now = new Date()
  const df = Math.floor((now - d) / 86400000)
  if (df === 0) return '<span style="color:var(--gr);font-size:12px">Hoje</span>'
  if (df === 1) return '<span style="color:var(--am);font-size:12px">Ontem</span>'
  if (df < 7)  return `<span class="dim">${df}d atrás</span>`
  return `<span class="dim">${d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</span>`
}

/* ─── String formatada ou traço ──────────────────────────── */
var fstr = (v, cls = '') => v
  ? `<span class="${cls}">${esc(v)}</span>`
  : '<span class="dim">—</span>'

/* ─── Valor monetário em R$ ──────────────────────────────── */
var money = v => {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (isNaN(n)) return '—'
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/* ─── Normaliza string (lowercase, sem acento, trim) ─────── */
var normStr = s => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()

/* ─── Debounce genérico ──────────────────────────────────── */
/* uso: const x = debounce(fn, 300); x(...) */
var debounce = (fn, ms = 300) => {
  let t = null
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}
