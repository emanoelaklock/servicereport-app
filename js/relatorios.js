/* ═══════════════════════════════════════════════
   Service Report — relatorios.js
   Lista de RATs (back-office) + filtros + detalhe + Faturar.
   Fotos/assinatura do bucket privado exibidas via signed URLs.
   Dependências: utils.js, supabase-client.js, auth.js (toast).
   Exposto como window.RelatoriosApp.
═══════════════════════════════════════════════ */
(function () {
  let cache = []
  let filtro = 'todas'
  let faturarId = null

  const SYNC_BADGE = {
    confirmado: { cls: 's-en', txt: 'Confirmado' },
    enviando:   { cls: 's-ct', txt: 'Enviando' },
    na_fila:    { cls: 's-ai', txt: 'Na fila' },
    salvo_local:{ cls: 's-rv', txt: 'Local' },
    erro:       { cls: 's-rm', txt: 'Erro' },
    rascunho:   { cls: 's-fi', txt: 'Rascunho' },
  }
  const syncBadge = (s) => {
    const b = SYNC_BADGE[s] || { cls: 's-sc', txt: s || '—' }
    return `<span class="badge ${b.cls}"><span class="dot"></span>${esc(b.txt)}</span>`
  }
  const STATUS_BADGE = {
    'Em andamento': 's-ct', 'Pausa': 's-ai', 'Concluído': 's-en', 'Concluído com Pendências': 's-rm',
  }
  const statusBadge = (s) => s
    ? `<span class="badge ${STATUS_BADGE[s] || 's-sc'}"><span class="dot"></span>${esc(s)}</span>`
    : '<span class="dim">—</span>'

  async function init() {
    const p = new URLSearchParams(location.search).get('filtro')
    if (p === 'faturar' || p === 'pendencia') filtro = p
    document.querySelectorAll('.chip-filtro').forEach(c => { c.onclick = () => { filtro = c.dataset.f; marcarChips(); render() } })
    marcarChips()
    await carregar()
  }

  function marcarChips() {
    document.querySelectorAll('.chip-filtro').forEach(c => c.classList.toggle('on', c.dataset.f === filtro))
  }

  async function carregar() {
    const sb = getSupabase()
    const { data, error } = await sb.from('rats')
      .select('id,cliente_nome,tecnico_nome,data_tarefa,status,sync_status,relatorio_completo,pendencias,faturado,data_faturamento,numero_nota,assinatura_url,respostas,tempo_trabalhado,tipos_servico(nome)')
      .order('data_tarefa', { ascending: false, nullsFirst: false }).limit(500)
    if (error) { toast('Erro ao carregar: ' + error.message, 'err'); cache = [] }
    else cache = data || []
    render()
  }

  function filtrar(rows) {
    if (filtro === 'faturar') return rows.filter(r => !r.faturado && r.relatorio_completo)
    if (filtro === 'pendencia') return rows.filter(r => r.status === 'Concluído com Pendências')
    return rows
  }

  function render() {
    const rows = filtrar(cache)
    const tb = document.getElementById('tbody-rel')
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="8" class="dim" style="text-align:center;padding:24px">Nenhuma RAT para este filtro.</td></tr>'
      return
    }
    tb.innerHTML = rows.map(r => `
      <tr>
        <td>${fdt(r.data_tarefa, { withTime: true })}</td>
        <td>${esc(r.cliente_nome || '—')}</td>
        <td>${esc(r.tipos_servico && r.tipos_servico.nome || '—')}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.relatorio_completo ? '<span class="badge s-en"><span class="dot"></span>Completo</span>' : '<span class="badge s-ai"><span class="dot"></span>Pendente</span>'}</td>
        <td>${syncBadge(r.sync_status)}</td>
        <td>${r.faturado ? `<span class="badge s-en"><span class="dot"></span>${esc(r.numero_nota || 'Faturada')}</span>` : '<span class="dim">—</span>'}</td>
        <td><div class="acts" style="opacity:1">
          <button class="ab ab-v" data-ver="${esc(r.id)}">Ver</button>
          ${!r.faturado ? `<button class="ab ab-m" data-faturar="${esc(r.id)}">Faturar</button>` : ''}
        </div></td>
      </tr>`).join('')
    tb.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => abrirVer(b.dataset.ver))
    tb.querySelectorAll('[data-faturar]').forEach(b => b.onclick = () => abrirFaturar(b.dataset.faturar))
  }

  // ── Detalhe ──
  async function abrirVer(id) {
    const r = cache.find(x => x.id === id); if (!r) return
    const sb = getSupabase()
    const fmtMin = (t) => (t == null) ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
    let html = `<div style="margin-bottom:12px"><b style="font-size:15px">${esc(r.cliente_nome || '—')}</b> · ${esc(r.tipos_servico && r.tipos_servico.nome || '—')}
      <div class="dim" style="margin-top:2px">Técnico: ${esc(r.tecnico_nome || '—')} · ${fdt(r.data_tarefa, { withTime: true })}</div>
      <div class="dim" style="margin-top:2px">Status: ${esc(r.status || '—')} · Tempo trabalhado: ${fmtMin(r.tempo_trabalhado)}</div></div>`

    if (r.respostas && Object.keys(r.respostas).length) {
      html += '<div class="det-grid">' + Object.entries(r.respostas).map(([k, v]) =>
        `<div class="det-item"><div class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em">${esc(k)}</div><div>${esc(String(v))}</div></div>`).join('') + '</div>'
    }

    // produtos utilizados
    const { data: mats } = await sb.from('materiais').select('descricao,codigo_produto,quantidade').eq('rat_id', id).eq('origem', 'usado')
    if (mats && mats.length) {
      html += '<div class="dim" style="margin-top:12px">Produtos utilizados</div><div class="det-prod">' +
        mats.map(m => `<div>${esc(m.descricao || m.codigo_produto || '—')} — <b>${esc(String(m.quantidade))}</b></div>`).join('') + '</div>'
    }

    // fotos (signed URLs) com legenda
    const { data: fotos } = await sb.from('relatorio_fotos').select('url,legenda').eq('rat_id', id)
    const comUrl = (fotos || []).filter(f => f.url)
    if (comUrl.length) {
      const legPorPath = {}; comUrl.forEach(f => { legPorPath[f.url] = f.legenda })
      const { data: signed } = await sb.storage.from('rat-anexos').createSignedUrls(comUrl.map(f => f.url), 3600)
      html += '<div class="dim" style="margin-top:12px">Fotos</div><div class="det-fotos">' +
        (signed || []).map(s => s.signedUrl
          ? `<figure class="det-foto"><a href="${s.signedUrl}" target="_blank"><img src="${s.signedUrl}" alt=""></a>${legPorPath[s.path] ? `<figcaption>${esc(legPorPath[s.path])}</figcaption>` : ''}</figure>`
          : '').join('') + '</div>'
    }
    // assinatura
    if (r.assinatura_url) {
      const { data: sg } = await sb.storage.from('rat-anexos').createSignedUrl(r.assinatura_url, 3600)
      if (sg && sg.signedUrl) html += `<div class="dim" style="margin-top:12px">Assinatura</div><img class="det-sig" src="${sg.signedUrl}" alt="">`
    }
    if (r.faturado) html += `<div style="margin-top:12px" class="dim">Faturada ${fdt(r.data_faturamento)} · Nota ${esc(r.numero_nota || '—')}</div>`

    document.getElementById('ver-body').innerHTML = html
    abrir('modal-ver')
  }

  // ── Faturar ──
  function abrirFaturar(id) { faturarId = id; document.getElementById('f-nota').value = ''; abrir('modal-faturar') }
  async function confirmarFaturar() {
    if (!faturarId) return
    const nota = document.getElementById('f-nota').value.trim()
    const { error } = await getSupabase().from('rats')
      .update({ faturado: true, data_faturamento: new Date().toISOString(), numero_nota: nota || null })
      .eq('id', faturarId)
    if (error) { toast('Erro ao faturar: ' + error.message, 'err'); return }
    toast('RAT marcada como faturada.', 'ok')
    const r = cache.find(x => x.id === faturarId)
    if (r) { r.faturado = true; r.data_faturamento = new Date().toISOString(); r.numero_nota = nota || null }
    faturarId = null
    fechar('modal-faturar')
    render()
  }

  const abrir = (id) => document.getElementById(id).classList.add('open')
  const fechar = (id) => document.getElementById(id).classList.remove('open')

  window.RelatoriosApp = { init, fechar, confirmarFaturar }
})()
