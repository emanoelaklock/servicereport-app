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

/* ─── Ícone SVG por tipo de arquivo (PDF/Word/Excel/…) — linha, rótulo colorido ─── */
function fileIcon(nome, px) {
  px = px || 44
  var ext = String(nome || '').split('.').pop().toLowerCase()
  var MAP = {
    pdf: ['PDF', '#E5403A'],
    doc: ['DOC', '#1E8AE0'], docx: ['DOC', '#1E8AE0'], rtf: ['DOC', '#1E8AE0'], odt: ['DOC', '#1E8AE0'],
    xls: ['XLS', '#179A47'], xlsx: ['XLS', '#179A47'], ods: ['XLS', '#179A47'], csv: ['CSV', '#179A47'],
    ppt: ['PPT', '#F4861F'], pptx: ['PPT', '#F4861F'],
    zip: ['ZIP', '#8E45B5'], rar: ['ZIP', '#8E45B5'], '7z': ['ZIP', '#8E45B5'],
    dwg: ['DWG', '#1E8AE0'], dxf: ['DXF', '#1E8AE0'], txt: ['TXT', '#5b6270']
  }
  var m = MAP[ext] || ['', '#5b6270'], label = m[0], cor = m[1]
  return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="none">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="#fff" stroke="' + cor + '" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M14 3v5h5" fill="#fff" stroke="' + cor + '" stroke-width="1.5" stroke-linejoin="round"/>' +
    (label ? '<text x="11.5" y="17" text-anchor="middle" font-family="Manrope,sans-serif" font-size="5.2" font-weight="800" fill="' + cor + '">' + label + '</text>' : '') +
    '</svg>'
}

/* ─── Lightbox fullscreen (galeria: prev/próximo, teclado, swipe) — reusável ───
   Uso: window.openLightbox([{url,legenda?}], startIdx). Ou marcação: qualquer elemento
   [data-lb="url"] (opcional data-lb-cap="legenda") vira gatilho; agrupa pela galeria mais
   próxima (.det-fotos, .cc-anexos ou [data-lb-scope]). Injeta o próprio CSS/DOM na 1ª vez. */
