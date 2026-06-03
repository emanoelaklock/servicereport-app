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
    document.getElementById('add-servico').onclick = () => { addItem({ tipo: 'servico', quantidade: 1, preco_unitario: 0 }); renderItens() }
    document.getElementById('add-avulso').onclick = () => { addItem({ tipo: 'avulso', quantidade: 1, preco_unitario: 0 }); renderItens() }
    document.getElementById('add-material').onclick = adicionarMaterialSelecionado
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
    itens = (its || []).map(m => ({
      _rid: rid(), tipo: m.tipo, produto_id: m.produto_id, descricao: m.descricao || '',
      unidade: m.unidade, quantidade: Number(m.quantidade) || 0, preco_unitario: Number(m.preco_unitario) || 0,
    }))
    setCliente(o.cliente_id)
    document.getElementById('e-origem').value = o.pre_orcamento_id ? 'A partir de pré-orçamento' : 'Novo (sem pré-orçamento)'
    document.getElementById('e-observacoes').value = o.observacoes || ''
    document.getElementById('e-condicao').value = o.condicao_pagamento || ''
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
    const tbS = document.getElementById('tb-servico')
    const tbM = document.getElementById('tb-material')
    const serv = itens.filter(i => i.tipo === 'servico')
    const mat = itens.filter(i => i.tipo === 'material' || i.tipo === 'avulso')
    tbS.innerHTML = serv.length ? serv.map(linhaHTML).join('') : '<tr><td colspan="5" class="muted">Nenhum serviço.</td></tr>'
    tbM.innerHTML = mat.length ? mat.map(linhaHTML).join('') : '<tr><td colspan="5" class="muted">Nenhum material.</td></tr>'
    bindLinhas()
    recomputeTotais()
  }

  function bindLinhas() {
    document.querySelectorAll('#tb-servico tr[data-rid], #tb-material tr[data-rid]').forEach(tr => {
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

  function somaPorTipo(tipos) {
    return itens.filter(i => tipos.includes(i.tipo))
      .reduce((s, i) => s + (Number(i.quantidade) || 0) * (Number(i.preco_unitario) || 0), 0)
  }
  function recomputeTotais() {
    const ts = somaPorTipo(['servico'])
    const tm = somaPorTipo(['material', 'avulso'])
    document.getElementById('tot-servico').textContent = money(ts)
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
    const valor_total = somaPorTipo(['servico', 'material', 'avulso'])
    const payload = {
      cliente_id: cliId,
      comercial_id: user.id,
      pre_orcamento_id: cur.pre_orcamento_id || null,
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
    ['e-cliente-busca', 'e-observacoes', 'e-condicao', 'mat-busca', 'add-servico', 'add-material', 'add-avulso']
      .forEach(id => { const e = document.getElementById(id); if (e) e.disabled = !on })
    document.querySelectorAll('#tb-servico input, #tb-material input').forEach(i => { i.disabled = !on })
    document.querySelectorAll('#tb-servico .it-x, #tb-material .it-x').forEach(b => { b.style.display = on ? '' : 'none' })
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

  // ─────────────────────────── PDF (servidor) ───────────────────────────
  async function gerarPdf() {
    if (!cur || !cur.id) return toast('Salve o orçamento antes de gerar o PDF.', 'err')
    const btn = document.getElementById('btn-pdf')
    const old = btn.textContent; btn.disabled = true; btn.textContent = 'Gerando…'
    try {
      const { data, error } = await sb().functions.invoke('documentos', { body: { action: 'pdf', tipo: 'orcamento', id: cur.id } })
      if (error) {
        let msg = error.message || 'falha'
        try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error } catch (_) {}
        throw new Error(msg)
      }
      if (!data || !data.base64) throw new Error((data && data.error) || 'resposta inválida')
      abrirPdfBase64(data.base64, data.filename || 'orcamento.pdf')
    } catch (e) {
      toast('Erro ao gerar PDF: ' + (e.message || e), 'err')
    } finally {
      btn.disabled = false; btn.textContent = old
    }
  }
  function abrirPdfBase64(b64, filename) {
    const bin = atob(b64), arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }))
    // Baixa o arquivo com o nome correto (salvar é mais confiável que abrir aba/blob).
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'orcamento.pdf'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  window.OrcamentosApp = { init }
})()
