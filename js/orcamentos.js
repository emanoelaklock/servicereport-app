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
  let fotos = []          // { id, url(path), legenda, signed }
  let filtro = 'ativos'
  let _seq = 0

  const sb = () => getSupabase()
  const rid = () => 'r' + (++_seq)

  const STATUS_LABEL = {
    rascunho: 'Aguardando aprovação', enviado: 'Aguardando aprovação', aprovado: 'Aprovado',
    nao_aprovado: 'Não aprovado', arquivado: 'Arquivado',
  }
  const STATUS_CLS = {
    rascunho: 's-ai', enviado: 's-ai', aprovado: 's-en',
    nao_aprovado: 's-rm', arquivado: 's-sc',
  }
  // classe do badge do topo do editor por status
  const BADGE_CLS = {
    rascunho: 's-aguardando', enviado: 's-aguardando', aprovado: 's-aprovado',
    nao_aprovado: 's-naoaprovado', arquivado: 's-arquivado',
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
      list.innerHTML = matches.map(m => `<div class="ac-item" data-id="${esc(m.id)}">${m.html || esc(m.label)}</div>`).join('')
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
    document.getElementById('btn-pdf').onclick = gerarPdf
    document.getElementById('btn-aprovar').onclick = aprovar
    document.getElementById('btn-naoaprovado').onclick = naoAprovado
    document.getElementById('btn-reabrir').onclick = reabrir
    document.getElementById('btn-arquivar').onclick = arquivar
    document.getElementById('btn-desarquivar').onclick = desarquivar
    // menu "⋯" (Arquivar · Excluir) — só no estado Aguardando aprovação
    document.getElementById('btn-more').onclick = (e) => { e.stopPropagation(); document.getElementById('more-menu').classList.toggle('open') }
    document.getElementById('mm-arquivar').onclick = () => { document.getElementById('more-menu').classList.remove('open'); arquivar() }
    document.getElementById('mm-excluir').onclick = () => { document.getElementById('more-menu').classList.remove('open'); excluir() }
    document.addEventListener('click', () => document.getElementById('more-menu')?.classList.remove('open'))
    document.getElementById('add-avulso').onclick = () => { addItem({ tipo: 'avulso', quantidade: 1, preco_unitario: 0 }); renderItens() }
    document.getElementById('add-material').onclick = adicionarMaterialSelecionado
    document.getElementById('e-servico-valor').oninput = recomputeTotais
    document.getElementById('e-foto-btn').onclick = () => document.getElementById('e-foto-input').click()
    document.getElementById('e-foto-input').onchange = () => adicionarFotos(document.getElementById('e-foto-input').files)
    document.getElementById('e-foto-import').onclick = importarFotosPreorc
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
      ref.produtos, p => ({
        id: p.id,
        label: (p.codigo ? p.codigo + ' ' : '') + (p.descricao || ''),
        html: `<div class="ac-prod"><span class="ac-cod">${esc(p.codigo || '—')}</span><span class="ac-desc">${esc(p.descricao || '')}</span><span class="ac-preco">${money(p.preco_venda)}</span></div>`,
      })
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
    if (secao !== 'editor') {
      document.getElementById('ed-badge').style.display = 'none'
      document.getElementById('ed-docno').textContent = ''
    }
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
    setClausulas(CLAUSULAS.map(c => c.k))   // novas propostas já vêm com as cláusulas padrão marcadas
    document.getElementById('ed-status').textContent = ''
    renderItens()
    aplicarEstado()
    carregarFotos()
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
    cur = { id: o.id, numero: o.numero, pre_orcamento_id: o.pre_orcamento_id, status: o.status, data_envio: o.data_envio, arquivado: !!o.arquivado }
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
    setClausulas(o.clausulas || [])
    document.getElementById('ed-status').textContent = `Nº ${o.numero} · ${STATUS_LABEL[o.status] || o.status}`
    if (e2) toast('Aviso: itens não carregaram: ' + e2.message, 'err')
    renderItens()
    aplicarEstado()
    carregarFotos()
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

  // Cláusulas padrão (chaves estáveis -> texto). Marcadas entram no bloco "Observações" do PDF.
  const CLAUSULAS = [
    { k: 'horario', t: 'Serviço executado em horário comercial (segunda a sexta, das 7h às 17h).' },
    { k: 'estoque', t: 'Materiais sujeitos à disponibilidade de estoque.' },
    { k: 'escopo', t: 'Qualquer alteração no escopo poderá impactar prazo e valores apresentados.' },
  ]
  const clausulaTexto = (k) => (CLAUSULAS.find(c => c.k === k) || {}).t || ''
  function setClausulas(arr) {
    const set = new Set(arr || [])
    document.querySelectorAll('#e-clausulas input[data-clausula]').forEach(cb => { cb.checked = set.has(cb.dataset.clausula) })
  }
  function getClausulas() {
    return [...document.querySelectorAll('#e-clausulas input[data-clausula]:checked')].map(cb => cb.dataset.clausula)
  }

  // Valor do serviço (descrição livre + valor único — não é mais item).
  const servicoValor = () => Number(document.getElementById('e-servico-valor').value) || 0
  const somaMateriais = () => itens.reduce((s, i) => s + (Number(i.quantidade) || 0) * (Number(i.preco_unitario) || 0), 0)
  function recomputeTotais() {
    const ts = servicoValor()
    const tm = somaMateriais()
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
      clausulas: getClausulas(),
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
      cur.numero = ins.data.numero
      cur.data_envio = ins.data.data_envio
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
    toast('Salvo — aguardando aprovação.', 'ok')
    aplicarEstado()
    carregarFotos()
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
    ['e-cliente-busca', 'e-servico-desc', 'e-servico-valor', 'e-prazo', 'e-observacoes', 'e-condicao', 'mat-busca', 'add-material', 'add-avulso', 'e-foto-btn']
      .forEach(id => { const e = document.getElementById(id); if (e) e.disabled = !on })
    document.querySelectorAll('#e-clausulas input[data-clausula]').forEach(cb => { cb.disabled = !on })
    document.querySelectorAll('#tb-material input').forEach(i => { i.disabled = !on })
    document.querySelectorAll('#tb-material .it-x').forEach(b => { b.style.display = on ? '' : 'none' })
  }

  function aplicarEstado() {
    const arq = !!cur.arquivado
    const aprovado = !arq && cur.status === 'aprovado'
    const naoAprov = !arq && cur.status === 'nao_aprovado'
    const aguardando = !arq && !aprovado && !naoAprov   // rascunho/enviado
    const saved = !!cur.id
    setEditorEnabled(aguardando)
    const show = (id, on) => { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none' }
    // Aguardando aprovação → Salvar · Gerar PDF · Aprovar · Não aprovado · ⋯(Arquivar · Excluir)
    show('btn-salvar', aguardando)
    show('btn-aprovar', aguardando && saved)
    show('btn-naoaprovado', aguardando && saved)
    show('more-wrap', aguardando && saved)
    // Aprovado → Gerar PDF · Reabrir | Não aprovado → Reabrir · Arquivar
    show('btn-reabrir', aprovado || naoAprov)
    show('btn-arquivar', naoAprov)
    // Arquivado → Desarquivar
    show('btn-desarquivar', arq)
    show('btn-pdf', saved && (aguardando || aprovado))
    document.getElementById('more-menu').classList.remove('open')
    // Badge de status no topo
    const badge = document.getElementById('ed-badge')
    badge.textContent = STATUS_LABEL[cur.status] || cur.status
    badge.className = 'ed-badge ' + (arq ? 's-arquivado' : (BADGE_CLS[cur.status] || 's-aguardando'))
    badge.style.display = ''
    document.getElementById('ed-docno').textContent = saved && cur.numero ? `Nº ${cur.numero}` : ''
    const b = document.getElementById('ed-banner')
    if (arq) { b.style.display = 'block'; b.style.background = '#F1F5F9'; b.style.color = '#475569'; b.textContent = 'Arquivado — fora das listas ativas; histórico preservado.' }
    else if (aprovado) { b.style.display = 'block'; b.style.background = '#E8F5E9'; b.style.color = '#2E7D32'; b.textContent = cur._tarefaMsg || 'Aprovado — orçamento congelado; Tarefa (OS) gerada.' }
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

  async function excluir() {
    if (!cur || !cur.id) return toast('Nada para excluir.', 'err')
    if (cur.status === 'aprovado') return toast('Orçamento aprovado gerou uma Tarefa — arquive em vez de excluir.', 'err')
    if (!confirm('Excluir definitivamente este orçamento? Esta ação não pode ser desfeita.')) return
    if (fotos.length) await sb().storage.from('rat-anexos').remove(fotos.map(f => f.url)).catch(() => {})
    const di = await sb().from('orcamento_itens').delete().eq('orcamento_id', cur.id)
    if (di.error) return toast('Erro ao excluir itens: ' + di.error.message, 'err')
    const d = await sb().from('orcamentos').delete().eq('id', cur.id)
    if (d.error) return toast('Erro ao excluir: ' + d.error.message, 'err')
    toast('Orçamento excluído.', 'ok'); cur = null; mostrar('lista'); await renderLista()
  }

  // ─────────────────────────── Fotos ───────────────────────────
  async function carregarFotos() {
    const hint = document.getElementById('fotos-hint')
    const btn = document.getElementById('e-foto-btn')
    const imp = document.getElementById('e-foto-import')
    const box = document.getElementById('e-thumbs')
    if (!cur || !cur.id) { fotos = []; box.innerHTML = ''; hint.style.display = 'block'; btn.disabled = true; imp.style.display = 'none'; return }
    const locked = cur.status === 'aprovado' || cur.arquivado
    hint.style.display = 'none'; btn.disabled = !!locked
    imp.style.display = (cur.pre_orcamento_id && !locked) ? '' : 'none'
    const { data, error } = await sb().from('relatorio_fotos').select('id,url,legenda').eq('orcamento_id', cur.id).order('criado_em')
    if (error) { toast('Erro ao carregar fotos: ' + error.message, 'err'); return }
    fotos = data || []
    await renderFotos()
  }
  async function renderFotos() {
    const box = document.getElementById('e-thumbs'); if (!box) return
    if (fotos.length) {
      const { data: signed } = await sb().storage.from('rat-anexos').createSignedUrls(fotos.map(f => f.url), 3600)
      fotos.forEach((f, i) => { f.signed = (signed && signed[i] && signed[i].signedUrl) || '' })
    }
    const locked = cur && (cur.status === 'aprovado' || cur.arquivado)
    box.innerHTML = fotos.map(f => `<div class="thumb-card">
      <div class="thumb"><img src="${esc(f.signed || '')}" alt="">${locked ? '' : `<button type="button" class="thumb-x" data-id="${esc(f.id)}">×</button>`}</div>
      <input type="text" class="thumb-leg" data-legid="${esc(f.id)}" placeholder="Legenda" value="${esc(f.legenda || '')}"${locked ? ' disabled' : ''}></div>`).join('')
    box.querySelectorAll('.thumb-x').forEach(b => { b.onclick = () => removerFoto(b.dataset.id) })
    box.querySelectorAll('.thumb-leg').forEach(inp => {
      inp.onchange = () => {
        const v = inp.value.trim() || null
        const f = fotos.find(x => x.id === inp.dataset.legid); if (f) f.legenda = v
        sb().from('relatorio_fotos').update({ legenda: v }).eq('id', inp.dataset.legid)
          .then(({ error }) => { if (error) toast('Erro ao salvar legenda: ' + error.message, 'err') })
      }
    })
  }
  async function adicionarFotos(fileList) {
    if (!cur || !cur.id) return toast('Salve o orçamento primeiro.', 'err')
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    const btn = document.getElementById('e-foto-btn'); const old = btn.textContent; btn.disabled = true; btn.textContent = 'Enviando…'
    for (const f of files) {
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))
      const ext = f.type.includes('png') ? 'png' : f.type.includes('webp') ? 'webp' : 'jpg'
      const path = `orcamentos/${cur.id}/foto-${id}.${ext}`
      const up = await sb().storage.from('rat-anexos').upload(path, f, { upsert: true, contentType: f.type || 'image/jpeg' })
      if (up.error) { toast('Erro no upload: ' + up.error.message, 'err'); continue }
      const ins = await sb().from('relatorio_fotos').insert({ id, orcamento_id: cur.id, url: path }).select('id,url,legenda').single()
      if (ins.error) { toast('Erro ao salvar foto: ' + ins.error.message, 'err'); continue }
      fotos.push(ins.data)
    }
    document.getElementById('e-foto-input').value = ''
    btn.disabled = false; btn.textContent = old
    await renderFotos()
  }
  async function importarFotosPreorc() {
    if (!cur || !cur.id) return toast('Salve o orçamento primeiro.', 'err')
    const imp = document.getElementById('e-foto-import'); const old = imp.textContent; imp.disabled = true; imp.textContent = 'Importando…'
    const r = await invoke('orcamento-importar-fotos', { id: cur.id })
    imp.disabled = false; imp.textContent = old
    if (!r) return
    if (r.importadas > 0) toast(r.importadas + ' foto(s) trazida(s) do pré-orçamento.', 'ok')
    else toast(r.motivo || 'Nenhuma foto nova para importar.', 'info')
    await carregarFotos()
  }
  async function removerFoto(id) {
    const f = fotos.find(x => x.id === id); if (!f) return
    if (!confirm('Remover esta foto?')) return
    await sb().storage.from('rat-anexos').remove([f.url]).catch(() => {})
    const d = await sb().from('relatorio_fotos').delete().eq('id', id)
    if (d.error) return toast('Erro ao remover: ' + d.error.message, 'err')
    fotos = fotos.filter(x => x.id !== id); await renderFotos()
  }

  // ─────────────────── PDF do orçamento (render do mockup → imprimir) ───────────────────
  // Reproduz fielmente docs/mockups/orcamento-pdf.html (Inter, A4). O usuário escolhe
  // "Salvar como PDF" no diálogo de impressão — saída vetorial, idêntica ao mockup.
  const nl2br = (s) => esc(s).replace(/\n/g, '<br>')
  const dmy = (iso) => { if (!iso) return '—'; const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[3] + '/' + m[2] + '/' + m[1]; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR') }

  // Title case p/ dados do cliente (vêm em CAIXA-ALTA do Omie). Preserva siglas e conectivos.
  const TC_UP = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'S/A', 'MEI', 'CEP', 'CNPJ', 'CPF', 'II', 'III', 'IV', 'BR',
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'])
  const TC_LOW = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'no', 'na'])
  function titleCase(s) {
    if (!s) return s
    return String(s).toLowerCase().replace(/[\p{L}\p{N}/]+/gu, (w) => {
      const up = w.toUpperCase()
      if (TC_UP.has(up)) return up
      if (TC_LOW.has(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
  }

  // Limpa endereço do Omie: UF duplicada (ex.: "Itupeva (SP), SP") -> "Itupeva/SP";
  // formata CEP (8 dígitos -> 00000-000). Aplicar depois do titleCase.
  function limparEndereco(e) {
    if (!e) return e
    let s = String(e).trim()
    s = s.replace(/\s*\(\s*([A-Za-zÀ-ú]{2})\s*\)/g, '')
    s = s.replace(/,\s*([A-Za-z]{2})\s*,\s*(\d{5})-?(\d{3})\s*$/, (_, uf, a, b) => '/' + uf.toUpperCase() + ' · ' + a + '-' + b)
    s = s.replace(/(\d{5})-?(\d{3})\b/, '$1-$2')
    return s.replace(/\s{2,}/g, ' ').trim()
  }

  // Normaliza exibição: caixa consistente em prazos; unidade padronizada (PÇ -> PC).
  const normPrazo = (s) => String(s || '').replace(/\b(dias?|úteis|útil|horas?|semanas?|meses|mês|imediato)\b/gi, m => m.toLowerCase())
  const normUnidade = (u) => u ? String(u).toUpperCase().replace(/PÇ/g, 'PC') : '—'

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
    // Usa as fotos carregadas no editor + legendas do estado vivo dos campos
    // (evita corrida com o salvamento da legenda no banco).
    const legAtual = {}
    document.querySelectorAll('#e-thumbs .thumb-leg').forEach(inp => { legAtual[inp.dataset.legid] = inp.value.trim() || null })
    const fotosArr = fotos.map(f => ({ id: f.id, url: f.url, legenda: (f.id in legAtual) ? legAtual[f.id] : (f.legenda || null) }))
    if (fotosArr.length) {
      const { data: signed } = await sb().storage.from('rat-anexos').createSignedUrls(fotosArr.map(f => f.url), 3600)
      fotosArr.forEach((f, i) => { f.signed = (signed && signed[i] && signed[i].signedUrl) || '' })
    }
    const html = orcamentoHTML(o, mats, cli, fotosArr)
    const w = window.open('', '_blank')
    if (!w) return toast('Permita pop-ups para gerar o PDF.', 'err')
    w.document.open(); w.document.write(html); w.document.close()
  }

  function orcamentoHTML(o, mats, cli, fotosArr) {
    fotosArr = fotosArr || []
    const servVal = Number(o.servico_valor) || 0
    const totMat = mats.reduce((s, m) => s + ((Number(m.preco_unitario) || 0) === 0 ? 0 : (Number(m.quantidade) || 0) * (Number(m.preco_unitario) || 0)), 0)
    const total = servVal + totMat
    const hasServico = !!(o.servico_descricao && o.servico_descricao.trim()) || servVal > 0
    const hasMateriais = mats.length > 0
    const numero = String(o.numero).padStart(3, '0')

    // Serviço: 1ª linha = resumo (destaque); demais linhas = bullets.
    const linhas = (o.servico_descricao || '').split('\n').map(s => s.trim()).filter(Boolean)
    const lead = linhas[0] || ''
    const bullets = linhas.slice(1).map(b => b.replace(/^[-•·*]\s*/, ''))

    const meta = [['Emissão', dmy(o.data_envio || o.criado_em)]]

    const servicoSec = hasServico ? `
      <section class="sec">
        <div class="eyebrow">Serviço</div>
        <div class="scope">
          <div class="scope-desc">
            ${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
            ${bullets.length ? `<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
          </div>
          <div class="scope-val"><span class="k">Valor do Serviço</span><span class="v num">${money(servVal)}</span></div>
        </div>
      </section>` : ''

    const matRowsArr = mats.map((m, i) => {
      const q = Number(m.quantidade) || 0, p = Number(m.preco_unitario) || 0, sem = p === 0
      return `<tr>
        <td class="c idx">${i + 1}</td>
        <td class="l">${esc(m.descricao || '—')}</td>
        <td class="c">${esc(normUnidade(m.unidade))}</td>
        <td class="c num">${q.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}</td>
        <td class="r num${sem ? ' dash' : ''}">${sem ? '—' : money(p)}</td>
        <td class="r tot num${sem ? ' dash' : ''}">${sem ? '—' : money(q * p)}</td></tr>`
    })
    const colgroupHtml = '<col style="width:6%"><col style="width:52%"><col style="width:7%"><col style="width:9%"><col style="width:13%"><col style="width:13%">'
    const theadHtml = '<tr><th class="c">Item</th><th class="l">Descrição</th><th class="c">Un.</th><th class="c">Qtd</th><th class="r">Vlr. Unit.</th><th class="r">Total</th></tr>'

    const bothGroups = hasServico && hasMateriais
    const resumoSec = (hasServico || hasMateriais) ? `
      <div class="mat-foot">
        <div class="obs-note">${hasMateriais ? 'Observação: Materiais inclusos para execução do serviço.' : ''}</div>
        <div class="resumo">
          ${bothGroups ? `<div class="rrow"><span>Serviços</span><span class="num">${money(servVal)}</span></div><div class="rrow"><span>Materiais</span><span class="num">${money(totMat)}</span></div>` : ''}
          <div class="rtot"><span>Total</span><span class="rtv num">${money(total)}</span></div>
        </div>
      </div>` : ''

    const clausLis = (o.clausulas || []).map(k => clausulaTexto(k)).filter(Boolean).map(t => `<li>${esc(t)}</li>`).join('')
    const clausHtml = clausLis ? `<ul class="obs-cl">${clausLis}</ul>` : ''
    const obsParas = clausHtml + (o.observacoes || '').split('\n').map(s => s.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')
    const condRows = []
    if (o.prazo_execucao) condRows.push(['Prazo de execução', esc(normPrazo(o.prazo_execucao))])
    condRows.push(['Validade da proposta', '15 dias'])
    if (o.condicao_pagamento && o.condicao_pagamento.trim()) condRows.push(['Forma de pagamento', esc(o.condicao_pagamento)])
    const condSec = `<section class="sec two">
        <div class="col">
          <div class="eyebrow">Condições comerciais</div>
          ${condRows.map(([k, v]) => `<div class="trow"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`).join('')}
        </div>
        <div class="col">
          <div class="eyebrow">Observações</div>
          <div class="obs-text">${obsParas || '<p>—</p>'}</div>
        </div>
      </section>`

    const introHtml = `<section class="doc">
      <div>
        <h1>Proposta <span class="no">Nº ${esc(numero)}</span></h1>
        ${o.assunto ? `<div class="sub">${esc(o.assunto)}</div>` : ''}
      </div>
      <div class="meta">${meta.map(([k, v]) => `<div class="mi"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}</div>
    </section>`
    const clienteHtml = `<section class="cli">
      <div class="eyebrow">Cliente</div>
      <div class="cli-row">
        <div class="cli-l"><div class="cname">${esc((cli.nome || '').toUpperCase() || '—')}</div></div>
        <div class="cli-r">${[cli.documento ? 'CNPJ ' + esc(cli.documento) : '', cli.endereco ? esc(limparEndereco(titleCase(cli.endereco))) : ''].filter(Boolean).join('<br>') || '&nbsp;'}</div>
      </div>
    </section>`
    const headerHtml = `<header class="head">
      <div class="brand"><div class="logo">TS</div><div class="nm">TRADERS SERVICE</div></div>
      <div class="firm"><b>Traders Service Soluções em Tecnologia LTDA</b>
        CNPJ 10.923.494/0001-30 &nbsp;|&nbsp; IE 255882904 &nbsp;|&nbsp; IM 96456<br>
        Rua Dona Francisca, 8300 – Via Trieste, Prédio 01/02<br>
        Perini Business Park – Joinville/SC – CEP 89219-600
        <span class="tel">(47) 3025-2660</span></div>
    </header>`
    const headerContHtml = `<header class="head head-cont">
      <div class="brand"><div class="logo">TS</div><div class="nm">TRADERS SERVICE</div></div>
      <div class="cont-no">Proposta Nº ${esc(numero)}</div>
    </header>`
    const footerHtml = `<footer class="foot"><span>(47) 3025-2660</span><span>comercial@tsrv.com.br</span><span>www.tsrv.com.br</span><span class="pg">Página 1 de 1</span></footer>`

    const blocks = []
    blocks.push({ t: 'html', h: introHtml })
    blocks.push({ t: 'html', h: clienteHtml })
    if (hasServico) blocks.push({ t: 'html', h: servicoSec })
    if (hasMateriais) {
      blocks.push({ t: 'tstart', eyebrow: 'Materiais', col: colgroupHtml, thead: theadHtml })
      matRowsArr.forEach(r => blocks.push({ t: 'row', h: r }))
      blocks.push({ t: 'tend' })
    }
    if (hasServico || hasMateriais) blocks.push({ t: 'html', h: resumoSec })
    blocks.push({ t: 'html', h: condSec })
    // Registro fotográfico (2 fotos por linha; cada linha é um bloco paginável)
    for (let i = 0; i < fotosArr.length; i += 2) {
      const pair = fotosArr.slice(i, i + 2)
      const eyebrow = i === 0 ? '<div class="eyebrow">Registro fotográfico</div>' : ''
      blocks.push({ t: 'html', h: `<section class="sec fotos-sec">${eyebrow}<div class="fotos-row">${pair.map(f => `<div class="foto-card"><div class="foto-img"><img src="${esc(f.signed || '')}"></div>${f.legenda ? `<div class="foto-cap">${esc(f.legenda)}</div>` : ''}</div>`).join('')}${pair.length === 1 ? '<div class="foto-card"></div>' : ''}</div></section>` })
    }

    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Orçamento Nº ${esc(numero)} — ${esc(cli.nome || 'Cliente')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--navy:#1B2A4A;--red:#BE1622;--ink:#1d2533;--gray:#6B7280;--line:#E5E7EB;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#e7eaef;}
body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.num{font-variant-numeric:tabular-nums;}
.sheet{width:794px;height:1123px;margin:30px auto;background:#fff;padding:44px 56px;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(20,30,55,.18);overflow:hidden;}
.sheet .hd{flex:none;}
.sheet .bd{flex:1 1 auto;min-height:0;overflow:hidden;padding-top:16px;}
.sheet .ft{flex:none;margin-top:14px;}
.eyebrow{font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--gray);margin-bottom:11px;}

/* header */
.head{display:flex;justify-content:space-between;align-items:center;gap:32px;padding-bottom:18px;border-bottom:1px solid var(--line);}
.brand{display:flex;align-items:center;gap:14px;}
.logo{width:50px;height:50px;border-radius:12px;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800;font-size:20px;letter-spacing:-1px;flex:none;}
.brand .nm{font-size:25px;font-weight:800;letter-spacing:.4px;color:var(--ink);line-height:1;}
.firm{text-align:right;font-size:10.5px;line-height:1.65;color:var(--gray);}
.firm b{display:block;color:var(--ink);font-weight:700;font-size:11px;margin-bottom:3px;}
.firm .tel{display:block;color:var(--ink);font-weight:700;font-size:11.5px;margin-top:3px;}
.head-cont{padding-bottom:12px;}
.head-cont .logo{width:34px;height:34px;font-size:14px;border-radius:9px;}
.head-cont .nm{font-size:17px;}
.head-cont .cont-no{font-size:13px;font-weight:700;color:var(--ink);}

/* título */
.doc{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-top:6px;padding-bottom:16px;border-bottom:1px solid var(--line);}
.doc h1{font-size:20px;font-weight:700;letter-spacing:-.2px;color:var(--ink);line-height:1.05;}
.doc h1 .no{color:var(--ink);}
.doc .sub{font-size:13px;color:var(--gray);margin-top:7px;max-width:430px;line-height:1.4;}
.meta{display:flex;}
.meta .mi{padding:0 16px;}
.meta .mi+.mi{border-left:1px solid #e4e7ec;}
.meta .mi:last-child{padding-right:0;}
.meta .k{font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--gray);}
.meta .v{font-size:12.5px;font-weight:600;color:var(--ink);margin-top:6px;white-space:nowrap;}

/* cliente */
.cli{margin-top:12px;padding-bottom:10px;border-bottom:1px solid var(--line);}
.cli .eyebrow{margin-bottom:6px;}
.cli-row{display:flex;align-items:center;}
.cli-l{flex:1;padding-right:32px;}
.cli .cname{font-size:16px;font-weight:700;letter-spacing:-.2px;color:var(--ink);line-height:1.25;}
.cli-r{flex:1;border-left:1px solid var(--line);padding-left:32px;font-size:11px;line-height:1.75;color:var(--gray);}

.sec{margin-top:24px;}

/* serviço (card azul claro, valor abaixo da descrição) */
.scope{background:#f2f6fc;border:1px solid #e6eef8;border-radius:12px;padding:16px 22px;}
.scope-desc .lead{font-size:12.5px;font-weight:700;color:var(--ink);line-height:1.6;margin-bottom:9px;}
.scope-desc .lead:last-child{margin-bottom:0;}
.scope-desc ul{list-style:disc;padding-left:18px;margin:0;}
.scope-desc li{font-size:12px;color:#3f444c;line-height:1.55;margin-bottom:6px;}
.scope-desc li::marker{color:#9aa1b0;}
.scope-val{display:flex;justify-content:space-between;align-items:baseline;margin-top:14px;padding-top:13px;border-top:1px solid #dde6f1;}
.scope-val .k{font-size:11.5px;font-weight:600;color:var(--gray);}
.scope-val .v{font-size:16px;font-weight:600;letter-spacing:-.2px;color:var(--ink);}

/* materiais */
table{width:100%;border-collapse:collapse;}
thead th{font-size:9.5px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--gray);background:#f4f5f7;padding:9px 10px;text-align:right;}
thead th.l{text-align:left;}
thead th.c{text-align:center;}
tbody td{font-size:10.5px;padding:7px 10px;text-align:right;color:var(--ink);border-bottom:1px solid #eef0f3;}
tbody tr:nth-child(even) td{background:#f8f9fb;}
tbody td.l{text-align:left;font-weight:500;line-height:1.4;}
tbody td.c{text-align:center;color:var(--gray);}
tbody td.idx{color:#9aa1b0;}
tbody td.tot{font-weight:700;}
tbody td.dash{color:#b8bcc4;}

/* resumo */
.mat-foot{display:flex;justify-content:space-between;align-items:flex-start;gap:30px;margin-top:13px;}
.mat-foot .obs-note{font-size:10px;color:var(--gray);padding-top:6px;}
.resumo{width:300px;flex:none;}
.rrow{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;color:var(--gray);}
.rrow span:last-child{color:var(--ink);font-weight:700;}
.rtot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding:13px 18px;background:#f2f6fc;border:1px solid #e6eef8;border-radius:10px;}
.rtot span:first-child{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--ink);}
.rtot .rtv{font-size:18px;font-weight:800;letter-spacing:-.2px;color:var(--red);}

/* condições + observações */
.two{display:flex;gap:48px;align-items:flex-start;}
.sec.two{margin-top:38px;}
.two .col{flex:1;min-width:0;}
.trow{display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px;padding:10px 0;border-bottom:1px solid #f1f2f4;}
.trow:last-child{border-bottom:none;}
.trow .k{color:var(--gray);font-weight:500;font-size:11.5px;white-space:nowrap;flex:none;padding-right:14px;}
.trow .v{color:var(--ink);font-weight:600;text-align:right;}
.obs-text p{font-size:11.5px;line-height:1.6;color:#4a4e56;margin-bottom:9px;}
.obs-text p:last-child{margin-bottom:0;}
.obs-cl{list-style:disc;padding-left:18px;margin:0 0 9px;}
.obs-cl:last-child{margin-bottom:0;}
.obs-cl li{font-size:11.5px;line-height:1.55;color:#4a4e56;margin-bottom:6px;}
.obs-cl li:last-child{margin-bottom:0;}
.obs-cl li::marker{color:#9aa1b0;}

/* rodapé */
.foot{padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--gray);}
.fotos-sec{margin-top:14px;}
.fotos-row{display:flex;gap:14px;}
.foto-card{flex:1;min-width:0;}
.foto-img{width:100%;height:175px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#f2f4f7;}
.foto-img img{width:100%;height:100%;object-fit:cover;display:block;}
.foto-cap{font-size:10px;color:var(--gray);margin-top:5px;line-height:1.3;}
@media print{@page{size:A4;margin:0;}html,body{background:#fff;}.sheet{box-shadow:none;margin:0;width:210mm;height:297mm;page-break-after:always;}.sheet:last-child{page-break-after:auto;}}
</style></head>
<body>
<div id="sheets"></div>
<script>
var HEADER=${JSON.stringify(headerHtml)};
var HEADERC=${JSON.stringify(headerContHtml)};
var FOOTER=${JSON.stringify(footerHtml)};
var BLOCKS=${JSON.stringify(blocks)};
function el(t,c){var e=document.createElement(t);if(c)e.className=c;return e;}
var sheets=document.getElementById('sheets'),cur=null,openTbody=null,curCol='',curThead='',ftrs=[];
function newSheet(){var first=ftrs.length===0;var s=el('div','sheet');var hd=el('div','hd');hd.innerHTML=first?HEADER:HEADERC;var bd=el('div','bd');var ft=el('div','ft');ft.innerHTML=FOOTER;s.appendChild(hd);s.appendChild(bd);s.appendChild(ft);sheets.appendChild(s);ftrs.push(ft);cur={bd:bd};}
function over(){return cur.bd.scrollHeight>cur.bd.clientHeight+1;}
function addHTML(h){var d=el('div');d.innerHTML=h;var n=d.firstElementChild;if(!n)return;cur.bd.appendChild(n);if(over()&&cur.bd.children.length>1){cur.bd.removeChild(n);newSheet();cur.bd.appendChild(n);}}
function makeTable(){var t=el('table');t.innerHTML='<colgroup>'+curCol+'</colgroup><thead>'+curThead+'</thead><tbody></tbody>';return t;}
function startTable(b){curCol=b.col;curThead=b.thead;var wrap=el('div');wrap.style.marginTop='22px';wrap.innerHTML='<div class="eyebrow">'+b.eyebrow+'</div>';var t=makeTable();wrap.appendChild(t);cur.bd.appendChild(wrap);if(over()&&cur.bd.children.length>1){cur.bd.removeChild(wrap);newSheet();cur.bd.appendChild(wrap);}openTbody=t.querySelector('tbody');}
function addRow(h){var tb=el('tbody');tb.innerHTML=h;var tr=tb.firstElementChild;if(!tr||!openTbody)return;openTbody.appendChild(tr);if(over()){openTbody.removeChild(tr);newSheet();var t=makeTable();cur.bd.appendChild(t);openTbody=t.querySelector('tbody');openTbody.appendChild(tr);}}
function build(){newSheet();for(var i=0;i<BLOCKS.length;i++){var b=BLOCKS[i];if(b.t==='html')addHTML(b.h);else if(b.t==='tstart')startTable(b);else if(b.t==='row')addRow(b.h);else if(b.t==='tend')openTbody=null;}var N=ftrs.length;for(var k=0;k<ftrs.length;k++){var pg=ftrs[k].querySelector('.pg');if(pg)pg.textContent='Página '+(k+1)+' de '+N;}var imgs=Array.prototype.slice.call(document.images);var left=imgs.filter(function(im){return !im.complete});function go(){window.focus();window.print();}if(!left.length){setTimeout(go,200);return;}var done=0,fired=false;function one(){done++;if(done>=left.length&&!fired){fired=true;setTimeout(go,150);}}left.forEach(function(im){im.addEventListener('load',one);im.addEventListener('error',one);});setTimeout(function(){if(!fired){fired=true;go();}},7000);}
if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){setTimeout(build,80);});}else{setTimeout(build,400);}
</script>
</body></html>`
  }

  window.OrcamentosApp = { init }
})()
