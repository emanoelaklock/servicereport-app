/* ═══════════════════════════════════════════════
   Service Report — pdf-tarefa.js
   PDF VETORIAL da Tarefa (capa + RATs) via pdfmake local (js/vendor/, offline).
   Texto real (selecionável/pesquisável), tabelas e linhas vetoriais, fonte Roboto
   embutida (subset). Fotos/assinatura são as ÚNICAS imagens — reduzidas e
   comprimidas em canvas (1600px, JPEG q0.85). O canvas é usado SÓ para isso;
   o relatório nunca é rasterizado.
   Layout aprovado na PoC (Tarefa 04826): header em faixa navy, seções com barra
   azul, tabelas zebradas, badges, grade de fotos adaptável (1/2/3 col, 2×2 p/ 4),
   "Fotos — continuação" nas páginas seguintes, "RAT — dados do atendimento"
   indivisível. Exposto como window.PdfTarefa. Depende de: rat-view.js (RatView).
═══════════════════════════════════════════════ */
window.PdfTarefa = (function () {
  'use strict'

  // ── paleta (design system SR) ──
  const AZ = '#243456', BLUE = '#1E8AE0', GREEN = '#179A47'
  const INK = '#2b3447', GRAY = '#5C6470', MUTED = '#76839B'
  const LINE = '#E3E8F0', BG = '#F4F7FB', ZEBRA = '#FAFBFD'
  const PAGE_W = 595.28, PAGE_H = 841.89, MARG = 36, TOPM = 76, BOTM = 44
  const CW = PAGE_W - MARG * 2, BOTTOM = PAGE_H - BOTM
  // JPEG 1×1 usado nos passes de medição de layout (mesmas dimensões declaradas → mesmo layout)
  const PIX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

  // ── carga preguiçosa do pdfmake local (fica no cache do SW → funciona offline) ──
  let carga = null
  function carregarPdfMake() {
    if (window.pdfMake && window.pdfMake.createPdf && window.pdfMake.vfs) return Promise.resolve()
    if (carga) return carga
    const um = (src) => new Promise((res, rej) => {
      const s = document.createElement('script')
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src))
      document.head.appendChild(s)
    })
    carga = um('js/vendor/pdfmake.min.js').then(() => um('js/vendor/vfs_fonts.js'))
    return carga
  }

  // ── imagens: reduz/comprime em canvas (ÚNICO uso de canvas; nunca rasteriza o relatório) ──
  // cover=true corta para 4:3 (grade uniforme de fotos, como o object-fit:cover da tela);
  // cover=false mantém proporção (assinatura). Sempre devolve dataURL (pdfmake exige) ou null.
  function carregarImg(url) {
    return new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
  }
  async function imgParaPdf(url, maxPx, cover) {
    let img = await carregarImg(url)
    if (!img) {
      // fallback: baixa o binário e tenta de novo via blob (evita bloqueio de decode direto)
      try {
        const r = await fetch(url); if (!r.ok) return null
        const blobUrl = URL.createObjectURL(await r.blob())
        img = await carregarImg(blobUrl)
        URL.revokeObjectURL(blobUrl)
      } catch (e) { return null }
      if (!img) return null
    }
    try {
      const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height
      if (!w0 || !h0) return null
      const c = document.createElement('canvas')
      if (cover) {
        // corta o centro para 4:3 e reduz — todas as fotos com a mesma proporção
        const alvoW = Math.min(maxPx, w0), alvoH = Math.round(alvoW * 0.75)
        c.width = alvoW; c.height = alvoH
        const propAlvo = 4 / 3, prop = w0 / h0
        let sw = w0, sh = h0, sx = 0, sy = 0
        if (prop > propAlvo) { sw = Math.round(h0 * propAlvo); sx = Math.round((w0 - sw) / 2) }
        else { sh = Math.round(w0 / propAlvo); sy = Math.round((h0 - sh) / 2) }
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, alvoW, alvoH)
      } else {
        const escala = Math.min(1, maxPx / Math.max(w0, h0))
        c.width = Math.max(1, Math.round(w0 * escala)); c.height = Math.max(1, Math.round(h0 * escala))
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      }
      const dataUrl = c.toDataURL('image/jpeg', 0.85)
      c.width = c.height = 1   // libera a memória do canvas já
      return dataUrl
    } catch (e) { return null }  // canvas "tainted" (sem CORS) → foto fica de fora
  }

  // ── nós de layout (aprovados na PoC) ──
  const luminancia = (hex) => { const n = parseInt(String(hex || '').replace('#', ''), 16) || 0; return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 }
  function sec(t) {
    return [
      { columns: [
        { width: 3, canvas: [{ type: 'rect', x: 0, y: 0.5, w: 3, h: 10, color: BLUE }] },
        { width: '*', text: String(t).toUpperCase(), bold: true, fontSize: 8.5, color: AZ, characterSpacing: 0.7, margin: [7, 0, 0, 0] },
      ], margin: [0, 16, 0, 4] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW, y2: 0, lineWidth: 0.6, lineColor: LINE }], margin: [0, 0, 0, 8] },
    ]
  }
  const pill = (txt, cor) => ({
    table: { body: [[{ text: String(txt).toUpperCase(), color: luminancia(cor) > 0.6 ? AZ : '#ffffff', bold: true, fontSize: 7, characterSpacing: 0.5 }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 3, paddingBottom: () => 3, fillColor: () => cor },
    width: 'auto',
  })
  const field = (label, value) => ({ width: '*',
    stack: [{ text: String(label).toUpperCase(), fontSize: 6.8, color: GRAY, characterSpacing: 0.4, margin: [0, 0, 0, 2] },
            { text: (value == null || value === '') ? '—' : String(value), fontSize: 9.5, color: INK, lineHeight: 1.15 }],
    margin: [0, 0, 0, 8] })
  function grid(items) {
    const rows = [], buf = []
    for (const it of items) {
      if (it.full) { if (buf.length) { rows.push({ columns: buf.slice(), columnGap: 16 }); buf.length = 0 } rows.push({ columns: [field(it[0], it[1])] }); continue }
      buf.push(field(it[0], it[1]))
      if (buf.length === 2) { rows.push({ columns: buf.slice(), columnGap: 16 }); buf.length = 0 }
    }
    if (buf.length) { if (buf.length === 1) buf.push({ text: '', width: '*' }); rows.push({ columns: buf.slice(), columnGap: 16 }) }
    return rows
  }
  function statCards(items) {
    return { columns: items.map(([label, value]) => ({
      table: { widths: ['*'], body: [[{ stack: [
        { text: String(label).toUpperCase(), fontSize: 6.8, color: GRAY, characterSpacing: 0.4 },
        { text: String(value), fontSize: 13, bold: true, color: AZ, margin: [0, 3, 0, 0] },
      ] }]] },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8, fillColor: () => BG },
    })), columnGap: 10, margin: [0, 2, 0, 2] }
  }
  function tabela(headers, rows, widths) {
    const body = [
      headers.map(h => ({ text: String(h.t).toUpperCase(), alignment: h.a || 'left', bold: true, fontSize: 7.2, color: GRAY, characterSpacing: 0.4, fillColor: BG })),
      ...rows.map((r, i) => r.map(c => (i % 2 === 1 && !c.fillColor) ? Object.assign({}, c, { fillColor: ZEBRA }) : c)),
    ]
    return { table: { headerRows: 1, widths, body },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length) ? 0.8 : 0.5,
        hLineColor: (i, node) => (i === 0 || i === 1 || i === node.table.body.length) ? '#D3DBE8' : LINE,
        vLineWidth: () => 0,
        paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 5, paddingBottom: () => 5,
      },
      margin: [0, 2, 0, 0] }
  }
  function textBox(txt) {
    return { table: { widths: ['*'], body: [[{ text: String(txt == null ? '' : txt), fontSize: 9, lineHeight: 1.35, color: INK }]] },
      layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => LINE, vLineColor: () => LINE,
        paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8, fillColor: () => ZEBRA },
      margin: [0, 2, 0, 0] }
  }
  const cel = (txt, extra) => Object.assign({ text: (txt == null || txt === '') ? '—' : String(txt), fontSize: 8.5 }, extra || {})
  const celNum = (txt) => cel(txt, { alignment: 'right' })

  // ── grade de fotos adaptável: 1→1col, 2→2, 3→3, 4→2×2, 5+→3 colunas ──
  function fotoLayout(n) {
    const perRow = n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : n === 4 ? 2 : 3
    let W = Math.floor((CW - (perRow - 1) * 10) / perRow) - 10
    if (perRow === 1) W = Math.min(W, 340)
    return { perRow, W }
  }
  // linhas da grade (indivisíveis). ids p/ medição de página: f{sec}_{row}
  function fotoRows(fotos, secIdx) {
    const { perRow, W } = fotoLayout(fotos.length)
    const rows = []
    for (let i = 0; i < fotos.length; i += perRow) {
      rows.push({ columns: fotos.slice(i, i + perRow).map(f => ({ width: W + 8, stack: [
        { table: { widths: [W], body: [[{ image: f.dataUrl, width: W, height: Math.round(W * 0.75) }]] },
          layout: { hLineWidth: () => 0.7, vLineWidth: () => 0.7, hLineColor: () => LINE, vLineColor: () => LINE,
            paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 3, paddingBottom: () => 3 } },
        { text: f.legenda || '', fontSize: 7.5, color: GRAY, margin: [1, 3, 0, 0] },
      ] })), columnGap: 10, margin: [0, 0, 0, 12] })
    }
    return rows
  }
  // seção "titulo" + linhas; contSet = índices de linha que abrem página nova (ganham "— continuação")
  function fotosSection(titulo, fotos, secIdx, contSet) {
    const rows = fotoRows(fotos, secIdx), nodes = []
    rows.forEach((row, i) => {
      const id = 'f' + secIdx + '_' + i
      if (i === 0) nodes.push({ stack: [...sec(titulo), row], unbreakable: true, id })
      else if (contSet && contSet.has(id)) nodes.push({ stack: [...sec(titulo + ' — continuação'), row], unbreakable: true, id })
      else nodes.push({ stack: [row], unbreakable: true, id })
    })
    return nodes
  }

  // ── capa (dossiê da tarefa) — dados já resolvidos por tarefa.js ──
  function capa(m) {
    const c = []
    c.push({ columns: [
      { width: '*', stack: [
        { text: m.capa.clienteNome || '—', bold: true, fontSize: 16, color: AZ },
        { text: `Tarefa Nº ${m.numeroFmt}${m.capa.dataAgendada ? '  ·  Agendada para ' + m.capa.dataAgendada : ''}`, color: BLUE, fontSize: 9.5, bold: true, margin: [0, 3, 0, 0] },
      ] },
      Object.assign(pill(m.capa.statusLabel || '—', m.capa.statusCor || AZ), { margin: [0, 4, 0, 0] }),
    ], margin: [0, 2, 0, 2] })

    c.push(...sec('Dados da Tarefa'))
    c.push(...grid(m.capa.campos))

    c.push(...sec('Resumo operacional'))
    c.push(statCards(m.capa.resumo))

    if (m.capa.ratsResumo.length) {
      c.push(...sec('RATs (resumo)'))
      c.push(tabela([{ t: 'RAT' }, { t: 'Data' }, { t: 'Técnico' }, { t: 'Situação' }, { t: 'Tempo', a: 'right' }],
        m.capa.ratsResumo.map(r => [cel(r.ratNo, { bold: true, color: AZ }), cel(r.data), cel(r.tecnico),
          cel(r.situacao, { color: r.ok ? GREEN : INK, bold: !!r.ok }), celNum(r.tempo)]),
        ['auto', 'auto', '*', 'auto', 'auto']))
    }
    if (m.flags.conciliacao && m.capa.conciliacao.length) {
      c.push(...sec('Produtos (conciliação)'))
      c.push(tabela([{ t: 'Produto' }, { t: 'Orçada', a: 'right' }, { t: 'Disponibilizada', a: 'right' }, { t: 'Utilizada', a: 'right' }, { t: 'Devolvida', a: 'right' }],
        m.capa.conciliacao.map(l => [cel(l.descricao), celNum(l.orcada), celNum(l.levada), celNum(l.utilizada), celNum(l.devolvida)]),
        ['*', 'auto', 'auto', 'auto', 'auto']))
    }
    if (m.capa.equipamentos.length) {
      c.push(...sec('Equipamentos'))
      c.push(tabela([{ t: 'Tipo' }, { t: 'Modelo' }, { t: 'Part number' }, { t: 'Serial' }],
        m.capa.equipamentos.map(e => [cel(e.tipo), cel(e.modelo), cel(e.part), cel(e.serial)]),
        ['auto', '*', 'auto', 'auto']))
    }
    return c
  }
  // Anexos da capa: imagens em grade (mesma lógica das fotos, seção 0) + nomes de não-imagens
  function anexosSection(m, contSet) {
    const c = []
    if (m.capa.anexosImgs.length) c.push(...fotosSection('Anexos', m.capa.anexosImgs, 0, contSet))
    if (m.capa.anexosNomes.length) {
      if (!m.capa.anexosImgs.length) c.push(...sec('Anexos'))
      c.push({ text: m.capa.anexosNomes.join(' · '), fontSize: 8.5, color: GRAY, margin: [0, 2, 0, 0] })
    }
    return c
  }

  // ── corpo de uma RAT (mesmo conteúdo do buildReportBody, em nós pdfmake) ──
  const fmtDataBR = (s) => { const mm = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})/); return mm ? `${mm[3]}/${mm[2]}/${mm[1]}` : String(s == null ? '' : s) }
  const minutosDe = (hhmm) => { if (!hhmm) return null; const p = String(hhmm).split(':').map(Number); return (isNaN(p[0]) || isNaN(p[1])) ? null : p[0] * 60 + p[1] }
  const durStr = (a, b) => { const x = minutosDe(a), y = minutosDe(b); if (x == null || y == null) return '—'; let d = y - x; if (d < 0) d += 1440; return RatView.fmtMin(d) }
  const money = (n) => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  function corpoRat(m, det, ratIdx, contSet) {
    const r = det.r, resp = r.respostas || {}, campos = det.campos || []
    const flags = m.flags
    const baseNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : m.numeroFmt
    const ratNo = baseNo + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : '')
    const st = RatView.statusInfo(r.status)
    const stCor = st.cls === 'st-ok' ? GREEN : st.cls === 'st-run' ? BLUE : st.cls === 'st-pend' ? '#B7791F' : AZ
    const tempo = RatView.fmtMin(RatView.tempoRat(r))
    const c = []

    // faixa de identificação da RAT
    c.push({ table: { widths: ['*', 'auto'], body: [[
      { stack: [
        { text: `RAT ${ratNo}`, bold: true, fontSize: 12, color: AZ },
        { text: `${r.tecnico_nome || '—'}  ·  ${fmtDataBR(r.data_tarefa)}`, fontSize: 8.5, color: GRAY, margin: [0, 2, 0, 0] },
      ] },
      { stack: [
        Object.assign(pill(st.label, stCor), { alignment: 'right' }),
        { text: `Tempo: ${tempo}`, fontSize: 8.5, color: GRAY, alignment: 'right', margin: [0, 4, 0, 0] },
      ] },
    ]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 9, paddingBottom: () => 9, fillColor: () => BG },
    margin: [0, 22, 0, 2], unbreakable: true })

    // Dados da OS
    c.push(...sec('Dados da OS'))
    const tf = r.tarefa || {}
    const osFields = [['Nº da OS', '#' + ratNo], ['Data da Tarefa', fmtDataBR(r.data_tarefa)],
      ['Tipo de tarefa', RatView.tipoNomeRat(r)], ['Duração', tempo]]
    if (r.checkin_lat != null && r.checkin_lng != null)
      osFields.push(['Local (GPS)', `${Number(r.checkin_lat).toFixed(5)}, ${Number(r.checkin_lng).toFixed(5)}${r.checkin_precisao ? ` (±${Math.round(r.checkin_precisao)} m)` : ''}`])
    if (tf.orientacao) osFields.push({ 0: 'Orientação', 1: tf.orientacao, full: true })
    c.push(...grid(osFields))

    // Visita improdutiva
    if (r.status === 'improdutiva' || r.atendimento_executado === false) {
      c.push(...sec('Visita improdutiva'))
      const imp = [{ 0: 'Motivo de não ter executado', 1: m.motivoImprodutiva(r), full: true }]
      if (resp.hora_inicio && resp.hora_termino) imp.push({ 0: 'Tempo no local (início–término)', 1: `${resp.hora_inicio} – ${resp.hora_termino} · ${durStr(resp.hora_inicio, resp.hora_termino)}`, full: true })
      c.push(...grid(imp))
      c.push({ text: 'Deslocamento e tempo no local ficam registrados (faturáveis); a execução foi zerada e a tarefa continua aguardando reagendamento.', fontSize: 8.5, color: GRAY, margin: [0, 0, 0, 4] })
    }

    // Passagem (volta depois pra terminar)
    if (resp.volta_amanha === 'Não' && resp.passagem_motivo === 'volto_depois') {
      c.push(...sec('Passagem — volta depois pra terminar'))
      const pg = []
      if (resp.passagem_falta) pg.push({ 0: 'O que falta', 1: resp.passagem_falta, full: true })
      if (resp.passagem_levar) pg.push({ 0: 'O que levar', 1: resp.passagem_levar, full: true })
      c.push(...grid(pg))
    }

    // Campos dinâmicos do formulário (mesmas regras do modo leitura do buildReportBody)
    const SKIP = { foto: 1, produtos: 1, assinatura: 1 }
    const EXC = { almoco: 1, almoco_inicio: 1, almoco_termino: 1, pausa: 1, pausa_inicio: 1, pausa_termino: 1, pausa_motivo: 1 }
    const gridItems = [], longSecs = []
    for (const cp of campos) {
      if (SKIP[cp.tipo] || EXC[cp.id]) continue
      const val = resp[cp.id]
      if (val == null || String(val).trim() === '') continue
      if (!RatView.campoVisivel(cp, resp)) continue
      if (cp.tipo === 'texto_longo') longSecs.push({ label: cp.label, val })
      else gridItems.push([cp.label, cp.tipo === 'data' ? fmtDataBR(val) : val])
    }
    if (gridItems.length) c.push({ stack: [...sec('RAT — dados do atendimento'), ...grid(gridItems)], unbreakable: true })

    // Pausas e almoço
    if ((resp.almoco != null && resp.almoco !== '') || (resp.pausa != null && resp.pausa !== '')) {
      c.push(...sec('Pausas e almoço'))
      const resumo = []
      if (resp.almoco != null && resp.almoco !== '') resumo.push({ text: 'Almoço: ', color: INK }, { text: resp.almoco, bold: true, color: AZ }, { text: '      ' })
      if (resp.pausa != null && resp.pausa !== '') resumo.push({ text: 'Pausa: ', color: INK }, { text: resp.pausa, bold: true, color: AZ })
      c.push({ text: resumo, fontSize: 9, margin: [0, 0, 0, 6] })
      const pausas = []
      if (resp.almoco === 'Sim' && (resp.almoco_inicio || resp.almoco_termino)) pausas.push({ ini: resp.almoco_inicio, fim: resp.almoco_termino, motivo: 'Almoço' })
      if (resp.pausa === 'Sim' && (resp.pausa_inicio || resp.pausa_termino || resp.pausa_motivo)) pausas.push({ ini: resp.pausa_inicio, fim: resp.pausa_termino, motivo: resp.pausa_motivo || 'Pausa' })
      if (pausas.length) c.push(tabela([{ t: 'Início' }, { t: 'Fim' }, { t: 'Tempo' }, { t: 'Justificativa/Motivo' }],
        pausas.map(p => [cel(p.ini), cel(p.fim), cel(durStr(p.ini, p.fim)), cel(p.motivo)]),
        ['auto', 'auto', 'auto', '*']))
    }

    // Textos longos (Serviço Executado etc.) em caixa destacada
    for (const ls of longSecs) { c.push(...sec(ls.label)); c.push(textBox(ls.val)) }

    // Produtos: cliente = só utilizados (qtd>0) sem valores; interno = todos com valores
    const mats = (det.mats || []).filter(mm => flags.zerados || (Number(mm.quantidade) || 0) > 0)
    if (mats.length) {
      c.push(...sec(flags.zerados ? 'Produtos' : 'Produtos utilizados'))
      const heads = [{ t: 'Produto' }, { t: 'Qtd', a: 'right' }]
      if (flags.valores) heads.push({ t: 'Valor unit.', a: 'right' }, { t: 'Subtotal', a: 'right' })
      const widths = flags.valores ? ['*', 'auto', 'auto', 'auto'] : ['*', 'auto']
      const rows = mats.map(mm => {
        const row = [cel(mm.descricao || mm.codigo), celNum(mm.quantidade)]
        if (flags.valores) row.push(celNum(money(mm.preco)), celNum(money(mm.subtotal)))
        return row
      })
      if (flags.valores) {
        const total = mats.reduce((s, mm) => s + (Number(mm.subtotal) || 0), 0)
        rows.push([
          { text: 'TOTAL', bold: true, fontSize: 8, color: AZ, characterSpacing: 0.4, fillColor: BG },
          { text: '', fillColor: BG }, { text: '', fillColor: BG },
          { text: money(total), alignment: 'right', bold: true, fontSize: 9.5, color: AZ, fillColor: BG },
        ])
      }
      c.push(tabela(heads, rows, widths))
    }

    // Fotos (grade adaptável + continuação medida)
    if (det.fotosPdf && det.fotosPdf.length) c.push(...fotosSection('Fotos', det.fotosPdf, ratIdx + 1, contSet))

    // Assinatura
    if (det.sigPdf) {
      c.push({ stack: [...sec('Assinatura'), { image: det.sigPdf, width: 200 }], unbreakable: true })
    }
    return c
  }

  // ── documento completo ──
  function docDefinition(m, contSet) {
    const content = [...capa(m)]
    content.push(...anexosSection(m, contSet))
    m.dets.forEach((det, i) => content.push(...corpoRat(m, det, i, contSet)))
    return {
      pageSize: 'A4', pageMargins: [MARG, TOPM, MARG, BOTM],
      defaultStyle: { font: 'Roboto', fontSize: 9, color: INK },
      info: { title: m.arquivo.replace(/\.pdf$/i, ''), creator: 'Service Report — Traders Service' },
      header: () => ({ stack: [
        { canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_W, h: 52, color: AZ },
                   { type: 'rect', x: 0, y: 52, w: PAGE_W, h: 2.5, color: BLUE }] },
        { columns: [
          { width: '*', stack: [
            { text: 'TRADERS SERVICE', bold: true, fontSize: 13, color: '#ffffff', characterSpacing: 1.2 },
            { text: 'Service Report', fontSize: 7.5, color: '#A9BCE2', characterSpacing: 0.6, margin: [0, 2, 0, 0] },
          ] },
          { width: 'auto', stack: [
            { text: 'RELATÓRIO DE ATENDIMENTO TÉCNICO', alignment: 'right', color: '#D4DEF1', bold: true, fontSize: 7.5, characterSpacing: 0.8 },
            { text: `Tarefa Nº ${m.numeroFmt}`, alignment: 'right', color: '#ffffff', bold: true, fontSize: 10, margin: [0, 3, 0, 0] },
          ] },
        ], margin: [MARG, -41, MARG, 0] },
      ] }),
      footer: (cur, tot) => ({ margin: [MARG, 8, MARG, 0], stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW, y2: 0, lineWidth: 0.6, lineColor: LINE }] },
        { columns: [
          { text: 'Documento gerado pela plataforma Service Report — Traders Service.' + (m.selo ? ' · ' + m.selo : ''), fontSize: 7.2, color: MUTED, margin: [0, 5, 0, 0] },
          { text: `Página ${cur} de ${tot}`, alignment: 'right', fontSize: 7.2, color: MUTED, margin: [0, 5, 0, 0] },
        ] },
      ] }),
      content,
    }
  }

  // ── medição de layout p/ "— continuação" (passes com imagem 1×1: mesmo layout, sem custo) ──
  // pdfmake informa a posição TENTADA de cada nó (pageBreakBefore). Com a altura real de cada
  // linha (medida num doc auxiliar, uma linha por página), decidimos a página FINAL de cada
  // linha: cabe na tentativa → fica; não cabe → vai pro topo da próxima (bloco indivisível).
  function renderLayout(dd) {
    return new Promise((resolve, reject) => {
      const pos = {}
      dd.pageBreakBefore = (cur) => {
        if (cur.id && cur.startPosition) pos[cur.id] = { page: cur.startPosition.pageNumber, top: cur.startPosition.top }
        return false
      }
      try { pdfMake.createPdf(dd).getBlob(() => resolve(pos)) } catch (e) { reject(e) }
    })
  }
  function trocaImgs(m, dataUrlFake) {
    // clona o modelo com todas as imagens trocadas pela 1×1 (largura/altura são declaradas
    // nos nós, então o layout não muda)
    const clone = Object.assign({}, m)
    clone.capa = Object.assign({}, m.capa, { anexosImgs: m.capa.anexosImgs.map(f => ({ legenda: f.legenda, dataUrl: dataUrlFake })) })
    clone.dets = m.dets.map(d => Object.assign({}, d, {
      fotosPdf: (d.fotosPdf || []).map(f => ({ legenda: f.legenda, dataUrl: dataUrlFake })),
      sigPdf: d.sigPdf ? dataUrlFake : null,
    }))
    return clone
  }
  async function medirAlturas(mLeve) {
    // doc auxiliar: cada linha de fotos numa página própria, com sentinela logo depois —
    // altura exata = top(sentinela) − top(linha). Idem pro bloco de título de seção.
    const grupos = []
    if (mLeve.capa.anexosImgs.length) grupos.push({ secIdx: 0, fotos: mLeve.capa.anexosImgs, titulo: 'Anexos' })
    mLeve.dets.forEach((d, i) => { if (d.fotosPdf && d.fotosPdf.length) grupos.push({ secIdx: i + 1, fotos: d.fotosPdf, titulo: 'Fotos' }) })
    if (!grupos.length) return null
    const content = []
    let primeiro = true
    for (const g of grupos) {
      const rows = fotoRows(g.fotos, g.secIdx)
      rows.forEach((row, ri) => {
        content.push(Object.assign({}, row, { id: `m_f${g.secIdx}_${ri}`, pageBreak: primeiro ? undefined : 'before' })); primeiro = false
        content.push({ text: '.', fontSize: 0.1, color: '#ffffff', id: `m_e${g.secIdx}_${ri}` })
      })
    }
    content.push({ stack: sec('Fotos — continuação'), id: 'm_tit', pageBreak: 'before' })
    content.push({ text: '.', fontSize: 0.1, color: '#ffffff', id: 'm_tit_e' })
    const pos = await renderLayout({ pageSize: 'A4', pageMargins: [MARG, TOPM, MARG, BOTM], defaultStyle: { font: 'Roboto', fontSize: 9 }, content })
    const alturas = {}
    for (const g of grupos) {
      const n = fotoRows(g.fotos, g.secIdx).length
      alturas['s' + g.secIdx] = []
      for (let ri = 0; ri < n; ri++) {
        const a = pos[`m_f${g.secIdx}_${ri}`], b = pos[`m_e${g.secIdx}_${ri}`]
        alturas['s' + g.secIdx].push((a && b) ? (b.top - a.top) : 160)
      }
    }
    alturas.titulo = (pos.m_tit && pos.m_tit_e) ? (pos.m_tit_e.top - pos.m_tit.top) : 40
    return { grupos, alturas }
  }
  async function calcularContinuacoes(m) {
    const mLeve = trocaImgs(m, PIX)
    const med = await medirAlturas(mLeve)
    if (!med) return new Set()
    let contSet = new Set()
    for (let passo = 0; passo < 4; passo++) {
      const pos = await renderLayout(docDefinition(mLeve, contSet))
      const next = new Set()
      for (const g of med.grupos) {
        const hs = med.alturas['s' + g.secIdx]
        let fimAnt = null   // página final da linha anterior
        for (let ri = 0; ri < hs.length; ri++) {
          const id = 'f' + g.secIdx + '_' + ri
          const p = pos[id]; if (!p) continue
          let h = hs[ri] + ((ri === 0 || contSet.has(id)) ? med.alturas.titulo : 0)
          const fim = (p.top + h <= BOTTOM) ? p.page : p.page + 1
          if (ri > 0 && fimAnt != null && fim > fimAnt) next.add(id)
          fimAnt = fim
        }
      }
      const iguais = next.size === contSet.size && [...next].every(x => contSet.has(x))
      if (iguais) break
      contSet = next
    }
    return contSet
  }

  // ── entrada única: monta imagens, mede continuações e baixa o PDF ──
  // m: modelo montado por tarefa.js (dados resolvidos + dets do RatView.loadDetalhe)
  async function gerar(m) {
    await carregarPdfMake()
    // Fotos/assinatura/anexos → dataURL comprimido, SEQUENCIAL (uma imagem por vez:
    // não estoura memória em tarefa com muitas fotos; canvas é liberado a cada uma)
    for (const det of m.dets) {
      det.fotosPdf = []
      for (const f of (det.fotos || [])) {
        const du = await imgParaPdf(f.url, 1600, true)
        if (du) det.fotosPdf.push({ dataUrl: du, legenda: f.legenda || '' })
      }
      det.sigPdf = det.sigUrl ? await imgParaPdf(det.sigUrl, 700, false) : null
    }
    const anexosImgs = []
    for (const a of (m.capa.anexosUrls || [])) {
      const du = await imgParaPdf(a.url, 1600, true)
      if (du) anexosImgs.push({ dataUrl: du, legenda: a.nome || '' })
    }
    m.capa.anexosImgs = anexosImgs

    const contSet = await calcularContinuacoes(m)
    const dd = docDefinition(m, contSet)
    await new Promise((resolve, reject) => {
      try { pdfMake.createPdf(dd).download(m.arquivo, resolve) } catch (e) { reject(e) }
    })
  }

  return { gerar }
})()
