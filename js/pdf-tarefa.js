/* ═══════════════════════════════════════════════
   Service Report — pdf-tarefa.js
   PDF VETORIAL dos atendimentos via pdfmake local (js/vendor/, offline):
   · Tarefa (m.capa preenchida): capa/dossiê + todas as RATs;
   · RAT avulsa / PDF unificado (m.capa = null): só os corpos de RAT, com o
     cliente na faixa de cada RAT e m.headerRight no cabeçalho das páginas.
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
            (value && typeof value === 'object' && value.node)
              ? value.node   // célula rica (ex.: Local (GPS) com o mapa embaixo das coordenadas)
              : { text: (value == null || value === '') ? '—' : String(value), fontSize: 9.5, color: INK, lineHeight: 1.15 }],
    margin: [0, 0, 0, 8] })
  // cada linha da grade é INDIVISÍVEL: par rótulo+valor nunca separa entre páginas
  function grid(items) {
    const rows = [], buf = []
    const fecha = () => { rows.push({ columns: buf.slice(), columnGap: 16, unbreakable: true }); buf.length = 0 }
    for (const it of items) {
      if (it.full) { if (buf.length) fecha(); rows.push({ columns: [field(it[0], it[1])], unbreakable: true }); continue }
      buf.push(field(it[0], it[1]))
      if (buf.length === 2) fecha()
    }
    if (buf.length) { if (buf.length === 1) buf.push({ text: '', width: '*' }); fecha() }
    return rows
  }
  // seção de campos: o título fica preso à 1ª linha da grade (nunca órfão no pé da página)
  function secGrid(titulo, items) {
    const rows = grid(items)
    if (!rows.length) return sec(titulo)
    return [{ stack: [...sec(titulo), rows[0]], unbreakable: true }, ...rows.slice(1)]
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
  // seção "título + tabela/caixa" movida inteira se não couber (título nunca fica órfão)
  const secBloco = (titulo, nodes) => ({ stack: [...sec(titulo), ...nodes], unbreakable: true })

  // ── tabela "fluida": título + cabeçalho + linhas viram blocos independentes com LARGURAS
  //    FIXAS (mini-tabelas alinhadas). Linha que abre página nova ganha "TÍTULO — CONTINUAÇÃO"
  //    + cabeçalho repetido — mesma medição de layout das fotos (ids fx{sec}_{i}). ──
  function tabelaFluida(m, titulo, heads, rows, widths, contSet, totalRow) {
    const secIdx = m._fluxos.length
    m._fluxos.push({ secIdx, n: rows.length })
    // células de cabeçalho SEMPRE novas por uso: reutilizar os mesmos objetos-célula em duas
    // tabelas faz o pdfmake renderizar a segunda vazia (faixa cinza sem texto)
    const headCells = () => heads.map(h => ({ text: String(h.t).toUpperCase(), alignment: h.a || 'left', bold: true, fontSize: 7.2, color: GRAY, characterSpacing: 0.4, fillColor: BG }))
    const linha = (cells, top, bot) => ({ table: { widths, body: [cells] },
      layout: { hLineWidth: (i) => i === 0 ? top : bot,
        hLineColor: (i) => ((i === 0 ? top : bot) >= 0.8) ? '#D3DBE8' : LINE,
        vLineWidth: () => 0, paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 5, paddingBottom: () => 5 } })
    const cabecalho = (t) => [...sec(t), linha(headCells(), 0.8, 0.8)]
    const blocos = []
    rows.forEach((r, i) => {
      const cells = (i % 2 === 1) ? r.map(c => c.fillColor ? c : Object.assign({}, c, { fillColor: ZEBRA })) : r
      const ultima = i === rows.length - 1
      const linhaNode = linha(cells, 0, (ultima && !totalRow) ? 0.8 : 0.5)
      const id = 'fx' + secIdx + '_' + i
      if (i === 0) blocos.push({ stack: [...cabecalho(titulo), linhaNode], unbreakable: true, id })
      else if (contSet && contSet.has(id)) blocos.push({ stack: [...cabecalho(titulo + ' — continuação'), linhaNode], unbreakable: true, id })
      else blocos.push({ stack: [linhaNode], unbreakable: true, id })
      if (ultima && totalRow) blocos[blocos.length - 1].stack.push(linha(totalRow, 0, 0.8))
    })
    return blocos
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
  // linhas da grade de fotos (indivisíveis)
  function fotoRows(fotos) {
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
  // seção "titulo" + linhas de fotos; contSet marca as linhas que abrem página nova
  // (ganham "TÍTULO — CONTINUAÇÃO" — página nunca começa com imagens sem indicar a seção)
  function fotosSection(m, titulo, fotos, contSet) {
    const secIdx = m._fluxos.length
    m._fluxos.push({ secIdx, n: Math.ceil(fotos.length / fotoLayout(fotos.length).perRow) })
    const rows = fotoRows(fotos), nodes = []
    rows.forEach((row, i) => {
      const id = 'fx' + secIdx + '_' + i
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

    c.push(...secGrid('Dados da Tarefa', m.capa.campos))

    c.push(secBloco('Resumo operacional', [statCards(m.capa.resumo)]))

    if (m.capa.ratsResumo.length) {
      c.push(secBloco('RATs (resumo)', [tabela([{ t: 'RAT' }, { t: 'Data' }, { t: 'Técnico' }, { t: 'Situação' }, { t: 'Tempo', a: 'right' }],
        m.capa.ratsResumo.map(r => [cel(r.ratNo, { bold: true, color: AZ }), cel(r.data), cel(r.tecnico),
          cel(r.situacao, { color: r.ok ? GREEN : INK, bold: !!r.ok }), celNum(r.tempo)]),
        ['auto', 'auto', '*', 'auto', 'auto'])]))
    }
    return c
  }
  // Conciliação (tabela fluida: continua com cabeçalho repetido + "— continuação") + equipamentos
  function capaTabelas(m, contSet) {
    const c = []
    if (m.flags.conciliacao && m.capa.conciliacao.length) {
      c.push(...tabelaFluida(m, 'Produtos (conciliação)',
        [{ t: 'Produto' }, { t: 'Orçada', a: 'right' }, { t: 'Disponibilizada', a: 'right' }, { t: 'Utilizada', a: 'right' }, { t: 'Devolvida', a: 'right' }],
        m.capa.conciliacao.map(l => [cel(l.descricao), celNum(l.orcada), celNum(l.levada), celNum(l.utilizada), celNum(l.devolvida)]),
        ['*', 45, 78, 52, 58], contSet))
    }
    if (m.capa.equipamentos.length) {
      c.push(secBloco('Equipamentos', [tabela([{ t: 'Tipo' }, { t: 'Modelo' }, { t: 'Part number' }, { t: 'Serial' }],
        m.capa.equipamentos.map(e => [cel(e.tipo), cel(e.modelo), cel(e.part), cel(e.serial)]),
        ['auto', '*', 'auto', 'auto'])]))
    }
    return c
  }
  // Anexos da capa: imagens em grade (mesma lógica das fotos) + nomes de não-imagens
  function anexosSection(m, contSet) {
    const c = []
    if (m.capa.anexosImgs.length) c.push(...fotosSection(m, 'Anexos', m.capa.anexosImgs, contSet))
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

  // ── Snapshot do Local (GPS) pro PDF INTERNO: satélite (tiles Esri, CORS ok) + pino,
  //    composto num canvas → dataURL. Falha silenciosa (retorna null; PDF segue sem mapa). ──
  const tileImg = (src) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src })
  async function mapaParaPdf(lat, lng) {
    const z = 16, T = 256, n = Math.pow(2, z)
    const rad = lat * Math.PI / 180
    const px = (lng + 180) / 360 * n * T
    const py = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n * T
    const W = 560, H = 210
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H
    const ctx = cv.getContext('2d')
    const x0 = px - W / 2, y0 = py - H / 2
    let algum = false
    for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + H) / T); ty++)
      for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + W) / T); tx++) {
        // ?cors=1: URL distinta da usada no card (que o SW cacheia como opaque, sem CORS) —
        // garante resposta com header CORS pro canvas poder exportar (toDataURL)
        const im = await tileImg(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}?cors=1`)
        if (im) { ctx.drawImage(im, Math.round(tx * T - x0), Math.round(ty * T - y0)); algum = true }
      }
    if (!algum) return null
    // pino (gota) no centro
    const cx = W / 2, cy = H / 2
    ctx.fillStyle = '#E5403A'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(cx, cy)
    ctx.bezierCurveTo(cx - 13, cy - 15, cx - 10, cy - 28, cx, cy - 28)
    ctx.bezierCurveTo(cx + 10, cy - 28, cx + 13, cy - 15, cx, cy)
    ctx.fill(); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx, cy - 19, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill()
    // atribuição obrigatória
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(W - 118, H - 15, 118, 15)
    ctx.fillStyle = '#fff'; ctx.font = '9px Manrope, sans-serif'; ctx.fillText('Imagens © Esri · Maxar', W - 112, H - 4)
    try { return cv.toDataURL('image/jpeg', 0.85) } catch (e) { return null }   // canvas contaminado (sem CORS) → sem mapa
  }

  function corpoRat(m, det, ratIdx, contSet) {
    const r = det.r, resp = r.respostas || {}, campos = det.campos || []
    const flags = m.flags
    const baseNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : m.numeroFmt
    const ratNo = baseNo + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : '')
    const st = RatView.statusInfo(r.status)
    const stCor = st.cls === 'st-ok' ? GREEN : st.cls === 'st-run' ? BLUE : st.cls === 'st-pend' ? '#B7791F' : AZ
    const tempo = RatView.fmtMin(RatView.tempoRat(r))
    const c = []

    // faixa de identificação da RAT. Sem capa (RAT avulsa / PDF unificado) o cliente ainda
    // não apareceu no documento → entra na faixa; com capa, faixa enxuta (cliente já no topo).
    const faixaEsq = m.capa
      ? [
        { text: `RAT ${ratNo}`, bold: true, fontSize: 12, color: AZ },
        { text: `${r.tecnico_nome || '—'}  ·  ${fmtDataBR(r.data_tarefa)}`, fontSize: 8.5, color: GRAY, margin: [0, 2, 0, 0] },
      ]
      : [
        { text: r.cliente_nome || '—', bold: true, fontSize: 12, color: AZ },
        { text: `RAT ${ratNo}  ·  ${r.tecnico_nome || '—'}  ·  ${fmtDataBR(r.data_tarefa)}`, fontSize: 8.5, color: GRAY, margin: [0, 2, 0, 0] },
      ]
    const faixa = { table: { widths: ['*', 'auto'], body: [[
      { stack: faixaEsq },
      { stack: [
        Object.assign(pill(st.label, stCor), { alignment: 'right' }),
        { text: `Tempo: ${tempo}`, fontSize: 8.5, color: GRAY, alignment: 'right', margin: [0, 4, 0, 0] },
      ] },
    ]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 9, paddingBottom: () => 9, fillColor: () => BG },
    margin: [0, (!m.capa && ratIdx === 0) ? 2 : 22, 0, 2] }

    // Dados da OS — junto da faixa da RAT: o bloco inteiro (faixa + título + campos) só
    // quebra se não couber, e aí desce inteiro pra próxima página.
    const tf = r.tarefa || {}
    const osFields = [['Nº da OS', '#' + ratNo], ['Data da Tarefa', fmtDataBR(r.data_tarefa)],
      ['Tipo de tarefa', RatView.tipoNomeRat(r)], ['Duração', tempo]]
    if (r.checkin_lat != null && r.checkin_lng != null) {
      const coordsTxt = `${Number(r.checkin_lat).toFixed(5)}, ${Number(r.checkin_lng).toFixed(5)}${r.checkin_precisao ? ` (±${Math.round(r.checkin_precisao)} m)` : ''}`
      // PDF interno: o snapshot entra DENTRO do campo Local (GPS), abaixo das coordenadas,
      // com link clicável pro Google Maps. PDF do cliente: só as coordenadas em texto.
      osFields.push(['Local (GPS)', det.mapaPdf
        ? { node: { stack: [
            { text: coordsTxt, fontSize: 9.5, color: INK, lineHeight: 1.15 },
            { image: det.mapaPdf, width: 200, link: `https://www.google.com/maps?q=${r.checkin_lat},${r.checkin_lng}`, margin: [0, 4, 0, 0] },
          ] } }
        : coordsTxt])
    }
    if (tf.orientacao) {
      // Orientação idêntica à orientação geral da tarefa (que já está na capa) não se repete
      // em cada RAT — vira uma referência. RAT avulsa (sem capa) mostra o texto completo.
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const igualGeral = m.capa && m.orientacaoGeral && norm(tf.orientacao) === norm(m.orientacaoGeral)
      osFields.push({ 0: 'Orientação', 1: igualGeral ? 'Conforme orientação geral da tarefa.' : tf.orientacao, full: true })
    }
    c.push({ stack: [faixa, ...sec('Dados da OS'), ...grid(osFields)], unbreakable: true })

    // Visita improdutiva — bloco inteiro indivisível (título + campos + nota)
    if (r.status === 'improdutiva' || r.atendimento_executado === false) {
      const imp = [{ 0: 'Motivo de não ter executado', 1: m.motivoImprodutiva(r), full: true }]
      if (resp.hora_inicio && resp.hora_termino) imp.push({ 0: 'Tempo no local (início–término)', 1: `${resp.hora_inicio} – ${resp.hora_termino} · ${durStr(resp.hora_inicio, resp.hora_termino)}`, full: true })
      c.push({ stack: [...sec('Visita improdutiva'), ...grid(imp),
        { text: 'Deslocamento e tempo no local ficam registrados (faturáveis); a execução foi zerada e a tarefa continua aguardando reagendamento.', fontSize: 8.5, color: GRAY, margin: [0, 0, 0, 4] }],
        unbreakable: true })
    }

    // Passagem (volta depois pra terminar) — informação operacional interna: fora do PDF Cliente.
    // Bloco inteiro indivisível ("O que falta" e "O que levar" nunca se separam).
    if (!flags.cliente && resp.volta_amanha === 'Não' && resp.passagem_motivo === 'volto_depois') {
      const pg = []
      if (resp.passagem_falta) pg.push({ 0: 'O que falta', 1: resp.passagem_falta, full: true })
      if (resp.passagem_levar) pg.push({ 0: 'O que levar', 1: resp.passagem_levar, full: true })
      if (pg.length) c.push({ stack: [...sec('Passagem — volta depois pra terminar'), ...grid(pg)], unbreakable: true })
    }

    // Campos dinâmicos do formulário (mesmas regras do modo leitura do buildReportBody)
    const SKIP = { foto: 1, produtos: 1, assinatura: 1 }
    const EXC = { almoco: 1, almoco_inicio: 1, almoco_termino: 1, pausa: 1, pausa_inicio: 1, pausa_termino: 1, pausa_motivo: 1 }
    const gridItems = [], longSecs = []
    for (const cp of campos) {
      if (SKIP[cp.tipo] || EXC[cp.id]) continue
      // "Observações" da RAT é anotação operacional interna (ex.: "precisamos retornar…") — fora do Cliente
      if (flags.cliente && cp.id === 'observacoes') continue
      const val = resp[cp.id]
      if (val == null || String(val).trim() === '') continue
      if (!RatView.campoVisivel(cp, resp)) continue
      if (cp.tipo === 'texto_longo') longSecs.push({ label: cp.label, val })
      else gridItems.push([cp.label, cp.tipo === 'data' ? fmtDataBR(val) : val])
    }
    if (gridItems.length) c.push({ stack: [...sec('RAT — dados do atendimento'), ...grid(gridItems)], unbreakable: true })

    // Pausas e almoço (bloco indivisível: título + resumo + tabela)
    if ((resp.almoco != null && resp.almoco !== '') || (resp.pausa != null && resp.pausa !== '')) {
      const resumo = []
      if (resp.almoco != null && resp.almoco !== '') resumo.push({ text: 'Almoço: ', color: INK }, { text: resp.almoco, bold: true, color: AZ }, { text: '      ' })
      if (resp.pausa != null && resp.pausa !== '') resumo.push({ text: 'Pausa: ', color: INK }, { text: resp.pausa, bold: true, color: AZ })
      const nodes = [{ text: resumo, fontSize: 9, margin: [0, 0, 0, 6] }]
      const pausas = []
      if (resp.almoco === 'Sim' && (resp.almoco_inicio || resp.almoco_termino)) pausas.push({ ini: resp.almoco_inicio, fim: resp.almoco_termino, motivo: 'Almoço' })
      if (resp.pausa === 'Sim' && (resp.pausa_inicio || resp.pausa_termino || resp.pausa_motivo)) pausas.push({ ini: resp.pausa_inicio, fim: resp.pausa_termino, motivo: resp.pausa_motivo || 'Pausa' })
      if (pausas.length) nodes.push(tabela([{ t: 'Início' }, { t: 'Fim' }, { t: 'Tempo' }, { t: 'Justificativa/Motivo' }],
        pausas.map(p => [cel(p.ini), cel(p.fim), cel(durStr(p.ini, p.fim)), cel(p.motivo)]),
        ['auto', 'auto', 'auto', '*']))
      c.push(secBloco('Pausas e almoço', nodes))
    }

    // Textos longos (Serviço Executado etc.): título preso à caixa (bloco move inteiro)
    for (const ls of longSecs) c.push(secBloco(ls.label, [textBox(ls.val)]))

    // Produtos da RAT: SÓ os efetivamente utilizados (qtd > 0) — itens zerados moram na
    // conciliação geral, não se repetem por RAT. (?zerados=1 na URL ainda força mostrar tudo.)
    const mats = (det.mats || []).filter(mm => flags.zerados || (Number(mm.quantidade) || 0) > 0)
    if (mats.length) {
      const heads = [{ t: 'Produto' }, { t: 'Qtd', a: 'right' }]
      if (flags.valores) heads.push({ t: 'Valor unit.', a: 'right' }, { t: 'Subtotal', a: 'right' })
      const widths = flags.valores ? ['*', 40, 68, 75] : ['*', 45]
      const rows = mats.map(mm => {
        const row = [cel(mm.descricao || mm.codigo), celNum(mm.quantidade)]
        if (flags.valores) row.push(celNum(money(mm.preco)), celNum(money(mm.subtotal)))
        return row
      })
      let totalRow = null
      if (flags.valores) {
        const total = mats.reduce((s, mm) => s + (Number(mm.subtotal) || 0), 0)
        totalRow = [
          { text: 'TOTAL', bold: true, fontSize: 8, color: AZ, characterSpacing: 0.4, fillColor: BG },
          { text: '', fillColor: BG }, { text: '', fillColor: BG },
          { text: money(total), alignment: 'right', bold: true, fontSize: 9.5, color: AZ, fillColor: BG },
        ]
      }
      c.push(...tabelaFluida(m, flags.zerados ? 'Produtos' : 'Produtos utilizados', heads, rows, widths, contSet, totalRow))
    }

    // Fotos (grade adaptável + continuação medida)
    if (det.fotosPdf && det.fotosPdf.length) c.push(...fotosSection(m, 'Fotos', det.fotosPdf, contSet))

    // Assinatura
    if (det.sigPdf) {
      c.push({ stack: [...sec('Assinatura'), { image: det.sigPdf, width: 200 }], unbreakable: true })
    }
    return c
  }

  // ── documento completo ──
  function docDefinition(m, contSet) {
    m._fluxos = []   // seções "fluidas" (fotos/tabelas) registradas durante a construção
    const content = []
    if (m.capa) { content.push(...capa(m)); content.push(...capaTabelas(m, contSet)); content.push(...anexosSection(m, contSet)) }
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
            { text: m.headerRight || `Tarefa Nº ${m.numeroFmt}`, alignment: 'right', color: '#ffffff', bold: true, fontSize: 10, margin: [0, 3, 0, 0] },
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
    if (m.capa) clone.capa = Object.assign({}, m.capa, { anexosImgs: m.capa.anexosImgs.map(f => ({ legenda: f.legenda, dataUrl: dataUrlFake })) })
    clone.dets = m.dets.map(d => Object.assign({}, d, {
      fotosPdf: (d.fotosPdf || []).map(f => ({ legenda: f.legenda, dataUrl: dataUrlFake })),
      sigPdf: d.sigPdf ? dataUrlFake : null,
    }))
    return clone
  }
  // Mede a altura REAL de cada bloco fluido do documento corrente (cada bloco numa página
  // própria + sentinela logo depois; altura = top(sentinela) − top(bloco)). Blocos já vêm
  // com título/cabeçalho embutidos quando é o caso — nada de aritmética por fora.
  async function medirBlocos(mLeve, contSet) {
    const dd = docDefinition(mLeve, contSet)
    const blocos = dd.content.filter(n => n.id && n.id.indexOf('fx') === 0)
    if (!blocos.length) return null
    // ATENÇÃO: o pdfmake NÃO chama pageBreakBefore para nós com pageBreak explícito —
    // a quebra vai num separador próprio, e o bloco (sem pageBreak) é medido no topo da página.
    const content = []
    blocos.forEach((b, k) => {
      if (k) content.push({ text: '', fontSize: 0.1, pageBreak: 'before' })
      content.push(b)
      content.push({ text: '.', fontSize: 0.1, color: '#ffffff', id: 'e_' + b.id })
    })
    const pos = await renderLayout({ pageSize: 'A4', pageMargins: [MARG, TOPM, MARG, BOTM],
      defaultStyle: { font: 'Roboto', fontSize: 9, color: INK }, content })
    const H = {}
    blocos.forEach(b => { const a = pos[b.id], e = pos['e_' + b.id]; H[b.id] = (a && e) ? (e.top - a.top) : 200 })
    if (window.PDF_DEBUG) console.log('[pdf] medirBlocos: pos keys', Object.keys(pos).length, 'blocos', blocos.length, 'exemplo pos:', JSON.stringify(Object.keys(pos).slice(0, 6)))
    return H
  }
  // Decide onde entram os "— continuação": posição tentada de cada bloco + altura real →
  // página final (cabe = fica; não cabe = bloco indivisível desce inteiro). Itera até
  // estabilizar (inserir título desloca os blocos seguintes).
  async function calcularContinuacoes(m) {
    const mLeve = trocaImgs(m, PIX)
    let contSet = new Set()
    for (let passo = 0; passo < 5; passo++) {
      const H = await medirBlocos(mLeve, contSet)
      if (!H) return contSet
      const pos = await renderLayout(docDefinition(mLeve, contSet))
      const next = new Set()
      for (const fl of mLeve._fluxos) {
        let fimAnt = null
        for (let i = 0; i < fl.n; i++) {
          const id = 'fx' + fl.secIdx + '_' + i
          const p = pos[id]; if (!p) continue
          // a altura medida inclui as margens do bloco — o pdfmake conta tudo no teste de quebra
          const fim = (p.top + (H[id] || 0) <= BOTTOM + 0.5) ? p.page : p.page + 1
          if (window.PDF_DEBUG) console.log('[pdf]', 'passo', passo, id, 'pág', p.page, 'top', Math.round(p.top), 'H', Math.round(H[id] || 0), '→ fim', fim, (i > 0 && fimAnt != null && fim > fimAnt) ? 'CONT' : '')
          if (i > 0 && fimAnt != null && fim > fimAnt) next.add(id)
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
      // Local (GPS) → snapshot no PDF INTERNO apenas (nunca no documento do cliente)
      const rr = det.r
      det.mapaPdf = (!m.flags.cliente && rr.checkin_lat != null && rr.checkin_lng != null)
        ? await mapaParaPdf(rr.checkin_lat, rr.checkin_lng).catch(() => null) : null
    }
    if (m.capa) {
      const anexosImgs = []
      for (const a of (m.capa.anexosUrls || [])) {
        const du = await imgParaPdf(a.url, 1600, true)
        if (du) anexosImgs.push({ dataUrl: du, legenda: a.nome || '' })
      }
      m.capa.anexosImgs = anexosImgs
    }

    const contSet = await calcularContinuacoes(m)
    const dd = docDefinition(m, contSet)
    await new Promise((resolve, reject) => {
      try { pdfMake.createPdf(dd).download(m.arquivo, resolve) } catch (e) { reject(e) }
    })
  }

  return { gerar }
})()
