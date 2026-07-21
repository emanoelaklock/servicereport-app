/* ═══════════════════════════════════════════════
   Service Report — pdf-tarefa.js (TEMPLATE da RAT/Tarefa)
   PDF VETORIAL dos atendimentos sobre o MOTOR COMPARTILHADO (PdfEngine,
   js/shared-pdf/pdf-engine.js — repo tsrv-pdf-engine, sincronizado por tag;
   NUNCA editar a cópia vendorizada à mão — ver docs/pdf-engine-f1.md):
   · Tarefa (m.capa preenchida): capa/dossiê + todas as RATs;
   · RAT avulsa / PDF unificado (m.capa = null): só os corpos de RAT, com o
     cliente na faixa de cada RAT e m.headerRight no cabeçalho das páginas.
   Texto real (selecionável/pesquisável), tabelas e linhas vetoriais, fonte Roboto
   embutida (subset). Layout aprovado na PoC (Tarefa 04826): header em faixa navy,
   seções com barra azul, tabelas zebradas, badges, grade de fotos adaptável
   (1/2/3 col, 2×2 p/ 4), "Fotos — continuação" nas páginas seguintes,
   "RAT — dados do atendimento" indivisível. Exposto como window.PdfTarefa.
   Depende de: pdf-engine.js (PdfEngine) e rat-view.js (RatView).
═══════════════════════════════════════════════ */
window.PdfTarefa = (function () {
  'use strict'

  // Motor compartilhado com o tema padrão (= SR) e a única dependência externa (fmtMin).
  // O vendor (pdfmake/vfs) continua em js/vendor/ — mesmo caminho e cache do SW de sempre.
  const E = PdfEngine.create({ vendorPath: 'js/vendor/', deps: { fmtMin: (min) => RatView.fmtMin(min) } })
  const { AZ, BLUE, GREEN, INK, GRAY, MUTED, LINE, BG, PAGE_W, MARG, TOPM, BOTM, CW } = E.consts
  const { sec, pill, grid, secGrid, statCards, tabela, textBox, secBloco, tabelaFluida,
          cel, celNum, fotosSection, fmtDataBR, durStr, money } = E

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

  // ── entrada única (API inalterada): monta imagens, mede continuações e baixa o PDF ──
  // m: modelo montado por tarefa.js (dados resolvidos + dets do RatView.loadDetalhe)
  async function gerar(m) {
    await E.carregarPdfMake()
    await E.prepararImagens(m)
    const contSet = await E.calcularContinuacoes(m, docDefinition)
    const dd = docDefinition(m, contSet)
    await E.download(dd, m.arquivo)
  }

  return { gerar }
})()