;(function () {
  var items = [], idx = 0, box, imgEl, capEl, cntEl, stripEl, sx = null
  var scale = 1, tx = 0, ty = 0, drag = null
  function applyT() { imgEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')' }
  function resetZoom() { scale = 1; tx = 0; ty = 0; if (imgEl) { imgEl.classList.remove('zoomed', 'grabbing'); applyT() } }
  function ensure() {
    if (box) return
    var st = document.createElement('style')
    st.textContent = '.lb-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,14,24,.93);display:none;align-items:center;justify-content:center}'
      + '.lb-ov.on{display:flex}'
      + '.lb-img{max-width:92vw;max-height:80vh;object-fit:contain;border-radius:6px;box-shadow:0 12px 44px rgba(0,0,0,.5);user-select:none;-webkit-user-drag:none;transform-origin:center center;transition:transform .12s ease;will-change:transform;cursor:zoom-in}'
      + '.lb-img.zoomed{cursor:grab;transition:none}.lb-img.grabbing{cursor:grabbing}'
      + '.lb-btn{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;border:none;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:30px;line-height:1;cursor:pointer;display:grid;place-items:center}'
      + '.lb-btn:hover{background:rgba(255,255,255,.26)}.lb-prev{left:18px}.lb-next{right:18px}'
      + '.lb-x{position:absolute;top:16px;right:18px;width:44px;height:44px;border:none;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:24px;line-height:1;cursor:pointer}'
      + '.lb-x:hover{background:rgba(255,255,255,.26)}'
      + '.lb-cnt{position:absolute;top:22px;left:50%;transform:translateX(-50%);color:#fff;font:600 13px/1 Manrope,system-ui,sans-serif;background:rgba(0,0,0,.4);padding:6px 12px;border-radius:20px}'
      + '.lb-cap{position:absolute;bottom:96px;left:50%;transform:translateX(-50%);max-width:90vw;color:#fff;font:500 13px/1.4 Manrope,system-ui,sans-serif;background:rgba(0,0,0,.5);padding:8px 14px;border-radius:8px;text-align:center;z-index:2}'
      + '.lb-strip{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);max-width:94vw;display:flex;gap:8px;padding:8px;overflow-x:auto;background:rgba(0,0,0,.35);border-radius:12px;z-index:2}'
      + '.lb-strip.hide{display:none}'
      + '.lb-thumb{width:54px;height:54px;flex:none;object-fit:cover;border-radius:6px;cursor:pointer;opacity:.55;border:2px solid transparent}'
      + '.lb-thumb.on{opacity:1;border-color:#fff}'
      + '@media(max-width:640px){.lb-btn{width:44px;height:44px;font-size:26px}.lb-prev{left:6px}.lb-next{right:6px}.lb-thumb{width:46px;height:46px}}'
    document.head.appendChild(st)
    box = document.createElement('div'); box.className = 'lb-ov'
    box.innerHTML = '<button class="lb-x" aria-label="Fechar">×</button>'
      + '<button class="lb-btn lb-prev" aria-label="Anterior">‹</button>'
      + '<img class="lb-img" alt="">'
      + '<button class="lb-btn lb-next" aria-label="Próxima">›</button>'
      + '<div class="lb-cnt"></div><div class="lb-cap"></div><div class="lb-strip"></div>'
    document.body.appendChild(box)
    imgEl = box.querySelector('.lb-img'); cntEl = box.querySelector('.lb-cnt'); capEl = box.querySelector('.lb-cap'); stripEl = box.querySelector('.lb-strip')
    box.querySelector('.lb-x').onclick = close
    box.querySelector('.lb-prev').onclick = function (e) { e.stopPropagation(); nav(-1) }
    box.querySelector('.lb-next').onclick = function (e) { e.stopPropagation(); nav(1) }
    imgEl.onclick = function (e) { e.stopPropagation() }
    box.onclick = function (e) { if (e.target === box) close() }
    // zoom com scroll (desktop); sobre a tira, deixa rolar a tira
    box.addEventListener('wheel', function (e) {
      if (stripEl && stripEl.contains(e.target)) return
      e.preventDefault()
      scale = Math.min(6, Math.max(1, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)))
      if (scale === 1) { tx = 0; ty = 0; imgEl.classList.remove('zoomed') } else imgEl.classList.add('zoomed')
      applyT()
    }, { passive: false })
    // arrastar p/ deslocar quando ampliado
    imgEl.addEventListener('mousedown', function (e) { if (scale <= 1) return; e.preventDefault(); drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty }; imgEl.classList.add('grabbing') })
    window.addEventListener('mousemove', function (e) { if (!drag) return; tx = drag.tx + (e.clientX - drag.x); ty = drag.ty + (e.clientY - drag.y); applyT() })
    window.addEventListener('mouseup', function () { if (drag) { drag = null; imgEl.classList.remove('grabbing') } })
    box.addEventListener('touchstart', function (e) { sx = e.touches.length === 1 ? e.touches[0].clientX : null }, { passive: true })
    box.addEventListener('touchend', function (e) { if (sx == null || scale > 1) { sx = null; return } var dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 45) nav(dx < 0 ? 1 : -1); sx = null })
  }
  function buildStrip() {
    var multi = items.length > 1
    stripEl.classList.toggle('hide', !multi)
    if (!multi) { stripEl.innerHTML = ''; return }
    stripEl.innerHTML = items.map(function (it, i) { return '<img class="lb-thumb" data-i="' + i + '" src="' + it.url + '" alt="">' }).join('')
    stripEl.querySelectorAll('.lb-thumb').forEach(function (t) { t.onclick = function (e) { e.stopPropagation(); idx = +t.getAttribute('data-i'); render() } })
  }
  function render() {
    var it = items[idx]; if (!it) return
    resetZoom()
    imgEl.src = it.url
    cntEl.textContent = (idx + 1) + ' / ' + items.length; cntEl.style.display = items.length > 1 ? '' : 'none'
    capEl.textContent = it.legenda || ''; capEl.style.display = it.legenda ? '' : 'none'
    var multi = items.length > 1
    box.querySelector('.lb-prev').style.display = multi ? '' : 'none'
    box.querySelector('.lb-next').style.display = multi ? '' : 'none'
    if (stripEl) {
      stripEl.querySelectorAll('.lb-thumb').forEach(function (t, i) { t.classList.toggle('on', i === idx) })
      var act = stripEl.querySelector('.lb-thumb.on'); if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest' })
    }
  }
  function nav(d) { if (items.length) { idx = (idx + d + items.length) % items.length; render() } }
  function close() { if (box) box.classList.remove('on'); document.removeEventListener('keydown', onKey) }
  function onKey(e) { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') nav(-1); else if (e.key === 'ArrowRight') nav(1) }
  window.openLightbox = function (list, start) {
    if (!list || !list.length) return
    ensure(); items = list; idx = Math.max(0, Math.min(start || 0, list.length - 1))
    buildStrip(); render(); box.classList.add('on'); document.addEventListener('keydown', onKey)
  }
  document.addEventListener('click', function (e) {
    var trg = e.target.closest && e.target.closest('[data-lb]'); if (!trg) return
    e.preventDefault(); e.stopPropagation()
    var scope = trg.closest('[data-lb-scope], .det-fotos, .cc-anexos') || document
    var els = Array.prototype.slice.call(scope.querySelectorAll('[data-lb]'))
    var list = els.map(function (el) { return { url: el.getAttribute('data-lb'), legenda: el.getAttribute('data-lb-cap') || '' } })
    var i = els.indexOf(trg)
    window.openLightbox(list, i < 0 ? 0 : i)
  })
})()

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
// PORTAL: sempre no fuso do escritório (America/Sao_Paulo), independente da máquina do admin.
// Data-só ('AAAA-MM-DD') é construída como data local (sem fuso) p/ não escorregar 1 dia;
// timestamptz é convertido pro fuso fixo. (utils.js é só do portal — o app usa o fuso do aparelho.)
var TZ_BR = 'America/Sao_Paulo'
var fdt = (iso, opts = {}) => {
  if (!iso) return '—'
  const md = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/)   // data-só, sem hora
  const d = md ? new Date(+md[1], +md[2] - 1, +md[3]) : new Date(iso)
  if (isNaN(d)) return '—'
  const dateOpts = {
    day: '2-digit',
    month: opts.numeric ? '2-digit' : 'short',
    year: opts.withYear === false ? undefined : 'numeric',
  }
  if (!md) dateOpts.timeZone = TZ_BR
  const base = d.toLocaleDateString('pt-BR', dateOpts)
  if (opts.withTime) {
    const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ_BR })
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
  return `<span class="dim">${d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: TZ_BR })}</span>`
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
