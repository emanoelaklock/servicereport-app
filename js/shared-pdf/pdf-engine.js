/* ═══════════════════════════════════════════════
   tsrv-pdf-engine — pdf-engine.js
   Motor vetorial de PDF (pdfmake) compartilhado entre os apps da Traders Service
   (Service Report, Comercial). Extraído VERBATIM de js/pdf-tarefa.js do SR (F1):
   qualquer mudança de comportamento aqui é regressão — o gate golden (test/golden.html)
   exige saída byte-idêntica ao legado para os fixtures congelados.

   O motor NÃO conhece marca, template nem Supabase. Contratos:
   · PdfEngine.create({ vendorPath, theme, deps }) → instância;
   · theme: tokens de cor/tipografia/geometria (defaults = Service Report);
   · deps.fmtMin(min): formatação de minutos (única dependência externa);
   · modelo m: { flags{cliente,valores,...}, capa|null{anexosUrls,anexosImgs}, dets[]
     {r, fotos[], sigUrl, fotosPdf, sigPdf, mapaPdf}, _fluxos[] } — o template monta
     o docDefinition e o passa como callback (buildDoc) para a medição de quebras.

   Fotos/assinatura são as ÚNICAS imagens rasterizadas — reduzidas e comprimidas em
   canvas (1600px, JPEG q0.85). O canvas é usado SÓ para isso; o relatório nunca é
   rasterizado.
═══════════════════════════════════════════════ */
window.PdfEngine = (function () {
  'use strict'

  // ── tema padrão (= design system do Service Report; byte-idêntico ao legado) ──
  const DEFAULT_THEME = {
    AZ: '#243456', BLUE: '#1E8AE0', GREEN: '#179A47',
    INK: '#2b3447', GRAY: '#5C6470', MUTED: '#76839B',
    LINE: '#E3E8F0', BG: '#F4F7FB', ZEBRA: '#FAFBFD',
    PAGE_W: 595.28, PAGE_H: 841.89, MARG: 36, TOPM: 76, BOTM: 44,
    font: 'Roboto', fontSize: 9,
  }
  // JPEG 1×1 usado nos passes de medição de layout (mesmas dimensões declaradas → mesmo layout)
  const PIX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

  function create(cfg) {
    cfg = cfg || {}
    const T = Object.assign({}, DEFAULT_THEME, cfg.theme || {})
    const deps = cfg.deps || {}
    const vendorPath = cfg.vendorPath != null ? cfg.vendorPath : 'js/vendor/'

    const AZ = T.AZ, BLUE = T.BLUE, GREEN = T.GREEN
    const INK = T.INK, GRAY = T.GRAY, MUTED = T.MUTED
    const LINE = T.LINE, BG = T.BG, ZEBRA = T.ZEBRA
    const PAGE_W = T.PAGE_W, PAGE_H = T.PAGE_H, MARG = T.MARG, TOPM = T.TOPM, BOTM = T.BOTM
    const CW = PAGE_W - MARG * 2, BOTTOM = PAGE_H - BOTM

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
      carga = um(vendorPath + 'pdfmake.min.js').then(() => um(vendorPath + 'vfs_fonts.js'))
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

    // ── nós de layout ──
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

    // ── formatadores neutros (sem regra de negócio) ──
    const fmtDataBR = (s) => { const mm = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})/); return mm ? `${mm[3]}/${mm[2]}/${mm[1]}` : String(s == null ? '' : s) }
    const minutosDe = (hhmm) => { if (!hhmm) return null; const p = String(hhmm).split(':').map(Number); return (isNaN(p[0]) || isNaN(p[1])) ? null : p[0] * 60 + p[1] }
    const durStr = (a, b) => { const x = minutosDe(a), y = minutosDe(b); if (x == null || y == null) return '—'; let d = y - x; if (d < 0) d += 1440; return deps.fmtMin(d) }
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

    // ── preparação de imagens do modelo: fotos/assinatura/anexos → dataURL comprimido,
    //    SEQUENCIAL (uma imagem por vez: não estoura memória em tarefa com muitas fotos;
    //    canvas é liberado a cada uma). Mapa GPS só no perfil interno (m.flags.cliente=false). ──
    async function prepararImagens(m) {
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
    async function medirBlocos(mLeve, contSet, buildDoc) {
      const dd = buildDoc(mLeve, contSet)
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
        defaultStyle: { font: T.font, fontSize: T.fontSize, color: INK }, content })
      const H = {}
      blocos.forEach(b => { const a = pos[b.id], e = pos['e_' + b.id]; H[b.id] = (a && e) ? (e.top - a.top) : 200 })
      if (window.PDF_DEBUG) console.log('[pdf] medirBlocos: pos keys', Object.keys(pos).length, 'blocos', blocos.length, 'exemplo pos:', JSON.stringify(Object.keys(pos).slice(0, 6)))
      return H
    }
    // Decide onde entram os "— continuação": posição tentada de cada bloco + altura real →
    // página final (cabe = fica; não cabe = bloco indivisível desce inteiro). Itera até
    // estabilizar (inserir título desloca os blocos seguintes).
    async function calcularContinuacoes(m, buildDoc) {
      const mLeve = trocaImgs(m, PIX)
      let contSet = new Set()
      for (let passo = 0; passo < 5; passo++) {
        const H = await medirBlocos(mLeve, contSet, buildDoc)
        if (!H) return contSet
        const pos = await renderLayout(buildDoc(mLeve, contSet))
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

    // ── saída ──
    function download(dd, arquivo) {
      return new Promise((resolve, reject) => {
        try { pdfMake.createPdf(dd).download(arquivo, resolve) } catch (e) { reject(e) }
      })
    }
    function getBlob(dd) {
      return new Promise((resolve, reject) => {
        try { pdfMake.createPdf(dd).getBlob(resolve) } catch (e) { reject(e) }
      })
    }

    return {
      consts: { AZ, BLUE, GREEN, INK, GRAY, MUTED, LINE, BG, ZEBRA, PAGE_W, PAGE_H, MARG, TOPM, BOTM, CW, BOTTOM },
      carregarPdfMake, imgParaPdf, mapaParaPdf, prepararImagens,
      sec, pill, field, grid, secGrid, statCards, tabela, textBox, secBloco,
      tabelaFluida, cel, celNum, fotoLayout, fotoRows, fotosSection,
      fmtDataBR, minutosDe, durStr, money, luminancia,
      renderLayout, trocaImgs, medirBlocos, calcularContinuacoes,
      download, getBlob,
    }
  }

  return { create, PIX, DEFAULT_THEME }
})()
