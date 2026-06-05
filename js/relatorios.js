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
  let forms = {}        // id do formulário -> array de campos
  let det = null        // detalhe atualmente aberto { r, campos, mats, fotos, sigUrl }
  let editMode = false

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
    document.getElementById('ver-editar').onclick = entrarEdicao
    document.getElementById('ver-cancelar').onclick = cancelarEdicao
    document.getElementById('ver-salvar').onclick = salvarEdicao
    document.getElementById('ver-pdf').onclick = gerarPdf
    marcarChips()
    await carregar()
  }

  function marcarChips() {
    document.querySelectorAll('.chip-filtro').forEach(c => c.classList.toggle('on', c.dataset.f === filtro))
  }

  async function carregar() {
    const sb = getSupabase()
    const { data, error } = await sb.from('rats')
      .select('id,cliente_nome,tecnico_nome,data_tarefa,status,sync_status,relatorio_completo,pendencias,faturado,data_faturamento,numero_nota,assinatura_url,respostas,tempo_trabalhado,formulario_id,tipos_servico(nome),tarefa:tarefas(numero,tipo:tipos_servico(nome))')
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

  // Tipo de serviço vem da Tarefa (a RAT não registra mais o tipo); fallback p/ RATs antigas.
  const tipoNome = (r) => (r.tarefa && r.tarefa.tipo && r.tarefa.tipo.nome) || (r.tipos_servico && r.tipos_servico.nome) || '—'

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
        <td>${esc(tipoNome(r))}</td>
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
  const fmtMin = (t) => (t == null) ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  const escMulti = (s) => esc(String(s == null ? '' : s)).replace(/\n/g, '<br>')

  async function carregarForms() {
    const { data } = await getSupabase().from('formulario_modelos').select('id,campos')
    forms = {}; (data || []).forEach(f => { forms[f.id] = f.campos || [] })
  }

  // Avalia visibilidade de um campo condicional (mesma lógica do app do técnico).
  function regraOk(rg, resp) {
    const v = String(resp[rg.campo] == null ? '' : resp[rg.campo]).trim()
    switch (rg.op) {
      case 'igual':       return v === (rg.valor == null ? '' : rg.valor)
      case 'diferente':   return v !== (rg.valor == null ? '' : rg.valor)
      case 'contem':      return v.toLowerCase().includes(String(rg.valor || '').toLowerCase())
      case 'preenchido':  return v !== ''
      case 'vazio':       return v === ''
      default:            return true
    }
  }
  function campoVisivel(c, resp) {
    if (!c.cond || !Array.isArray(c.cond.regras) || !c.cond.regras.length) return true
    const oks = c.cond.regras.map(rg => regraOk(rg, resp))
    return c.cond.logica === 'OU' ? oks.some(Boolean) : oks.every(Boolean)
  }

  // Monta o corpo do relatório (modal e PDF compartilham). edit=true torna textos longos editáveis.
  function buildReportBody(d, edit) {
    const { r, campos, mats, fotos, sigUrl } = d
    const resp = r.respostas || {}
    const SKIP = new Set(['foto', 'produtos', 'assinatura'])
    const tarefaNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null

    let h = `<div class="rd">
      <div class="rd-head">
        <div class="rd-cli">${esc(r.cliente_nome || '—')}</div>
        <div class="rd-sub">${esc(tipoNome(r))}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}</div>
        <div class="rd-meta">
          <span><b>Técnico:</b> ${esc(r.tecnico_nome || '—')}</span>
          <span><b>Data:</b> ${fdt(r.data_tarefa, { withTime: true })}</span>
          <span><b>Status:</b> ${esc(r.status || '—')}</span>
          <span><b>Tempo:</b> ${fmtMin(r.tempo_trabalhado)}</span>
        </div>
      </div>`

    if (edit) h += `<div class="rd-edit-hint">✎ Modo edição — ajuste as descrições e clique em <b>Salvar</b>. Os demais dados são do técnico.</div>`

    // campos curtos -> grid ; textos longos -> seção própria (em ordem do formulário)
    const grid = []
    const longSecs = []
    for (const c of campos) {
      if (SKIP.has(c.tipo)) continue
      const editable = c.tipo === 'texto_longo'
      const vis = campoVisivel(c, resp)
      const val = resp[c.id]
      const vazio = val == null || String(val).trim() === ''
      if (!vis && !(editable && edit)) continue
      if (vazio && !(editable && edit)) continue
      if (editable) {
        longSecs.push(`<div class="rd-sec"><div class="rd-sec-t">${esc(c.label)}</div>` +
          (edit
            ? `<textarea class="rd-edit" data-campo="${esc(c.id)}" rows="5">${esc(String(val || ''))}</textarea>`
            : `<div class="rd-long">${escMulti(val) || '—'}</div>`) + `</div>`)
      } else {
        grid.push(`<div class="rd-f"><label>${esc(c.label)}</label><div class="v">${escMulti(val) || '—'}</div></div>`)
      }
    }
    if (grid.length) h += `<div class="rd-sec"><div class="rd-sec-t">Dados do atendimento</div><div class="rd-grid">${grid.join('')}</div></div>`
    h += longSecs.join('')

    if (mats && mats.length) {
      h += `<div class="rd-sec"><div class="rd-sec-t">Produtos utilizados</div><div class="rd-prod">` +
        mats.map(m => `<div>${esc(m.descricao || m.codigo_produto || '—')} — <b>${esc(String(m.quantidade))}</b></div>`).join('') + `</div></div>`
    }
    if (fotos && fotos.length) {
      h += `<div class="rd-sec"><div class="rd-sec-t">Fotos</div><div class="det-fotos">` +
        fotos.map(f => `<figure class="det-foto"><a href="${f.url}" target="_blank"><img src="${f.url}" alt=""></a>${f.legenda ? `<figcaption>${esc(f.legenda)}</figcaption>` : ''}</figure>`).join('') + `</div></div>`
    }
    if (sigUrl) h += `<div class="rd-sec"><div class="rd-sec-t">Assinatura</div><img class="det-sig" src="${sigUrl}" alt=""></div>`
    if (r.faturado) h += `<div class="rd-sec dim" style="font-size:12px">Faturada ${fdt(r.data_faturamento)} · Nota ${esc(r.numero_nota || '—')}</div>`
    h += `</div>`
    return h
  }

  async function abrirVer(id) {
    const r = cache.find(x => x.id === id); if (!r) return
    const sb = getSupabase()
    if (!Object.keys(forms).length) await carregarForms()
    const campos = forms[r.formulario_id] || []

    const { data: mats } = await sb.from('materiais').select('descricao,codigo_produto,quantidade').eq('rat_id', id).eq('origem', 'usado')

    const { data: fotosRaw } = await sb.from('relatorio_fotos').select('url,legenda').eq('rat_id', id)
    const comUrl = (fotosRaw || []).filter(f => f.url)
    let fotos = []
    if (comUrl.length) {
      const legPorPath = {}; comUrl.forEach(f => { legPorPath[f.url] = f.legenda })
      const { data: signed } = await sb.storage.from('rat-anexos').createSignedUrls(comUrl.map(f => f.url), 3600)
      fotos = (signed || []).filter(s => s.signedUrl).map(s => ({ url: s.signedUrl, legenda: legPorPath[s.path] || '' }))
    }

    let sigUrl = null
    if (r.assinatura_url) {
      const { data: sg } = await sb.storage.from('rat-anexos').createSignedUrl(r.assinatura_url, 3600)
      sigUrl = (sg && sg.signedUrl) || null
    }

    det = { r, campos, mats: mats || [], fotos, sigUrl }
    editMode = false
    renderDetalhe()
    abrir('modal-ver')
  }

  function renderDetalhe() {
    document.getElementById('ver-body').innerHTML = buildReportBody(det, editMode)
    document.getElementById('ver-editar').style.display  = editMode ? 'none' : ''
    document.getElementById('ver-salvar').style.display  = editMode ? '' : 'none'
    document.getElementById('ver-cancelar').style.display = editMode ? '' : 'none'
    document.getElementById('ver-pdf').style.display      = editMode ? 'none' : ''
    document.getElementById('ver-excluir').style.display  = editMode ? 'none' : ''
    document.getElementById('ver-excluir').onclick = () => det && excluirRat(det.r.id)
  }

  function entrarEdicao() { editMode = true; renderDetalhe() }
  function cancelarEdicao() { editMode = false; renderDetalhe() }

  async function salvarEdicao() {
    if (!det) return
    const resp = Object.assign({}, det.r.respostas || {})
    document.querySelectorAll('#ver-body .rd-edit').forEach(t => { resp[t.getAttribute('data-campo')] = t.value })
    const { error } = await getSupabase().from('rats').update({ respostas: resp }).eq('id', det.r.id)
    if (error) return toast('Erro ao salvar: ' + error.message, 'err')
    det.r.respostas = resp
    const c = cache.find(x => x.id === det.r.id); if (c) c.respostas = resp
    editMode = false
    renderDetalhe()
    toast('Descrições atualizadas.', 'ok')
  }

  // PDF para envio manual: abre janela com layout de impressão e dispara o print ("Salvar como PDF").
  function gerarPdf() {
    if (!det) return
    const r = det.r
    const tarefaNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null
    const titulo = `RAT ${esc(r.cliente_nome || '')}${tarefaNo ? ' - ' + tarefaNo : ''}`.trim()
    const win = window.open('', '_blank')
    if (!win) { toast('Permita pop-ups para gerar o PDF.', 'err'); return }
    const doc = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title>
<style>${PDF_CSS}</style></head><body>
  <div class="pdf-top">
    <div class="pdf-brand">TRADERS SERVICE</div>
    <div class="pdf-doc">Relatório de Atendimento Técnico</div>
  </div>
  ${buildReportBody(det, false)}
  <div class="pdf-foot">Documento gerado pela plataforma Service Report.</div>
  <script>
    window.addEventListener('load', function () {
      var imgs = Array.prototype.slice.call(document.images)
      Promise.all(imgs.map(function (i) { return i.complete ? 1 : new Promise(function (res) { i.onload = i.onerror = res }) }))
        .then(function () { setTimeout(function () { window.print() }, 150) })
    })
  <\/script>
</body></html>`
    win.document.open(); win.document.write(doc); win.document.close()
  }

  // CSS auto-contido para a janela de impressão (tema claro, A4).
  const PDF_CSS = `
    *{box-sizing:border-box}
    body{font-family:Inter,Arial,sans-serif;color:#1B2A4A;margin:28px 30px;font-size:12.5px}
    .pdf-top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1B2A4A;padding-bottom:10px;margin-bottom:16px}
    .pdf-brand{font-size:20px;font-weight:800;letter-spacing:.04em;color:#1B2A4A}
    .pdf-doc{font-size:12px;color:#5b6b86;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
    .rd-head{margin-bottom:6px}
    .rd-cli{font-size:18px;font-weight:700}
    .rd-sub{font-size:13px;color:#2e6cd6;font-weight:600;margin-top:2px}
    .rd-meta{display:flex;flex-wrap:wrap;gap:3px 18px;margin-top:7px;font-size:12px}
    .rd-meta b{color:#5b6b86;font-weight:500}
    .rd-edit-hint{display:none}
    .rd-sec{margin-top:16px;page-break-inside:avoid}
    .rd-sec-t{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#5b6b86;border-bottom:1px solid #d6deea;padding-bottom:5px;margin-bottom:9px}
    .rd-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .rd-f{background:#f4f7fe;border:1px solid #e2e9f4;border-radius:7px;padding:7px 10px}
    .rd-f label{display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#7a89a3;margin-bottom:2px}
    .rd-f .v{font-size:12.5px}
    .rd-long{white-space:pre-wrap;line-height:1.5}
    .rd-prod{display:flex;flex-direction:column;gap:3px}
    .det-fotos{display:flex;flex-wrap:wrap;gap:12px}
    .det-foto{display:flex;flex-direction:column;gap:4px;width:150px;margin:0}
    .det-fotos img{width:150px;height:150px;object-fit:cover;border-radius:8px;border:1px solid #d6deea}
    .det-foto figcaption{font-size:10px;color:#5b6b86;line-height:1.2}
    .det-sig{max-width:280px;border:1px solid #d6deea;border-radius:8px;background:#fff}
    .pdf-foot{margin-top:26px;border-top:1px solid #d6deea;padding-top:8px;font-size:10px;color:#9aa7bd;text-align:center}
    @media print{ body{margin:14mm 12mm} a{color:inherit;text-decoration:none} }`

  async function excluirRat(id) {
    if (!confirm('Excluir esta RAT? Remove também os materiais e fotos dela. Esta ação não pode ser desfeita.')) return
    const { error } = await getSupabase().rpc('admin_excluir_rat', { p_rat: id })
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    toast('RAT excluída.', 'ok')
    fechar('modal-ver')
    await carregar()
    render()
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
