/* ═══════════════════════════════════════════════
   Service Report — rat-view.js
   Renderização compartilhada do detalhe da RAT (back-office):
   layout de relatório, edição de campos, PDF (1 RAT ou várias unificadas).
   Usado dentro da tela de Tarefas (Conciliação). Depende de: utils.js (esc, fdt),
   supabase-client.js (getSupabase). Exposto como window.RatView.
═══════════════════════════════════════════════ */
window.RatView = (function () {
  let forms = {}   // id do formulário -> array de campos

  // Colunas necessárias para montar o detalhe de uma RAT.
  const RAT_SELECT = 'id,cliente_id,cliente_nome,tecnico_nome,data_tarefa,status,sync_status,pendencias,assinatura_url,respostas,tempo_trabalhado,formulario_id,tipos_servico(nome),tarefa:tarefas(id,numero,cliente_id,tipo_servico_id,tipo:tipos_servico(nome))'

  async function ensureForms() {
    if (Object.keys(forms).length) return
    const { data } = await getSupabase().from('formulario_modelos').select('id,campos')
    forms = {}; (data || []).forEach(f => { forms[f.id] = f.campos || [] })
  }

  const fmtMin = (t) => (t == null) ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  const escMulti = (s) => esc(String(s == null ? '' : s)).replace(/\n/g, '<br>')
  const tipoNomeRat = (r) => (r.tarefa && r.tarefa.tipo && r.tarefa.tipo.nome) || (r.tipos_servico && r.tipos_servico.nome) || '—'

  // ── Tempo trabalhado (mesma regra do app do técnico): janela desloc Sim →
  //    ida→retorno; senão → execução; desconta almoço e pausa. ──
  const minutosDe = (hhmm) => { if (!hhmm) return null; const [h, m] = String(hhmm).split(':').map(Number); return (isNaN(h) || isNaN(m)) ? null : h * 60 + m }
  function calcTempoDe(resp) {
    resp = resp || {}
    const dur = (ini, fim) => { const a = minutosDe(ini), b = minutosDe(fim); return (a == null || b == null) ? 0 : Math.max(0, b - a) }
    let ini, fim
    if (resp.deslocamento === 'Sim') { ini = resp.desloc_inicial_ida; fim = resp.desloc_final_retorno }
    else { ini = resp.hora_inicio; fim = resp.hora_termino }
    const a = minutosDe(ini), b = minutosDe(fim)
    if (a == null || b == null) return null
    const t = (b - a) - dur(resp.almoco_inicio, resp.almoco_termino) - dur(resp.pausa_inicio, resp.pausa_termino)
    return t < 0 ? 0 : t
  }
  const tempoRat = (r) => { const t = calcTempoDe(r.respostas); return t == null ? r.tempo_trabalhado : t }

  // Visibilidade de campo condicional.
  function regraOk(rg, resp) {
    const v = String(resp[rg.campo] == null ? '' : resp[rg.campo]).trim()
    switch (rg.op) {
      case 'igual':      return v === (rg.valor == null ? '' : rg.valor)
      case 'diferente':  return v !== (rg.valor == null ? '' : rg.valor)
      case 'contem':     return v.toLowerCase().includes(String(rg.valor || '').toLowerCase())
      case 'preenchido': return v !== ''
      case 'vazio':      return v === ''
      default:           return true
    }
  }
  function campoVisivel(c, resp) {
    if (!c.cond || !Array.isArray(c.cond.regras) || !c.cond.regras.length) return true
    const oks = c.cond.regras.map(rg => regraOk(rg, resp))
    return c.cond.logica === 'OU' ? oks.some(Boolean) : oks.every(Boolean)
  }

  // Campo editável conforme o tipo (modo edição do admin).
  function editInput(c, val) {
    const v = val == null ? '' : String(val)
    const a = `data-campo="${esc(c.id)}"`
    if (c.tipo === 'selecao') {
      const ops = Array.isArray(c.opcoes) ? c.opcoes : []
      return `<select ${a}><option value=""></option>` + ops.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('') + `</select>`
    }
    if (c.tipo === 'hora')   return `<input type="time" ${a} value="${esc(v)}">`
    if (c.tipo === 'data')   return `<input type="date" ${a} value="${esc(v)}">`
    if (c.tipo === 'numero') return `<input type="number" ${a} value="${esc(v)}">`
    return `<input type="text" ${a} value="${esc(v)}">`
  }

  // Monta o corpo de UMA RAT (modal e PDF compartilham). edit=true torna campos editáveis.
  function buildReportBody(d, edit) {
    const { r, campos, mats, fotos, sigUrl } = d
    const resp = r.respostas || {}
    const SKIP = new Set(['foto', 'produtos', 'assinatura'])
    const tarefaNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null

    let h = `<div class="rd">
      <div class="rd-head">
        <div class="rd-cli">${esc(r.cliente_nome || '—')}</div>
        <div class="rd-sub">${esc(tipoNomeRat(r))}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}</div>
        <div class="rd-meta">
          <span><b>Técnico:</b> ${esc(r.tecnico_nome || '—')}</span>
          <span><b>Data:</b> ${fdt(r.data_tarefa, { withTime: true })}</span>
          <span><b>Status:</b> ${esc(r.status || '—')}</span>
          <span><b>Tempo:</b> ${fmtMin(tempoRat(r))}</span>
        </div>
      </div>`

    if (edit) h += `<div class="rd-edit-hint">✎ Modo edição — você pode ajustar qualquer campo. O tempo trabalhado é recalculado automaticamente ao salvar.</div>`

    const grid = []
    const longSecs = []
    for (const c of campos) {
      if (SKIP.has(c.tipo)) continue
      const isLong = c.tipo === 'texto_longo'
      const val = resp[c.id]
      const vazio = val == null || String(val).trim() === ''
      if (!campoVisivel(c, resp)) continue
      if (!edit && vazio) continue
      if (isLong) {
        longSecs.push(`<div class="rd-sec"><div class="rd-sec-t">${esc(c.label)}</div>` +
          (edit
            ? `<textarea class="rd-edit" data-campo="${esc(c.id)}" rows="5">${esc(String(val || ''))}</textarea>`
            : `<div class="rd-long">${escMulti(val) || '—'}</div>`) + `</div>`)
      } else {
        grid.push(`<div class="rd-f"><label>${esc(c.label)}</label>` +
          (edit ? editInput(c, val) : `<div class="v">${escMulti(val) || '—'}</div>`) + `</div>`)
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
    h += `</div>`
    return h
  }

  // Carrega tudo de uma RAT (form, materiais usados, fotos e assinatura assinadas).
  async function loadDetalhe(r) {
    await ensureForms()
    const sb = getSupabase()
    const campos = forms[r.formulario_id] || []
    const { data: mats } = await sb.from('materiais').select('descricao,codigo_produto,quantidade').eq('rat_id', r.id).eq('origem', 'usado')
    const { data: fotosRaw } = await sb.from('relatorio_fotos').select('url,legenda').eq('rat_id', r.id)
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
    return { r, campos, mats: mats || [], fotos, sigUrl }
  }

  // Coleta as respostas editadas do container e devolve {respostas, tempo}.
  function coletarEdicao(container, det) {
    const resp = Object.assign({}, det.r.respostas || {})
    container.querySelectorAll('[data-campo]').forEach(el => { resp[el.getAttribute('data-campo')] = el.value })
    return { respostas: resp, tempo: calcTempoDe(resp) }
  }

  // PDF: 1 ou várias RATs no mesmo documento (para envio manual ao cliente).
  function gerarPdf(dets, titulo) {
    const win = window.open('', '_blank')
    if (!win) { try { toast('Permita pop-ups para gerar o PDF.', 'err') } catch (e) {} return }
    const corpo = dets.map((d, i) =>
      `<div class="rat-wrap"${i > 0 ? ' style="page-break-before:always"' : ''}>` +
      (dets.length > 1 ? `<div class="rat-sep">Relatório ${i + 1} de ${dets.length}</div>` : '') +
      buildReportBody(d, false) + `</div>`).join('')
    const doc = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo || 'RAT')}</title>
<style>${PDF_CSS}</style></head><body>
  <div class="pdf-top"><div class="pdf-brand">TRADERS SERVICE</div><div class="pdf-doc">Relatório de Atendimento Técnico</div></div>
  ${corpo}
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

  const PDF_CSS = `
    *{box-sizing:border-box}
    body{font-family:Inter,Arial,sans-serif;color:#1B2A4A;margin:28px 30px;font-size:12.5px}
    .pdf-top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1B2A4A;padding-bottom:10px;margin-bottom:16px}
    .pdf-brand{font-size:20px;font-weight:800;letter-spacing:.04em;color:#1B2A4A}
    .pdf-doc{font-size:12px;color:#5b6b86;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
    .rat-sep{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9aa7bd;margin:0 0 8px}
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

  return {
    RAT_SELECT, ensureForms, loadDetalhe, buildReportBody, coletarEdicao,
    gerarPdf, calcTempoDe, tempoRat, fmtMin, tipoNomeRat,
  }
})()
