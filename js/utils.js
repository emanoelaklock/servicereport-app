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

/* ─── Cor de texto legível sobre um tint claro do próprio matiz ──────────
   A "cor" de status (marca) pode ser clara (amarelo/laranja) e fica ilegível
   como TEXTO sobre o fundo tintado. Matiz escuro o suficiente → o próprio matiz.
   Matiz claro (amarelo etc.) → ESCURECE o próprio tom até ficar legível (âmbar
   escuro), em vez de cair pra preto — mantém "cor = significado" na pílula e
   evita o texto preto destoante. Contraste AA garantido sobre o fundo tintado. */
var corTextoLegivel = (hex) => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''))
  if (!m) return hex || '#1A1A1A'
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (lum <= 0.6) return '#' + m[1]
  const k = 0.34 / lum   // escurece proporcionalmente até luminância-alvo ~0.34
  const hx = (v) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')
  return '#' + hx(r) + hx(g) + hx(b)
}

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

/* ─── ✨ Melhorar escrita (IA) — somente desktop ─────────────────────────
   Botão reutilizável para textareas: insira window.IA_BTN_HTML logo APÓS a
   <textarea> (ou aponte com data-ia-for="#id"). Clique → edge function
   melhorar-texto (Claude) → prévia Original/Melhorado → Usar ou Manter.
   A delegação global é inofensiva em páginas sem o botão (ex.: app técnico). */
var IA_BTN_HTML = '<button type="button" class="ia-btn-desk" title="Melhorar escrita (IA)" style="margin-top:6px;display:inline-flex;align-items:center;gap:6px;border:1px dashed #C6CCDA;background:#fff;color:#7E37A6;border-radius:9px;padding:6px 11px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M12 3l1.9 4.7 4.7 1.9-4.7 1.9L12 16.2l-1.9-4.7L5.4 9.6l4.7-1.9L12 3Z"/><path d="M19 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z"/></svg>Melhorar escrita</button>'

document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('.ia-btn-desk')
  if (!b || b.disabled) return
  const ta = b.dataset.iaFor ? document.querySelector(b.dataset.iaFor) : b.previousElementSibling
  if (!ta || ta.tagName !== 'TEXTAREA') return
  const texto = (ta.value || '').trim()
  if (!texto) return toast('Escreva o texto primeiro — a IA só ajusta o que foi escrito.', 'err')
  if (!navigator.onLine) return toast('Melhorar escrita precisa de internet.', 'err')
  b.disabled = true
  b.style.opacity = '.5'
  try {
    const { data, error } = await getSupabase().functions.invoke('melhorar-texto', { body: { texto } })
    if (error) throw new Error(error.message || 'falha na chamada')
    if (data && data.error) throw new Error(data.error)
    const novo = ((data && data.texto) || '').trim()
    if (!novo) throw new Error('a IA não retornou texto')
    _iaPrevia(texto, novo, (ok) => {
      if (ok) {
        ta.value = novo
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
  } catch (err) {
    toast('Não consegui melhorar agora: ' + (err.message || err), 'err')
  } finally {
    b.disabled = false
    b.style.opacity = ''
  }
})

function _iaPrevia(antes, depois, cb) {
  const old = document.getElementById('ia-previa-ovl'); if (old) old.remove()
  const ovl = document.createElement('div')
  ovl.id = 'ia-previa-ovl'
  ovl.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,55,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px'
  const box = (lab, txt, bg) => `<div style="font-size:11px;font-weight:700;color:#7C8290;margin:12px 0 4px">${lab}</div><div style="border:1px solid #EAEDF2;border-radius:10px;padding:10px 12px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;background:${bg};max-height:30vh;overflow:auto">${esc(txt)}</div>`
  ovl.innerHTML = `<div style="background:#fff;border-radius:14px;width:100%;max-width:560px;max-height:85vh;overflow:auto;box-shadow:0 24px 64px rgba(20,30,55,.3);padding:18px 20px;font-family:inherit;color:#1B1E26">
    <div style="font-size:15px;font-weight:700">Texto melhorado</div>
    ${box('Original', antes, '#F4F5F8')}
    ${box('Melhorado', depois, '#F3EDF8')}
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
      <button type="button" id="ia-pv-manter" style="border:1px solid #EAEDF2;background:#fff;border-radius:10px;padding:9px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer">Manter original</button>
      <button type="button" id="ia-pv-usar" style="border:none;background:#1B7FC4;color:#fff;border-radius:10px;padding:9px 16px;font:inherit;font-size:13px;font-weight:700;cursor:pointer">Usar texto melhorado</button>
    </div>
  </div>`
  document.body.appendChild(ovl)
  const fechar = (ok) => { ovl.remove(); cb(ok) }
  ovl.querySelector('#ia-pv-usar').onclick = () => fechar(true)
  ovl.querySelector('#ia-pv-manter').onclick = () => fechar(false)
  ovl.onclick = (ev) => { if (ev.target === ovl) fechar(false) }
}
