/* ═══════════════════════════════════════════════
   Service Report — rat-view.js
   Renderização compartilhada do detalhe da RAT (back-office):
   layout de relatório (tela) e edição de campos. A geração de PDF mora em
   pdf-tarefa.js (motor vetorial pdfmake — Tarefa, RAT avulsa e unificado).
   Usado dentro da tela de Tarefas (Conciliação). Depende de: utils.js (esc, fdt),
   supabase-client.js (getSupabase). Exposto como window.RatView.
═══════════════════════════════════════════════ */
window.RatView = (function () {
  let forms = {}   // id do formulário -> array de campos

  // Dados do emitente (cabeçalho do documento) — mesmos do orçamento/TSRV.
  const EMPRESA = {
    nome: 'Traders Service Soluções em Tecnologia',
    cnpj: '10.923.494/0001-30',
    tel: '(47) 3025-2660',
    email: 'suporte@tsrv.com.br',
    endereco: 'R. Dona Francisca, 8300 — Via Trieste, Prédio 02 · Perini Business Park · Joinville-SC · 89.219-600',
  }

  // Colunas necessárias para montar o detalhe de uma RAT (inclui dados fiscais do cliente e da OS).
  const RAT_SELECT = 'id,cliente_id,cliente_nome,tecnico_nome,data_tarefa,status,sync_status,pendencias,assinatura_url,respostas,tempo_trabalhado,formulario_id,rat_seq,checkin_lat,checkin_lng,checkin_precisao,checkin_em,atendimento_executado,motivo_improdutiva,motivo_texto,tipos_servico(nome),cliente:clientes(nome,documento,endereco),tarefa:tarefas(id,numero,cliente_id,tipo_servico_id,orientacao,tipo:tipos_servico(nome))'

  async function ensureForms() {
    if (Object.keys(forms).length) return
    const { data } = await getSupabase().from('formulario_modelos').select('id,campos')
    forms = {}; (data || []).forEach(f => { forms[f.id] = f.campos || [] })
  }

  const fmtMin = (t) => (t == null) ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  const escMulti = (s) => esc(String(s == null ? '' : s)).replace(/\n/g, '<br>')
  // Data ISO (AAAA-MM-DD) → DD/MM/AAAA por split de string (sem new Date, evita off-by-one UTC).
  const fmtDataBR = (s) => { const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : esc(String(s == null ? '' : s)) }
  const tipoNomeRat = (r) => (r.tarefa && r.tarefa.tipo && r.tarefa.tipo.nome) || (r.tipos_servico && r.tipos_servico.nome) || '—'

  const STATUS = {
    em_andamento:        { label: 'Em andamento',           cls: 'st-run' },
    registrado:          { label: 'Atendimento Realizado',  cls: 'st-ok' },
    concluida:           { label: 'Concluída',              cls: 'st-ok' },
    concluida_pendencia: { label: 'Concluída c/ pendência', cls: 'st-pend' },
    improdutiva:         { label: 'Visita improdutiva',     cls: 'st-pend' },
  }
  const statusInfo = (s) => STATUS[s] || { label: s || '—', cls: '' }
  // Motivos da visita improdutiva (mesmas chaves do app do técnico)
  const MOTIVO_IMPRODUTIVA = {
    cliente_nao_liberou: 'Cliente não liberou acesso',
    local_nao_pronto: 'Local não estava pronto',
    falta_material: 'Falta de peça / material',
    clima: 'Condições climáticas',
    equip_cliente_indisponivel: 'Equipamento do cliente indisponível',
    outro: 'Outro motivo',
  }
  const motivoImprodutivaLabel = (r) => {
    const base = MOTIVO_IMPRODUTIVA[r.motivo_improdutiva] || r.motivo_improdutiva || '—'
    return (r.motivo_improdutiva === 'outro' && r.motivo_texto) ? `${base}: ${r.motivo_texto}` : base
  }

  // ── Tempo trabalhado (mesma regra do app do técnico) ──
  // NOVO: execução + ida + retorno (que existiram) − almoço − pausa.
  // LEGADO: RAT antiga (só a chave `deslocamento`) → janela única ida→retorno; senão execução.
  const minutosDe = (hhmm) => { if (!hhmm) return null; const [h, m] = String(hhmm).split(':').map(Number); return (isNaN(h) || isNaN(m)) ? null : h * 60 + m }
  function calcTempoDe(resp) {
    resp = resp || {}
    // horários são só HH:MM (sem data): término < início = virou a meia-noite → +24h
    const dur = (ini, fim) => { const a = minutosDe(ini), b = minutosDe(fim); if (a == null || b == null) return 0; let d = b - a; if (d < 0) d += 1440; return d }
    const alm = dur(resp.almoco_inicio, resp.almoco_termino), pau = dur(resp.pausa_inicio, resp.pausa_termino)
    const temNovo = (resp.desloc_ida != null && resp.desloc_ida !== '') || (resp.desloc_retorno != null && resp.desloc_retorno !== '')
    if (temNovo) {
      const exec = (resp.hora_inicio && resp.hora_termino) ? dur(resp.hora_inicio, resp.hora_termino) : 0
      const ida = resp.desloc_ida === 'Sim' ? dur(resp.desloc_inicial_ida, resp.desloc_final_ida) : 0
      const ret = resp.desloc_retorno === 'Sim' ? dur(resp.desloc_inicial_retorno, resp.desloc_final_retorno) : 0
      if (!resp.hora_inicio && !ida && !ret) return null
      const t = exec + ida + ret - alm - pau
      return t < 0 ? 0 : t
    }
    let ini, fim
    if (resp.deslocamento === 'Sim') { ini = resp.desloc_inicial_ida; fim = resp.desloc_final_retorno }
    else { ini = resp.hora_inicio; fim = resp.hora_termino }
    const a = minutosDe(ini), b = minutosDe(fim)
    if (a == null || b == null) return null
    let bruto = b - a; if (bruto < 0) bruto += 1440
    const t = bruto - alm - pau
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
  // Reavalia condicionais ao vivo no editor: lê os valores atuais dos inputs e mostra/esconde
  // cada campo (ex.: almoço/pausa/deslocamento = "Sim" revela os horários de início/término).
  function aplicarCondicionais(container, campos) {
    if (!container || !Array.isArray(campos)) return
    const resp = {}
    container.querySelectorAll('[data-campo]').forEach(el => { resp[el.getAttribute('data-campo')] = el.value })
    for (const c of campos) {
      const wrap = container.querySelector(`[data-cwrap="${c.id}"]`)
      if (wrap) wrap.style.display = campoVisivel(c, resp) ? '' : 'none'
    }
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
  // opts.noHeader: omite o cabeçalho interno (a página desenha o seu próprio).
  function buildReportBody(d, edit, opts) {
    opts = opts || {}
    const { r, campos, mats, fotos, sigUrl } = d
    const resp = r.respostas || {}
    const SKIP = new Set(['foto', 'produtos', 'assinatura'])
    const baseNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null
    const tarefaNo = baseNo ? (baseNo + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : '')) : null

    let h = `<div class="rd">`
    // PDF: cliente já está no topo do documento (capa) → header da RAT é enxuto, sem repetir
    // cliente nem contrato. "RAT NNNNN/SS · Técnico · Data" + status/tempo.
    if (opts.slim) h += `
      <div class="rd-head rd-head-slim">
        <div class="rd-sub">RAT ${tarefaNo ? esc(tarefaNo) : '—'} · ${esc(r.tecnico_nome || '—')} · ${fdt(r.data_tarefa, { numeric: true })}</div>
        <div class="rd-meta"><span><b>Status:</b> ${esc(statusInfo(r.status).label)}</span><span><b>Tempo:</b> ${fmtMin(tempoRat(r))}</span></div>
      </div>`
    else if (!opts.noHeader) h += `
      <div class="rd-head">
        <div class="rd-cli">${esc(r.cliente_nome || '—')}</div>
        <div class="rd-sub">${esc(tipoNomeRat(r))}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}</div>
        <div class="rd-meta">
          <span><b>Técnico:</b> ${esc(r.tecnico_nome || '—')}</span>
          <span><b>Data:</b> ${fdt(r.data_tarefa, { numeric: true })}</span>
          <span><b>Status:</b> ${esc(statusInfo(r.status).label)}</span>
          <span><b>Tempo:</b> ${fmtMin(tempoRat(r))}</span>
        </div>
      </div>`

    if (edit) h += `<div class="rd-edit-hint">✎ Modo edição — você pode ajustar qualquer campo e o valor unitário dos produtos. O tempo é recalculado ao salvar.</div>`

    // Dados da OS
    const tf = r.tarefa || {}
    h += `<div class="rd-sec"><div class="rd-sec-t">Dados da OS</div><div class="rd-grid">
      <div class="rd-f"><label>Nº da OS</label><div class="v">${tarefaNo ? '#' + tarefaNo : '—'}</div></div>
      <div class="rd-f"><label>Data da Tarefa</label><div class="v">${fdt(r.data_tarefa, { numeric: true })}</div></div>
      <div class="rd-f"><label>Tipo de tarefa</label><div class="v">${esc(tipoNomeRat(r))}</div></div>
      <div class="rd-f"><label>Duração</label><div class="v">${fmtMin(tempoRat(r))}</div></div>
      ${(r.checkin_lat != null && r.checkin_lng != null) ? `<div class="rd-f"><label>Local (GPS)</label><div class="v"><a href="https://www.google.com/maps?q=${r.checkin_lat},${r.checkin_lng}" target="_blank" rel="noopener">📍 ver no mapa</a>${r.checkin_precisao ? ` <span class="dim">(±${Math.round(r.checkin_precisao)} m)</span>` : ''}</div></div>` : ''}
      ${tf.orientacao ? `<div class="rd-f" style="grid-column:1/-1"><label>Orientação</label><div class="v">${escMulti(tf.orientacao)}</div></div>` : ''}
    </div></div>`

    // Visita improdutiva: destaque do motivo + permanência (execução não aconteceu; tarefa segue aguardando).
    if (r.status === 'improdutiva' || r.atendimento_executado === false) {
      const hi = resp.hora_inicio, hf = resp.hora_termino
      const mi = minutosDe(hi), mf = minutosDe(hf)
      const pDur = (mi != null && mf != null && mf >= mi) ? (mf - mi) : null
      h += `<div class="rd-sec"><div class="rd-sec-t">Visita improdutiva</div><div class="rd-grid">
        <div class="rd-f" style="grid-column:1/-1"><label>Motivo de não ter executado</label><div class="v">${esc(motivoImprodutivaLabel(r))}</div></div>
        ${(hi && hf) ? `<div class="rd-f" style="grid-column:1/-1"><label>Tempo no local (início–término)</label><div class="v">${esc(hi)} – ${esc(hf)}${pDur != null ? ' · ' + fmtMin(pDur) : ''}</div></div>` : ''}
        <div class="rd-f" style="grid-column:1/-1"><div class="v dim">Deslocamento e tempo no local ficam registrados (faturáveis); a execução foi zerada e a tarefa continua aguardando reagendamento.</div></div>
      </div></div>`
    }

    // Passagem (handoff): técnico encerrou o dia e vai voltar depois pra terminar — o que falta / levar.
    if (resp.volta_amanha === 'Não' && resp.passagem_motivo === 'volto_depois') {
      h += `<div class="rd-sec"><div class="rd-sec-t">Passagem — volta depois pra terminar</div><div class="rd-grid">
        ${resp.passagem_falta ? `<div class="rd-f" style="grid-column:1/-1"><label>O que falta</label><div class="v">${escMulti(resp.passagem_falta)}</div></div>` : ''}
        ${resp.passagem_levar ? `<div class="rd-f" style="grid-column:1/-1"><label>O que levar</label><div class="v">${escMulti(resp.passagem_levar)}</div></div>` : ''}
      </div></div>`
    }

    // Intervalos (almoço/pausa) saem da grade no modo leitura — viram a tabela "Pausas".
    const EXC_GRID = new Set(['almoco', 'almoco_inicio', 'almoco_termino', 'pausa', 'pausa_inicio', 'pausa_termino', 'pausa_motivo'])
    const grid = []
    const pausasGrid = []   // almoço/pausa no modo edição → seção própria "Pausas e almoço"
    const longSecs = []
    for (const c of campos) {
      if (SKIP.has(c.tipo)) continue
      const isExc = EXC_GRID.has(c.id)
      if (!edit && isExc) continue
      const isLong = c.tipo === 'texto_longo'
      const val = resp[c.id]
      const vazio = val == null || String(val).trim() === ''
      const vis = campoVisivel(c, resp)
      if (!edit) { if (!vis || vazio) continue }          // leitura: esconde invisível/vazio
      const hid = (edit && !vis) ? ' style="display:none"' : ''  // edição: renderiza tudo; condicional começa oculto e é revelado ao vivo
      if (isLong) {
        longSecs.push(`<div class="rd-sec" data-cwrap="${esc(c.id)}"${hid}><div class="rd-sec-t">${esc(c.label)}</div>` +
          (edit
            ? `<textarea class="rd-edit" data-campo="${esc(c.id)}" rows="5">${esc(String(val || ''))}</textarea>${typeof IA_BTN_HTML !== 'undefined' ? IA_BTN_HTML : ''}`
            : `<div class="rd-long">${escMulti(val) || '—'}</div>`) + `</div>`)
      } else {
        const f = `<div class="rd-f" data-cwrap="${esc(c.id)}"${hid}><label>${esc(c.label)}</label>` +
          (edit ? editInput(c, val) : `<div class="v">${(c.tipo === 'data' ? fmtDataBR(val) : escMulti(val)) || '—'}</div>`) + `</div>`
        if (edit && isExc) pausasGrid.push(f); else grid.push(f)
      }
    }
    if (grid.length) h += `<div class="rd-sec"><div class="rd-sec-t">RAT — dados do atendimento</div><div class="rd-grid">${grid.join('')}</div></div>`
    if (pausasGrid.length) h += `<div class="rd-sec"><div class="rd-sec-t">Pausas e almoço</div><div class="rd-grid">${pausasGrid.join('')}</div></div>`

    // Pausas e almoço — no modo leitura aparece SEMPRE que respondido (Sim com horários vira
    // tabela; "Não" fica explícito, pra não dar impressão de campo faltando). Fica junto dos
    // dados do atendimento (antes de Produtos), não lá embaixo.
    if (!edit && ((resp.almoco != null && resp.almoco !== '') || (resp.pausa != null && resp.pausa !== ''))) {
      const durStr = (a, b) => { const x = minutosDe(a), y = minutosDe(b); if (x == null || y == null) return '—'; let d = y - x; if (d < 0) d += 1440; return fmtMin(d) }
      const pausas = []
      if (resp.almoco === 'Sim' && (resp.almoco_inicio || resp.almoco_termino)) pausas.push({ ini: resp.almoco_inicio, fim: resp.almoco_termino, motivo: 'Almoço' })
      if (resp.pausa === 'Sim' && (resp.pausa_inicio || resp.pausa_termino || resp.pausa_motivo)) pausas.push({ ini: resp.pausa_inicio, fim: resp.pausa_termino, motivo: resp.pausa_motivo || 'Pausa' })
      const resumo = []
      if (resp.almoco != null && resp.almoco !== '') resumo.push(`Almoço: <b>${esc(resp.almoco)}</b>`)
      if (resp.pausa != null && resp.pausa !== '') resumo.push(`Pausa: <b>${esc(resp.pausa)}</b>`)
      h += `<div class="rd-sec"><div class="rd-sec-t">Pausas e almoço</div>`
        + (resumo.length ? `<div style="font-size:13px;line-height:1.6;color:#2b3447${pausas.length ? ';margin-bottom:10px' : ''}">${resumo.join(' · ')}</div>` : '')
        + (pausas.length ? `<table class="rd-pausas"><thead><tr><th>Início</th><th>Fim</th><th>Tempo</th><th>Justificativa/Motivo</th></tr></thead><tbody>`
            + pausas.map(p => `<tr><td>${esc(p.ini || '—')}</td><td>${esc(p.fim || '—')}</td><td>${durStr(p.ini, p.fim)}</td><td>${esc(p.motivo)}</td></tr>`).join('')
            + `</tbody></table>` : '')
        + `</div>`
    }
    h += longSecs.join('')

    // Produtos com preço (editável no modo edição) + Resumo de Valores
    const adminEdit = edit && opts && opts.adminEdit
    const mostrarValores = opts.valores !== false   // tela/editor mostram; PDF-cliente passa valores:false
    const soUtilizados = opts.zerados === false      // esconde itens de qtd 0 só quando pedido (PDF)
    const matsView = (mats || []).filter(m => !soUtilizados || (Number(m.quantidade) || 0) > 0)
    if (matsView.length || adminEdit) {
      const total = matsView.reduce((s, m) => s + (Number(m.subtotal) || 0), 0)
      // Conflito de material colaborativo: 2+ autores (created_by) na mesma RAT → avisa e rotula por autor.
      const autores = [...new Set(matsView.map(m => m.created_by).filter(Boolean))]
      const temConflito = adminEdit && autores.length >= 2   // só no editor admin (não no PDF/leitura)
      h += `<div class="rd-sec"><div class="rd-sec-t">Produtos${soUtilizados ? ' utilizados' : ''}</div>` +
        (temConflito ? `<div class="rd-conflito">⚠ Conflito de material — ${autores.length} técnicos lançaram produto nesta RAT. Mantenha um conjunto e remova o duplicado (×); ao sobrar um, o conflito some e o faturamento libera.</div>` : '') +
        `<table class="rd-prodtbl"><thead><tr><th>Produto</th><th class="num">Qtd</th>${mostrarValores ? '<th class="num">Valor unit.</th><th class="num">Subtotal</th>' : ''}${adminEdit ? '<th></th>' : ''}</tr></thead><tbody id="rd-prodbody">` +
        matsView.map(m => `<tr data-matrow="${esc(m.id)}">
          <td>${esc(m.descricao || m.codigo || '—')}${(temConflito && m.autor) ? `<div class="rd-autor">por ${esc(m.autor)}</div>` : ''}</td>
          <td class="num">${adminEdit ? `<input class="rd-qtd" data-matqtd="${esc(m.id)}" type="number" step="any" min="0" value="${m.quantidade}">` : esc(String(m.quantidade))}</td>
          ${mostrarValores ? `<td class="num">${edit ? `<input class="rd-preco" data-mat="${esc(m.id)}" type="number" step="0.01" min="0" value="${m.preco}">` : money(m.preco)}</td><td class="num">${money(m.subtotal)}</td>` : ''}
          ${adminEdit ? `<td class="num"><button type="button" class="rd-matdel" data-matdel="${esc(m.id)}" title="Remover">×</button></td>` : ''}
        </tr>`).join('') +
        `</tbody></table>` +
        (adminEdit ? `<div class="rd-addprod"><input id="rd-prodbusca" placeholder="+ Adicionar produto (código ou descrição)…" autocomplete="off"><div id="rd-prodres" class="rd-prodres" hidden></div></div>` : '') +
        (mostrarValores ? `<div class="rd-total">Total <b id="rd-prodtot">${money(total)}</b></div>` : '') + `</div>`
    }

    if ((fotos && fotos.length) || adminEdit) {
      h += `<div class="rd-sec"><div class="rd-sec-t">Fotos</div><div class="det-fotos" id="rd-fotos">` +
        (fotos || []).map(f => `<figure class="det-foto" data-fotorow="${esc(f.id)}">
          <img src="${f.url}" data-lb="${f.url}"${f.legenda ? ` data-lb-cap="${esc(f.legenda)}"` : ''} alt="" style="cursor:zoom-in">
          ${adminEdit
            ? `<button type="button" class="rd-fotodel" data-fotodel="${esc(f.id)}" title="Remover">×</button><input class="rd-fotoleg" data-fotoleg="${esc(f.id)}" value="${esc(f.legenda || '')}" placeholder="legenda">`
            : (f.legenda ? `<figcaption>${esc(f.legenda)}</figcaption>` : '')}
        </figure>`).join('') + `</div>` +
        (adminEdit ? `<label class="rd-fotoadd">+ Adicionar foto<input type="file" id="rd-fotoinput" accept="image/*" multiple hidden></label>` : '') +
        `</div>`
    }
    if (sigUrl) h += `<div class="rd-sec"><div class="rd-sec-t">Assinatura</div><img class="det-sig" src="${sigUrl}" alt=""></div>`
    h += `</div>`
    return h
  }

  // Carrega tudo de uma RAT (form, materiais usados c/ preço, fotos e assinatura assinadas).
  async function loadDetalhe(r) {
    await ensureForms()
    const sb = getSupabase()
    const campos = forms[r.formulario_id] || []
    const { data: matsRaw } = await sb.from('materiais')
      .select('id,produto_id,codigo_produto,descricao,quantidade,preco_unitario,created_by').eq('rat_id', r.id).eq('origem', 'usado')
    const pids = [...new Set((matsRaw || []).map(m => m.produto_id).filter(Boolean))]
    const precoCat = {}
    if (pids.length) {
      const { data: ps } = await sb.from('produtos').select('id,preco_venda').in('id', pids)
      ; (ps || []).forEach(p => { precoCat[p.id] = Number(p.preco_venda) || 0 })
    }
    // Autor de cada linha (conflito de material colaborativo): resolve created_by → nome do técnico.
    const aids = [...new Set((matsRaw || []).map(m => m.created_by).filter(Boolean))]
    const nomeAutor = {}
    if (aids.length) {
      const { data: us } = await sb.from('usuarios').select('id,nome').in('id', aids)
      ; (us || []).forEach(u => { nomeAutor[u.id] = u.nome })
    }
    const mats = (matsRaw || []).map(m => {
      const preco = m.preco_unitario != null ? Number(m.preco_unitario) : (m.produto_id ? (precoCat[m.produto_id] || 0) : 0)
      const qtd = Number(m.quantidade) || 0
      return { id: m.id, descricao: m.descricao, codigo: m.codigo_produto, quantidade: qtd, preco, subtotal: qtd * preco, created_by: m.created_by || null, autor: nomeAutor[m.created_by] || null }
    })
    const { data: fotosRaw } = await sb.from('relatorio_fotos').select('id,url,legenda').eq('rat_id', r.id)
    const comUrl = (fotosRaw || []).filter(f => f.url)
    let fotos = []
    if (comUrl.length) {
      const meta = {}; comUrl.forEach(f => { meta[f.url] = { id: f.id, legenda: f.legenda } })
      const { data: signed } = await sb.storage.from('rat-anexos').createSignedUrls(comUrl.map(f => f.url), 3600)
      fotos = (signed || []).filter(s => s.signedUrl).map(s => ({ id: (meta[s.path] || {}).id, path: s.path, url: s.signedUrl, legenda: (meta[s.path] || {}).legenda || '' }))
    }
    let sigUrl = null
    if (r.assinatura_url) {
      const { data: sg } = await sb.storage.from('rat-anexos').createSignedUrl(r.assinatura_url, 3600)
      sigUrl = (sg && sg.signedUrl) || null
    }
    return { r, campos, mats: mats || [], fotos, sigUrl }
  }

  // Coleta as respostas e os preços editados do container e devolve {respostas, tempo, precos}.
  function coletarEdicao(container, det) {
    const resp = Object.assign({}, det.r.respostas || {})
    container.querySelectorAll('[data-campo]').forEach(el => { resp[el.getAttribute('data-campo')] = el.value })
    // Condicional oculto (ex.: Pausa=Não) → limpa os filhos, senão o horário fica ÓRFÃO no respostas
    // e o cálculo continua descontando (calcTempoDe olha a presença do horário, não a flag). Espelha
    // o coletarRespostas do app, que já pula campo oculto. Uma passada cobre condicional de 1 nível.
    for (const c of (det.campos || [])) if (!campoVisivel(c, resp)) resp[c.id] = ''
    const precos = []
    container.querySelectorAll('[data-mat]').forEach(el => { precos.push({ id: el.getAttribute('data-mat'), preco: el.value === '' ? null : Number(el.value) }) })
    return { respostas: resp, tempo: calcTempoDe(resp), precos }
  }

  // Persiste os preços editados dos produtos (materiais.preco_unitario).
  async function salvarPrecos(precos) {
    if (!precos || !precos.length) return
    const sb = getSupabase()
    for (const p of precos) await sb.from('materiais').update({ preco_unitario: p.preco }).eq('id', p.id)
  }


  return {
    RAT_SELECT, ensureForms, loadDetalhe, buildReportBody, coletarEdicao, salvarPrecos, aplicarCondicionais,
    calcTempoDe, tempoRat, fmtMin, tipoNomeRat, statusInfo, campoVisivel, motivoImprodutivaLabel,
  }
})()
