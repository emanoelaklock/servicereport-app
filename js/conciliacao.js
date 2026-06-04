/* ═══════════════════════════════════════════════
   Service Report — conciliacao.js  (#5.3)
   Tela admin: lista de Tarefas + conciliação de material (5 colunas).
   Admin edita a coluna "Levada" e adiciona materiais (catálogo ou avulso).
   Orçada vem do orçamento; Utilizada vem das RATs do técnico (view).
═══════════════════════════════════════════════ */
const ConciliacaoApp = (() => {
  const sb = () => getSupabase()
  let user = { id: null }
  let ref = { produtos: [] }
  let tarefas = []           // lista de tarefas
  let cliNomes = {}          // cliente_id -> nome
  let divPorTarefa = {}      // tarefa_id -> nº de linhas com divergência
  let filtro = 'todas'
  let cur = null             // tarefa aberta
  let linhas = []            // conciliação da tarefa atual

  const STATUS_LABEL = {
    aguardando_execucao: 'Aguardando execução', em_execucao: 'Em execução',
    concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência',
    devolvida: 'Devolvida', aprovada_faturamento: 'Aprovada p/ faturamento', faturada: 'Faturada',
  }
  const SIT = {
    ok:            { t: 'OK',               cls: 's-ok' },
    devolver:      { t: 'Devolver',         cls: 's-dev' },
    sem_orcada:    { t: 'Fora da proposta', cls: 's-fora' },
    falta_estoque: { t: 'Faltou levar',     cls: 's-falta' },
    acima_orcado:  { t: 'Acima do orçado',  cls: 's-acima' },
  }
  const qtd = (n) => {
    const v = Number(n) || 0
    return Number.isInteger(v) ? String(v) : v.toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  }
  const dmy = (iso) => { if (!iso) return '—'; const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const unid = (l) => l.unidade ? ` <span class="u">${esc(l.unidade)}</span>` : ''

  async function init() {
    const { data: { user: u } } = await sb().auth.getUser()
    user.id = u?.id || null
    const prod = await sb().from('produtos').select('id,codigo,descricao,unidade,preco_venda').eq('ativo', true).eq('oculto', false).order('descricao')
    ref.produtos = prod.data || []
    bind()
    await carregarTarefas()
    mostrar('lista')
    renderLista()
  }

  function bind() {
    document.getElementById('btn-voltar').onclick = () => { cur = null; mostrar('lista'); carregarTarefas().then(renderLista) }
    document.querySelectorAll('#cc-filtros .chip').forEach(ch => ch.onclick = () => {
      filtro = ch.dataset.f
      document.querySelectorAll('#cc-filtros .chip').forEach(c => c.classList.toggle('on', c === ch))
      renderLista()
    })
    const bt = document.getElementById('busca-tarefa')
    if (bt) bt.oninput = debounce(() => renderLista(), 200)
    document.getElementById('cc-add-btn').onclick = adicionarMaterial
    attachAutocomplete(
      document.getElementById('cc-add-busca'),
      document.getElementById('cc-add-prod'),
      document.getElementById('cc-add-list'),
      ref.produtos,
      p => ({ id: p.id, label: `${p.codigo ? p.codigo + ' · ' : ''}${p.descricao}`,
              html: `<div class="ac-prod"><span class="ac-cod">${esc(p.codigo || '—')}</span><span class="ac-desc">${esc(p.descricao || '')}</span></div>` }),
      () => { document.getElementById('cc-add-desc').value = '' },
    )
  }

  // Autocomplete (mesmo padrão dos demais módulos).
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

  // ─────────────────────────── Lista ───────────────────────────
  async function carregarTarefas() {
    const { data: ts, error } = await sb().from('tarefas')
      .select('id,numero,status,criado_em,data_agendada,orcamento_id,cliente_id')
      .order('numero', { ascending: false })
    if (error) { toast('Erro ao carregar tarefas: ' + error.message, 'err'); tarefas = []; return }
    tarefas = ts || []
    const ids = [...new Set(tarefas.map(t => t.cliente_id).filter(Boolean))]
    cliNomes = {}
    if (ids.length) { const { data: cs } = await sb().from('clientes').select('id,nome').in('id', ids); for (const c of cs || []) cliNomes[c.id] = c.nome }
    divPorTarefa = {}
    const { data: vc } = await sb().from('vw_conciliacao_tarefa').select('tarefa_id,situacao')
    for (const r of vc || []) { if (r.situacao && r.situacao !== 'ok') divPorTarefa[r.tarefa_id] = (divPorTarefa[r.tarefa_id] || 0) + 1 }
  }

  function renderLista() {
    const box = document.getElementById('lista-box')
    const q = normStr(document.getElementById('busca-tarefa').value || '')
    let rows = tarefas
    if (filtro === 'divergencia') rows = rows.filter(t => divPorTarefa[t.id])
    else if (filtro !== 'todas') rows = rows.filter(t => t.status === filtro)
    if (q) rows = rows.filter(t => normStr(cliNomes[t.cliente_id] || '').includes(q) || String(t.numero || '').includes(q))
    if (!rows.length) { box.innerHTML = '<div class="cc-empty">Nenhuma tarefa encontrada.</div>'; return }
    box.innerHTML = `<table class="cc-list"><thead><tr>
        <th>Nº</th><th>Cliente</th><th>Status</th><th>Criada</th><th>Conciliação</th>
      </tr></thead><tbody>${rows.map(t => {
        const d = divPorTarefa[t.id] || 0
        const concil = d ? `<span class="pill pill-warn">${d} divergência${d > 1 ? 's' : ''}</span>` : '<span class="pill pill-ok">OK</span>'
        return `<tr class="row-click" data-id="${esc(t.id)}">
          <td class="cc-num">${t.numero ?? '—'}</td>
          <td>${esc(cliNomes[t.cliente_id] || '—')}</td>
          <td><span class="st">${esc(STATUS_LABEL[t.status] || t.status || '—')}</span></td>
          <td>${dmy(t.criado_em)}</td>
          <td>${concil}</td>
        </tr>`
      }).join('')}</tbody></table>`
    box.querySelectorAll('.row-click').forEach(tr => tr.onclick = () => abrirTarefa(tr.dataset.id))
  }

  // ─────────────────────────── Detalhe ───────────────────────────
  async function abrirTarefa(id) {
    const t = tarefas.find(x => x.id === id); if (!t) return
    cur = { id, numero: t.numero, status: t.status, cliente_nome: cliNomes[t.cliente_id] || '—' }
    document.getElementById('cc-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-docno').textContent = cur.numero != null ? `Tarefa Nº ${cur.numero}` : ''
    document.getElementById('cc-badge').textContent = STATUS_LABEL[cur.status] || cur.status || ''
    limparAdd()
    await carregarLinhas()
    mostrar('detalhe')
  }

  async function carregarLinhas() {
    const { data, error } = await sb().from('vw_conciliacao_tarefa').select('*').eq('tarefa_id', cur.id)
    linhas = error ? [] : (data || [])
    linhas.sort((a, b) => (a.situacao === 'ok' ? 1 : 0) - (b.situacao === 'ok' ? 1 : 0) || (a.descricao || '').localeCompare(b.descricao || ''))
    if (error) toast('Erro ao carregar conciliação: ' + error.message, 'err')
    renderLinhas()
  }

  function renderLinhas() {
    const tb = document.getElementById('cc-tbody')
    if (!linhas.length) {
      tb.innerHTML = '<tr><td colspan="6" class="cc-empty">Sem materiais nesta tarefa. Adicione abaixo.</td></tr>'
    } else {
      tb.innerHTML = linhas.map((l, i) => {
        const sit = SIT[l.situacao] || { t: l.situacao, cls: '' }
        const fora = l.situacao === 'sem_orcada'
        return `<tr class="${fora ? 'row-fora' : ''}">
          <td class="cc-mat"><div class="cc-desc">${esc(l.descricao || '—')}</div>${l.codigo_produto ? `<div class="cc-cod">${esc(l.codigo_produto)}</div>` : ''}</td>
          <td class="num">${Number(l.qtd_orcada) > 0 ? qtd(l.qtd_orcada) + unid(l) : '<span class="dash">—</span>'}</td>
          <td class="num"><input class="cc-lev num" type="number" inputmode="decimal" min="0" step="any" value="${Number(l.qtd_levada) > 0 ? l.qtd_levada : ''}" data-i="${i}" placeholder="0"></td>
          <td class="num">${Number(l.qtd_utilizada) > 0 ? qtd(l.qtd_utilizada) + unid(l) : '<span class="dash">—</span>'}</td>
          <td class="num ${Number(l.qtd_devolvida) < 0 ? 'neg' : ''}">${qtd(l.qtd_devolvida) + unid(l)}</td>
          <td><span class="sit ${sit.cls}">${esc(sit.t)}</span></td>
        </tr>`
      }).join('')
      tb.querySelectorAll('.cc-lev').forEach(inp => inp.onchange = () => salvarLevada(Number(inp.dataset.i), inp.value))
    }
    const div = linhas.filter(l => l.situacao !== 'ok').length
    document.getElementById('cc-resumo').innerHTML = linhas.length
      ? (div ? `<span class="pill pill-warn">${div} linha(s) com divergência</span>` : '<span class="pill pill-ok">Tudo conciliado</span>')
      : ''
  }

  async function salvarLevada(i, val) {
    const l = linhas[i]; if (!l) return
    const v = Number(val) || 0
    let err
    if (l.tm_id) {
      err = (await sb().from('tarefa_materiais').update({ qtd_levada: v }).eq('id', l.tm_id)).error
    } else {
      // linha "fora da proposta" (sem orçada) — cria a linha de material p/ registrar a levada
      err = (await sb().from('tarefa_materiais').insert({
        tarefa_id: cur.id, produto_id: l.produto_id || null, codigo_produto: l.codigo_produto || null,
        descricao: l.descricao || '(sem descrição)', unidade: l.unidade || null,
        preco_unitario: 0, qtd_orcada: 0, qtd_levada: v, origem: 'avulso',
      })).error
    }
    if (err) return toast('Erro ao salvar Levada: ' + err.message, 'err')
    toast('Levada atualizada.', 'ok')
    await carregarLinhas()
  }

  async function adicionarMaterial() {
    const pid = document.getElementById('cc-add-prod').value
    const desc = document.getElementById('cc-add-desc').value.trim()
    const qv = Number(document.getElementById('cc-add-qtd').value) || 0
    const p = ref.produtos.find(x => x.id === pid)
    const descricao = p ? p.descricao : desc
    if (!descricao) return toast('Selecione um produto ou digite uma descrição avulsa.', 'err')
    if (!qv || qv <= 0) return toast('Informe a quantidade levada.', 'err')
    const ins = await sb().from('tarefa_materiais').insert({
      tarefa_id: cur.id,
      produto_id: p ? p.id : null,
      codigo_produto: p ? p.codigo : null,
      descricao,
      unidade: p ? p.unidade : null,
      preco_unitario: p ? (Number(p.preco_venda) || 0) : 0,
      qtd_orcada: 0, qtd_levada: qv, origem: 'avulso',
    })
    if (ins.error) {
      if (ins.error.code === '23505') return toast('Esse material já está na lista — edite a Levada na linha.', 'err')
      return toast('Erro: ' + ins.error.message, 'err')
    }
    limparAdd()
    toast('Material adicionado.', 'ok')
    await carregarLinhas()
  }

  function limparAdd() {
    document.getElementById('cc-add-busca').value = ''
    document.getElementById('cc-add-prod').value = ''
    document.getElementById('cc-add-desc').value = ''
    document.getElementById('cc-add-qtd').value = ''
  }

  function mostrar(sec) {
    document.getElementById('view-lista').style.display = sec === 'lista' ? 'block' : 'none'
    document.getElementById('view-detalhe').style.display = sec === 'detalhe' ? 'block' : 'none'
    document.getElementById('topbar-title').textContent = sec === 'detalhe' ? 'Conciliação da Tarefa' : 'Conciliação'
    const badge = document.getElementById('cc-badge')
    if (sec !== 'detalhe') { badge.style.display = 'none'; document.getElementById('cc-docno').textContent = '' }
    else badge.style.display = ''
  }

  return { init }
})()
