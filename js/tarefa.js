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
  let cliConf = {}           // cliente_id -> { modalidade_padrao, valor_hora_padrao, dia_continuo }
  let tecNomes = {}          // tecnico_id -> nome
  let tecPorTarefa = {}      // tarefa_id -> [tecnico_id]
  let orcNo = {}             // orcamento_id -> numero
  let divPorTarefa = {}      // tarefa_id -> nº de linhas com divergência
  let matsPorTarefa = {}     // tarefa_id -> texto dos produtos (p/ busca)
  let cur = null             // tarefa aberta
  let linhas = []            // conciliação da tarefa atual
  let selMat = new Set()     // tm_ids de produtos selecionados p/ exclusão em massa
  let respSel = new Set()     // tecnico_ids responsáveis selecionados (chips) na aba Dados
  let pendRat = null         // RAT base do modal "nova tarefa da pendência"
  let souAdmin = false       // só admin edita RAT (mesma regra do rat.html)

  const RAT_SIT = { em_andamento: 'Em andamento', registrado: 'Atendimento Realizado', concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência', improdutiva: 'Visita improdutiva' }
  const ratSit = (s) => RAT_SIT[s] || s || '—'
  const PANES = ['dados', 'equip', 'anexos', 'rats', 'desloc', 'material', 'fat']
  const urlTarefa = (id, aba) => `tarefa.html?t=${encodeURIComponent(id)}${aba ? '&aba=' + aba : ''}`
  const SVG_NEWTAB = '<svg viewBox="0 0 24 24"><path d="M14 3h7v7M21 3l-9 9M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>'
  // Data própria da RAT (campo respostas.data 'YYYY-MM-DD') — NÃO a data/hora da OS (data_tarefa).
  // Formata via new Date(y,m,d) local p/ evitar o new Date('YYYY-MM-DD') UTC que voltaria 1 dia.
  function fmtDataRat(r) {
    const s = r && r.respostas && r.respostas.data
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const [y, m, d] = s.slice(0, 10).split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
    }
    return fdt(r.data_tarefa, { withTime: true })   // RAT sem data própria: cai na data/hora da tarefa
  }
  // Cresce o textarea para caber todo o conteúdo (sem barra de rolagem).
  const autoGrow = (el) => { if (!el) return; el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px' }

  // Status configuráveis (tabela status_tarefa). Carregados em carregarStatus().
  let STATUS = {}   // chave -> { chave, label, cor, ordem, ativo, sistema }
  async function carregarStatus() {
    const { data } = await sb().from('status_tarefa').select('chave,label,cor,ordem,ativo,sistema').order('ordem')
    STATUS = {}
    for (const s of (data || [])) STATUS[s.chave] = s
    if (!Object.keys(STATUS).length) STATUS = { aguardando_execucao: { chave: 'aguardando_execucao', label: 'Aguardando execução', cor: '#B7791F', ordem: 10, ativo: true, sistema: true } }
  }
  const statusLabel = (k) => (STATUS[k] && STATUS[k].label) || k || '—'
  const statusCor = (k) => (STATUS[k] && STATUS[k].cor) || '#48506A'
  const statusStyleAttr = (k) => `background:${statusCor(k)}1A;color:${corTextoLegivel(statusCor(k))}`
  const statusAtivos = () => Object.values(STATUS).filter(s => s.ativo).sort((a, b) => a.ordem - b.ordem)
  // Opções <option> dos status ativos + garante a opção do status atual (mesmo inativo).
  function statusOptionsHTML(atual) {
    const arr = statusAtivos()
    if (atual && !arr.some(s => s.chave === atual)) arr.push(STATUS[atual] || { chave: atual, label: atual })
    return arr.map(s => `<option value="${esc(s.chave)}">${esc(s.label || s.chave)}</option>`).join('')
  }
  const setStatusBadge = (s) => {
    const b = document.getElementById('cc-badge'); if (b) { b.textContent = statusLabel(s); b.className = 'ed-badge'; b.style.cssText = statusStyleAttr(s) }
    const h = document.getElementById('cc-hd-status'); if (h) { h.textContent = statusLabel(s); h.style.color = corTextoLegivel(statusCor(s)) }
  }
  // Colore o <select> de Status conforme o valor (mesma paleta do badge).
  const pintarStatusSel = () => {
    const sel = document.getElementById('cc-d-status-sel'); if (!sel) return
    const c = statusCor(sel.value)
    sel.style.background = c + '1A'
    sel.style.color = corTextoLegivel(c)
    sel.style.borderColor = c + '66'
    sel.style.fontWeight = '700'
  }
  const iniciais = (n) => String(n || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '—'
  function renderHeader(t) {
    const tipo = (ref.tipos.find(x => x.id === (t && t.tipo_servico_id)) || {}).nome || ''
    const subEl = document.getElementById('cc-hd-sub'); if (subEl) subEl.textContent = tipo
    const dEl = document.getElementById('cc-hd-data'); if (dEl) dEl.textContent = (t && t.data_agendada) ? dmy(t.data_agendada) : '—'
    const ids = (cur && cur.id && tecPorTarefa[cur.id]) || []
    const pUser = ids.length ? (ref.tecnicos.find(x => x.id === ids[0]) || {}) : {}
    const principal = pUser.nome || ''
    const rEl = document.getElementById('cc-hd-resp'); if (rEl) rEl.textContent = principal || '—'
    const avEl = document.getElementById('cc-hd-resp-av')
    if (avEl) {
      const foto = avatarUrl(pUser.foto_url)
      avEl.innerHTML = principal ? (foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciais(principal))) : '—'
    }
    const noc = document.getElementById('cc-nochip'), dn = document.getElementById('cc-docno')
    if (noc) noc.style.display = (dn && dn.textContent.trim()) ? '' : 'none'
  }
  const SIT = {
    ok:            { t: 'OK',               cls: 's-ok' },
    devolver:      { t: 'Devolver',         cls: 's-dev' },
    sem_orcada:    { t: 'Fora da proposta', cls: 's-fora' },
    sem_orcamento: { t: 'Sem orçamento',    cls: 's-semorc' },   // tarefa SEM proposta: usado vira pendência NEUTRA (não "fora da proposta")
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
  // Corpo dos pushes de tarefa. data-only "YYYY-MM-DD" → "16/jun" SEM new Date (evita F1/UTC).
  const MES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  const dataCurta = (iso) => { const p = iso ? String(iso).slice(0, 10).split('-') : []; const m = Number(p[1]); return (p.length === 3 && m >= 1 && m <= 12) ? `${Number(p[2])}/${MES_ABREV[m - 1]}` : '' }
  const truncOri = (s) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 79) + '…' : s }
  const pushAtribTexto = (cli, dataIso, ori) => [cli, dataCurta(dataIso), truncOri(ori)].filter(Boolean).join(' · ')
  const pushReagendTexto = (cli, dataIso) => [cli, dataCurta(dataIso)].filter(Boolean).join(' · ')
  const equipLabel = (e) => `${e.modelo || e.tipo || 'Equipamento'}${e.serial ? ' · S/N ' + e.serial : ''}${e.part_number ? ' · PN ' + e.part_number : ''}`
  const fmtSize = (n) => { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  const getTecnicosChecked = () => [...respSel]
  const setTecnicosChecked = (ids) => { respSel = new Set(ids || []); renderRespChips() }
  // Responsáveis em chips (avatar + nome + papel + ×) com botão "+ Adicionar".
  function renderRespChips() {
    const box = document.getElementById('cc-d-tecnicos'); if (!box) return
    box.className = 'resp'
    const ROLE_RL = { admin: 'Administrador', gestor_axis: 'Gestor', tecnico_campo: 'Técnico' }
    const ids = [...respSel]
    const chips = ids.map((id) => {
      const u = ref.tecnicos.find(x => x.id === id) || {}
      const nome = u.nome || tecNomes[id] || '—'
      const papel = ROLE_RL[u.role] || 'Responsável'
      const rl = u.cargo ? `${u.cargo} · ${papel}` : papel
      const foto = avatarUrl(u.foto_url)
      const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciais(nome))
      return `<span class="chip"><span class="av">${av}</span>` +
        `<span><span class="nm">${esc(nome)}</span><br><span class="rl">${rl}</span></span>` +
        `<span class="x" data-rem="${esc(id)}" title="Remover">×</span></span>`
    }).join('')
    const disponiveis = ref.tecnicos.filter(t => !respSel.has(t.id))
    box.innerHTML = chips + (disponiveis.length ? '<span class="chip add" id="cc-resp-add">+ Adicionar</span>' : '')
    box.querySelectorAll('[data-rem]').forEach(x => x.onclick = () => { respSel.delete(x.dataset.rem); renderRespChips() })
    const addBtn = document.getElementById('cc-resp-add')
    if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); abrirRespMenu(addBtn, disponiveis) }
  }
  function abrirRespMenu(anchor, disponiveis) {
    const old = document.getElementById('cc-resp-menu')
    if (old) { old.remove(); return }
    const menu = document.createElement('div')
    menu.id = 'cc-resp-menu'; menu.className = 'resp-menu'
    menu.innerHTML = disponiveis.map(t => `<div class="resp-menu-item" data-add="${esc(t.id)}">${esc(tecNomes[t.id] || t.nome || '—')}</div>`).join('')
    anchor.parentNode.appendChild(menu)
    menu.querySelectorAll('[data-add]').forEach(it => it.onclick = () => { respSel.add(it.dataset.add); renderRespChips() })
    setTimeout(() => {
      const onDoc = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', onDoc) } }
      document.addEventListener('click', onDoc)
    }, 0)
  }

  async function init() {
    const { data: { user: u } } = await sb().auth.getUser()
    user.id = u?.id || null
    const [prod, tec, tip, eq, cli] = await Promise.all([
      (async () => {   // pagina p/ trazer TODOS os produtos (Supabase corta em 1000/req)
        const all = []; const P = 1000
        for (let i = 0; ; i += P) {
          const r = await sb().from('produtos').select('id,codigo,descricao,unidade,preco_venda').eq('ativo', true).eq('oculto', false).order('descricao').range(i, i + P - 1)
          if (r.error) return { data: all, error: r.error }
          all.push(...(r.data || []))
          if (!r.data || r.data.length < P) break
        }
        return { data: all }
      })(),
      sb().rpc('sr_usuarios'),   // usuários do SR (papel vindo do Portal/portal_acessos)
      sb().from('tipos_servico').select('id,nome').eq('ativo', true).order('nome'),
      sb().from('equipamentos_axis').select('id,tipo,part_number,modelo,serial').order('modelo'),
      sb().from('clientes').select('id,nome').eq('oculto', false).order('nome'),
    ])
    ref.produtos = prod.data || []
    ref.tecnicos = (tec.data || []).filter(u => u.ativo)   // responsáveis atribuíveis (admin + técnico do SR)
    souAdmin = ((ref.tecnicos.find(x => x.id === user.id) || {}).role) === 'admin'
    ref.tipos = tip.data || []
    ref.equip = eq.data || []
    ref.clientes = cli.data || []
    const ROLE_TAG = { admin: ' (Admin)', gestor_axis: ' (Gestor)', tecnico_campo: '' }
    tecNomes = {}; for (const t of ref.tecnicos) tecNomes[t.id] = (t.nome || '(sem nome)') + (ROLE_TAG[t.role] || '')
    renderRespChips()
    document.getElementById('cc-d-tipo').innerHTML = '<option value="">— selecione —</option>' + ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome || '')}</option>`).join('')
    await carregarStatus()
    document.getElementById('cc-d-status-sel').innerHTML = statusOptionsHTML()
    // Filtros combináveis da lista
    document.getElementById('f-status').innerHTML = '<option value="">Status: todos</option>' +
      statusAtivos().map(s => `<option value="${esc(s.chave)}">${esc(s.label || s.chave)}</option>`).join('') +
      '<option value="a_faturar">• A faturar</option><option value="divergencia">• A revisar</option><option value="pendente_class">• Pendente de classificação</option>'
    document.getElementById('f-tec').innerHTML = '<option value="">Responsável: todos</option>' +
      ref.tecnicos.map(t => `<option value="${esc(t.id)}">${esc(tecNomes[t.id] || t.nome || '(sem nome)')}</option>`).join('')
    document.getElementById('f-tipo').innerHTML = '<option value="">Tipo: todos</option>' +
      ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome || '')}</option>`).join('')
    bind()
    // ✨ Melhorar escrita (IA) nas textareas da Tarefa (desktop)
    if (typeof IA_BTN_HTML !== 'undefined') {
      const o = document.getElementById('cc-d-orientacao'); if (o) o.insertAdjacentHTML('afterend', IA_BTN_HTML)
      const ob = document.getElementById('cc-d-obs'); if (ob) ob.insertAdjacentHTML('afterend', IA_BTN_HTML)
    }
    const params = new URLSearchParams(location.search)
    const f = params.get('f')
    if (f) document.getElementById('f-status').value = f
    await carregarTarefas()
    const tid = params.get('t')
    focoRatId = params.get('rat') || null   // atalho do calendário de RATs
    if (tid && tarefas.some(x => x.id === tid)) await abrirTarefa(tid, params.get('aba'))
    else { mostrar('lista'); renderLista() }
    iniciarRealtimeLista()
  }

  // Realtime: quando o status de uma Tarefa muda no servidor (ex.: técnico pausou → "Em Pausa"),
  // a lista se atualiza sozinha. Só recarrega na LISTA (não atrapalha quem edita uma tarefa).
  // Fallback (sem realtime): foco da janela e a cada 2 min.
  let recListaT = null
  function iniciarRealtimeLista() {
    const recarregaLista = () => {
      if (cur || document.hidden) return
      clearTimeout(recListaT); recListaT = setTimeout(() => { carregarTarefas().then(renderLista) }, 500)
    }
    document.addEventListener('visibilitychange', recarregaLista)
    window.addEventListener('focus', recarregaLista)
    setInterval(recarregaLista, 120000)
    try {
      sb().channel('adm-tarefas')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tarefas' }, recarregaLista)
        .subscribe()
    } catch (e) { /* sem realtime → fica o foco/intervalo */ }
  }

  function bind() {
    document.getElementById('btn-voltar').onclick = () => { cur = null; history.replaceState(null, '', 'tarefa.html'); mostrar('lista'); carregarTarefas().then(renderLista) }
    ;['f-status', 'f-tec', 'f-tipo', 'f-de', 'f-ate'].forEach(id => { document.getElementById(id).onchange = renderLista })
    document.getElementById('f-limpar').onclick = () => {
      document.getElementById('busca-tarefa').value = ''
      ;['f-status', 'f-tec', 'f-tipo', 'f-de', 'f-ate'].forEach(id => { document.getElementById(id).value = '' })
      renderLista()
    }
    const bt = document.getElementById('busca-tarefa')
    if (bt) bt.oninput = debounce(() => renderLista(), 200)
    // Nova tarefa: abre direto na página de detalhe (sem modal), em modo "nova".
    document.getElementById('btn-nova-tarefa').onclick = abrirNovaTarefa
    attachAutocomplete(
      document.getElementById('cc-d-cli-busca'),
      document.getElementById('cc-d-cli'),
      document.getElementById('cc-d-cli-list'),
      ref.clientes,
      c => ({ id: c.id, label: c.nome || '(sem nome)' }),
      null,
    )
    document.getElementById('cc-add-material').onclick = adicionarMaterialCatalogo
    document.getElementById('cc-add-avulso').onclick = adicionarMaterialAvulso
    document.getElementById('cc-bulk-del').onclick = excluirSelecionados
    document.getElementById('cc-bulk-clear').onclick = () => { selMat.clear(); renderLinhas() }
    document.getElementById('cc-check-all').onclick = (e) => {
      const tb = document.getElementById('cc-tbody')
      tb.querySelectorAll('.cc-chk').forEach(cb => { cb.checked = e.target.checked; e.target.checked ? selMat.add(cb.dataset.tm) : selMat.delete(cb.dataset.tm) })
      renderBulk()
    }
    document.getElementById('cc-d-salvar').onclick = salvarDados
    document.getElementById('cc-d-excluir').onclick = excluirTarefa
    document.getElementById('cc-eq-btn').onclick = vincularEquip
    document.getElementById('cc-anx-btn').onclick = () => document.getElementById('cc-anx-input').click()
    document.getElementById('cc-anx-input').onchange = (e) => adicionarAnexos(e.target.files)
    document.getElementById('cc-obs-salvar').onclick = salvarConcilObs
    document.getElementById('cc-d-orientacao').oninput = (e) => autoGrow(e.target)
    document.getElementById('cc-d-obs').oninput = (e) => autoGrow(e.target)
    // Abas do detalhe
    document.querySelectorAll('#cc-tabs .tab').forEach(b => b.onclick = () => mostrarPane(b.dataset.pane))
    // RATs
    document.getElementById('cc-rat-pdf').onclick = pdfUnificado
    // Gerar PDF (vetorial, download direto) — botão único + dropdown Cliente/Interno.
    // A exportação antiga (impressão) fica no rodapé do menu como contingência.
    const pdfBtn = document.getElementById('cc-pdf-btn')
    const pdfPop = document.getElementById('cc-pdf-pop')
    pdfBtn.onclick = (e) => { e.stopPropagation(); if (!pdfBtn.disabled) pdfPop.hidden = !pdfPop.hidden }
    document.addEventListener('click', (e) => {
      if (!pdfPop.hidden && !pdfPop.contains(e.target)) pdfPop.hidden = true
      if (!e.target.closest('#cc-rat-list .pdfmenu')) fecharRatMenus()   // menu ⋮ dos cards de RAT
    })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pdfPop.hidden = true; fecharRatMenus() } })
    pdfPop.querySelectorAll('[data-pdf]').forEach(b => b.onclick = () => { pdfPop.hidden = true; gerarPdfVetorial(b.dataset.pdf) })
    document.getElementById('cc-d-pend-tarefa').onclick = abrirPendTarefa
    document.getElementById('cc-d-status-sel').addEventListener('change', (e) => {
      document.getElementById('cc-d-pend-tarefa').style.display = (e.target.value === 'concluida_pendencia') ? '' : 'none'
      pintarStatusSel()
    })
    // Faturamento
    document.getElementById('cc-fat-modalidade').onchange = renderModalidadeCalc
    document.getElementById('cc-fat-vh').oninput = renderModalidadeCalc
    document.getElementById('cc-fat-mod-salvar').onclick = salvarModalidade
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
      .select('id,numero,status,criado_em,data_agendada,orcamento_id,cliente_id,orientacao,observacoes,pedido_compra,tipo_servico_id,conciliacao_obs,pendencias,faturado,data_faturamento,numero_nota,modalidade,valor_hora,motivo_devolucao')
      .order('numero', { ascending: false })
    if (error) { toast('Erro ao carregar tarefas: ' + error.message, 'err'); tarefas = []; return }
    tarefas = ts || []
    tecPorTarefa = {}
    const { data: tts } = await sb().from('tarefa_tecnicos').select('tarefa_id,tecnico_id')
    for (const r of tts || []) (tecPorTarefa[r.tarefa_id] = tecPorTarefa[r.tarefa_id] || []).push(r.tecnico_id)
    const ids = [...new Set(tarefas.map(t => t.cliente_id).filter(Boolean))]
    cliNomes = {}; cliConf = {}
    if (ids.length) {
      const { data: cs } = await sb().from('clientes').select('id,nome,modalidade_padrao,valor_hora_padrao,dia_continuo').in('id', ids)
      for (const c of cs || []) { cliNomes[c.id] = c.nome; cliConf[c.id] = { modalidade: c.modalidade_padrao || '', valor_hora: c.valor_hora_padrao, dia_continuo: !!c.dia_continuo } }
    }
    const oids = [...new Set(tarefas.map(t => t.orcamento_id).filter(Boolean))]
    orcNo = {}
    if (oids.length) { const { data: os } = await sb().from('orcamentos').select('id,numero').in('id', oids); for (const o of os || []) orcNo[o.id] = o.numero }
    divPorTarefa = {}
    matsPorTarefa = {}
    const { data: vc } = await sb().from('vw_conciliacao_tarefa').select('tarefa_id,situacao,revisado,descricao,codigo_produto')
    for (const r of vc || []) {
      // divergência só conta pós-execução (antes, material em campo é normal); fora da proposta sempre
      const pe = POS_EXEC.includes(((tarefas || []).find(x => x.id === r.tarefa_id) || {}).status)
      if (r.situacao && r.situacao !== 'ok' && !r.revisado && (pe || r.situacao === 'sem_orcada' || r.situacao === 'sem_orcamento')) divPorTarefa[r.tarefa_id] = (divPorTarefa[r.tarefa_id] || 0) + 1
      const txt = [r.descricao, r.codigo_produto].filter(Boolean).join(' ')
      if (txt) matsPorTarefa[r.tarefa_id] = (matsPorTarefa[r.tarefa_id] || '') + ' ' + txt
    }
  }

  // Ordenação da lista por clique no cabeçalho (top bar da tabela)
  let ordCampo = 'numero', ordDir = 'desc'
  const ordVal = (t, campo) => {
    switch (campo) {
      case 'cliente': return normStr(cliNomes[t.cliente_id] || '')
      case 'status': return (STATUS[t.status] && STATUS[t.status].ordem != null) ? STATUS[t.status].ordem : 999
      case 'tecnico': return normStr((tecPorTarefa[t.id] || []).map(id => tecNomes[id] || '').join(' '))
      case 'agenda': return (t.data_agendada || '').slice(0, 10)
      case 'conciliacao': return divPorTarefa[t.id] || 0
      default: return Number(t.numero) || 0
    }
  }

  function renderLista() {
    const box = document.getElementById('lista-box')
    const q = normStr(document.getElementById('busca-tarefa').value || '')
    const fStatus = document.getElementById('f-status').value
    const fTec = document.getElementById('f-tec').value
    const fTipo = document.getElementById('f-tipo').value
    const fDe = document.getElementById('f-de').value
    const fAte = document.getElementById('f-ate').value
    const tipoNomeDe = (id) => { const x = ref.tipos.find(p => p.id === id); return x ? x.nome : '' }
    const buscaStr = (t) => normStr([
      osNo(t.numero), t.numero, cliNomes[t.cliente_id], t.pedido_compra,
      (orcNo[t.orcamento_id] != null ? 'orcamento ' + orcNo[t.orcamento_id] : ''),
      (tecPorTarefa[t.id] || []).map(id => tecNomes[id]).join(' '),
      statusLabel(t.status), tipoNomeDe(t.tipo_servico_id),
      t.orientacao, t.observacoes, t.conciliacao_obs, t.pendencias,
      matsPorTarefa[t.id] || '',
    ].filter(Boolean).join(' '))
    let rows = tarefas
    if (fStatus === 'divergencia') rows = rows.filter(t => divPorTarefa[t.id])
    else if (fStatus === 'a_faturar') rows = rows.filter(t => !t.faturado && (t.status === 'concluida' || t.status === 'concluida_pendencia'))
    else if (fStatus === 'pendente_class') rows = rows.filter(t => !t.modalidade && (t.status === 'concluida' || t.status === 'concluida_pendencia'))
    else if (fStatus) rows = rows.filter(t => t.status === fStatus)
    if (fTec) rows = rows.filter(t => (tecPorTarefa[t.id] || []).includes(fTec))
    if (fTipo) rows = rows.filter(t => t.tipo_servico_id === fTipo)
    if (fDe) rows = rows.filter(t => (t.data_agendada || '').slice(0, 10) >= fDe)
    if (fAte) rows = rows.filter(t => { const d = (t.data_agendada || '').slice(0, 10); return d && d <= fAte })
    if (q) rows = rows.filter(t => buscaStr(t).includes(q))
    // ordena pela coluna escolhida (vazios por último); desempate por Nº desc
    const dir = ordDir === 'asc' ? 1 : -1
    rows = rows.slice().sort((a, b) => {
      const va = ordVal(a, ordCampo), vb = ordVal(b, ordCampo)
      const ea = (va === '' || va == null), eb = (vb === '' || vb == null)
      if (ea !== eb) return ea ? 1 : -1
      if (va < vb) return -dir
      if (va > vb) return dir
      return (Number(b.numero) || 0) - (Number(a.numero) || 0)
    })
    document.getElementById('f-count').textContent = `${rows.length} de ${tarefas.length}`
    if (!rows.length) { box.innerHTML = '<div class="listpanel"><div class="cc-empty">Nenhuma tarefa encontrada.</div></div>'; return }
    const COLS = [['numero', 'Nº'], ['cliente', 'Cliente'], ['status', 'Status'], ['tecnico', 'Técnico'], ['agenda', 'Agenda'], ['conciliacao', 'Conciliação']]
    const seta = (k) => ordCampo === k ? (ordDir === 'asc' ? ' ▲' : ' ▼') : ''
    const thHtml = COLS.map(([k, t]) => `<th class="th-ord" data-ord="${k}">${t}${seta(k)}</th>`).join('') + '<th>Ações</th>'
    box.innerHTML = `<div class="listpanel" style="overflow-x:auto"><table class="cc-list"><thead><tr>
        ${thHtml}
      </tr></thead><tbody>${rows.map(t => {
        const d = divPorTarefa[t.id] || 0
        const concil = d ? `<span class="pill pill-warn">${d} a revisar</span>` : '<span class="pill pill-ok">OK</span>'
        const tids = tecPorTarefa[t.id] || []
        const tec = tids.length ? esc(tids.map(id => tecNomes[id] || '—').join(', ')) : `<button class="pill pill-warn" data-atrib="${esc(t.id)}" style="cursor:pointer;border:none">atribuir</button>`
        return `<tr class="row-click" data-id="${esc(t.id)}">
          <td class="cc-num">${osNo(t.numero)}</td>
          <td>
            <div class="cc-cli">${esc(cliNomes[t.cliente_id] || '—')}</div>
            ${t.orientacao ? `<div class="cc-ori" title="${esc(t.orientacao)}">${esc(t.orientacao)}</div>` : ''}
          </td>
          <td><span class="st-pill" style="${statusStyleAttr(t.status)}">${esc(statusLabel(t.status))}</span>${(t.faturado && t.status !== 'faturada') ? ' <span class="pill pill-fat">Faturada</span>' : ''}</td>
          <td>${tec}</td>
          <td>${t.data_agendada ? dmy(t.data_agendada) : '<span class="st">—</span>'}</td>
          <td>${concil}</td>
          <td><div class="acts" style="opacity:1">
            <a class="row-newtab" href="${urlTarefa(t.id)}" target="_blank" rel="noopener" title="Abrir em nova aba">${SVG_NEWTAB}</a>
            <button class="ab ab-v" data-edit="${esc(t.id)}">Editar</button>
            <button class="ab ab-d" data-del="${esc(t.id)}">Excluir</button>
          </div></td>
        </tr>`
      }).join('')}</tbody></table></div>`
    box.querySelectorAll('.row-click').forEach(tr => tr.onclick = (e) => { if (e.target.closest('.acts')) return; if (e.metaKey || e.ctrlKey) { window.open(urlTarefa(tr.dataset.id), '_blank', 'noopener'); return } abrirTarefa(tr.dataset.id) })
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = (e) => { e.stopPropagation(); abrirTarefa(b.dataset.edit) })
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); excluirTarefaLista(b.dataset.del) })
    box.querySelectorAll('[data-atrib]').forEach(b => b.onclick = (e) => { e.stopPropagation(); abrirTarefa(b.dataset.atrib, 'dados') })
    box.querySelectorAll('th[data-ord]').forEach(th => th.onclick = () => {
      const k = th.dataset.ord
      if (ordCampo === k) ordDir = (ordDir === 'asc' ? 'desc' : 'asc')
      else { ordCampo = k; ordDir = (k === 'cliente' || k === 'tecnico' || k === 'status') ? 'asc' : 'desc' }
      renderLista()
    })
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
  // Abre direto a página de detalhe em modo "nova": cliente editável, só a aba Dados.
  // A tarefa é criada no banco ao "Salvar dados".
  function abrirNovaTarefa() {
    cur = { id: null, numero: null, status: 'aguardando_execucao', cliente_nome: '', equip: [], anexos: [] }
    document.getElementById('cc-d-cliente').style.display = 'none'
    document.getElementById('cc-d-cli-wrap').style.display = 'block'
    document.getElementById('cc-d-cli').value = ''
    document.getElementById('cc-d-cli-busca').value = ''
    document.getElementById('cc-tabs').style.display = 'none'
    document.getElementById('cc-d-excluir').style.display = 'none'
    document.getElementById('cc-cliente').textContent = 'Nova tarefa'
    document.getElementById('cc-docno').textContent = ''
    setStatusBadge('aguardando_execucao')
    document.getElementById('cc-d-orc').textContent = 'Criada direto (sem orçamento)'
    document.getElementById('cc-d-status-sel').value = 'aguardando_execucao'
    pintarStatusSel()
    document.getElementById('cc-d-pend-note').textContent = ''
    document.getElementById('cc-d-tipo').value = ''
    setTecnicosChecked([])
    document.getElementById('cc-d-data').value = ''
    document.getElementById('cc-d-pc').value = ''
    document.getElementById('cc-d-orientacao').value = ''
    document.getElementById('cc-d-obs').value = ''
    document.getElementById('cc-obs').value = ''
    document.getElementById('cc-d-hint').textContent = 'Selecione o cliente e salve para criar a tarefa.'
    mostrarPane('dados')
    renderHeader({})
    renderSituacao()
    mostrar('detalhe')
    history.replaceState(null, '', 'tarefa.html')
    document.getElementById('cc-d-cli-busca').focus()
  }

  // ─────────────────────────── Detalhe ───────────────────────────
  async function abrirTarefa(id, aba) {
    const t = tarefas.find(x => x.id === id); if (!t) return
    cur = { id, numero: t.numero, status: t.status, cliente_nome: cliNomes[t.cliente_id] || '—', motivo_devolucao: t.motivo_devolucao || null, equip: [], anexos: [] }
    // garante modo normal (caso venha do modo "nova")
    document.getElementById('cc-d-cliente').style.display = ''
    document.getElementById('cc-d-cli-wrap').style.display = 'none'
    document.getElementById('cc-tabs').style.display = ''
    document.getElementById('cc-d-excluir').style.display = ''
    mostrarPane(aba)
    document.getElementById('cc-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-docno').textContent = cur.numero != null ? `Tarefa Nº ${osNo(cur.numero)}` : ''
    setStatusBadge(cur.status)
    // Card "Dados da Tarefa"
    document.getElementById('cc-d-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-d-orc').textContent = t.orcamento_id ? `Orçamento Nº ${orcNo[t.orcamento_id] ?? '—'}` : 'Criada direto (sem orçamento)'
    document.getElementById('cc-d-status-sel').innerHTML = statusOptionsHTML(cur.status)
    document.getElementById('cc-d-status-sel').value = cur.status || 'aguardando_execucao'
    pintarStatusSel()
    document.getElementById('cc-d-pend-note').textContent = (cur.status === 'concluida_pendencia' && t.pendencias) ? 'Pendência: ' + t.pendencias : ''
    document.getElementById('cc-d-pend-tarefa').style.display = (cur.status === 'concluida_pendencia') ? '' : 'none'
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
    renderModalidadeCalc()   // RATs já carregadas → horas faturáveis corretas
    renderHeader(t)
    renderSituacao()
    carregarTimeline()
    mostrar('detalhe')
    // recalcula a altura só depois do detalhe ficar visível (scrollHeight=0 se oculto)
    autoGrow(document.getElementById('cc-d-orientacao'))
    autoGrow(document.getElementById('cc-d-obs'))
  }

  // Passagem "vou voltar depois pra terminar" em aberto na RAT mais recente da tarefa?
  function passagemAberta(rats) {
    const comP = (rats || []).filter(r => r.respostas && r.respostas.volta_amanha)
    if (!comP.length) return false
    const chave = (r) => (r.respostas.data || r.data_tarefa || r.criado_em || '')
    comP.sort((a, b) => chave(b).localeCompare(chave(a)))
    const u = comP[0]
    return u.respostas.volta_amanha === 'Não' && u.respostas.passagem_motivo === 'volto_depois'
  }

  // Motivos da devolução — ESTRUTURADOS (código + label), em dois blocos orientados à escolha.
  // Vocabulário oficial (fonte única) mora no utils.js (window.DEVOLUCAO_MOTIVOS / MOTIVO_LABEL);
  // o app do técnico lê do mesmo lugar. Grava-se o CÓDIGO (motivo_devolucao_cats) + o detalhe; o
  // texto renderizado (motivo_devolucao) segue p/ display no app e fallback dos registros antigos.
  const MOTIVOS_TAREFA = window.DEVOLUCAO_MOTIVOS.tarefa
  const MOTIVOS_RAT = window.DEVOLUCAO_MOTIVOS.rat
  const MOTIVO_LABEL = window.MOTIVO_LABEL
  // Modal do motivo. Resolve com { cats:[códigos], detalhe, texto } — ou null se cancelar.
  function pedirMotivoDevolucao() {
    return new Promise((resolve) => {
      const back = document.createElement('div')
      back.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,55,.5);z-index:400;display:flex;align-items:center;justify-content:center;padding:20px'
      const opt = (m) => `<label style="display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border:1px solid #D7DCE6;border-radius:10px;cursor:pointer;font-size:13.5px;color:#2b3447;line-height:1.4">
        <input type="checkbox" class="dv-opt" value="${esc(m[0])}" style="margin-top:2px;flex:none;width:17px;height:17px;accent-color:#E5403A">
        <span>${esc(m[1])}</span></label>`
      const bloco = (titulo, arr) => `<div style="font-size:11.5px;font-weight:700;color:#7C8290;margin:0 0 6px">${titulo}</div>
        <div style="display:flex;flex-direction:column;gap:8px">${arr.map(opt).join('')}</div>`
      back.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:540px;width:100%;padding:20px;max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(20,30,55,.3)">
        <div style="font-size:16px;font-weight:700;color:#1B2A4A;margin-bottom:8px">Devolver ao técnico</div>
        <div style="font-size:12.5px;color:#2b3447;background:#F2F8FE;border:1px solid #cfe3f6;border-radius:9px;padding:9px 11px;line-height:1.45;margin-bottom:14px"><b>Editar ou devolver?</b> Se você <b>sabe</b> a informação certa, edite a RAT (fica auditado). Devolva só o que <b>só o técnico</b> sabe ou precisa refazer.</div>
        ${bloco('Problema no conjunto da Tarefa', MOTIVOS_TAREFA)}
        <div style="height:14px"></div>
        ${bloco('Problema no preenchimento da RAT', MOTIVOS_RAT)}
        <div style="margin-top:14px">
          <label style="font-size:12px;color:#5b6270;font-weight:600">Detalhe <span style="font-weight:400;color:#7C8290">(obrigatório se marcar "Outro")</span></label>
          <textarea id="dv-det" rows="3" style="width:100%;box-sizing:border-box;border:1px solid #D7DCE6;border-radius:10px;padding:10px;font:inherit;font-size:14px;resize:vertical;margin-top:4px" placeholder="Ex.: faltou a foto do rack; cabo lançado divergente do orçado."></textarea>
        </div>
        <div id="dv-err" style="display:none;color:#E5403A;font-size:12.5px;font-weight:600;margin-top:8px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
          <button id="dv-cancel" style="background:#EEF1F6;color:#5b6270;border:1px solid #D7DCE6;border-radius:10px;padding:9px 16px;cursor:pointer">Cancelar</button>
          <button id="dv-ok" style="background:#E5403A;color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:700;cursor:pointer">Devolver</button>
        </div></div>`
      document.body.appendChild(back)
      const err = back.querySelector('#dv-err')
      const showErr = (msg) => { err.textContent = msg; err.style.display = 'block' }
      const close = (val) => { back.remove(); resolve(val) }
      back.querySelector('#dv-cancel').onclick = () => close(null)
      back.querySelector('#dv-ok').onclick = () => {
        const cats = [...back.querySelectorAll('.dv-opt:checked')].map(c => c.value)
        const detalhe = back.querySelector('#dv-det').value.trim()
        if (!cats.length) return showErr('Marque ao menos um motivo.')
        if (cats.some(c => c === 'outro_tarefa' || c === 'outro_rat') && !detalhe) return showErr('Você marcou "Outro" — descreva o problema no detalhe abaixo.')
        const texto = cats.map(c => '• ' + (MOTIVO_LABEL[c] || c)).join('\n') + (detalhe ? '\n\n' + detalhe : '')
        close({ cats, detalhe: detalhe || null, texto })
      }
    })
  }

  async function salvarDados() {
    if (!cur) return
    const patch = {
      tipo_servico_id: document.getElementById('cc-d-tipo').value || null,
      status: document.getElementById('cc-d-status-sel').value,
      data_agendada: document.getElementById('cc-d-data').value || null,
      pedido_compra: document.getElementById('cc-d-pc').value.trim() || null,
      orientacao: document.getElementById('cc-d-orientacao').value.trim() || null,
      observacoes: document.getElementById('cc-d-obs').value.trim() || null,
    }
    // Devolver ao técnico exige MOTIVO (que aparece pra ele). Só ao ENTRAR em 'devolvida'.
    if (cur.id && patch.status === 'devolvida' && cur.status !== 'devolvida') {
      const dv = await pedirMotivoDevolucao()
      if (!dv) return   // cancelou → não salva
      patch.motivo_devolucao_cats = dv.cats
      patch.motivo_devolucao_detalhe = dv.detalhe
      patch.motivo_devolucao = dv.texto   // renderizado: display no app + fallback dos antigos
      patch.devolvida_em = new Date().toISOString()   // carimbo p/ o lembrete "sem retorno há +1 dia"
    }
    // Modo "nova": cria a tarefa agora (cliente é obrigatório) e reabre já carregada.
    if (!cur.id) {
      const cliId = document.getElementById('cc-d-cli').value
      if (!cliId) return toast('Selecione o cliente.', 'err')
      const ins = await sb().from('tarefas')
        .insert(Object.assign({ cliente_id: cliId, criado_por: user.id }, patch))
        .select('id,numero').single()
      if (ins.error) return toast('Erro ao criar tarefa: ' + ins.error.message, 'err')
      const tecIdsN = getTecnicosChecked()
      if (tecIdsN.length) {
        const insT = await sb().from('tarefa_tecnicos').insert(tecIdsN.map(tid => ({ tarefa_id: ins.data.id, tecnico_id: tid })))
        if (insT.error) toast('Tarefa criada, mas falhou ao atribuir técnicos: ' + insT.error.message, 'err')
      }
      toast(`Tarefa Nº ${osNo(ins.data.numero)} criada.`, 'ok')
      if (tecIdsN.length && window.notificarPush) notificarPush('tarefa_atribuida', { tecnicos: tecIdsN, numero: ins.data.numero, cliente: cliNomes[cliId] || '', tarefa_id: ins.data.id, texto: pushAtribTexto(cliNomes[cliId] || '', patch.data_agendada, patch.orientacao) })
      await carregarTarefas()
      return abrirTarefa(ins.data.id, 'dados')
    }
    // Concluir com "retorno em aberto": o escritório PODE forçar, mas com ciência (confirma).
    const concluindo = ['concluida', 'concluida_pendencia'].includes(patch.status) && !['concluida', 'concluida_pendencia'].includes(cur.status)
    if (concluindo && passagemAberta(cur.rats) &&
        !confirm('Esta tarefa tem uma RAT marcada como "retornar para finalizar" (retorno em aberto). Concluir mesmo assim?')) return
    const up = await sb().from('tarefas').update(patch).eq('id', cur.id)
    if (up.error) return toast('Erro ao salvar: ' + up.error.message, 'err')
    cur.status = patch.status
    if (patch.motivo_devolucao !== undefined) {
      cur.motivo_devolucao = patch.motivo_devolucao
      cur.motivo_devolucao_cats = patch.motivo_devolucao_cats
      cur.motivo_devolucao_detalhe = patch.motivo_devolucao_detalhe
    }
    setStatusBadge(cur.status)
    // sincroniza técnicos (N:N) por DIFERENÇA — evita ruído na auditoria (sem delete-all)
    const tecIds = getTecnicosChecked()
    const tecAntes = tecPorTarefa[cur.id] || []
    const tecNovos = tecIds.filter(id => !tecAntes.includes(id))     // recém-atribuídos (push "Nova tarefa atribuída")
    const tecRemov = tecAntes.filter(id => !tecIds.includes(id))     // removidos
    const tecJaEram = tecIds.filter(id => tecAntes.includes(id))     // continuam atribuídos (push "Tarefa reagendada" se a data mudar)
    // data_agendada ANTES deste save (cache ainda não recebeu o patch — Object.assign acontece adiante)
    const dataAntes = (tarefas.find(x => x.id === cur.id) || {}).data_agendada || null
    if (tecRemov.length) {
      const del = await sb().from('tarefa_tecnicos').delete().eq('tarefa_id', cur.id).in('tecnico_id', tecRemov)
      if (del.error) return toast('Erro ao salvar técnicos: ' + del.error.message, 'err')
    }
    if (tecNovos.length) {
      const insT = await sb().from('tarefa_tecnicos').insert(tecNovos.map(tid => ({ tarefa_id: cur.id, tecnico_id: tid })))
      if (insT.error) return toast('Erro ao salvar técnicos: ' + insT.error.message, 'err')
    }
    // Responsável é N:N (tarefa_tecnicos) e não há trigger que bumpe tarefas.atualizado_em; sem isso
    // a alteração feita no portal não deixa rastro de "última modificação". Marca a tarefa explícito.
    // (Propagação ao app de campo via realtime/tombstone em tarefa_tecnicos fica p/ depois.)
    if (tecRemov.length || tecNovos.length) {
      const bump = await sb().from('tarefas').update({ atualizado_em: new Date().toISOString() }).eq('id', cur.id)
      if (bump.error) console.warn('[tarefa] bump atualizado_em falhou:', bump.error.message)
    }
    tecPorTarefa[cur.id] = tecIds
    // atualiza cache local p/ a lista refletir sem novo fetch
    const t = tarefas.find(x => x.id === cur.id)
    if (t) Object.assign(t, patch)
    document.getElementById('cc-d-hint').textContent = tecIds.length ? '' : 'Atribua um ou mais técnicos e agende para a Tarefa aparecer no app do técnico.'
    if (tecNovos.length && window.notificarPush) notificarPush('tarefa_atribuida', { tecnicos: tecNovos, numero: cur.numero, cliente: cur.cliente_nome, tarefa_id: cur.id, texto: pushAtribTexto(cur.cliente_nome, patch.data_agendada, patch.orientacao) })
    // Reagendamento: técnico que JÁ era atribuído + a DATA mudou (e há nova data). Só a data dispara (anti-spam).
    const dataMudou = (dataAntes || null) !== (patch.data_agendada || null)
    if (tecJaEram.length && dataMudou && patch.data_agendada && window.notificarPush) notificarPush('tarefa_reagendada', { tecnicos: tecJaEram, numero: cur.numero, cliente: cur.cliente_nome, tarefa_id: cur.id, texto: pushReagendTexto(cur.cliente_nome, patch.data_agendada) })
    renderHeader(t || tarefas.find(x => x.id === cur.id) || {})
    renderSituacao()
    carregarTimeline()
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
    await renderAnexos()
    renderSituacao()
  }
  async function renderAnexos() {
    const box = document.getElementById('cc-anx-list')
    if (!cur.anexos || !cur.anexos.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhum anexo.</span>'; return }
    const ehImg = (n) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n || '')
    const urlByPath = {}
    const imgs = cur.anexos.filter(a => ehImg(a.nome))
    if (imgs.length) {
      try {
        const { data: signed } = await sb().storage.from('rat-anexos').createSignedUrls(imgs.map(a => a.url), 3600)
        ;(signed || []).forEach(s => { if (s && s.signedUrl) urlByPath[s.path] = s.signedUrl })
      } catch (e) { /* offline/erro: cai pro ícone */ }
    }
    box.innerHTML = cur.anexos.map(a => {
      const url = urlByPath[a.url]
      const isImg = url && ehImg(a.nome)
      const inner = isImg ? `<img src="${url}" alt="">` : `<span class="cc-anx-ic">${fileIcon(a.nome, 46)}</span>`
      // imagem → o card abre o lightbox (data-lb); não-imagem → baixa (data-anx)
      const card = isImg ? `data-lb="${url}" data-lb-cap="${esc(a.nome)}" style="cursor:zoom-in"` : ''
      const trig = isImg ? '' : `data-anx="${esc(a.id)}"`
      return `<div class="cc-anx-card" ${card}>
          <div class="cc-anx-thumbwrap" ${trig}>${inner}<button class="x" data-del="${esc(a.id)}" title="Remover">×</button></div>
          <a class="nome" ${trig}>${esc(a.nome)}</a>
          <span class="sz">${fmtSize(a.tamanho)}</span>
        </div>`
    }).join('')
    box.querySelectorAll('[data-anx]').forEach(el => el.onclick = () => baixarAnexo(el.dataset.anx))
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); removerAnexo(b.dataset.del) })
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
    selMat.clear()
    const { data, error } = await sb().from('vw_conciliacao_tarefa').select('*').eq('tarefa_id', cur.id)
    linhas = error ? [] : (data || [])
    linhas.sort((a, b) => (a.situacao === 'ok' ? 1 : 0) - (b.situacao === 'ok' ? 1 : 0) || (a.descricao || '').localeCompare(b.descricao || ''))
    if (error) toast('Erro ao carregar conciliação: ' + error.message, 'err')
    // Conflito de material colaborativo (2+ técnicos lançaram na mesma RAT) — não soma em silêncio.
    try {
      const { data: cf } = await sb().from('vw_rat_material_conflito').select('rat_id,em_conflito').eq('tarefa_id', cur.id).eq('em_conflito', true)
      if (cur) cur.matConflitoRats = (cf || []).length
    } catch (e) { if (cur) cur.matConflitoRats = 0 }
    renderLinhas()
  }

  // Ordenação da Conciliação por clique no cabeçalho (null = ordem padrão de carregarLinhas)
  let ccOrd = null, ccDir = 'asc'
  const ccVal = (l, campo) => {
    switch (campo) {
      case 'descricao': return normStr(l.descricao || '')
      case 'unidade': return normStr(l.unidade || '')
      case 'orcada': return Number(l.qtd_orcada) || 0
      case 'levada': return Number(l.qtd_levada) || 0
      case 'utilizada': return Number(l.qtd_utilizada) || 0
      case 'devolvida': return Number(l.qtd_devolvida) || 0
      case 'situacao': return normStr(SIT[l.situacao] ? SIT[l.situacao].t : (l.situacao || ''))
      case 'preco': return Number(l.preco_unitario) || 0
      case 'subtotal': return (Number(l.qtd_utilizada) || 0) * (Number(l.preco_unitario) || 0)
      default: return 0
    }
  }

  function renderLinhas() {
    const tb = document.getElementById('cc-tbody')
    const posExec = tarefaPosExec(cur && cur.id)
    // cabeçalho clicável (ordena) — religa a cada render e atualiza a seta da coluna ativa
    const tbl = tb.closest('table')
    if (tbl) tbl.querySelectorAll('th[data-ord]').forEach(th => {
      th.onclick = () => {
        const k = th.dataset.ord
        if (ccOrd === k) ccDir = (ccDir === 'asc' ? 'desc' : 'asc')
        else { ccOrd = k; ccDir = (k === 'descricao' || k === 'unidade' || k === 'situacao') ? 'asc' : 'desc' }
        renderLinhas()
      }
      const ar = th.querySelector('.ord-ar'); if (ar) ar.textContent = (ccOrd === th.dataset.ord) ? (ccDir === 'asc' ? ' ▲' : ' ▼') : ''
    })
    if (ccOrd) {
      const dir = ccDir === 'asc' ? 1 : -1
      linhas.sort((a, b) => { const va = ccVal(a, ccOrd), vb = ccVal(b, ccOrd); if (va < vb) return -dir; if (va > vb) return dir; return normStr(a.descricao || '').localeCompare(normStr(b.descricao || '')) })
    }
    if (!linhas.length) {
      tb.innerHTML = '<tr><td colspan="10" class="cc-empty">Sem produtos nesta tarefa. Adicione abaixo.</td></tr>'
    } else {
      tb.innerHTML = linhas.map((l, i) => {
        const sit = SIT[l.situacao] || { t: l.situacao, cls: '' }
        const fora = l.situacao === 'sem_orcada'
        const orcada = Number(l.qtd_orcada) || 0
        const lev = Number(l.qtd_levada) || 0
        const util = Number(l.qtd_utilizada) || 0          // oficial: teto da soma das RATs
        const utilReal = Number(l.qtd_utilizada_real) || 0 // soma crua (auditoria)
        const dev = Number(l.qtd_devolvida) || 0
        const devNeg = dev < 0                 // usado sem ter sido levado: não imprime negativo
        const devShown = Math.max(0, dev)
        const semOrcada = orcada <= 0          // avulso/fora → preço editável
        const preco = Number(l.preco_unitario) || 0
        // só dá pra excluir linha avulsa (tem tarefa_materiais, sem orçada e sem uso em RAT)
        const podeExcluir = !!l.tm_id && orcada === 0 && util === 0
        // caixa somente-leitura (igual à da Levada); 0 em cinza; sem "—"
        const box = (v, cls) => `<div class="cc-box${cls ? ' ' + cls : ''}">${v}</div>`
        const cOrcada = `<td>${box(qtd(orcada), orcada === 0 ? 'zero' : '')}</td>`
        const somaReal = (utilReal !== util) ? `<div class="cc-real">Σ ${qtd(utilReal)}${l.unidade ? ' ' + esc(l.unidade) : ''}</div>` : ''
        const cUtil = `<td>${box(qtd(util), devNeg ? 'alert' : (util === 0 ? 'zero' : ''))}${somaReal}</td>`
        const cDev = `<td>${box(qtd(devShown), devShown === 0 ? 'zero' : '')}</td>`
        const cPreco = semOrcada
          ? `<td><div class="cc-box money cc-preco-edit${preco === 0 ? ' zero' : ''}" data-i="${i}" tabindex="0" title="Clique para editar o valor">${money(preco)}</div></td>`
          : `<td>${box(money(preco), 'money')}</td>`
        const sub = util * preco
        const cSub = `<td>${box(money(sub), 'money' + (sub === 0 ? ' zero' : ''))}</td>`
        // pendência (badge + Revisar) só pós-execução; antes, material levado está "Em campo"
        const pend = l.situacao !== 'ok' && (posExec || l.situacao === 'sem_orcada' || l.situacao === 'sem_orcamento')
        const rev = !!l.revisado
        const badgeTxt = !pend
          ? (l.situacao === 'ok' ? sit.t : 'Em campo')
          : ((l.situacao === 'devolver' && dev > 0) ? `${rev ? 'Devolvido' : 'Devolver'} ${qtd(dev)}` : sit.t)
        const cSit = !pend
          ? `<td class="c"><span class="sit ${l.situacao === 'ok' ? sit.cls : ''}">${esc(badgeTxt)}</span></td>`
          : `<td class="c"><div class="cc-sit">
               <span class="sit ${sit.cls}">${esc(badgeTxt)}</span>
               <button class="cc-rev${rev ? ' on' : ''}" data-i="${i}">${rev ? '✓ Revisado' : 'Revisar'}</button>
             </div></td>`
        return `<tr class="${fora ? 'row-fora' : ''}${rev ? ' row-rev' : ''}">
          <td class="c chk">${podeExcluir ? `<input type="checkbox" class="cc-chk" data-tm="${esc(l.tm_id)}"${selMat.has(l.tm_id) ? ' checked' : ''}>` : ''}</td>
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
      tb.querySelectorAll('.cc-preco-edit').forEach(el => {
        el.onclick = () => editarPreco(el, Number(el.dataset.i))
        el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editarPreco(el, Number(el.dataset.i)) } }
      })
      tb.querySelectorAll('.cc-rev').forEach(btn => btn.onclick = () => salvarRevisado(Number(btn.dataset.i), !linhas[Number(btn.dataset.i)].revisado))
      tb.querySelectorAll('.cc-chk').forEach(cb => cb.onchange = () => { cb.checked ? selMat.add(cb.dataset.tm) : selMat.delete(cb.dataset.tm); renderBulk() })
    }
    renderStats()
    renderBulk()
    renderSituacao()
  }

  // Seleção múltipla de produtos para exclusão em massa.
  function renderBulk() {
    const bar = document.getElementById('cc-bulk'); if (!bar) return
    const tb = document.getElementById('cc-tbody')
    const chks = tb ? [...tb.querySelectorAll('.cc-chk')] : []
    // limpa da seleção tm_ids que não existem mais na tela
    const vivos = new Set(chks.map(c => c.dataset.tm))
    for (const tm of [...selMat]) if (!vivos.has(tm)) selMat.delete(tm)
    bar.style.display = selMat.size ? 'flex' : 'none'
    const n = document.getElementById('cc-bulk-n'); if (n) n.textContent = `${selMat.size} produto(s) selecionado(s)`
    const all = document.getElementById('cc-check-all')
    if (all) all.checked = chks.length > 0 && selMat.size === chks.length
  }
  async function excluirSelecionados() {
    if (!selMat.size) return
    if (!confirm(`Excluir ${selMat.size} produto(s) selecionado(s) desta tarefa?`)) return
    const ids = [...selMat]
    const { error } = await sb().from('tarefa_materiais').delete().in('id', ids)
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    selMat.clear()
    toast(`${ids.length} produto(s) removido(s).`, 'ok')
    await carregarLinhas()
  }

  // Resumo de custo (Orçado × Utilizado → faturamento) e devoluções (→ estoque).
  function renderStats() {
    const box = document.getElementById('cc-stats')
    if (!linhas.length) { box.innerHTML = ''; return }
    const posExec = tarefaPosExec(cur && cur.id)
    let custoOrcado = 0, custoUtil = 0, devValor = 0, devItens = 0, devFeitoItens = 0, div = 0, aRevisar = 0
    for (const l of linhas) {
      const p = Number(l.preco_unitario) || 0
      custoOrcado += (Number(l.qtd_orcada) || 0) * p
      custoUtil   += (Number(l.qtd_utilizada) || 0) * p
      const d = Number(l.qtd_devolvida) || 0
      // Linha revisada = devolução conferida/feita → sai do "A devolver" (vira "já devolvido").
      if (d > 0) { if (l.revisado) devFeitoItens++; else { devItens++; devValor += d * p } }
      if (l.situacao !== 'ok' && (posExec || l.situacao === 'sem_orcada' || l.situacao === 'sem_orcamento')) { div++; if (!l.revisado) aRevisar++ }
    }
    const delta = custoUtil - custoOrcado
    const dcls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    const dtxt = delta > 0 ? `↑ ${money(delta)} acima do orçado`
               : delta < 0 ? `↓ ${money(-delta)} abaixo do orçado` : 'igual ao orçado'
    box.innerHTML = `
      <div class="stat"><div class="k">Valor orçado</div><div class="v">${money(custoOrcado)}</div><div class="d flat">venda (do orçamento)</div></div>
      <div class="stat"><div class="k">Valor utilizado</div><div class="v">${money(custoUtil)}</div><div class="d ${dcls}">${dtxt}</div></div>
      <div class="stat"><div class="k">A devolver ao estoque</div><div class="v">${money(devValor)}</div><div class="d flat">${devItens} item(ns)${devFeitoItens ? ` · ${devFeitoItens} já devolvido` : ''}</div></div>
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
    if (err) return toast('Erro ao salvar Disponibilizada: ' + err.message, 'err')
    toast('Disponibilizada atualizada.', 'ok')
    await carregarLinhas()
  }

  // Valor unit. (avulso): exibe igual ao Subtotal (money box) e vira input só ao clicar.
  function editarPreco(boxEl, i) {
    const l = linhas[i]; if (!l) return
    const td = boxEl.closest('td'); if (!td) return
    const preco = Number(l.preco_unitario) || 0
    td.innerHTML = `<span class="cc-edit-money"><span class="rs">R$</span><input class="cc-preco-inp" type="text" inputmode="decimal" value="${preco > 0 ? preco.toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></span>`
    const inp = td.querySelector('.cc-preco-inp')
    inp.focus(); inp.select()
    let done = false
    const fim = (salvar) => {
      if (done) return; done = true
      const novo = Math.max(0, parseMoneyBR(inp.value))
      if (!salvar || inp.value.trim() === '' || novo === preco) return renderLinhas()   // sem mudança → restaura o box
      salvarPreco(i, inp.value)
    }
    inp.onblur = () => fim(true)
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur() } else if (e.key === 'Escape') { e.preventDefault(); fim(false) } }
  }

  // Parser de valor em R$ no padrão BR: aceita "3,50", "1.234,56", "17" ou "3.5".
  const parseMoneyBR = (s) => {
    let t = String(s == null ? '' : s).replace(/[^\d.,-]/g, '')
    if (t.indexOf(',') > -1) t = t.replace(/\./g, '').replace(',', '.')   // . = milhar, , = decimal
    return Number(t) || 0
  }

  // Valor unitário de venda do produto (tarefa_materiais.preco_unitario).
  async function salvarPreco(i, val) {
    const l = linhas[i]; if (!l) return
    const v = Math.max(0, parseMoneyBR(val))
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
      if (ins.error.code === '23505') return toast('Esse produto já está na lista — edite a Disponibilizada na linha.', 'err')
      return toast('Erro: ' + ins.error.message, 'err')
    }
    limparAdd()
    toast('Produto adicionado — informe a Disponibilizada na linha.', 'ok')
    await carregarLinhas()
  }

  function limparAdd() {
    document.getElementById('cc-add-busca').value = ''
    document.getElementById('cc-add-prod').value = ''
  }

  // ───────────────────── Deslocamentos vinculados (só leitura aqui; editar abre a página de Deslocamentos) ─────────────────────
  let deslocMaps = null
  async function deslocLabels() {
    if (deslocMaps) return deslocMaps
    const [us, vc, cl, og] = await Promise.all([
      sb().rpc('sr_usuarios'),
      sb().from('veiculos').select('id,modelo,placa'),
      sb().from('clientes').select('id,nome'),
      sb().from('org_config').select('base_cidade').eq('id', 1).maybeSingle(),
    ])
    const tec = {}, veic = {}, cli = {}
    for (const u of (us.data || [])) tec[u.id] = u.nome
    for (const v of (vc.data || [])) veic[v.id] = `${v.modelo || ''} (${v.placa || ''})`
    for (const c of (cl.data || [])) cli[c.id] = c.nome
    deslocMaps = { tec, veic, cli, base: (og.data && og.data.base_cidade) || '' }
    return deslocMaps
  }
  async function carregarDeslocamentos() {
    const box = document.getElementById('cc-desloc-list'); if (!box || !cur || !cur.id) return
    box.innerHTML = '<span class="cc-empty-sm">Carregando…</span>'
    const m = await deslocLabels()
    const { data: links, error: le } = await sb().from('deslocamento_tarefas').select('deslocamento_id').eq('tarefa_id', cur.id)
    if (le) { box.innerHTML = '<span class="cc-empty-sm" style="color:var(--re)">Erro ao carregar — recarregue a página.</span>'; return }
    const ids = [...new Set((links || []).map(x => x.deslocamento_id).filter(Boolean))]
    if (!ids.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhum deslocamento (pernoite) vinculado a esta tarefa.</span>'; return }
    const { data, error } = await sb().from('deslocamentos')
      .select('id,revisado,deslocamento_trechos(id,ordem,origem,destino,destino_cliente_id,data,saida_em,chegada_em,veiculo_id,nota_transporte,espelho_legado,trecho_tecnicos(tecnico_id))')
      .in('id', ids)
    if (error) { box.innerHTML = '<span class="cc-empty-sm" style="color:var(--re)">Erro ao carregar — recarregue a página.</span>'; return }
    renderDeslocamentos(data || [], m, box)
  }
  function renderDeslocamentos(rows, m, box) {
    const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, c => c.toUpperCase())
    const fmtLugar = (v) => { const x = String(v || '').match(/^(.+)\/([A-Za-z]{2})$/); return x ? `${tcase(x[1].trim())}/${x[2].toUpperCase()}` : (v || '') }
    const baseC = (m.base || '').trim().toLowerCase()
    const ehBase = (t) => !!baseC && String(t || '').toLowerCase().includes(baseC)   // base (org_config) = Traders
    const oLbl = (v) => ehBase(v) ? 'Traders' : (fmtLugar(v) || '—')
    const dLbl = (t) => { if (ehBase(t.destino)) return 'Traders'; const cli = t.destino_cliente_id ? (m.cli[t.destino_cliente_id] || '') : ''; const txt = fmtLugar(t.destino) || ''; return cli ? `${cli}${txt ? ' · ' + txt : ''}` : (txt || '—') }
    const diaT = (t) => { const d = t && t.data; return (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) ? d.slice(0, 10) : null }
    const dd = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : ''
    box.innerHTML = rows.map(d => {
      const ts = (d.deslocamento_trechos || []).filter(t => !t.espelho_legado).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0))
      const prim = ts[0] || {}, ult = ts[ts.length - 1] || {}
      const datas = [...new Set(ts.map(diaT).filter(Boolean))].sort()
      const periodo = datas.length ? `${dd(datas[0])}${datas[datas.length - 1] !== datas[0] ? ' → ' + dd(datas[datas.length - 1]) : ''}` : ''
      const veics = []   // veículo herda do trecho anterior quando vazio (mesma regra do calendário)
      let lastV = ''
      for (const t of ts) { if (t.veiculo_id) lastV = m.veic[t.veiculo_id]; if (lastV && !veics.includes(lastV)) veics.push(lastV) }
      const tecs = [...new Set(ts.flatMap(t => (t.trecho_tecnicos || []).map(x => x.tecnico_id)))].map(id => m.tec[id]).filter(Boolean)
      const detalhe = ts.map(t => `<div class="dd-leg">${t.ordem}. ${esc(oLbl(t.origem))} → ${esc(dLbl(t))}${diaT(t) ? ' · ' + dd(diaT(t)) : ''}</div>`).join('')
      return `<button class="cc-desloc-item" data-id="${esc(d.id)}">
        <div class="dd-top"><span class="dd-rota">${esc(oLbl(prim.origem))} → ${esc(dLbl(ult))}</span><span class="dd-rev ${d.revisado ? 'on' : ''}">${d.revisado ? '✓ Revisado' : 'A revisar'}</span></div>
        <div class="dd-meta">${periodo ? esc(periodo) + ' · ' : ''}${veics.length ? esc(veics.join(', ')) : '<span class="dim">sem veículo</span>'}${tecs.length ? ' · ' + esc(tecs.join(', ')) : ''}</div>
        ${detalhe}
      </button>`
    }).join('')
    box.querySelectorAll('.cc-desloc-item').forEach(b => b.onclick = () => { location.href = `deslocamentos.html?editar=${encodeURIComponent(b.dataset.id)}` })
  }

  // ───────────────────── RATs da tarefa ─────────────────────
  const abrirModal = (id) => document.getElementById(id).classList.add('open')
  const fecharModal = (id) => document.getElementById(id).classList.remove('open')

  async function carregarRats() {
    const { data, error } = await sb().from('rats').select(RatView.RAT_SELECT)
      .eq('tarefa_id', cur.id).order('data_tarefa', { ascending: true, nullsFirst: true })
    cur.ratsErro = !!error            // erro de carga ≠ tarefa sem RAT: não esvaziar a lista em silêncio
    cur.rats = error ? [] : (data || [])
    renderRats()
    renderSituacao()
  }
  // Mostra as RATs já abertas (expandidas) dentro da aba.
  async function renderRats() {
    const box = document.getElementById('cc-rat-list')
    if (cur.ratsErro) {   // falha na busca ≠ "sem RAT" — nunca fingir lista vazia
      document.getElementById('cc-rat-pdf').disabled = true
      box.innerHTML = '<span class="cc-empty-sm" style="color:var(--red)">Erro ao carregar as RATs — recarregue a página.</span>'
      return
    }
    const rats = cur.rats || []
    document.getElementById('cc-rat-pdf').disabled = !rats.length
    if (!rats.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhuma RAT registrada nesta tarefa ainda.</span>'; return }
    box.innerHTML = '<span class="cc-empty-sm">Carregando RATs…</span>'
    const dets = []
    for (const r of rats) dets.push(await RatView.loadDetalhe(r))
    ratDets = dets
    ratTabEditId = null
    box.innerHTML = dets.map(d => `<div class="rat-open" data-rat-id="${esc(d.r.id)}">${ratCardInner(d)}</div>`).join('')
    dets.forEach(d => { const card = box.querySelector(`[data-rat-id="${CSS.escape(d.r.id)}"]`); if (card) bindRatCard(card, d) })
    if (focoRatId) {   // veio de ?rat= (calendário): rola até a RAT e destaca por ~2,6s
      const alvo = box.querySelector(`[data-rat-id="${CSS.escape(focoRatId)}"]`)
      if (alvo) {
        alvo.scrollIntoView({ behavior: 'smooth', block: 'center' })
        alvo.style.transition = 'box-shadow .3s'; alvo.style.boxShadow = '0 0 0 3px var(--ac)'
        setTimeout(() => { alvo.style.boxShadow = '' }, 2600)
      }
      focoRatId = null
    }
  }

  // ── Ações diretas no card da RAT (aba RATs): Editar · PDF · Pendência · menu ⋮ ──
  // O rat.html continua existindo (acesso direto/compatibilidade), mas deixa de ser
  // o fluxo obrigatório: as ações principais rodam aqui, com o MESMO editor auditado.
  let ratDets = []           // detalhes carregados da aba (base dos handlers)
  let ratTabEditId = null    // RAT em edição direta no card (uma por vez)
  let ratTabEdInst = null
  const ratTabEd = () => ratTabEdInst || (ratTabEdInst = RatEditor.criar({
    sb,
    getUsuarios: () => ref.tecnicos,
    container: () => document.querySelector(`#cc-rat-list .rat-open[data-rat-id="${CSS.escape(ratTabEditId || '')}"] .rat-open-b`),
    onSaved: async () => { ratTabEditId = null; await Promise.all([carregarRats(), carregarLinhas()]) },   // "Utilizada" depende das RATs
  }))
  // Pendência de retorno (passagem): mesmo critério do card âmbar do detalhe.
  const temPendenciaRetorno = (r) => { const resp = r.respostas || {}; return resp.volta_amanha === 'Não' && resp.passagem_motivo === 'volto_depois' }
  // Ícones SVG de linha (nunca emoji) das ações do card.
  const RAT_IC = {
    check: '<svg viewBox="0 0 24 24"><path d="M21 11.5a9 9 0 1 1-5.3-8.2"/><path d="m9 11 3 3L22 4"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    pdf: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>',
    pend: '<svg viewBox="0 0 24 24"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/><path d="M12 11v6M9 14h6"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>',
  }
  function ratAcoesHTML(r) {
    if (ratTabEditId === r.id) return `
      <button class="btn btn-sm" data-rat-cancelar>Cancelar</button>
      <button class="btn btn-sm btn-g" data-rat-salvar>${RAT_IC.check}Salvar</button>`
    return `
      ${ratNaoEncerrada(r)
        ? `<span class="ri-sit" style="color:#B7791F;font-weight:700" title="O técnico iniciou o atendimento e não encerrou">⚠ Não encerrada · ${esc(diasTxt(diasAberta(r)))}</span>`
        : `<span class="ri-sit">${esc(ratSit(r.status))}</span>`}
      ${r.status === 'em_andamento' ? `<button class="btn btn-sm btn-g" data-encerrar>${RAT_IC.check}Encerrar</button>` : ''}
      ${souAdmin ? `<button class="btn btn-sm" data-rat-editar>${RAT_IC.edit}Editar</button>` : ''}
      <button class="btn btn-sm" data-rat-pdf>${RAT_IC.pdf}PDF</button>
      ${temPendenciaRetorno(r) ? `<button class="btn btn-sm" data-rat-pend>${RAT_IC.pend}Nova tarefa da pendência</button>` : ''}
      <div class="pdfmenu">
        <button class="btn btn-sm" data-rat-menu title="Mais ações">${RAT_IC.dots}</button>
        <div class="pm-pop pm-compact" hidden>
          <a class="pm-item" href="rat.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener"><b>Ver em página completa ↗</b></a>
          ${souAdmin && r.status !== 'improdutiva' ? `<button class="pm-item" data-rat-improd><b>Reclassificar como visita improdutiva</b></button>` : ''}
          ${souAdmin ? `<button class="pm-item" data-rat-del><b style="color:var(--re)">Excluir RAT</b></button>` : ''}
        </div>
      </div>`
  }
  function ratCardInner(d) {
    const r = d.r, editando = ratTabEditId === r.id
    return `
      <div class="rat-open-h">
        <div><b>RAT ${cur && cur.numero != null ? osNo(cur.numero) + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : '') : ''} · ${esc(fmtDataRat(r))}</b> · ${esc(r.tecnico_nome || '—')} · ${RatView.fmtMin(RatView.tempoRat(r))}</div>
        <div class="roh-a">${ratAcoesHTML(r)}</div>
      </div>
      <div class="rat-open-b">${editando ? ratTabEd().tecnicosHTML() : ''}${RatView.buildReportBody(d, editando, { noHeader: true, adminEdit: editando })}</div>`
  }
  function renderRatCard(d) {
    const card = document.querySelector(`#cc-rat-list .rat-open[data-rat-id="${CSS.escape(d.r.id)}"]`)
    if (!card) return
    card.innerHTML = ratCardInner(d)
    bindRatCard(card, d)
  }
  function fecharRatMenus() { document.querySelectorAll('#cc-rat-list .pm-pop').forEach(p => { p.hidden = true }) }
  function bindRatCard(card, d) {
    const r = d.r
    const q = (s) => card.querySelector(s)
    const bEn = q('[data-encerrar]'); if (bEn) bEn.onclick = () => encerrarRat(r.id)
    const bEd = q('[data-rat-editar]'); if (bEd) bEd.onclick = async () => {
      // uma edição por vez: se outro card estava em edição, volta pra leitura antes
      const prev = (ratTabEditId && ratTabEditId !== r.id) ? ratDets.find(x => x.r.id === ratTabEditId) : null
      ratTabEditId = r.id
      if (prev) renderRatCard(prev)
      await ratTabEd().iniciar(d)
      renderRatCard(d)
      ratTabEd().bind()
    }
    const bCa = q('[data-rat-cancelar]'); if (bCa) bCa.onclick = () => { ratTabEditId = null; renderRatCard(d) }
    const bSa = q('[data-rat-salvar]'); if (bSa) bSa.onclick = () => ratTabEd().salvar()
    const bPdf = q('[data-rat-pdf]'); if (bPdf) bPdf.onclick = () => {
      const seq = r.rat_seq != null ? String(r.rat_seq).padStart(2, '0') : null
      gerarRatsPdf([d], `RAT Nº ${osNo(cur.numero)}${seq ? '/' + seq : ''}`, `RAT_${osNo(cur.numero)}${seq ? '_' + seq : ''}.pdf`, bPdf)
    }
    const bPe = q('[data-rat-pend]'); if (bPe) bPe.onclick = () => abrirPend(r)
    const bMe = q('[data-rat-menu]'); if (bMe) {
      const pop = bMe.parentElement.querySelector('.pm-pop')
      bMe.onclick = (e) => { e.stopPropagation(); const abrir = pop.hidden; fecharRatMenus(); pop.hidden = !abrir }
    }
    const bDel = q('[data-rat-del]'); if (bDel) bDel.onclick = () => { fecharRatMenus(); excluirRatTab(r.id) }
    const bIm = q('[data-rat-improd]'); if (bIm) bIm.onclick = () => {
      fecharRatMenus()
      RatEditor.reclassificarImprodutiva({ sb, rat: r, onDone: async () => { await Promise.all([carregarRats(), carregarLinhas()]) } })
    }
  }
  async function excluirRatTab(id) {
    if (!confirm('Excluir esta RAT? Remove os produtos e fotos dela. Esta ação não pode ser desfeita.')) return
    const { error } = await sb().rpc('admin_excluir_rat', { p_rat: id })
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    toast('RAT excluída.', 'ok')
    await Promise.all([carregarRats(), carregarLinhas()])   // "Utilizada" depende das RATs
  }

  // Encerra (conclui) uma RAT presa "em andamento" — destrava a tarefa quando o técnico
  // esqueceu de fechar o atendimento. RLS: tarefas_admin_all permite o update.
  async function encerrarRat(ratId) {
    const r = (cur.rats || []).find(x => x.id === ratId); if (!r) return
    if (!confirm('Encerrar esta RAT em andamento e marcá-la como Atendimento Realizado (fecha o dia)?\n\nUse "Editar" para acertar horários/tempo antes, se precisar. Encerrar a RAT não conclui o serviço — isso é feito na Tarefa.')) return
    const upd = { status: 'registrado' }
    const tm = RatView.tempoRat(r)
    if (tm != null) upd.tempo_trabalhado = tm
    const { error } = await sb().from('rats').update(upd).eq('id', ratId)
    if (error) return toast('Erro ao encerrar: ' + error.message, 'err')
    r.status = 'registrado'; if (tm != null) r.tempo_trabalhado = tm
    toast('Atendimento realizado (dia encerrado).', 'ok')
    await carregarRats()   // recarrega RATs + atualiza a faixa Situação/abas
  }

  let focoRatId = null   // ?rat= (atalho do calendário): rola/destaca a RAT certa na aba RATs
  // Modelo do PDF vetorial SÓ de RATs (sem capa da Tarefa): RAT avulsa e PDF unificado.
  // Mesmo perfil do documento antigo dessas telas: com valores e todos os itens (uso interno).
  function modeloRatsPdf(dets, headerRight, arquivo) {
    return {
      numeroFmt: osNo(cur.numero), headerRight, arquivo, selo: null,
      flags: { cliente: false, valores: true, conciliacao: false, zerados: true },
      motivoImprodutiva: RatView.motivoImprodutivaLabel,
      capa: null, dets,
    }
  }
  // Gera com estado de "gerando…" no botão (id ou elemento) + toast padrão de erro.
  async function gerarRatsPdf(dets, headerRight, arquivo, btnId) {
    const btn = typeof btnId === 'string' ? document.getElementById(btnId) : (btnId || null)
    const antes = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF…' }
    try { await PdfTarefa.gerar(modeloRatsPdf(dets, headerRight, arquivo)) }
    catch (e) { console.error('[PDF RATs]', e); toast('Não foi possível gerar o PDF. Tente novamente.', 'err') }
    finally { if (btn) { btn.disabled = false; btn.textContent = antes } }
  }
  async function pdfUnificado() {
    const rats = cur.rats || []
    if (!rats.length) return toast('Nenhuma RAT para gerar PDF.', 'err')
    const btn = document.getElementById('cc-rat-pdf')
    const antes = btn.textContent
    btn.disabled = true; btn.textContent = 'Gerando PDF…'
    try {
      const dets = []
      for (const r of rats) dets.push(await RatView.loadDetalhe(r))
      await PdfTarefa.gerar(modeloRatsPdf(dets, `Tarefa Nº ${osNo(cur.numero)} · RATs`, `Tarefa_${osNo(cur.numero)}_RATs.pdf`))
    } catch (e) {
      console.error('[PDF unificado]', e); toast('Não foi possível gerar o PDF. Tente novamente.', 'err')
    } finally { btn.disabled = false; btn.textContent = antes }
  }

  // ── PDF VETORIAL (pdfmake local) — botão "Gerar PDF" ─────────────────────
  // Texto real, tabelas vetoriais, fonte embutida, download direto (sem aba nova,
  // sem diálogo de impressão). Perfis Cliente/Interno + overrides finos pela URL
  // (?valores=1/0, ?conciliacao=1/0, ?zerados=1/0); Cliente com valores ganha selo.
  async function gerarPdfVetorial(perfil) {
    if (!cur || !cur.id) return
    const btn = document.getElementById('cc-pdf-btn')
    const txt = document.getElementById('cc-pdf-btn-txt')
    btn.disabled = true; txt.textContent = 'Gerando PDF…'
    try {
      const m = await montarModeloPdf(perfil)
      await PdfTarefa.gerar(m)
    } catch (e) {
      console.error('[PDF vetorial]', e)
      toast('Não foi possível gerar o PDF. Tente novamente.', 'err')
    } finally {
      btn.disabled = false; txt.textContent = 'Gerar PDF'
    }
  }

  // Monta o modelo de dados do PDF vetorial (capa resolvida + dets das RATs),
  // com as regras Cliente/Interno e os overrides de URL (?valores/?conciliacao/?zerados).
  async function montarModeloPdf(perfil) {
    const cliente = perfil !== 'interno'
    const p = new URLSearchParams(location.search)
    const flag = (name, base) => { const v = p.get(name); return v === '1' ? true : v === '0' ? false : base }
    const flags = {
      cliente,
      valores: flag('valores', !cliente),
      conciliacao: flag('conciliacao', !cliente),
      // A tabela por RAT lista SÓ o utilizado (qtd>0) nos DOIS perfis — item zerado mora na
      // conciliação geral e não se repete por RAT. ?zerados=1 força mostrar tudo (debug).
      zerados: flag('zerados', false),
    }
    const t = tarefas.find(x => x.id === cur.id) || {}
    const tipoNome = (ref.tipos.find(x => x.id === t.tipo_servico_id) || {}).nome || '—'
    const MOD_LBL = { por_hora: 'Por hora', projeto_fechado: 'Projeto fechado / orçamento', contrato: 'Contrato (locação/manutenção)', nao_faturavel: 'Não-faturável' }
    const responsaveis = [...respSel].map(id => tecNomes[id] || (ref.tecnicos.find(x => x.id === id) || {}).nome).filter(Boolean).join(', ')
    const rats = cur.rats || []
    const totalMin = rats.reduce((s, r) => s + (Number(RatView.tempoRat(r)) || 0), 0)
    const aDevolver = (linhas || []).reduce((s, l) => s + Math.max(0, Number(l.qtd_devolvida) || 0), 0)
    const foraProposta = (linhas || []).filter(l => !(Number(l.qtd_orcada) || 0) && ((Number(l.qtd_utilizada) || 0) > 0 || (Number(l.qtd_levada) || 0) > 0)).length
    const fatTxt = t.faturado
      ? `Faturada${t.numero_nota ? ' · Nota ' + t.numero_nota : ''}${t.data_faturamento ? ' · ' + dmy(t.data_faturamento) : ''}`
      : 'Não faturada'

    // Dados da Tarefa (pares [label, valor]; {0,1,full} ocupa a linha inteira)
    const campos = [
      ['Tipo de tarefa', tipoNome],
      ['Data agendada', dmy(t.data_agendada)],
      ['Origem', t.orcamento_id ? 'Orçamento aprovado' : 'Criada direto (sem orçamento)'],
    ]
    if (t.pedido_compra) campos.push(['Pedido de Compra (PC)', t.pedido_compra])
    if (!cliente && t.modalidade) campos.push(['Modalidade de faturamento', MOD_LBL[t.modalidade] || t.modalidade])
    if (!cliente) campos.push(['Faturamento', fatTxt])
    if (responsaveis) campos.push({ 0: 'Responsáveis', 1: responsaveis, full: true })
    if (t.orientacao) campos.push({ 0: 'Orientação ao técnico', 1: t.orientacao, full: true })
    if (!cliente && t.observacoes) campos.push({ 0: 'Observações internas', 1: t.observacoes, full: true })
    if (!cliente && t.pendencias) campos.push({ 0: 'Pendências', 1: t.pendencias, full: true })
    if (!cliente && t.conciliacao_obs) campos.push({ 0: 'Observações da conciliação', 1: t.conciliacao_obs, full: true })

    // Badge de status do PDF: faturamento é informação interna e o rótulo do status
    // ("Faturada/Finalizada") não confere com t.faturado quando ainda não faturou.
    //  · Cliente: tarefa encerrada → sempre "Finalizada" (nunca expõe faturamento).
    //  · Interno: "Faturada/Finalizada" SÓ com t.faturado=true; encerrada sem faturar → "Finalizada".
    //  · Demais status (em execução, devolvida…) seguem o rótulo/cor normais nos dois perfis.
    const encerrada = t.faturado === true || cur.status === 'faturada' || cur.status === 'concluida'
    const pdfStatusLabel = encerrada
      ? ((!cliente && t.faturado) ? 'Faturada/Finalizada' : 'Finalizada')
      : statusLabel(cur.status)
    const pdfStatusCor = encerrada ? '#179A47' : statusCor(cur.status)

    const resumo = [['RATs registradas', String(rats.length)], ['Horas registradas', RatView.fmtMin(totalMin)]]
    if (!cliente) {
      resumo.push(['A devolver ao estoque', aDevolver ? aDevolver.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '—'])
      resumo.push(['Fora da proposta', String(foraProposta)])
    }

    const ratsResumo = rats.map(r => ({
      ratNo: osNo(cur.numero) + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : ''),
      data: dmy(r.data_tarefa), tecnico: r.tecnico_nome || '—',
      situacao: ratSit(r.status), ok: r.status === 'registrado' || r.status === 'concluida',
      tempo: RatView.fmtMin(RatView.tempoRat(r)),
    }))

    const q = (n) => { const v = Number(n) || 0; return v ? v.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '—' }
    const conciliacao = (flags.conciliacao ? (linhas || []) : []).map(l => ({
      descricao: l.descricao || l.codigo_produto || '—',
      orcada: q(l.qtd_orcada), levada: q(l.qtd_levada), utilizada: q(l.qtd_utilizada),
      devolvida: q(Math.max(0, Number(l.qtd_devolvida) || 0)),
    }))

    const equipIds = (cur.equip || []).map(x => x.equipamento_id || x)
    const equipamentos = equipIds.map(id => {
      const e = (ref.equip || []).find(x => x.id === id)
      return e ? { tipo: e.tipo || '—', modelo: e.modelo || '—', part: e.part_number || '—', serial: e.serial || '—' } : null
    }).filter(Boolean)

    // Anexos: imagens viram URLs assinadas (o PdfTarefa reduz/comprime); demais ficam como nome
    const anexosUrls = [], anexosNomes = []
    const anx = cur.anexos || []
    const ehImg = (n) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n || '')
    const imgs = anx.filter(a => ehImg(a.nome))
    const urlByPath = {}
    if (imgs.length) {
      try {
        const { data: signed } = await sb().storage.from('rat-anexos').createSignedUrls(imgs.map(a => a.url), 3600)
        ;(signed || []).forEach(s => { if (s && s.signedUrl) urlByPath[s.path] = s.signedUrl })
      } catch (e) { /* offline/erro: anexo cai pro nome */ }
    }
    for (const a of anx) {
      if (ehImg(a.nome) && urlByPath[a.url]) anexosUrls.push({ url: urlByPath[a.url], nome: a.nome })
      else anexosNomes.push(a.nome)
    }

    const dets = []
    for (const r of rats) dets.push(await RatView.loadDetalhe(r))

    return {
      numeroFmt: osNo(cur.numero),
      arquivo: `Tarefa_${osNo(cur.numero)}_${cliente ? 'Cliente' : 'Interno'}.pdf`,
      selo: (cliente && flags.valores) ? 'versão com valores' : null,
      flags,
      motivoImprodutiva: RatView.motivoImprodutivaLabel,
      orientacaoGeral: t.orientacao || null,   // RAT com orientação idêntica vira "Conforme orientação geral…"
      capa: {
        clienteNome: cur.cliente_nome || '—',
        statusLabel: pdfStatusLabel, statusCor: pdfStatusCor,
        dataAgendada: t.data_agendada ? dmy(t.data_agendada) : null,
        campos, resumo, ratsResumo, conciliacao, equipamentos, anexosUrls, anexosNomes,
      },
      dets,
    }
  }

  // Nova tarefa a partir da pendência da TAREFA (botão na aba Dados quando concluída c/ pendência).
  function abrirPendTarefa() {
    const t = tarefas.find(x => x.id === (cur && cur.id)); if (!t) return
    pendRat = { cliente_id: t.cliente_id, tarefa: { cliente_id: t.cliente_id } }
    // Pendência vem da RAT do técnico: a mais recente concluída c/ pendência (ou que tenha texto de pendência).
    const candidatas = (cur.rats || []).filter(r => (r.pendencias && r.pendencias.trim()) || r.status === 'concluida_pendencia')
      .sort((a, b) => (b.data_tarefa || '').localeCompare(a.data_tarefa || ''))
    const rp = candidatas[0]
    const pendRT = rp ? ((rp.pendencias && rp.pendencias.trim()) || (rp.respostas && rp.respostas.observacoes && String(rp.respostas.observacoes).trim()) || '') : ''
    document.getElementById('pend-cli').textContent = cliNomes[t.cliente_id] || cur.cliente_nome || '—'
    document.getElementById('pend-tipo').innerHTML = ref.tipos.map(x =>
      `<option value="${esc(x.id)}"${x.id === t.tipo_servico_id ? ' selected' : ''}>${esc(x.nome)}</option>`).join('')
    document.getElementById('pend-orient').value = pendRT || (t.pendencias && t.pendencias.trim()) || ''
    document.getElementById('pend-origem').textContent = cur.numero != null ? `Origem: Tarefa Nº ${osNo(cur.numero)} (pendência da RAT)` : ''
    abrirModal('modal-pend')
  }
  // Nova tarefa a partir da pendência de uma RAT.
  function abrirPend(r) {
    if (!r) return
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
    // A pendência virou uma tarefa própria → a original deixa de ser "concluída c/ pendência"
    // e passa a "concluída" (a pendência não pende mais nela). Só quando já estava nesse estado.
    if (cur && cur.status === 'concluida_pendencia') {
      const upd = await sb().from('tarefas').update({ status: 'concluida', pendencias: null }).eq('id', cur.id)
      if (upd.error) toast('Tarefa de retorno criada, mas falhou atualizar a original: ' + upd.error.message, 'err')
      else {
        cur.status = 'concluida'; cur.pendencias = null
        setStatusBadge(cur.status)
        const ss = document.getElementById('cc-d-status-sel'); if (ss) ss.value = 'concluida'
        pintarStatusSel()
      }
    }
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
    // Modalidade: usa a da tarefa; se vazia, deriva do padrão do cliente (sugestão, confirmar ao salvar).
    const conf = (t && cliConf[t.cliente_id]) || {}
    const derivada = !(t && t.modalidade) && !!conf.modalidade
    const mod = (t && t.modalidade) || conf.modalidade || ''
    const vh = (t && t.valor_hora != null) ? t.valor_hora : (conf.valor_hora != null ? conf.valor_hora : '')
    document.getElementById('cc-fat-modalidade').value = mod
    document.getElementById('cc-fat-vh').value = vh
    document.getElementById('cc-fat-mod-hint').textContent = derivada ? '↳ derivada do cliente — confirme em Salvar' : ''
    renderModalidadeCalc()
    renderSituacao()
  }
  // Mostra/oculta valor-hora e calcula horas faturáveis (por hora) p/ a tarefa.
  function renderModalidadeCalc() {
    const isHora = document.getElementById('cc-fat-modalidade').value === 'por_hora'
    document.getElementById('cc-fat-vh-wrap').style.display = isHora ? '' : 'none'
    document.getElementById('cc-fat-hora').style.display = isHora ? '' : 'none'
    if (!isHora) return
    const totalMin = (cur && cur.rats ? cur.rats : []).reduce((s, r) => s + (Number(RatView.tempoRat(r)) || 0), 0)
    const billedMin = Math.ceil(totalMin / 30) * 30          // arredonda p/ cima de 30 em 30 min
    const vh = Number(document.getElementById('cc-fat-vh').value) || 0
    document.getElementById('cc-fat-horas').textContent = RatView.fmtMin(billedMin) +
      (totalMin && billedMin !== totalMin ? ` (real ${RatView.fmtMin(totalMin)})` : '')
    document.getElementById('cc-fat-valor').textContent = money((billedMin / 60) * vh)
  }
  async function salvarModalidade() {
    if (!cur || !cur.id) return
    const mod = document.getElementById('cc-fat-modalidade').value || null
    const vh = mod === 'por_hora' ? (Number(document.getElementById('cc-fat-vh').value) || null) : null
    const up = await sb().from('tarefas').update({ modalidade: mod, valor_hora: vh }).eq('id', cur.id)
    if (up.error) return toast('Erro ao salvar modalidade: ' + up.error.message, 'err')
    const t = tarefas.find(x => x.id === cur.id); if (t) { t.modalidade = mod; t.valor_hora = vh }
    toast(mod ? 'Modalidade salva.' : 'Modalidade removida (pendente de classificação).', 'ok')
  }
  async function faturarTarefa() {
    if (!cur || !cur.id) return
    const nota = document.getElementById('cc-fat-nota').value.trim() || null
    const iso = new Date().toISOString()
    const up = await sb().from('tarefas').update({ faturado: true, data_faturamento: iso, numero_nota: nota, status: 'faturada' }).eq('id', cur.id)
    if (up.error) return toast('Erro ao faturar: ' + up.error.message, 'err')
    const t = tarefas.find(x => x.id === cur.id); if (t) { t.faturado = true; t.data_faturamento = iso; t.numero_nota = nota; t.status = 'faturada' }
    cur.status = 'faturada'
    document.getElementById('cc-d-status-sel').value = 'faturada'
    setStatusBadge('faturada')
    renderFaturamento({ faturado: true, data_faturamento: iso, numero_nota: nota })
    carregarTimeline()
    toast('Tarefa marcada como faturada.', 'ok')
  }
  async function desfazerFaturamento() {
    if (!cur || !cur.id) return
    if (!confirm('Desfazer o faturamento desta tarefa?')) return
    // Volta para o passo anterior à faturada (se o status estava 'faturada').
    const novoStatus = cur.status === 'faturada' ? 'aprovada_faturamento' : cur.status
    const up = await sb().from('tarefas').update({ faturado: false, data_faturamento: null, numero_nota: null, status: novoStatus }).eq('id', cur.id)
    if (up.error) return toast('Erro: ' + up.error.message, 'err')
    const t = tarefas.find(x => x.id === cur.id); if (t) { t.faturado = false; t.data_faturamento = null; t.numero_nota = null; t.status = novoStatus }
    cur.status = novoStatus
    document.getElementById('cc-d-status-sel').value = novoStatus
    setStatusBadge(novoStatus)
    renderFaturamento({ faturado: false })
    carregarTimeline()
    toast('Faturamento desfeito.', 'ok')
  }

  // ───────────────────── Situação da tarefa (faixa de 6 cards) ─────────────────────
  const SITU_ICO = {
    dados: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    rats:  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    prod:  '<svg viewBox="0 0 24 24"><path d="M21 16V8l-9-5-9 5v8l9 5 9-5Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>',
    fora:  '<svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    fat:   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    anx:   '<svg viewBox="0 0 24 24"><path d="M21 12.5 12.5 21a4 4 0 0 1-6-6l8-8a2.5 2.5 0 0 1 4 3l-8 8"/></svg>',
  }
  const situCard = (cls, ico, lbl, st, mini) =>
    `<div class="scard ${cls}"><div class="ic">${ico}</div>` +
    `<div class="lbl">${esc(lbl)}${mini ? ` <span class="mini">${esc(mini)}</span>` : ''}</div>` +
    `<div class="st">${esc(st)}</div></div>`

  // Conciliação só vira PENDÊNCIA depois da execução: antes disso, Levada > Utilizada
  // é o estado normal (material em campo, ninguém usou nada ainda).
  // "Fora da proposta" alerta sempre (levou/usou algo que não estava no orçamento).
  const POS_EXEC = ['concluida', 'concluida_pendencia', 'aprovada_faturamento', 'faturada']
  const tarefaPosExec = (id) => POS_EXEC.includes(((tarefas || []).find(x => x.id === id) || {}).status)

  // RAT "em andamento" de HOJE = legitimamente em execução. De um dia anterior =
  // o técnico esqueceu de encerrar — é "não encerrada" (ação do admin), não um travamento.
  const hojeMeiaNoite = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
  function diaDaRat(r) {
    const s = (r.respostas && r.respostas.data) || r.data_tarefa || r.criado_em
    if (!s) return null
    const d = new Date(String(s).length <= 10 ? s + 'T00:00:00' : s)
    return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate())
  }
  const ratNaoEncerrada = (r) => { if (r.status !== 'em_andamento') return false; const dia = diaDaRat(r); return !!dia && dia < hojeMeiaNoite() }
  const diasAberta = (r) => { const dia = diaDaRat(r); return dia ? Math.round((hojeMeiaNoite() - dia) / 86400000) : 0 }
  const diasTxt = (n) => `há ${n} ${n === 1 ? 'dia' : 'dias'}`

  // Estado consolidado da tarefa aberta (usado pela faixa Situação e pelas abas).
  function estadoTarefa() {
    const t = tarefas.find(x => x.id === (cur && cur.id)) || {}
    const dadosOk = !!(cur && cur.id) && (tecPorTarefa[cur.id] || []).length > 0 && !!t.data_agendada
    const rats = (cur && cur.rats) || []
    const ratEmAnd = rats.some(r => r.status === 'em_andamento')
    const ratsNaoEnc = rats.filter(ratNaoEncerrada)
    const ratNaoEncN = ratsNaoEnc.length
    const ratNaoEncDias = ratsNaoEnc.reduce((m, r) => Math.max(m, diasAberta(r)), 0)
    const ratEmAndHoje = rats.some(r => r.status === 'em_andamento' && !ratNaoEncerrada(r))
    const posExec = POS_EXEC.includes(t.status)
    let devItens = 0, aRevisar = 0, foraN = 0, prodAtencao = 0
    for (const l of (linhas || [])) {
      const dev = posExec && (Number(l.qtd_devolvida) || 0) > 0 && !l.revisado   // revisado = já devolvido → não conta
      const rev = !!(l.situacao && l.situacao !== 'ok' && !l.revisado && (posExec || l.situacao === 'sem_orcada' || l.situacao === 'sem_orcamento'))
      if (dev) devItens++
      if (rev) aRevisar++
      if (l.situacao === 'sem_orcada') foraN++
      if (dev || rev) prodAtencao++   // LINHAS com atenção (a mesma linha não conta 2x)
    }
    return {
      t, dadosOk, ratsLen: rats.length, ratEmAnd, ratNaoEncN, ratNaoEncDias, ratEmAndHoje,
      prodLen: (linhas || []).length, devItens, aRevisar, foraN, prodAtencao,
      // pendência de Produtos = só divergências NÃO revisadas. "A devolver" de item já revisado
      // é informativo (segue no card/stat), mas não mantém o card em pendência.
      prodWarn: aRevisar > 0,
      matConflito: !!(cur && cur.matConflitoRats), matConflitoRats: (cur && cur.matConflitoRats) || 0,
      fat: !!t.faturado, anx: ((cur && cur.anexos) || []).length, equipLen: ((cur && cur.equip) || []).length,
    }
  }

  function renderSituacao() {
    const wrap = document.getElementById('cc-situacao-wrap')
    const box = document.getElementById('cc-situacao')
    if (!wrap || !box) return
    if (!cur || !cur.id) { wrap.style.display = 'none'; renderTabs(); return }
    wrap.style.display = ''
    const e = estadoTarefa()
    box.innerHTML = [
      situCard(e.dadosOk ? 's-ok' : 's-warn', SITU_ICO.dados, 'Dados da tarefa', e.dadosOk ? 'Preenchido' : 'Incompleto'),
      cur.ratsErro
        ? situCard('s-warn', SITU_ICO.rats, 'RATs', 'Erro ao carregar')
        : e.ratsLen === 0
          ? situCard('s-warn', SITU_ICO.rats, 'RATs', 'Sem RATs')
          : e.ratNaoEncN
            ? situCard('s-pend', SITU_ICO.rats, 'RATs', e.ratNaoEncN > 1 ? `${e.ratNaoEncN} não encerradas` : 'Não encerrada', diasTxt(e.ratNaoEncDias))
            : e.ratEmAndHoje
              ? situCard('s-warn', SITU_ICO.rats, 'RATs', 'Em andamento', 'hoje')
              : situCard('s-ok', SITU_ICO.rats, 'RATs', 'Concluído'),
      situCard(e.matConflito ? 's-pend' : (e.prodWarn ? 's-warn' : 's-ok'), SITU_ICO.prod, 'Produtos', e.matConflito ? 'Conflito de material' : (e.prodWarn ? 'Pendência' : 'OK'), e.matConflito ? (e.matConflitoRats > 1 ? e.matConflitoRats + ' RATs' : 'resolver') : (e.devItens ? `${e.devItens} a devolver` : '')),
      situCard(e.foraN ? 's-pend' : 's-ok', SITU_ICO.fora, 'Fora da proposta', e.foraN ? `${e.foraN} ${e.foraN > 1 ? 'itens' : 'item'}` : 'OK'),
      situCard(e.fat ? 's-ok' : 's-warn', SITU_ICO.fat, 'Faturamento', e.fat ? 'Faturado' : 'Pendente'),
      situCard('s-ok', SITU_ICO.anx, 'Anexos', e.anx ? `${e.anx} ${e.anx > 1 ? 'arquivos' : 'arquivo'}` : 'Nenhum'),
    ].join('')
    renderTabs()
    renderResumo()
  }

  // Indicadores das abas: ✓ (completo) ou contador (atenção/pendência).
  function renderTabs() {
    const tabs = document.getElementById('cc-tabs'); if (!tabs) return
    const e = estadoTarefa()
    const chk = '<span class="chk"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg></span>'
    const cnt = (n, red) => `<span class="cnt${red ? ' red' : ''}">${n}</span>`
    const ind = {
      dados: e.dadosOk ? chk : '',
      rats: e.ratsLen === 0 ? '' : (e.ratNaoEncN ? cnt(e.ratNaoEncN, true) : (e.ratEmAnd ? cnt(e.ratsLen) : chk)),
      material: e.prodLen === 0 ? '' : (e.matConflito ? cnt(e.matConflitoRats, true) : (e.prodWarn ? cnt(e.aRevisar) : chk)),
      fat: e.fat ? chk : '',
      equip: e.equipLen ? chk : '',
      anexos: e.anx ? chk : '',
    }
    tabs.querySelectorAll('.tab').forEach(tb => {
      const slot = tb.querySelector('.tind'); if (slot) slot.innerHTML = ind[tb.dataset.pane] || ''
    })
  }

  // Resumo operacional (coluna direita da aba Dados) — dados reais + próxima ação.
  function renderResumo() {
    const box = document.getElementById('cc-rsum'); if (!box) return
    if (!cur || !cur.id) { box.innerHTML = ''; return }
    const e = estadoTarefa()
    let custoUtil = 0, devValor = 0
    for (const l of (linhas || [])) {
      const p = Number(l.preco_unitario) || 0
      custoUtil += (Number(l.qtd_utilizada) || 0) * p
      const d = Number(l.qtd_devolvida) || 0
      if (d > 0 && !l.revisado) devValor += d * p   // revisado = já devolvido → não conta no "A devolver"
    }
    const totalMin = ((cur && cur.rats) || []).reduce((s, r) => s + (Number(RatView.tempoRat(r)) || 0), 0)
    let next
    if (e.matConflito) next = 'Conflito de material: 2+ técnicos lançaram na MESMA RAT. Abra a RAT em conflito (aba RATs → "Editar ↗"), remova o conjunto duplicado e salve — depois é seguro faturar.'
    else if (e.ratsLen === 0) next = 'Aguardando a primeira RAT do técnico.'
    else if (e.ratNaoEncN) next = `RAT em aberto ${diasTxt(e.ratNaoEncDias)} — o técnico não encerrou. Use "✓ Encerrar" na aba RATs para concluir.`
    else if (e.ratEmAndHoje) next = 'Há RAT em andamento hoje — aguarde a conclusão pelo técnico.'
    else if (e.devItens > 0 || e.foraN > 0) next = 'Conferir devolução de materiais / itens fora da proposta antes de faturar.'
    else if (!e.fat) next = 'Tudo conciliado — liberar faturamento.'
    else next = 'Tarefa faturada — sem ação pendente.'
    const stat = (cls, svg, k, v) => `<div class="stat"><div class="ic ${cls}">${svg}</div><div class="k">${k}</div><div class="v num">${esc(v)}</div></div>`
    box.innerHTML = '<h2>Resumo operacional</h2>'
      + stat('i-blue', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>', 'Horas registradas (RATs)', RatView.fmtMin(totalMin))
      + stat('i-green', '<svg viewBox="0 0 24 24"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>', 'Valor utilizado (materiais)', money(custoUtil))
      + stat('i-amber', '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/></svg>', 'A devolver ao estoque', e.devItens ? money(devValor) : '—')
      + stat('i-red', '<svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>', 'Itens fora da proposta', String(e.foraN))
      + `<div class="nextact"><div class="ic"><svg viewBox="0 0 24 24"><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1ZM16 9a3 3 0 0 1 0 6"/></svg></div><div><div class="k">Próxima ação recomendada</div><div class="v">${esc(next)}</div></div></div>`
  }

  // Linha do tempo da tarefa — lê a trilha de auditoria (tabela auditoria).
  const TL_ICO = {
    criada: '<svg viewBox="0 0 24 24"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>',
    status_alterado: '<svg viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></svg>',
    faturada: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    faturamento_desfeito: '<svg viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>',
    tecnico_atribuido: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>',
    tecnico_removido: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>',
    rat_criada: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    rat_status: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="m8.5 13 2.5 2.5 4.5-5"/></svg>',
  }
  const TL_COR = { criada: 'd-blue', status_alterado: 'd-blue', faturada: 'd-green', faturamento_desfeito: 'd-red', tecnico_atribuido: 'd-green', tecnico_removido: 'd-red', rat_criada: 'd-blue', rat_status: 'd-green' }
  async function carregarTimeline() {
    const tl = document.getElementById('cc-timeline'); if (!tl) return
    if (!cur || !cur.id) { tl.innerHTML = ''; return }
    const { data, error } = await sb().from('auditoria').select('acao,detalhe,ator_nome,em').eq('tarefa_id', cur.id).order('em', { ascending: true })
    const rows = error ? [] : (data || [])
    if (!rows.length) { tl.innerHTML = '<div class="cc-empty-sm" style="grid-column:1/-1">Sem eventos registrados ainda.</div>'; return }
    tl.innerHTML = rows.map(r => {
      const ico = TL_ICO[r.acao] || TL_ICO.status_alterado
      const cor = TL_COR[r.acao] || 'd-blue'
      return `<div class="tcard"><div class="top"><span class="dot ${cor}">${ico}</span><span class="dt">${fdt(r.em, { withTime: true })}</span></div>`
        + `<div class="lbl">${esc(r.detalhe || r.acao)}</div><div class="who">${esc(r.ator_nome || '—')}</div></div>`
    }).join('')
  }

  function mostrar(sec) {
    document.getElementById('view-lista').style.display = sec === 'lista' ? 'block' : 'none'
    document.getElementById('view-detalhe').style.display = sec === 'detalhe' ? 'block' : 'none'
    document.getElementById('topbar-title').textContent = sec === 'detalhe' ? (cur && cur.numero != null ? `Tarefa Nº ${osNo(cur.numero)}` : 'Tarefa') : 'Tarefas'
    if (sec !== 'detalhe') { const dn = document.getElementById('cc-docno'); if (dn) dn.textContent = '' }
  }

  // Abas do detalhe: mostra um card por vez e reflete na URL (tarefa.html?t=<id>&aba=<key>).
  function mostrarPane(key) {
    if (!PANES.includes(key)) key = 'dados'
    document.querySelectorAll('#cc-tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.pane === key))
    document.querySelectorAll('#view-detalhe .cc-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === key))
    if (key === 'dados') { autoGrow(document.getElementById('cc-d-orientacao')); autoGrow(document.getElementById('cc-d-obs')) }
    if (key === 'desloc') carregarDeslocamentos()
    if (cur && cur.id) history.replaceState(null, '', `tarefa.html?t=${encodeURIComponent(cur.id)}&aba=${key}`)
  }

  return { init }
})()
