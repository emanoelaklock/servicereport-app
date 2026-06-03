/* ═══════════════════════════════════════════════
   Service Report — orcamentos.js  (#4.3 Módulo Comercial)
   Portal do comercial: lista de orçamentos + editor.
   Cria do zero ou a partir de um pré-orçamento (pre_orcamento_id).
   Itens: serviço (preço manual) · material (preço do Omie, editável) ·
   avulso (preço manual). Total = soma dos subtotais (subtotal é coluna
   GERADA no banco). numero é IDENTITY (servidor). PDF = #4.5 (servidor).
   RLS office-only — técnico nunca acessa (preço protegido no nível de dados).
   Exposto como window.OrcamentosApp.
═══════════════════════════════════════════════ */
(function () {
  let ref = { clientes: [], produtos: [], preorcs: [] }
  let user = { id: null, nome: null }
  let cur = null          // { id, pre_orcamento_id, status, data_envio }
  let itens = []          // { _rid, tipo, produto_id, descricao, unidade, quantidade, preco_unitario }
  let filtro = 'ativos'
  let _seq = 0

  const sb = () => getSupabase()
  const rid = () => 'r' + (++_seq)

  const STATUS_LABEL = {
    rascunho: 'Rascunho', enviado: 'Enviado', aprovado: 'Aprovado',
    nao_aprovado: 'Não aprovado', arquivado: 'Arquivado',
  }
  const STATUS_CLS = {
    rascunho: 's-fi', enviado: 's-ai', aprovado: 's-en',
    nao_aprovado: 's-rm', arquivado: 's-sc',
  }
  function statusBadge(s) {
    return `<span class="badge ${STATUS_CLS[s] || 's-sc'}"><span class="dot"></span>${esc(STATUS_LABEL[s] || s)}</span>`
  }

  // Autocomplete com busca (mesmo padrão do app de campo).
  function attachAutocomplete(busca, hidden, list, items, fmt, onPick) {
    function render(q) {
      const nq = normStr(q)
      if (!nq) { list.classList.remove('open'); list.innerHTML = ''; return }
      const matches = []
      for (const it of items) {
        const f = fmt(it)
        if (normStr(f.label).includes(nq)) { matches.push(f); if (matches.length >= 30) break }
      }
      if (!matches.length) { list.innerHTML = '<div class="ac-empty">Nada encontrado</div>'; list.classList.add('open'); return }
      list.innerHTML = matches.map(m => `<div class="ac-item" data-id="${esc(m.id)}">${esc(m.label)}</div>`).join('')
      list.classList.add('open')
      list.querySelectorAll('.ac-item').forEach(el => {
        el.onmousedown = (e) => {
          e.preventDefault()
          if (hidden) hidden.value = el.dataset.id
          const m = matches.find(x => String(x.id) === el.dataset.id)
          busca.value = m ? m.label : ''
          list.classList.remove('open')
          if (onPick) onPick(el.dataset.id)
        }
      })
    }
    busca.oninput = () => { if (hidden) hidden.value = ''; render(busca.value) }
    busca.onfocus = () => { if (busca.value) render(busca.value) }
    busca.onblur = () => { setTimeout(() => list.classList.remove('open'), 150) }
  }

  // ─────────────────────────── Init ───────────────────────────
  async function init() {
    const { data: { user: u } } = await sb().auth.getUser()
    user.id = u?.id || null
    const ur = await getUserRole().catch(() => null)
    user.nome = ur?.nome || u?.email?.split('@')[0] || 'Comercial'

    bind()
    await carregarRef()
    await renderLista()
  }

  function bind() {
    document.getElementById('btn-novo').onclick = () => novoOrcamento(null)
    document.getElementById('btn-de-preorc').onclick = abrirSelecaoPreorc
    document.getElementById('btn-voltar').onclick = () => { cur = null; mostrar('lista'); renderLista() }
    document.getElementById('btn-salvar').onclick = () => salvar('rascunho')
    document.getElementById('btn-enviar').onclick = () => salvar('enviado')
    document.getElementById('btn-pdf').onclick = gerarPdf
    document.getElementById('btn-aprovar').onclick = aprovar
    document.getElementById('btn-naoaprovado').onclick = naoAprovado
    document.getElementById('btn-reabrir').onclick = reabrir
    document.getElementById('btn-arquivar').onclick = arquivar
    document.getElementById('btn-desarquivar').onclick = desarquivar
    document.getElementById('add-avulso').onclick = () => { addItem({ tipo: 'avulso', quantidade: 1, preco_unitario: 0 }); renderItens() }
    document.getElementById('add-material').onclick = adicionarMaterialSelecionado
    document.getElementById('e-servico-valor').oninput = recomputeTotais
    document.getElementById('e-obs-horario').onchange = toggleObsHorario
    document.getElementById('e-observacoes').oninput = syncObsHorarioCheckbox
    document.querySelectorAll('#orc-filtros .chip').forEach(ch => {
      ch.onclick = () => {
        filtro = ch.dataset.f
        document.querySelectorAll('#orc-filtros .chip').forEach(c => c.classList.toggle('on', c === ch))
        renderLista()
      }
    })
  }

  async function carregarRef() {
    const [cli, prod, pre] = await Promise.all([
      sb().from('clientes').select('id,nome,documento,endereco').eq('oculto', false).order('nome'),
      sb().from('produtos').select('id,codigo,descricao,unidade,preco_venda').eq('ativo', true).eq('oculto', false).order('descricao'),
      sb().from('pre_orcamentos').select('id,numero,cliente_id,cliente_nome,descricao,status').eq('status', 'concluido').order('numero', { ascending: false }),
    ])
    ref.clientes = cli.data || []
    ref.produtos = prod.data || []
    ref.preorcs = pre.data || []

    attachAutocomplete(
      document.getElementById('e-cliente-busca'),
      document.getElementById('e-cliente'),
      document.getElementById('e-cliente-list'),
      ref.clientes, c => ({ id: c.id, label: c.nome })
    )
    attachAutocomplete(
      document.getElementById('mat-busca'),
      document.getElementById('mat-sel'),
      document.getElementById('mat-list'),
      ref.produtos, p => ({ id: p.id, label: (p.codigo ? p.codigo + ' - ' : '') + (p.descricao || '') })
    )
  }

  // ─────────────────────────── Lista ───────────────────────────
  async function renderLista() {
    const box = document.getElementById('lista-box')
    box.innerHTML = '<p class="muted" style="padding:10px">Carregando…</p>'
    let q = sb().from('orcamentos').select('id,numero,cliente_id,status,valor_total,condicao_pagamento,data_envio,criado_em,pre_orcamento_id,arquivado')
    if (filtro === 'ativos') q = q.eq('arquivado', false).neq('status', 'arquivado')
    else if (filtro === 'arquivado') q = q.or('arquivado.eq.true,status.eq.arquivado')
    else q = q.eq('status', filtro).eq('arquivado', false)
    q = q.order('numero', { ascending: false })
    const { data, error } = await q
    if (error) { box.innerHTML = `<p class="muted" style="padding:10px;color:var(--re)">Erro: ${esc(error.message)}</p>`; return }
    if (!data || !data.length) { box.innerHTML = '<p class="muted" style="padding:14px 2px">Nenhum orçamento.</p>'; return }
    const cliNome = (id) => (ref.clientes.find(c => c.id === id) || {}).nome || '—'
    const semRetorno = (o) => {
      if (o.status !== 'enviado' || !o.data_envio) return ''
      const dias = Math.floor((Date.now() - new Date(o.data_envio).getTime()) / 86400000)
      return dias >= 90 ? ` <span class="badge s-rm"><span class="dot"></span>sem retorno ${dias}d</span>` : ''
    }
    box.innerHTML = `<table class="orc-table">
      <thead><tr><th>Nº</th><th>Cliente</th><th>Status</th><th>Total</th><th>Enviado</th><th>Criado</th></tr></thead>
      <tbody>${data.map(o => `
        <tr class="row-click" data-id="${esc(o.id)}">
          <td class="orc-num">${esc(o.numero)}</td>
          <td>${esc(cliNome(o.cliente_id))}${o.pre_orcamento_id ? ' <span class="muted">· de pré-orç</span>' : ''}</td>
          <td>${statusBadge(o.status)}${semRetorno(o)}</td>
          <td class="orc-total">${money(o.valor_total)}</td>
          <td>${o.data_envio ? fdt(o.data_envio) : '<span class="muted">—</span>'}</td>
          <td>${fdt(o.criado_em)}</td>
        </tr>`).join('')}</tbody></table>`
    box.querySelectorAll('.row-click').forEach(tr => { tr.onclick = () => abrirOrcamento(tr.dataset.id) })
  }

  // ─────────────────── Seleção de pré-orçamento ───────────────────
  function abrirSelecaoPreorc() {
    if (!ref.preorcs.length) return toast('Nenhum pré-orçamento concluído disponível.', 'info')
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px'
    const cliNome = (id, fb) => (ref.clientes.find(c => c.id === id) || {}).nome || fb || '—'
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:80vh;overflow:auto;box-shadow:var(--sh)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--bd);font-weight:600">Escolher pré-orçamento</div>
      <div id="pre-list" style="padding:6px 0">${ref.preorcs.map(p => `
        <div class="ac-item" data-id="${esc(p.id)}" style="border-top:1px solid var(--bd)">
          <strong>Nº ${esc(p.numero)}</strong> · ${esc(cliNome(p.cliente_id, p.cliente_nome))}
          <div class="muted">${esc((p.descricao || '').slice(0, 70))}</div>
        </div>`).join('')}</div>
      <div style="padding:12px 18px;text-align:right;border-top:1px solid var(--bd)"><button class="btn" id="pre-cancel">Cancelar</button></div>
    </div>`
    document.body.appendChild(ov)
    ov.querySelector('#pre-cancel').onclick = () => ov.remove()
    ov.onclick = (e) => { if (e.target === ov) ov.remove() }
    ov.querySelectorAll('#pre-list .ac-item').forEach(el => {
      el.onclick = async () => { const id = el.dataset.id; ov.remove(); await novoOrcamentoDePreorc(id) }
    })
  }

  // ─────────────────────────── Editor ───────────────────────────
  function mostrar(secao) {
    document.getElementById('view-lista').style.display = secao === 'lista' ? 'block' : 'none'
    document.getElementById('view-editor').style.display = secao === 'editor' ? 'block' : 'none'
    document.getElementById('topbar-title').textContent = secao === 'editor' ? 'Orçamento' : 'Orçamentos'
  }

  function setCliente(id, nome) {
    document.getElementById('e-cliente').value = id || ''
    document.getElementById('e-cliente-busca').value = nome || (ref.clientes.find(c => c.id === id) || {}).nome || ''
  }

  function novoOrcamento(preorc) {
    cur = { id: null, pre_orcamento_id: preorc ? preorc.id : null, status: 'rascunho', data_envio: null, arquivado: false }
    itens = []
    setCliente(preorc ? preorc.cliente_id : '', preorc ? preorc.cliente_nome : '')
    document.getElementById('e-origem').value = preorc ? `Pré-orçamento Nº ${preorc.numero}` : 'Novo (sem pré-orçamento)'
    document.getElementById('e-observacoes').value = ''
    document.getElementById('e-condicao').value = ''
    document.getElementById('e-servico-desc').value = preorc ? (preorc.descricao || '') : ''
    document.getElementById('e-servico-valor').value = ''
    document.getElementById('e-prazo').value = ''
    document.getElementById('e-obs-horario').checked = false
    document.getElementById('ed-status').textContent = ''
    renderItens()
    aplicarEstado()
    mostrar('editor')
  }

  async function novoOrcamentoDePreorc(preId) {
    const pre = ref.preorcs.find(p => p.id === preId)
    novoOrcamento(pre)
    // puxa os materiais necessários do pré-orçamento como itens (preço do Omie)
    const { data, error } = await sb().from('pre_orcamento_itens')
      .select('produto_id,codigo_produto,descricao,unidade,quantidade').eq('pre_orcamento_id', preId)
    if (error) return toast('Erro ao ler itens do pré-orçamento: ' + error.message, 'err')
    ;(data || []).forEach(m => {
      const p = ref.produtos.find(x => x.id === m.produto_id)
      addItem({
        tipo: 'material', produto_id: m.produto_id || null,
        descricao: m.descricao || (p ? p.descricao : '') || m.codigo_produto || '',
        unidade: m.unidade || (p ? p.unidade : null),
        quantidade: Number(m.quantidade) || 1,
        preco_unitario: p ? (Number(p.preco_venda) || 0) : 0,
      })
    })
    renderItens()
    if (data && data.length) toast(`${data.length} material(is) trazido(s) do pré-orçamento.`, 'ok')
  }

  async function abrirOrcamento(id) {
    const [{ data: o, error: e1 }, { data: its, error: e2 }] = await Promise.all([
      sb().from('orcamentos').select('*').eq('id', id).single(),
      sb().from('orcamento_itens').select('*').eq('orcamento_id', id).order('criado_em'),
    ])
    if (e1 || !o) return toast('Erro ao abrir orçamento.', 'err')
    cur = { id: o.id, pre_orcamento_id: o.pre_orcamento_id, status: o.status, data_envio: o.data_envio, arquivado: !!o.arquivado }
    itens = (its || []).filter(m => m.tipo === 'material' || m.tipo === 'avulso').map(m => ({
      _rid: rid(), tipo: m.tipo, produto_id: m.produto_id, descricao: m.descricao || '',
      unidade: m.unidade, quantidade: Number(m.quantidade) || 0, preco_unitario: Number(m.preco_unitario) || 0,
    }))
    setCliente(o.cliente_id)
    document.getElementById('e-origem').value = o.pre_orcamento_id ? 'A partir de pré-orçamento' : 'Novo (sem pré-orçamento)'
    document.getElementById('e-observacoes').value = o.observacoes || ''
    document.getElementById('e-condicao').value = o.condicao_pagamento || ''
    document.getElementById('e-servico-desc').value = o.servico_descricao || ''
    document.getElementById('e-servico-valor').value = (o.servico_valor != null && Number(o.servico_valor) !== 0) ? o.servico_valor : ''
    document.getElementById('e-prazo').value = o.prazo_execucao || ''
    syncObsHorarioCheckbox()
    document.getElementById('ed-status').textContent = `Nº ${o.numero} · ${STATUS_LABEL[o.status] || o.status}`
    if (e2) toast('Aviso: itens não carregaram: ' + e2.message, 'err')
    renderItens()
    aplicarEstado()
    mostrar('editor')
  }

  // ── Itens ──
  function addItem(it) {
    itens.push({ _rid: rid(), tipo: it.tipo, produto_id: it.produto_id || null, descricao: it.descricao || '',
      unidade: it.unidade || null, quantidade: it.quantidade != null ? it.quantidade : 1, preco_unitario: it.preco_unitario || 0 })
  }

  function adicionarMaterialSelecionado() {
    const pid = document.getElementById('mat-sel').value
    if (!pid) return toast('Busque e selecione um produto.', 'err')
    const p = ref.produtos.find(x => x.id === pid)
    if (!p) return
    addItem({ tipo: 'material', produto_id: p.id, descricao: p.descricao, unidade: p.unidade, quantidade: 1, preco_unitario: Number(p.preco_venda) || 0 })
    document.getElementById('mat-sel').value = ''
    document.getElementById('mat-busca').value = ''
    renderItens()
  }

  function linhaHTML(it) {
    return `<tr data-rid="${it._rid}">
      <td><input type="text" data-f="descricao" value="${esc(it.descricao)}" placeholder="Descrição"></td>
      <td class="col-qtd"><input type="number" data-f="quantidade" inputmode="decimal" min="0" step="any" value="${it.quantidade}"></td>
      <td class="col-preco"><input type="number" data-f="preco_unitario" inputmode="decimal" min="0" step="any" value="${it.preco_unitario}"></td>
      <td class="col-sub" data-sub>${money((Number(it.quantidade) || 0) * (Number(it.preco_unitario) || 0))}</td>
      <td class="col-x"><button class="it-x" title="Remover">×</button></td>
    </tr>`
  }

  function renderItens() {
    const tbM = document.getElementById('tb-material')
    tbM.innerHTML = itens.length ? itens.map(linhaHTML).join('') : '<tr><td colspan="5" class="muted">Nenhum material.</td></tr>'
    bindLinhas()
    recomputeTotais()
  }

  function bindLinhas() {
    document.querySelectorAll('#tb-material tr[data-rid]').forEach(tr => {
      const it = itens.find(x => x._rid === tr.dataset.rid)
      if (!it) return
      tr.querySelectorAll('input[data-f]').forEach(inp => {
        inp.oninput = () => {
          const f = inp.dataset.f
          it[f] = (f === 'descricao') ? inp.value : (Number(inp.value) || 0)
          if (f !== 'descricao') {
            tr.querySelector('[data-sub]').textContent = money((Number(it.quantidade) || 0) * (Number(it.preco_unitario) || 0))
            recomputeTotais()
          }
        }
      })
      tr.querySelector('.it-x').onclick = () => { itens = itens.filter(x => x._rid !== it._rid); renderItens() }
    })
  }

  // Frase-padrão de observação via checkbox (insere/remove sem digitar).
  const OBS_HORARIO = 'Serviço executado em horário comercial (segunda a sexta, das 7h às 17h).'
  function toggleObsHorario() {
    const ta = document.getElementById('e-observacoes')
    const on = document.getElementById('e-obs-horario').checked
    const has = ta.value.includes(OBS_HORARIO)
    if (on && !has) ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + OBS_HORARIO
    else if (!on && has) ta.value = ta.value.replace(OBS_HORARIO, '').replace(/\s{2,}/g, ' ').trim()
  }
  function syncObsHorarioCheckbox() {
    document.getElementById('e-obs-horario').checked = document.getElementById('e-observacoes').value.includes(OBS_HORARIO)
  }

  // Valor do serviço (descrição livre + valor único — não é mais item).
  const servicoValor = () => Number(document.getElementById('e-servico-valor').value) || 0
  const somaMateriais = () => itens.reduce((s, i) => s + (Number(i.quantidade) || 0) * (Number(i.preco_unitario) || 0), 0)
  function recomputeTotais() {
    const ts = servicoValor()
    const tm = somaMateriais()
    document.getElementById('tot-servico').value = money(ts)
    document.getElementById('tot-material').textContent = money(tm)
    document.getElementById('rt-servico').textContent = money(ts)
    document.getElementById('rt-material').textContent = money(tm)
    document.getElementById('rt-total').textContent = money(ts + tm)
  }

  // ─────────────────────────── Salvar ───────────────────────────
  async function salvar(novoStatus) {
    if (!cur) return
    const cliId = document.getElementById('e-cliente').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    const servDesc = document.getElementById('e-servico-desc').value.trim()
    const servVal = servicoValor()
    const matVal = somaMateriais()
    const temServico = !!servDesc || servVal > 0
    const temMaterial = itens.some(i => (i.descricao || '').trim() || i.produto_id)
    if (!temServico && !temMaterial) return toast('Orçamento vazio: informe ao menos um serviço ou um material.', 'err')
    const valor_total = servVal + matVal
    const payload = {
      cliente_id: cliId,
      comercial_id: user.id,
      pre_orcamento_id: cur.pre_orcamento_id || null,
      servico_descricao: servDesc || null,
      servico_valor: servVal,
      prazo_execucao: document.getElementById('e-prazo').value.trim() || null,
      observacoes: document.getElementById('e-observacoes').value.trim() || null,
      condicao_pagamento: document.getElementById('e-condicao').value.trim() || null,
      valor_total,
      status: novoStatus,
    }
    if (novoStatus === 'enviado' && !cur.data_envio) payload.data_envio = new Date().toISOString().slice(0, 10)

    let orcId = cur.id
    if (orcId) {
      const up = await sb().from('orcamentos').update(payload).eq('id', orcId)
      if (up.error) return toast('Erro ao salvar: ' + up.error.message, 'err')
    } else {
      const ins = await sb().from('orcamentos').insert(payload).select('id,numero,data_envio').single()
      if (ins.error) return toast('Erro ao criar: ' + ins.error.message, 'err')
      orcId = ins.data.id
      cur.id = orcId
      cur.data_envio = ins.data.data_envio
      document.getElementById('ed-status').textContent = `Nº ${ins.data.numero} · ${STATUS_LABEL[novoStatus]}`
    }
    cur.status = novoStatus

    // Substitui os itens (delete + insert). subtotal é GERADA; numero IDENTITY.
    const del = await sb().from('orcamento_itens').delete().eq('orcamento_id', orcId)
    if (del.error) return toast('Erro ao limpar itens: ' + del.error.message, 'err')
    const rows = itens
      .filter(i => (i.descricao || '').trim() || i.produto_id)
      .map(i => ({
        orcamento_id: orcId, tipo: i.tipo, produto_id: i.produto_id || null,
        descricao: (i.descricao || '').trim() || null, unidade: i.unidade || null,
        quantidade: Number(i.quantidade) || 0, preco_unitario: Number(i.preco_unitario) || 0,
      }))
    if (rows.length) {
      const insI = await sb().from('orcamento_itens').insert(rows)
      if (insI.error) return toast('Erro ao salvar itens: ' + insI.error.message, 'err')
    }
    document.getElementById('ed-status').textContent = STATUS_LABEL[novoStatus] || novoStatus
    toast(novoStatus === 'enviado' ? 'Orçamento marcado como enviado.' : 'Rascunho salvo.', 'ok')
    aplicarEstado()
  }

  // ─────────────────────── Status / aprovação ───────────────────────
  async function invoke(fn, body) {
    try {
      const { data, error } = await sb().functions.invoke(fn, { body })
      if (error) {
        let m = error.message || 'falha'
        try { const c = await error.context?.json?.(); if (c?.error) m = c.error } catch (_) {}
        throw new Error(m)
      }
      if (data && data.error) throw new Error(data.error)
      return data
    } catch (e) { toast('Erro: ' + (e.message || e), 'err'); return null }
  }

  function setEditorEnabled(on) {
    ['e-cliente-busca', 'e-servico-desc', 'e-servico-valor', 'e-prazo', 'e-obs-horario', 'e-observacoes', 'e-condicao', 'mat-busca', 'add-material', 'add-avulso']
      .forEach(id => { const e = document.getElementById(id); if (e) e.disabled = !on })
    document.querySelectorAll('#tb-material input').forEach(i => { i.disabled = !on })
    document.querySelectorAll('#tb-material .it-x').forEach(b => { b.style.display = on ? '' : 'none' })
  }

  function aplicarEstado() {
    const locked = cur.status === 'aprovado'   // congelado
    const arq = !!cur.arquivado
    const editable = !locked && !arq
    setEditorEnabled(editable)
    const show = (id, on) => { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none' }
    show('btn-salvar', editable)
    show('btn-enviar', editable)
    show('btn-aprovar', editable)
    show('btn-naoaprovado', editable && cur.status !== 'nao_aprovado')
    show('btn-reabrir', !arq && cur.status === 'nao_aprovado')
    show('btn-arquivar', !arq && !!cur.id)
    show('btn-desarquivar', arq)
    show('btn-pdf', !!cur.id)
    const b = document.getElementById('ed-banner')
    if (arq) { b.style.display = 'block'; b.style.background = '#F1F5F9'; b.style.color = '#475569'; b.textContent = 'Arquivado — fora das listas ativas; histórico preservado.' }
    else if (locked) { b.style.display = 'block'; b.style.background = '#E8F5E9'; b.style.color = '#2E7D32'; b.textContent = cur._tarefaMsg || 'Aprovado — orçamento congelado; Tarefa (OS) gerada.' }
    else { b.style.display = 'none' }
  }

  async function aprovar() {
    if (!cur || !cur.id) return toast('Salve o orçamento antes de aprovar.', 'err')
    if (!confirm('Aprovar este orçamento? Gera a Tarefa (OS) e congela o orçado.')) return
    const r = await invoke('aprovar-orcamento', { id: cur.id })
    if (!r) return
    cur.status = 'aprovado'
    cur._tarefaMsg = r.tarefa_numero
      ? `Aprovado — Tarefa (OS) Nº ${r.tarefa_numero} gerada; orçamento congelado.`
      : 'Aprovado — Tarefa (OS) gerada; orçamento congelado.'
    document.getElementById('ed-status').textContent = 'Aprovado'
    toast(r.already ? 'Já estava aprovado.' : 'Aprovado e Tarefa gerada.', 'ok')
    aplicarEstado()
  }

  async function mudarStatusSimples(patch, novoStatus, msg) {
    if (!cur || !cur.id) return toast('Salve o orçamento primeiro.', 'err')
    const up = await sb().from('orcamentos').update(patch).eq('id', cur.id)
    if (up.error) return toast('Erro: ' + up.error.message, 'err')
    if (novoStatus) { cur.status = novoStatus; document.getElementById('ed-status').textContent = STATUS_LABEL[novoStatus] || novoStatus }
    toast(msg, 'ok')
    aplicarEstado()
  }

  const naoAprovado = () => mudarStatusSimples({ status: 'nao_aprovado', data_resposta: new Date().toISOString().slice(0, 10) }, 'nao_aprovado', 'Marcado como não aprovado.')
  const reabrir = () => mudarStatusSimples({ status: 'rascunho' }, 'rascunho', 'Reaberto para revisão.')
  const desarquivar = () => { cur.arquivado = false; mudarStatusSimples({ arquivado: false, arquivado_em: null }, null, 'Desarquivado.') }

  async function arquivar() {
    if (!cur || !cur.id) return toast('Salve o orçamento primeiro.', 'err')
    if (!confirm('Arquivar este orçamento? Sai das listas ativas; histórico preservado.')) return
    const up = await sb().from('orcamentos').update({ arquivado: true, arquivado_em: new Date().toISOString() }).eq('id', cur.id)
    if (up.error) return toast('Erro: ' + up.error.message, 'err')
    toast('Arquivado.', 'ok'); cur = null; mostrar('lista'); await renderLista()
  }

  // ─────────────────── PDF do orçamento (render do mockup → imprimir) ───────────────────
  // Reproduz fielmente docs/mockups/orcamento-pdf.html (Inter, A4). O usuário escolhe
  // "Salvar como PDF" no diálogo de impressão — saída vetorial, idêntica ao mockup.
  const nl2br = (s) => esc(s).replace(/\n/g, '<br>')
  const dmy = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR') }

  async function gerarPdf() {
    if (!cur || !cur.id) return toast('Salve o orçamento antes de gerar o PDF.', 'err')
    const [{ data: o, error: e1 }, { data: its, error: e2 }] = await Promise.all([
      sb().from('orcamentos').select('*').eq('id', cur.id).single(),
      sb().from('orcamento_itens').select('*').eq('orcamento_id', cur.id).order('criado_em'),
    ])
    if (e1 || !o) return toast('Erro ao carregar orçamento: ' + (e1 && e1.message || ''), 'err')
    if (e2) return toast('Erro ao carregar itens: ' + e2.message, 'err')
    const cli = ref.clientes.find(c => c.id === o.cliente_id) || {}
    const mats = (its || []).filter(i => i.tipo === 'material' || i.tipo === 'avulso')
    const html = orcamentoHTML(o, mats, cli, user.nome)
    const w = window.open('', '_blank')
    if (!w) return toast('Permita pop-ups para gerar o PDF.', 'err')
    w.document.open(); w.document.write(html); w.document.close()
  }

  function orcamentoHTML(o, mats, cli, geradoPor) {
    const servVal = Number(o.servico_valor) || 0
    const totMat = mats.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.preco_unitario) || 0), 0)
    const total = servVal + totMat
    const hasServico = !!(o.servico_descricao && o.servico_descricao.trim()) || servVal > 0
    const hasMateriais = mats.length > 0

    const meta = [['Emissão', dmy(o.data_envio || o.criado_em)], ['Validade', '15 dias']]
    if (o.prazo_execucao) meta.push(['Prazo de execução', esc(o.prazo_execucao)])

    const escopo = hasServico ? `
      <section class="sec">
        <div class="sh"><span class="dot"></span><span class="t">Escopo do serviço</span></div>
        <div class="scope">
          <div class="scope-desc">${nl2br(o.servico_descricao || '')}</div>
          <div class="scope-val"><span class="k">Valor do serviço</span><span class="v num">${money(servVal)}</span></div>
        </div>
      </section>` : ''

    const materiais = hasMateriais ? `
      <section class="sec">
        <div class="sh"><span class="dot"></span><span class="t">Materiais</span></div>
        <table>
          <colgroup><col style="width:44%"><col style="width:9%"><col style="width:11%"><col style="width:18%"><col style="width:18%"></colgroup>
          <thead><tr><th class="l">Descrição</th><th class="c">Un.</th><th class="c">Qtd</th><th>Valor unit.</th><th>Total</th></tr></thead>
          <tbody>${mats.map(m => { const q = Number(m.quantidade) || 0, p = Number(m.preco_unitario) || 0; return `
            <tr><td class="l">${nl2br(m.descricao || '—')}</td><td class="c">${esc(m.unidade || '—')}</td><td class="c num">${q.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}</td><td class="unit num">${money(p)}</td><td class="tot num">${money(q * p)}</td></tr>`
    }).join('')}</tbody>
        </table>
      </section>` : ''

    const subs = (hasServico && hasMateriais) ? `
      <div class="row"><span>Subtotal · Serviços</span><span class="v num">${money(servVal)}</span></div>
      <div class="row"><span>Subtotal · Materiais</span><span class="v num">${money(totMat)}</span></div>` : ''
    const resumo = `
      <div class="summary"><div class="box">
        ${subs}
        <div class="total"><span class="l">Total geral</span><span class="v num">${money(total)}</span></div>
      </div></div>`

    const temCond = !!(o.condicao_pagamento || o.observacoes)
    const condTerms = `
      ${o.condicao_pagamento ? `<div class="trow"><span class="k">Forma de pagamento</span><span class="v">${esc(o.condicao_pagamento)}</span></div>` : ''}
      <div class="trow"><span class="k">Valor</span><span class="v num">${money(total)}</span></div>`
    const condObs = temCond ? `
      <section class="sec two">
        <div class="col">
          <div class="sh"><span class="dot"></span><span class="t">Condições comerciais</span></div>
          <div class="terms">${condTerms}</div>
        </div>
        <div class="col">
          <div class="sh"><span class="dot"></span><span class="t">Observações</span></div>
          <p class="obs-text">${o.observacoes ? nl2br(o.observacoes) : '—'}</p>
        </div>
      </section>` : ''

    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Orçamento Nº ${esc(o.numero)} — ${esc(cli.nome || 'Cliente')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--navy:#1B2A4A;--ink:#1d2533;--gray:#6B7280;--line:#E5E7EB;--line-soft:#F1F2F4;--card:#F8FAFC;--paper:#fff;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#e7eaef;}
body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.num{font-variant-numeric:tabular-nums;}
.page{width:794px;min-height:1123px;margin:30px auto;background:var(--paper);padding:48px 60px 26px;position:relative;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(20,30,55,.18);}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:32px;padding-bottom:20px;border-bottom:1.5px solid #d3d9e2;}
.brand{display:flex;align-items:center;gap:13px;}
.logo{width:46px;height:46px;border-radius:11px;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800;font-size:19px;letter-spacing:-1px;flex:none;}
.brand .nm{font-size:21px;font-weight:700;letter-spacing:-.4px;color:var(--ink);line-height:1;}
.brand .tg{font-size:11.5px;font-weight:500;color:var(--gray);margin-top:3px;}
.firm{text-align:right;font-size:10.5px;line-height:1.7;color:var(--gray);}
.firm b{display:block;color:var(--ink);font-weight:600;margin-bottom:2px;}
.intro{margin-top:26px;}
.intro-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;}
.intro-head h1{font-size:26px;font-weight:700;letter-spacing:-.8px;color:var(--ink);line-height:1;}
.docno{text-align:right;}
.docno .lbl{font-size:10.5px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--gray);}
.docno .no{font-size:20px;font-weight:700;color:#5a6884;letter-spacing:-.4px;display:block;margin-top:2px;}
.meta{display:flex;gap:52px;margin-top:20px;}
.meta .k{font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--gray);}
.meta .v{font-size:14px;font-weight:600;color:var(--ink);margin-top:5px;}
.client{margin-top:22px;padding-top:20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:flex-end;gap:40px;}
.eyebrow{font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--gray);margin-bottom:7px;}
.client .name{font-size:17px;font-weight:700;letter-spacing:-.2px;color:var(--ink);line-height:1.2;}
.client .det{text-align:right;font-size:11.5px;line-height:1.7;color:var(--gray);}
.sh{display:flex;align-items:center;gap:9px;margin-bottom:14px;}
.sh .dot{width:7px;height:7px;border-radius:50%;background:#8a93a6;flex:none;display:inline-block;}
.sh .t{font-size:12.5px;font-weight:600;letter-spacing:.2px;color:var(--ink);}
.sec{margin-top:36px;}
.scope{background:var(--card);border-radius:12px;padding:18px 24px;}
.scope-desc{font-size:13px;line-height:1.95;color:#3b3f46;}
.scope-val{display:flex;justify-content:space-between;align-items:baseline;margin-top:14px;padding-top:13px;border-top:1px solid var(--line);}
.scope-val .k{font-size:10.5px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--gray);}
.scope-val .v{font-size:18px;font-weight:700;color:var(--ink);}
table{width:100%;border-collapse:collapse;}
thead th{font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--gray);padding:0 10px 13px;border-bottom:1px solid var(--line);text-align:right;}
thead th.l{text-align:left;padding-left:2px;}
thead th.c{text-align:center;}
tbody td{font-size:12.5px;padding:12px 10px;border-bottom:1px solid var(--line-soft);text-align:right;color:var(--ink);}
tbody td.l{text-align:left;padding-left:2px;font-weight:500;line-height:1.55;}
tbody td.c{text-align:center;color:var(--gray);}
tbody td.unit{color:var(--gray);}
tbody td.tot{font-weight:700;}
.summary{display:flex;justify-content:flex-end;margin-top:24px;}
.summary .box{width:340px;}
.summary .row{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;padding:9px 0;color:var(--gray);}
.summary .row .v{color:var(--ink);font-weight:700;}
.summary .total{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:17px 20px;background:var(--navy);border-radius:12px;color:#fff;}
.summary .total .l{font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;opacity:.82;}
.summary .total .v{font-size:25px;font-weight:800;letter-spacing:-.6px;}
.two{display:flex;gap:42px;align-items:flex-start;}
.two .col{flex:1;min-width:0;}
.trow{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;padding:12px 0;border-bottom:1px solid var(--line-soft);}
.trow:last-child{border-bottom:none;}
.trow .k{color:var(--gray);font-weight:500;}
.trow .v{color:var(--ink);font-weight:600;}
.obs-text{font-size:11.5px;line-height:1.9;color:#4a4e56;}
.foot{margin-top:auto;padding-top:16px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--gray);}
.foot b{color:var(--ink);font-weight:600;}
@media print{@page{size:A4;margin:0;}html,body{background:#fff;}.page{box-shadow:none;margin:0;width:210mm;min-height:297mm;}}
</style></head>
<body>
<div class="page">
  <header class="head">
    <div class="brand"><div class="logo">TS</div><div>
      <div class="nm">Traders Service</div>
      <div class="tg">Infraestrutura · Redes · Segurança Eletrônica</div></div></div>
    <div class="firm"><b>Traders Service Soluções em Tecnologia LTDA</b>
      CNPJ 10.923.494/0001-30 · IE 255882904 · IM 96456<br>
      Rua Dona Francisca, 8300 — Via Trieste, Prédio 2<br>
      Zona Industrial Norte · Joinville-SC · 89219-600<br>(47) 3025-2660</div>
  </header>
  <section class="intro">
    <div class="intro-head"><h1>Proposta Comercial</h1>
      <div class="docno"><span class="lbl">Orçamento</span><span class="no">Nº ${esc(o.numero)}</span></div></div>
    <div class="meta">${meta.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}</div>
  </section>
  <div class="client">
    <div><div class="eyebrow">Cliente</div><div class="name">${esc(cli.nome || '—')}</div></div>
    <div class="det">${[cli.documento ? 'CNPJ ' + esc(cli.documento) : '', cli.endereco ? esc(cli.endereco) : ''].filter(Boolean).join('<br>') || '&nbsp;'}</div>
  </div>
  ${escopo}
  ${materiais}
  ${resumo}
  ${condObs}
  <footer class="foot">
    <span><b>Traders Service</b> · (47) 3025-2660 · comercial@tsrv.com.br · Joinville-SC</span>
    <span>Gerado em ${dmy(new Date().toISOString())} por ${esc(geradoPor || '')} · Página 1 de 1</span>
  </footer>
</div>
<script>window.onload=function(){var p=function(){window.focus();window.print();};(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){setTimeout(p,300)});};</script>
</body></html>`
  }

  window.OrcamentosApp = { init }
})()
