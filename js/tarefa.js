/* ═══════════════════════════════════════════════
   Service Report — tarefa.js  (#5.3)
   Tela admin: lista de Tarefas + conciliação de material (5 colunas).
   Admin edita a coluna "Levada" e adiciona materiais (catálogo ou avulso).
   Orçada vem do orçamento; Utilizada vem das RATs do técnico (view).
═══════════════════════════════════════════════ */
const TarefaApp = (() => {
  const sb = () => getSupabase()
  let user = { id: null }
  let ref = { produtos: [], tecnicos: [], tipos: [], equip: [], clientes: [] }
  let tarefas = []           // lista de tarefas
  let cliNomes = {}          // cliente_id -> nome
  let tecNomes = {}          // tecnico_id -> nome
  let tecPorTarefa = {}      // tarefa_id -> [tecnico_id]
  let orcNo = {}             // orcamento_id -> numero
  let divPorTarefa = {}      // tarefa_id -> nº de linhas com divergência
  let filtro = 'todas'
  let cur = null             // tarefa aberta
  let linhas = []            // conciliação da tarefa atual
  let ratDet = null          // RAT aberta no modal { r, campos, ... }
  let ratEdit = false        // modo edição do modal de RAT
  let pendRat = null         // RAT base do modal "nova tarefa da pendência"

  const RAT_SIT = { em_andamento: 'Em andamento', concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência' }
  const ratSit = (s) => RAT_SIT[s] || s || '—'
  const PANES = ['dados', 'equip', 'anexos', 'rats', 'material', 'fat']
  // Cresce o textarea para caber todo o conteúdo (sem barra de rolagem).
  const autoGrow = (el) => { if (!el) return; el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px' }

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
  const osNo = (n) => n != null ? String(n).padStart(5, '0') : '—'
  const equipLabel = (e) => `${e.modelo || e.tipo || 'Equipamento'}${e.serial ? ' · S/N ' + e.serial : ''}${e.part_number ? ' · PN ' + e.part_number : ''}`
  const fmtSize = (n) => { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  const getTecnicosChecked = () => [...document.querySelectorAll('#cc-d-tecnicos input:checked')].map(c => c.value)
  const setTecnicosChecked = (ids) => { const s = new Set(ids || []); document.querySelectorAll('#cc-d-tecnicos input').forEach(c => { c.checked = s.has(c.value) }) }

  async function init() {
    const { data: { user: u } } = await sb().auth.getUser()
    user.id = u?.id || null
    const [prod, tec, tip, eq, cli] = await Promise.all([
      sb().from('produtos').select('id,codigo,descricao,unidade,preco_venda').eq('ativo', true).eq('oculto', false).order('descricao'),
      sb().from('usuarios').select('id,nome').eq('role', 'tecnico_campo').eq('ativo', true).order('nome'),
      sb().from('tipos_servico').select('id,nome').eq('ativo', true).order('nome'),
      sb().from('equipamentos_axis').select('id,tipo,part_number,modelo,serial').order('modelo'),
      sb().from('clientes').select('id,nome').eq('oculto', false).order('nome'),
    ])
    ref.produtos = prod.data || []
    ref.tecnicos = tec.data || []
    ref.tipos = tip.data || []
    ref.equip = eq.data || []
    ref.clientes = cli.data || []
    tecNomes = {}; for (const t of ref.tecnicos) tecNomes[t.id] = t.nome
    document.getElementById('cc-d-tecnicos').innerHTML = ref.tecnicos.length
      ? ref.tecnicos.map(t => `<label><input type="checkbox" value="${esc(t.id)}"> ${esc(t.nome || '(sem nome)')}</label>`).join('')
      : '<span class="cc-empty-sm">Nenhum técnico ativo cadastrado.</span>'
    document.getElementById('cc-d-tipo').innerHTML = '<option value="">— selecione —</option>' + ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome || '')}</option>`).join('')
    bind()
    const params = new URLSearchParams(location.search)
    const f = params.get('f')
    if (f) { filtro = f; document.querySelectorAll('#cc-filtros .chip').forEach(c => c.classList.toggle('on', c.dataset.f === f)) }
    await carregarTarefas()
    const tid = params.get('t')
    if (tid && tarefas.some(x => x.id === tid)) await abrirTarefa(tid, params.get('aba'))
    else { mostrar('lista'); renderLista() }
  }

  function bind() {
    document.getElementById('btn-voltar').onclick = () => { cur = null; history.replaceState(null, '', 'tarefa.html'); mostrar('lista'); carregarTarefas().then(renderLista) }
    document.querySelectorAll('#cc-filtros .chip').forEach(ch => ch.onclick = () => {
      filtro = ch.dataset.f
      document.querySelectorAll('#cc-filtros .chip').forEach(c => c.classList.toggle('on', c === ch))
      renderLista()
    })
    const bt = document.getElementById('busca-tarefa')
    if (bt) bt.oninput = debounce(() => renderLista(), 200)
    // Nova tarefa (criada direto, sem orçamento)
    document.getElementById('btn-nova-tarefa').onclick = abrirModalNovaTarefa
    document.getElementById('nt-fechar').onclick = fecharModalNovaTarefa
    document.getElementById('nt-cancelar').onclick = fecharModalNovaTarefa
    document.getElementById('nt-criar').onclick = criarTarefa
    attachAutocomplete(
      document.getElementById('nt-cliente-busca'),
      document.getElementById('nt-cliente'),
      document.getElementById('nt-cliente-list'),
      ref.clientes,
      c => ({ id: c.id, label: c.nome || '(sem nome)' }),
      null,
    )
    document.getElementById('cc-add-material').onclick = adicionarMaterialCatalogo
    document.getElementById('cc-add-avulso').onclick = adicionarMaterialAvulso
    document.getElementById('cc-d-salvar').onclick = salvarDados
    document.getElementById('cc-d-excluir').onclick = excluirTarefa
    document.getElementById('cc-eq-btn').onclick = vincularEquip
    document.getElementById('cc-anx-btn').onclick = () => document.getElementById('cc-anx-input').click()
    document.getElementById('cc-anx-input').onchange = (e) => adicionarAnexos(e.target.files)
    document.getElementById('cc-obs-salvar').onclick = salvarConcilObs
    document.getElementById('cc-d-orientacao').oninput = (e) => autoGrow(e.target)
    document.getElementById('cc-d-obs').oninput = (e) => autoGrow(e.target)
    // Abas do detalhe
    document.querySelectorAll('#cc-tabs .cc-tab').forEach(b => b.onclick = () => mostrarPane(b.dataset.pane))
    // RATs
    document.getElementById('cc-rat-pdf').onclick = pdfUnificado
    document.getElementById('rat-x').onclick = () => fecharModal('modal-rat')
    document.getElementById('rat-fechar').onclick = () => fecharModal('modal-rat')
    document.getElementById('rat-editar').onclick = ratEntrarEdicao
    document.getElementById('rat-cancelar').onclick = ratCancelarEdicao
    document.getElementById('rat-salvar').onclick = ratSalvarEdicao
    document.getElementById('rat-pdf').onclick = ratPdf
    document.getElementById('rat-excluir').onclick = ratExcluir
    document.getElementById('rat-nova-tarefa').onclick = abrirPend
    // Faturamento
    document.getElementById('cc-fat-btn').onclick = faturarTarefa
    document.getElementById('cc-fat-undo').onclick = desfazerFaturamento
    // Pendência -> nova tarefa
    document.getElementById('pend-x').onclick = () => fecharModal('modal-pend')
    document.getElementById('pend-cancelar').onclick = () => fecharModal('modal-pend')
    document.getElementById('pend-criar').onclick = criarTarefaPendencia
    attachAutocomplete(
      document.getElementById('cc-add-busca'),
      document.getElementById('cc-add-prod'),
      document.getElementById('cc-add-list'),
      ref.produtos,
      p => ({ id: p.id, label: `${p.codigo ? p.codigo + ' · ' : ''}${p.descricao}`,
              html: `<div class="ac-prod"><span class="ac-cod">${esc(p.codigo || '—')}</span><span class="ac-desc">${esc(p.descricao || '')}</span><span class="ac-preco">${money(p.preco_venda)}</span></div>` }),
      null,
    )
    attachAutocomplete(
      document.getElementById('cc-eq-busca'),
      document.getElementById('cc-eq-sel'),
      document.getElementById('cc-eq-list'),
      ref.equip,
      e => ({ id: e.id, label: equipLabel(e),
              html: `<div class="ac-prod"><span class="ac-desc">${esc(e.modelo || e.tipo || '—')}</span><span class="ac-cod">${esc(e.serial ? 'S/N ' + e.serial : (e.part_number ? 'PN ' + e.part_number : ''))}</span></div>` }),
      null,
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
      .select('id,numero,status,criado_em,data_agendada,orcamento_id,cliente_id,orientacao,observacoes,pedido_compra,tipo_servico_id,conciliacao_obs,pendencias,faturado,data_faturamento,numero_nota')
      .order('numero', { ascending: false })
    if (error) { toast('Erro ao carregar tarefas: ' + error.message, 'err'); tarefas = []; return }
    tarefas = ts || []
    tecPorTarefa = {}
    const { data: tts } = await sb().from('tarefa_tecnicos').select('tarefa_id,tecnico_id')
    for (const r of tts || []) (tecPorTarefa[r.tarefa_id] = tecPorTarefa[r.tarefa_id] || []).push(r.tecnico_id)
    const ids = [...new Set(tarefas.map(t => t.cliente_id).filter(Boolean))]
    cliNomes = {}
    if (ids.length) { const { data: cs } = await sb().from('clientes').select('id,nome').in('id', ids); for (const c of cs || []) cliNomes[c.id] = c.nome }
    const oids = [...new Set(tarefas.map(t => t.orcamento_id).filter(Boolean))]
    orcNo = {}
    if (oids.length) { const { data: os } = await sb().from('orcamentos').select('id,numero').in('id', oids); for (const o of os || []) orcNo[o.id] = o.numero }
    divPorTarefa = {}
    const { data: vc } = await sb().from('vw_conciliacao_tarefa').select('tarefa_id,situacao,revisado')
    for (const r of vc || []) { if (r.situacao && r.situacao !== 'ok' && !r.revisado) divPorTarefa[r.tarefa_id] = (divPorTarefa[r.tarefa_id] || 0) + 1 }
  }

  function renderLista() {
    const box = document.getElementById('lista-box')
    const q = normStr(document.getElementById('busca-tarefa').value || '')
    let rows = tarefas
    if (filtro === 'divergencia') rows = rows.filter(t => divPorTarefa[t.id])
    else if (filtro === 'a_faturar') rows = rows.filter(t => !t.faturado && (t.status === 'concluida' || t.status === 'concluida_pendencia'))
    else if (filtro !== 'todas') rows = rows.filter(t => t.status === filtro)
    if (q) rows = rows.filter(t => normStr(cliNomes[t.cliente_id] || '').includes(q) || String(t.numero || '').includes(q))
    if (!rows.length) { box.innerHTML = '<div class="cc-empty">Nenhuma tarefa encontrada.</div>'; return }
    box.innerHTML = `<table class="cc-list"><thead><tr>
        <th>Nº</th><th>Cliente</th><th>Status</th><th>Técnico</th><th>Agenda</th><th>Conciliação</th><th>Ações</th>
      </tr></thead><tbody>${rows.map(t => {
        const d = divPorTarefa[t.id] || 0
        const concil = d ? `<span class="pill pill-warn">${d} a revisar</span>` : '<span class="pill pill-ok">OK</span>'
        const tids = tecPorTarefa[t.id] || []
        const tec = tids.length ? esc(tids.map(id => tecNomes[id] || '—').join(', ')) : '<span class="pill pill-warn">atribuir</span>'
        return `<tr class="row-click" data-id="${esc(t.id)}">
          <td class="cc-num">${osNo(t.numero)}</td>
          <td>${esc(cliNomes[t.cliente_id] || '—')}</td>
          <td><span class="st">${esc(STATUS_LABEL[t.status] || t.status || '—')}</span>${t.faturado ? ' <span class="pill pill-fat">Faturada</span>' : ''}</td>
          <td>${tec}</td>
          <td>${t.data_agendada ? dmy(t.data_agendada) : '<span class="st">—</span>'}</td>
          <td>${concil}</td>
          <td><div class="acts" style="opacity:1">
            <button class="ab ab-v" data-edit="${esc(t.id)}">Editar</button>
            <button class="ab ab-d" data-del="${esc(t.id)}">Excluir</button>
          </div></td>
        </tr>`
      }).join('')}</tbody></table>`
    box.querySelectorAll('.row-click').forEach(tr => tr.onclick = (e) => { if (e.target.closest('.acts')) return; abrirTarefa(tr.dataset.id) })
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = (e) => { e.stopPropagation(); abrirTarefa(b.dataset.edit) })
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); excluirTarefaLista(b.dataset.del) })
  }

  async function excluirTarefaLista(id) {
    const t = tarefas.find(x => x.id === id)
    if (!confirm(`Excluir a Tarefa Nº ${osNo(t && t.numero)}? Remove conciliação, RATs, produtos, anexos e equipamentos. Esta ação não pode ser desfeita.`)) return
    const { error } = await sb().rpc('admin_excluir_tarefa', { p_tarefa: id })
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    toast('Tarefa excluída.', 'ok')
    await carregarTarefas()
    renderLista()
  }

  // ─────────────────────── Nova tarefa (sem orçamento) ───────────────────────
  function abrirModalNovaTarefa() {
    document.getElementById('nt-cliente').value = ''
    document.getElementById('nt-cliente-busca').value = ''
    document.getElementById('modal-nova-tarefa').classList.add('open')
    document.getElementById('nt-cliente-busca').focus()
  }
  function fecharModalNovaTarefa() {
    document.getElementById('modal-nova-tarefa').classList.remove('open')
  }
  async function criarTarefa() {
    const cliId = document.getElementById('nt-cliente').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    const ins = await sb().from('tarefas')
      .insert({ cliente_id: cliId, status: 'aguardando_execucao', criado_por: user.id })
      .select('id,numero').single()
    if (ins.error) return toast('Erro ao criar tarefa: ' + ins.error.message, 'err')
    fecharModalNovaTarefa()
    toast(`Tarefa Nº ${osNo(ins.data.numero)} criada.`, 'ok')
    await carregarTarefas()
    await abrirTarefa(ins.data.id)
  }

  // ─────────────────────────── Detalhe ───────────────────────────
  async function abrirTarefa(id, aba) {
    const t = tarefas.find(x => x.id === id); if (!t) return
    cur = { id, numero: t.numero, status: t.status, cliente_nome: cliNomes[t.cliente_id] || '—', equip: [], anexos: [] }
    mostrarPane(aba)
    document.getElementById('cc-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-docno').textContent = cur.numero != null ? `Tarefa Nº ${osNo(cur.numero)}` : ''
    document.getElementById('cc-badge').textContent = STATUS_LABEL[cur.status] || cur.status || ''
    // Card "Dados da Tarefa"
    document.getElementById('cc-d-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-d-orc').textContent = t.orcamento_id ? `Orçamento Nº ${orcNo[t.orcamento_id] ?? '—'}` : 'Criada direto (sem orçamento)'
    document.getElementById('cc-d-status').textContent = (STATUS_LABEL[cur.status] || cur.status || '—') +
      (cur.status === 'concluida_pendencia' && t.pendencias ? ' — ' + t.pendencias : '')
    document.getElementById('cc-d-tipo').value = t.tipo_servico_id || ''
    setTecnicosChecked(tecPorTarefa[id] || [])
    document.getElementById('cc-d-data').value = t.data_agendada || ''
    document.getElementById('cc-d-pc').value = t.pedido_compra || ''
    document.getElementById('cc-d-orientacao').value = t.orientacao || ''
    document.getElementById('cc-d-obs').value = t.observacoes || ''
    autoGrow(document.getElementById('cc-d-orientacao'))
    autoGrow(document.getElementById('cc-d-obs'))
    document.getElementById('cc-d-hint').textContent = (tecPorTarefa[id] || []).length ? '' : 'Atribua um ou mais técnicos e agende para a Tarefa aparecer no app do técnico.'
    document.getElementById('cc-obs').value = t.conciliacao_obs || ''
    document.getElementById('cc-obs-hint').textContent = ''
    limparAdd()
    document.getElementById('cc-eq-busca').value = ''; document.getElementById('cc-eq-sel').value = ''
    renderFaturamento(t)
    await Promise.all([carregarLinhas(), carregarEquip(), carregarAnexos(), carregarRats()])
    mostrar('detalhe')
    // recalcula a altura só depois do detalhe ficar visível (scrollHeight=0 se oculto)
    autoGrow(document.getElementById('cc-d-orientacao'))
    autoGrow(document.getElementById('cc-d-obs'))
  }

  async function salvarDados() {
    if (!cur || !cur.id) return
    const patch = {
      tipo_servico_id: document.getElementById('cc-d-tipo').value || null,
      data_agendada: document.getElementById('cc-d-data').value || null,
      pedido_compra: document.getElementById('cc-d-pc').value.trim() || null,
      orientacao: document.getElementById('cc-d-orientacao').value.trim() || null,
      observacoes: document.getElementById('cc-d-obs').value.trim() || null,
    }
    const up = await sb().from('tarefas').update(patch).eq('id', cur.id)
    if (up.error) return toast('Erro ao salvar: ' + up.error.message, 'err')
    // sincroniza técnicos (N:N): substitui o conjunto
    const tecIds = getTecnicosChecked()
    const del = await sb().from('tarefa_tecnicos').delete().eq('tarefa_id', cur.id)
    if (del.error) return toast('Erro ao salvar técnicos: ' + del.error.message, 'err')
    if (tecIds.length) {
      const insT = await sb().from('tarefa_tecnicos').insert(tecIds.map(tid => ({ tarefa_id: cur.id, tecnico_id: tid })))
      if (insT.error) return toast('Erro ao salvar técnicos: ' + insT.error.message, 'err')
    }
    tecPorTarefa[cur.id] = tecIds
    // atualiza cache local p/ a lista refletir sem novo fetch
    const t = tarefas.find(x => x.id === cur.id)
    if (t) Object.assign(t, patch)
    document.getElementById('cc-d-hint').textContent = tecIds.length ? '' : 'Atribua um ou mais técnicos e agende para a Tarefa aparecer no app do técnico.'
    toast('Dados da Tarefa salvos.', 'ok')
  }

  async function excluirTarefa() {
    if (!cur || !cur.id) return
    if (!confirm(`Excluir a Tarefa Nº ${osNo(cur.numero)}? Remove a conciliação, RATs, produtos, anexos e equipamentos desta tarefa. Esta ação não pode ser desfeita.`)) return
    const { error } = await sb().rpc('admin_excluir_tarefa', { p_tarefa: cur.id })
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    toast('Tarefa excluída.', 'ok')
    cur = null
    history.replaceState(null, '', 'tarefa.html')
    mostrar('lista')
    await carregarTarefas()
    renderLista()
  }

  async function salvarConcilObs() {
    if (!cur || !cur.id) return
    const val = document.getElementById('cc-obs').value.trim() || null
    const up = await sb().from('tarefas').update({ conciliacao_obs: val }).eq('id', cur.id)
    if (up.error) return toast('Erro ao salvar: ' + up.error.message, 'err')
    const t = tarefas.find(x => x.id === cur.id); if (t) t.conciliacao_obs = val
    document.getElementById('cc-obs-hint').textContent = 'Salvo.'
    toast('Observações dos produtos salvas.', 'ok')
  }

  // ───────────────────── Equipamentos relacionados ─────────────────────
  async function carregarEquip() {
    const { data, error } = await sb().from('tarefa_equipamentos').select('equipamento_id').eq('tarefa_id', cur.id)
    cur.equip = error ? [] : (data || []).map(r => r.equipamento_id)
    renderEquip()
  }
  function renderEquip() {
    const box = document.getElementById('cc-eq-chips')
    if (!cur.equip || !cur.equip.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhum equipamento vinculado.</span>'; return }
    box.innerHTML = cur.equip.map(id => {
      const e = ref.equip.find(x => x.id === id) || {}
      const sub = e.serial ? 'S/N ' + e.serial : (e.part_number ? 'PN ' + e.part_number : '')
      return `<span class="cc-chip"><span>${esc(e.modelo || e.tipo || 'Equipamento')}</span>${sub ? `<span class="cc-chip-sub">${esc(sub)}</span>` : ''}<button class="x" data-eq="${esc(id)}" title="Remover">×</button></span>`
    }).join('')
    box.querySelectorAll('[data-eq]').forEach(b => b.onclick = () => removerEquip(b.dataset.eq))
  }
  async function vincularEquip() {
    const id = document.getElementById('cc-eq-sel').value
    if (!id) return toast('Selecione um equipamento na busca.', 'err')
    if ((cur.equip || []).includes(id)) return toast('Equipamento já vinculado.', 'err')
    const ins = await sb().from('tarefa_equipamentos').insert({ tarefa_id: cur.id, equipamento_id: id })
    if (ins.error) return toast('Erro: ' + ins.error.message, 'err')
    document.getElementById('cc-eq-busca').value = ''; document.getElementById('cc-eq-sel').value = ''
    await carregarEquip()
  }
  async function removerEquip(id) {
    const d = await sb().from('tarefa_equipamentos').delete().eq('tarefa_id', cur.id).eq('equipamento_id', id)
    if (d.error) return toast('Erro: ' + d.error.message, 'err')
    await carregarEquip()
  }

  // ───────────────────── Anexos ─────────────────────
  async function carregarAnexos() {
    const { data, error } = await sb().from('tarefa_anexos').select('*').eq('tarefa_id', cur.id).order('criado_em')
    cur.anexos = error ? [] : (data || [])
    renderAnexos()
  }
  function renderAnexos() {
    const box = document.getElementById('cc-anx-list')
    if (!cur.anexos || !cur.anexos.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhum anexo.</span>'; return }
    box.innerHTML = cur.anexos.map(a => `<div class="cc-anx-item"><span>📄</span><a class="nome" data-anx="${esc(a.id)}">${esc(a.nome)}</a><span class="sz">${fmtSize(a.tamanho)}</span><button class="x" data-del="${esc(a.id)}" title="Remover">×</button></div>`).join('')
    box.querySelectorAll('[data-anx]').forEach(el => el.onclick = () => baixarAnexo(el.dataset.anx))
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removerAnexo(b.dataset.del))
  }
  async function adicionarAnexos(files) {
    if (!cur || !cur.id || !files || !files.length) return
    for (const f of files) {
      const ext = (f.name.split('.').pop() || 'bin').toLowerCase()
      const path = `tarefas/${cur.id}/${crypto.randomUUID()}.${ext}`
      const up = await sb().storage.from('rat-anexos').upload(path, f, { contentType: f.type || undefined })
      if (up.error) { toast('Erro ao enviar ' + f.name + ': ' + up.error.message, 'err'); continue }
      const ins = await sb().from('tarefa_anexos').insert({ tarefa_id: cur.id, nome: f.name, url: path, mime: f.type || null, tamanho: f.size, criado_por: user.id })
      if (ins.error) toast('Erro ao registrar ' + f.name + ': ' + ins.error.message, 'err')
    }
    document.getElementById('cc-anx-input').value = ''
    toast('Anexos enviados.', 'ok')
    await carregarAnexos()
  }
  async function baixarAnexo(id) {
    const a = (cur.anexos || []).find(x => x.id === id); if (!a) return
    const { data, error } = await sb().storage.from('rat-anexos').createSignedUrl(a.url, 120)
    if (error) return toast('Erro ao abrir: ' + error.message, 'err')
    window.open(data.signedUrl, '_blank')
  }
  async function removerAnexo(id) {
    const a = (cur.anexos || []).find(x => x.id === id); if (!a) return
    if (!confirm('Remover este anexo?')) return
    await sb().storage.from('rat-anexos').remove([a.url]).catch(() => {})
    const d = await sb().from('tarefa_anexos').delete().eq('id', id)
    if (d.error) return toast('Erro: ' + d.error.message, 'err')
    await carregarAnexos()
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
      tb.innerHTML = '<tr><td colspan="9" class="cc-empty">Sem produtos nesta tarefa. Adicione abaixo.</td></tr>'
    } else {
      tb.innerHTML = linhas.map((l, i) => {
        const sit = SIT[l.situacao] || { t: l.situacao, cls: '' }
        const fora = l.situacao === 'sem_orcada'
        const orcada = Number(l.qtd_orcada) || 0
        const lev = Number(l.qtd_levada) || 0
        const util = Number(l.qtd_utilizada) || 0
        const dev = Number(l.qtd_devolvida) || 0
        const devNeg = dev < 0                 // usado sem ter sido levado: não imprime negativo
        const devShown = Math.max(0, dev)
        const semOrcada = orcada <= 0          // avulso/fora → preço editável
        const preco = Number(l.preco_unitario) || 0
        // caixa somente-leitura (igual à da Levada); 0 em cinza; sem "—"
        const box = (v, cls) => `<div class="cc-box${cls ? ' ' + cls : ''}">${v}</div>`
        const cOrcada = `<td>${box(qtd(orcada), orcada === 0 ? 'zero' : '')}</td>`
        const cUtil = `<td>${box(qtd(util), devNeg ? 'alert' : (util === 0 ? 'zero' : ''))}</td>`
        const cDev = `<td>${box(qtd(devShown), devShown === 0 ? 'zero' : '')}</td>`
        const cPreco = semOrcada
          ? `<td><input class="edit cc-preco" type="number" inputmode="decimal" min="0" step="0.01" value="${preco > 0 ? preco : ''}" data-i="${i}" placeholder="0,00"></td>`
          : `<td>${box(money(preco), 'money')}</td>`
        const sub = util * preco
        const cSub = `<td>${box(money(sub), 'money' + (sub === 0 ? ' zero' : ''))}</td>`
        const badgeTxt = (l.situacao === 'devolver' && dev > 0) ? `Devolver ${qtd(dev)}` : sit.t
        const rev = !!l.revisado
        const cSit = l.situacao === 'ok'
          ? `<td class="c"><span class="sit ${sit.cls}">${esc(badgeTxt)}</span></td>`
          : `<td class="c"><div class="cc-sit">
               <span class="sit ${sit.cls}">${esc(badgeTxt)}</span>
               <button class="cc-rev${rev ? ' on' : ''}" data-i="${i}">${rev ? '✓ Revisado' : 'Revisar'}</button>
             </div></td>`
        return `<tr class="${fora ? 'row-fora' : ''}${rev ? ' row-rev' : ''}">
          <td class="l cc-mat"><div class="cc-desc">${esc(l.descricao || '—')}</div>${l.codigo_produto ? `<div class="cc-cod">${esc(l.codigo_produto)}</div>` : ''}</td>
          <td class="c un">${esc(l.unidade || '—')}</td>
          ${cOrcada}
          <td><input class="edit cc-lev" type="number" inputmode="decimal" min="0" step="any" value="${lev}" data-i="${i}"></td>
          ${cUtil}
          ${cDev}
          ${cSit}
          ${cPreco}
          ${cSub}
        </tr>`
      }).join('')
      tb.querySelectorAll('.cc-lev').forEach(inp => inp.onchange = () => salvarLevada(Number(inp.dataset.i), inp.value))
      tb.querySelectorAll('.cc-preco').forEach(inp => inp.onchange = () => salvarPreco(Number(inp.dataset.i), inp.value))
      tb.querySelectorAll('.cc-rev').forEach(btn => btn.onclick = () => salvarRevisado(Number(btn.dataset.i), !linhas[Number(btn.dataset.i)].revisado))
    }
    renderStats()
  }

  // Resumo de custo (Orçado × Utilizado → faturamento) e devoluções (→ estoque).
  function renderStats() {
    const box = document.getElementById('cc-stats')
    if (!linhas.length) { box.innerHTML = ''; return }
    let custoOrcado = 0, custoUtil = 0, devValor = 0, devItens = 0, div = 0, aRevisar = 0
    for (const l of linhas) {
      const p = Number(l.preco_unitario) || 0
      custoOrcado += (Number(l.qtd_orcada) || 0) * p
      custoUtil   += (Number(l.qtd_utilizada) || 0) * p
      const d = Number(l.qtd_devolvida) || 0
      if (d > 0) { devItens++; devValor += d * p }
      if (l.situacao !== 'ok') { div++; if (!l.revisado) aRevisar++ }
    }
    const delta = custoUtil - custoOrcado
    const dcls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    const dtxt = delta > 0 ? `↑ ${money(delta)} acima do orçado`
               : delta < 0 ? `↓ ${money(-delta)} abaixo do orçado` : 'igual ao orçado'
    box.innerHTML = `
      <div class="stat"><div class="k">Valor orçado</div><div class="v">${money(custoOrcado)}</div><div class="d flat">venda (do orçamento)</div></div>
      <div class="stat"><div class="k">Valor utilizado</div><div class="v">${money(custoUtil)}</div><div class="d ${dcls}">${dtxt}</div></div>
      <div class="stat"><div class="k">A devolver ao estoque</div><div class="v">${money(devValor)}</div><div class="d flat">${devItens} item(ns)</div></div>
      <div class="stat ${aRevisar ? 'warn' : ''}"><div class="k">A revisar</div><div class="v">${aRevisar}</div><div class="d flat">${div ? (aRevisar ? `${aRevisar} de ${div} divergência${div > 1 ? 's' : ''}` : 'tudo revisado') : 'tudo conciliado'}</div></div>`
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

  // Valor unitário de venda do produto (tarefa_materiais.preco_unitario).
  async function salvarPreco(i, val) {
    const l = linhas[i]; if (!l) return
    const v = Number(val) || 0
    let err
    if (l.tm_id) {
      err = (await sb().from('tarefa_materiais').update({ preco_unitario: v }).eq('id', l.tm_id)).error
    } else {
      // linha "fora da proposta" (sem linha orçada) — cria p/ registrar o valor
      err = (await sb().from('tarefa_materiais').insert({
        tarefa_id: cur.id, produto_id: l.produto_id || null, codigo_produto: l.codigo_produto || null,
        descricao: l.descricao || '(sem descrição)', unidade: l.unidade || null,
        preco_unitario: v, qtd_orcada: 0, qtd_levada: Number(l.qtd_levada) || 0, origem: 'avulso',
      })).error
    }
    if (err) return toast('Erro ao salvar valor: ' + err.message, 'err')
    toast('Valor unitário atualizado.', 'ok')
    await carregarLinhas()
  }

  // Marca/desmarca a linha como revisada pelo admin.
  async function salvarRevisado(i, val) {
    const l = linhas[i]; if (!l) return
    let err
    if (l.tm_id) {
      err = (await sb().from('tarefa_materiais').update({ revisado: val }).eq('id', l.tm_id)).error
    } else {
      err = (await sb().from('tarefa_materiais').insert({
        tarefa_id: cur.id, produto_id: l.produto_id || null, codigo_produto: l.codigo_produto || null,
        descricao: l.descricao || '(sem descrição)', unidade: l.unidade || null,
        preco_unitario: Number(l.preco_unitario) || 0, qtd_orcada: 0, qtd_levada: Number(l.qtd_levada) || 0,
        origem: 'avulso', revisado: val,
      })).error
    }
    if (err) return toast('Erro ao salvar revisão: ' + err.message, 'err')
    await carregarLinhas()
  }

  // Adiciona material do catálogo (produto selecionado na busca). Levada = 0; edita-se na linha.
  async function adicionarMaterialCatalogo() {
    const pid = document.getElementById('cc-add-prod').value
    const p = ref.produtos.find(x => x.id === pid)
    if (!p) return toast('Busque e selecione um produto do catálogo (ou use "Item avulso").', 'err')
    await inserirMaterial({ produto_id: p.id, codigo_produto: p.codigo || null, descricao: p.descricao, unidade: p.unidade || null, preco_unitario: Number(p.preco_venda) || 0 })
  }
  // Adiciona item avulso usando o texto digitado na busca como descrição.
  async function adicionarMaterialAvulso() {
    const desc = document.getElementById('cc-add-busca').value.trim()
    if (!desc) return toast('Digite a descrição do item avulso na busca.', 'err')
    await inserirMaterial({ produto_id: null, codigo_produto: null, descricao: desc, unidade: null, preco_unitario: 0 })
  }
  async function inserirMaterial(m) {
    const ins = await sb().from('tarefa_materiais').insert({
      tarefa_id: cur.id, produto_id: m.produto_id, codigo_produto: m.codigo_produto,
      descricao: m.descricao, unidade: m.unidade, preco_unitario: m.preco_unitario,
      qtd_orcada: 0, qtd_levada: 0, origem: 'avulso',
    })
    if (ins.error) {
      if (ins.error.code === '23505') return toast('Esse produto já está na lista — edite a Levada na linha.', 'err')
      return toast('Erro: ' + ins.error.message, 'err')
    }
    limparAdd()
    toast('Produto adicionado — informe a Levada na linha.', 'ok')
    await carregarLinhas()
  }

  function limparAdd() {
    document.getElementById('cc-add-busca').value = ''
    document.getElementById('cc-add-prod').value = ''
  }

  // ───────────────────── RATs da tarefa ─────────────────────
  const abrirModal = (id) => document.getElementById(id).classList.add('open')
  const fecharModal = (id) => document.getElementById(id).classList.remove('open')

  async function carregarRats() {
    const { data, error } = await sb().from('rats').select(RatView.RAT_SELECT)
      .eq('tarefa_id', cur.id).order('data_tarefa', { ascending: true, nullsFirst: true })
    cur.rats = error ? [] : (data || [])
    renderRats()
  }
  // Mostra as RATs já abertas (expandidas) dentro da aba.
  async function renderRats() {
    const box = document.getElementById('cc-rat-list')
    const rats = cur.rats || []
    document.getElementById('cc-rat-pdf').disabled = !rats.length
    if (!rats.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhuma RAT registrada nesta tarefa ainda.</span>'; return }
    box.innerHTML = '<span class="cc-empty-sm">Carregando RATs…</span>'
    const dets = []
    for (const r of rats) dets.push(await RatView.loadDetalhe(r))
    box.innerHTML = dets.map(d => {
      const r = d.r
      return `<div class="rat-open">
        <div class="rat-open-h">
          <div><b>RAT · ${fdt(r.data_tarefa, { withTime: true })}</b> · ${esc(r.tecnico_nome || '—')} · ${RatView.fmtMin(RatView.tempoRat(r))}</div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="ri-sit">${esc(ratSit(r.status))}</span>
            <a class="btn btn-sm" href="rat.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Abrir ↗</a>
          </div>
        </div>
        ${RatView.buildReportBody(d, false, { noHeader: true })}
      </div>`
    }).join('')
  }

  let ratMulti = false, ratList = []
  function toggleRatBtns(multi) {
    const show = (id, v) => { document.getElementById(id).style.display = v ? '' : 'none' }
    show('rat-editar', !multi && !ratEdit)
    show('rat-salvar', !multi && ratEdit)
    show('rat-cancelar', !multi && ratEdit)
    show('rat-excluir', !multi && !ratEdit)
    show('rat-nova-tarefa', !multi && !ratEdit)
    show('rat-pdf', true)
  }
  function renderRatModal() {
    document.getElementById('rat-modal-title').textContent = 'Detalhe da RAT'
    document.getElementById('rat-body').innerHTML = RatView.buildReportBody(ratDet, ratEdit)
    toggleRatBtns(false)
  }
  async function verRat(id) {
    const r = (cur.rats || []).find(x => x.id === id); if (!r) return
    ratMulti = false; ratEdit = false
    ratDet = await RatView.loadDetalhe(r)
    renderRatModal()
    abrirModal('modal-rat')
  }
  function ratEntrarEdicao() { ratEdit = true; renderRatModal() }
  function ratCancelarEdicao() { ratEdit = false; renderRatModal() }
  async function ratSalvarEdicao() {
    if (!ratDet) return
    const { respostas, tempo } = RatView.coletarEdicao(document.getElementById('rat-body'), ratDet)
    const upd = { respostas }; if (tempo != null) upd.tempo_trabalhado = tempo
    const { error } = await sb().from('rats').update(upd).eq('id', ratDet.r.id)
    if (error) return toast('Erro ao salvar: ' + error.message, 'err')
    ratDet.r.respostas = respostas; if (tempo != null) ratDet.r.tempo_trabalhado = tempo
    const c = (cur.rats || []).find(x => x.id === ratDet.r.id); if (c) { c.respostas = respostas; if (tempo != null) c.tempo_trabalhado = tempo }
    ratEdit = false; renderRatModal(); renderRats()
    toast('RAT atualizada.', 'ok')
  }
  function ratPdf() {
    if (ratMulti) RatView.gerarPdf(ratList, `RATs Tarefa ${osNo(cur.numero)}`)
    else if (ratDet) RatView.gerarPdf([ratDet], `RAT ${cur.cliente_nome || ''} ${osNo(cur.numero)}`.trim())
  }
  async function ratExcluir() {
    if (!ratDet) return
    if (!confirm('Excluir esta RAT? Remove os produtos e fotos dela. Esta ação não pode ser desfeita.')) return
    const { error } = await sb().rpc('admin_excluir_rat', { p_rat: ratDet.r.id })
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    toast('RAT excluída.', 'ok')
    fecharModal('modal-rat')
    await Promise.all([carregarRats(), carregarLinhas()])  // "Utilizada" depende das RATs
  }
  async function verTodasRats() {
    const rats = cur.rats || []
    if (!rats.length) return toast('Nenhuma RAT nesta tarefa.', 'err')
    ratList = []
    for (const r of rats) ratList.push(await RatView.loadDetalhe(r))
    ratMulti = true; ratEdit = false
    document.getElementById('rat-modal-title').textContent = `Todas as RATs (${ratList.length})`
    document.getElementById('rat-body').innerHTML = ratList.map(d => RatView.buildReportBody(d, false)).join('')
    toggleRatBtns(true)
    abrirModal('modal-rat')
  }
  async function pdfUnificado() {
    const rats = cur.rats || []
    if (!rats.length) return toast('Nenhuma RAT para gerar PDF.', 'err')
    const dets = []
    for (const r of rats) dets.push(await RatView.loadDetalhe(r))
    RatView.gerarPdf(dets, `RATs Tarefa ${osNo(cur.numero)}`)
  }

  // Nova tarefa a partir da pendência de uma RAT.
  function abrirPend() {
    const r = ratDet && ratDet.r; if (!r) return
    pendRat = r
    const resp = r.respostas || {}
    const pend = (r.pendencias && r.pendencias.trim()) || (resp.observacoes && String(resp.observacoes).trim()) || ''
    const tipoOrig = (r.tarefa && r.tarefa.tipo_servico_id) || ''
    document.getElementById('pend-cli').textContent = r.cliente_nome || cur.cliente_nome || '—'
    document.getElementById('pend-tipo').innerHTML = ref.tipos.map(t =>
      `<option value="${esc(t.id)}"${t.id === tipoOrig ? ' selected' : ''}>${esc(t.nome)}</option>`).join('')
    document.getElementById('pend-orient').value = pend
    document.getElementById('pend-origem').textContent = cur.numero != null ? `Origem: Tarefa Nº ${osNo(cur.numero)}` : ''
    abrirModal('modal-pend')
  }
  async function criarTarefaPendencia() {
    if (!pendRat) return
    const cliId = pendRat.cliente_id || (pendRat.tarefa && pendRat.tarefa.cliente_id)
    const tipoId = document.getElementById('pend-tipo').value
    const orient = document.getElementById('pend-orient').value.trim()
    if (!cliId) return toast('RAT sem cliente vinculado.', 'err')
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')
    const ins = await sb().from('tarefas').insert({
      cliente_id: cliId, tipo_servico_id: tipoId, status: 'aguardando_execucao',
      orientacao: orient || null,
      observacoes: cur.numero != null ? `Gerada da pendência da Tarefa Nº ${osNo(cur.numero)}.` : 'Gerada de pendência de RAT.',
      criado_por: user.id,
    }).select('numero').single()
    if (ins.error) return toast('Erro ao criar tarefa: ' + ins.error.message, 'err')
    fecharModal('modal-pend')
    toast(`Tarefa Nº ${osNo(ins.data.numero)} criada. Atribua o técnico na lista.`, 'ok')
    await carregarTarefas()
  }

  // ───────────────────── Faturamento (por Tarefa) ─────────────────────
  function renderFaturamento(t) {
    const fat = !!(t && t.faturado)
    document.getElementById('cc-fat-status').textContent = fat
      ? `Faturada${t.numero_nota ? ' · Nota ' + t.numero_nota : ''}${t.data_faturamento ? ' · ' + dmy(t.data_faturamento) : ''}`
      : 'Não faturada'
    document.getElementById('cc-fat-nota').value = (t && t.numero_nota) || ''
    document.getElementById('cc-fat-nota').style.display = fat ? 'none' : ''
    document.getElementById('cc-fat-btn').style.display = fat ? 'none' : ''
    document.getElementById('cc-fat-undo').style.display = fat ? '' : 'none'
  }
  async function faturarTarefa() {
    if (!cur || !cur.id) return
    const nota = document.getElementById('cc-fat-nota').value.trim() || null
    const iso = new Date().toISOString()
    const up = await sb().from('tarefas').update({ faturado: true, data_faturamento: iso, numero_nota: nota }).eq('id', cur.id)
    if (up.error) return toast('Erro ao faturar: ' + up.error.message, 'err')
    const t = tarefas.find(x => x.id === cur.id); if (t) { t.faturado = true; t.data_faturamento = iso; t.numero_nota = nota }
    renderFaturamento({ faturado: true, data_faturamento: iso, numero_nota: nota })
    toast('Tarefa marcada como faturada.', 'ok')
  }
  async function desfazerFaturamento() {
    if (!cur || !cur.id) return
    if (!confirm('Desfazer o faturamento desta tarefa?')) return
    const up = await sb().from('tarefas').update({ faturado: false, data_faturamento: null, numero_nota: null }).eq('id', cur.id)
    if (up.error) return toast('Erro: ' + up.error.message, 'err')
    const t = tarefas.find(x => x.id === cur.id); if (t) { t.faturado = false; t.data_faturamento = null; t.numero_nota = null }
    renderFaturamento({ faturado: false })
    toast('Faturamento desfeito.', 'ok')
  }

  function mostrar(sec) {
    document.getElementById('view-lista').style.display = sec === 'lista' ? 'block' : 'none'
    document.getElementById('view-detalhe').style.display = sec === 'detalhe' ? 'block' : 'none'
    document.getElementById('topbar-title').textContent = sec === 'detalhe' ? 'Tarefa' : 'Tarefas'
    const badge = document.getElementById('cc-badge')
    if (sec !== 'detalhe') { badge.style.display = 'none'; document.getElementById('cc-docno').textContent = '' }
    else badge.style.display = ''
  }

  // Abas do detalhe: mostra um card por vez e reflete na URL (tarefa.html?t=<id>&aba=<key>).
  function mostrarPane(key) {
    if (!PANES.includes(key)) key = 'dados'
    document.querySelectorAll('#cc-tabs .cc-tab').forEach(b => b.classList.toggle('on', b.dataset.pane === key))
    document.querySelectorAll('#view-detalhe .cc-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === key))
    if (key === 'dados') { autoGrow(document.getElementById('cc-d-orientacao')); autoGrow(document.getElementById('cc-d-obs')) }
    if (cur && cur.id) history.replaceState(null, '', `tarefa.html?t=${encodeURIComponent(cur.id)}&aba=${key}`)
  }

  return { init }
})()
