/* ═══════════════════════════════════════════════
   Service Report — tecnico.js
   App de campo (PWA): formulário de RAT local-first.
   Fluxo: seleciona cliente + tipo de serviço (carrega o formulário do tipo) →
   preenche questionário dinâmico → ≥1 foto → assinatura → salva via DBLocal
   como 'salvo_local'. A subida (→ confirmado) é o passo 5 (sync.js).

   Dependências: utils.js (esc), supabase-client.js (getSupabase/getUserRole),
   auth.js (SESSION, toast), db-local.js (window.DBLocal).
   Exposto como window.TecnicoApp.
═══════════════════════════════════════════════ */
(function () {
  const D = () => window.DBLocal
  const REF_KEY = 'sr_ref_v1'

  let ref = { clientes: [], tipos: [], formularios: {}, tecnicos: [], veiculos: [], produtos: [], base: { cidade: '', uf: '' }, status: {} }   // formularios: { [id]: {nome,campos} }
  let tecnico = { id: null, nome: null }
  let cur = null            // RAT em edição: { client_uuid, campos: [], tarefa_id?, tarefa_numero? }
  let prodTab = 'add'       // aba do seletor de produtos da RAT: add | comigo | estoque
  let sig = null            // controlador do canvas de assinatura
  let curVisivel = {}       // id do campo -> visível? (condicionais)
  const TAREFAS_KEY = 'sr_tarefas_v1'
  let tarefas = []          // tarefas atribuídas (cache)
  let tarefaAberta = null   // tarefa no detalhe
  const T_STATUS = {
    aguardando_execucao: { t: 'Aguardando execução', c: '' },
    em_execucao: { t: 'Em execução', c: 's-exec' },
    concluida: { t: 'Concluída', c: 's-done' },
    concluida_pendencia: { t: 'Concluída c/ pendência', c: 's-done' },
    devolvida: { t: 'Devolvida', c: '' },
    aprovada_faturamento: { t: 'Aprovada p/ faturamento', c: 's-done' },
    faturada: { t: 'Faturada', c: 's-done' },
  }
  const RAT_SIT_LABEL = { em_andamento: 'Em andamento', concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência' }
  const ratSit = (s) => RAT_SIT_LABEL[s] || s || '—'
  // Prioridade de exibição por status da tarefa (menor = aparece primeiro).
  const STATUS_PRIORIDADE = { em_execucao: 1, devolvida: 2, aguardando_execucao: 3, concluida_pendencia: 4, concluida: 5, aprovada_faturamento: 6, faturada: 7 }
  const RAT_PARA_TAREFA = { em_andamento: 'em_execucao', concluida: 'concluida', concluida_pendencia: 'concluida_pendencia' }
  const prioStatus = (s) => (STATUS_PRIORIDADE[s] != null ? STATUS_PRIORIDADE[s] : 50)
  // Label/cor do status vindos de Configurações (status_tarefa); cai no T_STATUS fixo.
  const stLabel = (s) => (ref.status && ref.status[s] && ref.status[s].label) || (T_STATUS[s] && T_STATUS[s].t) || s || '—'
  const stCor = (s) => (ref.status && ref.status[s] && ref.status[s].cor) || '#48506A'
  const stStyle = (s) => `background:${stCor(s)}1A;color:${stCor(s)};border:none`
  // Mapeia status do sistema → variante visual do skin (info/done/warn/pend/aguard).
  const SKIN_STATUS = { em_execucao: 'info', aguardando_execucao: 'aguard', concluida: 'done', concluida_pendencia: 'warn', devolvida: 'pend', aprovada_faturamento: 'done', faturada: 'done' }
  function togglePendencias() {
    const v = document.getElementById('f-status').value
    document.getElementById('f-pendencias-wrap').style.display = (v === 'concluida_pendencia') ? 'block' : 'none'
    const b = document.getElementById('btn-salvar')
    if (b) b.textContent = (v === 'em_andamento') ? 'Salvar e continuar' : 'Salvar e concluir'
  }
  const osNo = (n) => n != null ? String(n).padStart(5, '0') : '—'
  const cliNomeDe = (id, fb) => (ref.clientes.find(c => c.id === id) || {}).nome || fb || '—'

  // Título-case: "marcelo oliveira" -> "Marcelo Oliveira"
  const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, m => m.toUpperCase())

  // Autocomplete com busca (listas grandes: clientes/produtos). Sem framework.
  // busca: input texto; hidden: input que guarda o id; list: div de sugestões.
  function attachAutocomplete(busca, hidden, list, items, fmt, onpick) {
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
          hidden.value = el.dataset.id
          const m = matches.find(x => String(x.id) === el.dataset.id)
          busca.value = m ? m.label : ''
          list.classList.remove('open')
          if (onpick) onpick(items.find(it => String(fmt(it).id) === el.dataset.id))
        }
      })
    }
    busca.oninput = () => { hidden.value = ''; render(busca.value) }
    busca.onfocus = () => { if (busca.value) render(busca.value) }
    busca.onblur = () => { setTimeout(() => list.classList.remove('open'), 150) }
  }

  // ─────────────────────────── Init ───────────────────────────
  async function init() {
    const { data: { user } } = await getSupabase().auth.getUser()
    tecnico.id = user?.id || null
    const u = await getUserRole().catch(() => null)
    tecnico.nome = tcase(u?.nome || user?.email?.split('@')[0] || 'Técnico')
    const ftn = document.getElementById('ft-nome'); if (ftn) ftn.textContent = tecnico.nome

    const hello = document.getElementById('home-hello')
    if (hello) hello.textContent = 'Olá, ' + (tecnico.nome || 'técnico')

    bind()
    await carregarRef()
    await limparRascunhosVazios()
    await restaurarTela()
  }

  // Varredura na abertura: remove rascunhos órfãos (abertos e abandonados sem nenhum
  // conteúdo real — sem respostas, fotos, assinatura ou produtos). Complementa o
  // descarte do cancelar(): cobre quem saiu fechando o navegador no meio.
  async function limparRascunhosVazios() {
    try {
      const rs = await D().listarRats({ status: D().STATUS.RASCUNHO })
      for (const r of rs) {
        if (cur && cur.client_uuid === r.client_uuid) continue
        if (r.tem_foto || r.tem_assinatura || r.questionario_ok || r.respostas) continue
        const fotos = await D().listarFotos(r.client_uuid)
        if (fotos.length) continue
        const mats = await D().listarMateriais(r.client_uuid)
        // levados pré-carregados (qtd 0) não são trabalho do técnico; avulso/qtd>0 são
        if (mats.some(m => (Number(m.quantidade) || 0) > 0 || m.qtd_levada == null)) continue
        await D().removerRat(r.client_uuid)
      }
    } catch (e) { /* limpeza é melhor-esforço */ }
  }

  // Restaura a última tela após recarregar (pull-to-refresh do iOS, etc.) — não volta pra home.
  async function restaurarTela() {
    let alvo = 'home'
    try { alvo = sessionStorage.getItem('sr_tec_screen') || 'home' } catch (e) { /* sem storage */ }
    const RENDER = {
      tarefas: renderTarefas, lista: renderLista, 'preorc-lista': renderPreorcLista,
      jornada: renderJornada, desloc: renderDesloc,
    }
    if (alvo !== 'home' && VIEWS[alvo]) {
      mostrar(alvo)
      if (RENDER[alvo]) { try { await RENDER[alvo]() } catch (e) { mostrar('home') } }
    } else mostrar('home')
  }

  function bind() {
    // RAT — sempre criada DENTRO de uma Tarefa (não há criação avulsa).
    document.getElementById('btn-cancelar').onclick = cancelar
    document.getElementById('btn-salvar').onclick = salvar
    document.getElementById('f-gps-btn').onclick = marcarGpsRat
    // Modal de produtos da RAT
    document.getElementById('form-produtos-btn').onclick = abrirModalProd
    document.getElementById('form-fotos-btn').onclick = abrirModalFotos
    document.getElementById('form-desloc-btn').onclick = abrirDesloc
    document.getElementById('fotos-x').onclick = fecharModalFotos
    document.getElementById('fotos-ok').onclick = fecharModalFotos
    document.getElementById('btn-foto').onclick = () => document.getElementById('foto-input').click()
    document.getElementById('foto-input').onchange = (e) => { adicionarFotos(e.target.files); e.target.value = '' }
    const bfg = document.getElementById('btn-foto-gal')
    if (bfg) bfg.onclick = () => document.getElementById('foto-input-gal').click()
    const fig = document.getElementById('foto-input-gal')
    if (fig) fig.onchange = (e) => { adicionarFotos(e.target.files); e.target.value = '' }
    document.getElementById('prod-x').onclick = fecharModalProd
    document.getElementById('prod-ok').onclick = fecharModalProd
    document.getElementById('prod-avulso-btn').onclick = adicionarAvulsoUI
    document.getElementById('prod-busca').oninput = () => refreshMateriais()
    document.querySelectorAll('#modal-prod .prod-tab').forEach(b => b.onclick = () => {
      prodTab = b.dataset.tab
      document.querySelectorAll('#modal-prod .prod-tab').forEach(x => x.classList.toggle('on', x === b))
      refreshMateriais()
    })
    document.getElementById('f-tipo').onchange = onTipoChange
    document.getElementById('f-status').onchange = togglePendencias
    // Navegação da home
    document.getElementById('btn-voltar').onclick = onVoltar
    document.getElementById('nav-os').onclick = async () => { mostrar('lista'); await renderLista() }
    document.getElementById('nav-tarefas').onclick = async () => { mostrar('tarefas'); await renderTarefas() }
    document.getElementById('btn-tarefas-sync').onclick = async () => { await renderTarefas(true) }
    document.getElementById('btn-nova-tarefa').onclick = () => {
      document.getElementById('nt-cliente').value = ''; document.getElementById('nt-cliente-busca').value = ''
      document.getElementById('nt-tipo').value = ''; document.getElementById('nt-data').value = ''
      document.getElementById('nt-status').value = 'aguardando_execucao'
      document.getElementById('nt-orientacao').value = ''
      montarNtTecnicos()
      document.getElementById('modal-nt').classList.add('open')
    }
    document.getElementById('nt-fechar').onclick = () => document.getElementById('modal-nt').classList.remove('open')
    document.getElementById('nt-cancelar').onclick = () => document.getElementById('modal-nt').classList.remove('open')
    document.getElementById('nt-criar').onclick = criarTarefaTecnico
    document.getElementById('btn-iniciar-rat').onclick = () => { if (tarefaAberta) iniciarRatDaTarefa(tarefaAberta) }
    document.getElementById('btn-concluir').onclick = () => concluirTarefa(false)
    document.getElementById('btn-concluir-pend').onclick = () => concluirTarefa(true)
    document.getElementById('nav-preorc').onclick = async () => { mostrar('preorc-lista'); await renderPreorcLista() }
    document.getElementById('nav-jornada').onclick = async () => { mostrar('jornada'); await renderJornada() }
    document.getElementById('nav-desloc').onclick = async () => { mostrar('desloc'); await renderDesloc() }
    bindJornada()
    bindDesloc()
    const bsh = document.getElementById('btn-sync-home'); if (bsh) bsh.onclick = () => window.SyncEngine && SyncEngine.syncAll()
    // Pré-orçamento
    document.getElementById('btn-preorc-novo').onclick = novoPreorcUI
    document.getElementById('po-btn-cancelar').onclick = cancelarPreorc
    document.getElementById('po-btn-salvar').onclick = concluirPreorc
    document.getElementById('po-desloc').onchange = onDeslocPoChange
    document.getElementById('view-preorc-form').addEventListener('input', atualizarTempoPo)
    document.getElementById('po-prod-add-btn').onclick = poAddItem
    const pf = document.getElementById('po-foto-input')
    document.getElementById('po-btn-foto').onclick = () => pf.click()
    pf.onchange = () => poAddFotos(pf.files)
  }

  // ───────────────────── Dados de referência ─────────────────────
  // Online: busca do Supabase e cacheia (localStorage) para uso offline.
  // Offline: usa o cache.
  async function carregarRef() {
    try {
      const sb = getSupabase()
      const [cli, tip, forms, tec, veic, prod, base, sts] = await Promise.all([
        // mesma regra da tela Empresas: mostra todas as visíveis (inclui Omie),
        // escondendo só as "excluídas" (oculto + não reimporta).
        sb.from('clientes').select('id,nome,documento,endereco').or('oculto.is.false,oculto.is.null,sync_omie.is.null,sync_omie.neq.false').order('nome'),
        sb.from('tipos_servico').select('id,nome,formulario_id,ativo').eq('ativo', true).order('nome'),
        sb.from('formulario_modelos').select('id,nome,campos').eq('ativo', true),
        sb.rpc('sr_usuarios'),   // técnicos do SR (papel vindo do Portal); filtra abaixo
        sb.from('veiculos').select('id,modelo,placa,ativo').eq('ativo', true).order('modelo'),
        (async () => {   // pagina p/ trazer TODOS os produtos (Supabase corta em 1000/req)
          const all = []; const P = 1000
          for (let i = 0; ; i += P) {
            const r = await sb.from('produtos').select('id,codigo,descricao,unidade,ativo').eq('ativo', true).eq('oculto', false).order('descricao').range(i, i + P - 1)
            if (r.error) return { data: all, error: r.error }
            all.push(...(r.data || []))
            if (!r.data || r.data.length < P) break
          }
          return { data: all }
        })(),
        sb.from('org_config').select('base_cidade,base_uf').eq('id', 1).maybeSingle(),
        sb.from('status_tarefa').select('chave,label,cor'),
      ])
      if (cli.error || tip.error || forms.error) throw (cli.error || tip.error || forms.error)
      // Falha PARCIAL (ex.: só a query de produtos) não pode apagar o cache anterior:
      // cada bloco cai no valor cacheado quando a própria consulta falhou.
      let cacheRef = {}
      try { cacheRef = JSON.parse(localStorage.getItem(REF_KEY) || '{}') } catch (e) { cacheRef = {} }
      ref.clientes = cli.data || []
      ref.tipos = tip.data || []
      ref.formularios = {}
      ;(forms.data || []).forEach(f => { ref.formularios[f.id] = f })
      ref.tecnicos = tec.error ? (cacheRef.tecnicos || []) : (tec.data || []).filter(u => u.role === 'tecnico_campo' && u.ativo)
      ref.veiculos = veic.error ? (cacheRef.veiculos || []) : (veic.data || [])
      ref.produtos = prod.error
        ? (((cacheRef.produtos || []).length > (prod.data || []).length) ? cacheRef.produtos : (prod.data || []))
        : (prod.data || [])
      ref.base = (base && base.data) ? { cidade: base.data.base_cidade || '', uf: base.data.base_uf || '' } : (cacheRef.base || { cidade: '', uf: '' })
      ref.status = {}
      if (sts && !sts.error) (sts.data || []).forEach(s => { ref.status[s.chave] = { label: s.label, cor: s.cor } })
      else if (cacheRef.status) ref.status = cacheRef.status
      localStorage.setItem(REF_KEY, JSON.stringify(ref))
    } catch (e) {
      const cache = localStorage.getItem(REF_KEY)
      if (cache) { ref = JSON.parse(cache); toast('Offline — usando cadastros salvos.', 'info') }
      else { toast('Sem conexão e sem cadastros em cache.', 'err') }
    }
    // cliente: autocomplete (lista grande do Omie)
    attachAutocomplete(
      document.getElementById('f-cliente-busca'),
      document.getElementById('f-cliente'),
      document.getElementById('ac-cliente-list'),
      ref.clientes, c => ({ id: c.id, label: c.nome })
    )
    // cliente no modal "Nova tarefa" (técnico)
    attachAutocomplete(
      document.getElementById('nt-cliente-busca'),
      document.getElementById('nt-cliente'),
      document.getElementById('nt-cliente-list'),
      ref.clientes, c => ({ id: c.id, label: c.nome })
    )
    const tipoOpts = ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')
    document.getElementById('f-tipo').innerHTML = '<option value="">Selecione…</option>' + tipoOpts
    document.getElementById('nt-tipo').innerHTML = '<option value="">— selecione —</option>' + tipoOpts
    montarNtTecnicos()
  }

  // Checkboxes de responsáveis no modal "Nova tarefa" — o próprio técnico vem marcado.
  function montarNtTecnicos() {
    const box = document.getElementById('nt-tecs'); if (!box) return
    const eu = ref.tecnicos.find(t => t.id === tecnico.id)
    const lista = eu ? ref.tecnicos : [{ id: tecnico.id, nome: tecnico.nome }].concat(ref.tecnicos)
    box.innerHTML = lista.map(t => {
      const souEu = t.id === tecnico.id
      return `<label><input type="checkbox" value="${esc(t.id)}"${souEu ? ' checked' : ''}> ${esc(tcase(t.nome))}${souEu ? ' (você)' : ''}</label>`
    }).join('')
  }

  // ─────────────────────────── Lista ───────────────────────────
  const BADGE = {
    rascunho:   { cls: 's-fi', txt: 'Rascunho' },
    salvo_local:{ cls: 's-rv', txt: 'Salvo no aparelho' },
    na_fila:    { cls: 's-ai', txt: 'Na fila' },
    enviando:   { cls: 's-ct', txt: 'Enviando…' },
    confirmado: { cls: 's-en', txt: 'Confirmado' },
    erro:       { cls: 's-rm', txt: 'Erro' },
  }
  function badge(status) {
    const b = BADGE[status] || { cls: 's-sc', txt: status }
    return `<span class="badge ${b.cls}"><span class="dot"></span>${esc(b.txt)}</span>`
  }

  async function renderLista() {
    const rats = await D().listarRats()
    const box = document.getElementById('lista-rats')
    if (!rats.length) {
      box.innerHTML = '<p class="dim" style="padding:14px 2px">Nenhuma RAT no aparelho. Abra uma tarefa em <b>Minhas Tarefas</b> e toque em <b>“Iniciar RAT”</b>.</p>'
      return
    }
    if (!tarefas.length) { try { await renderTarefas() } catch (e) { /* segue */ } }   // garante números/status atualizados
    // Status da tarefa-pai (para ordenar por prioridade); cai no status da própria RAT se a tarefa não estiver carregada.
    const tarStatusDe = (r) => { const t = tarefas.find(x => x.id === r.tarefa_id); return t ? t.status : (RAT_PARA_TAREFA[r.status] || r.status) }
    const tarNumeroDe = (r) => { const t = tarefas.find(x => x.id === r.tarefa_id); return (t && t.numero != null) ? t.numero : r.tarefa_numero }
    // Subnumeração por tarefa (/01, /02…): usa rat_seq do servidor; se ainda local, ordem de criação.
    const subLocal = {}
    for (const r of [...rats].sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''))) {
      (subLocal[r.tarefa_id] = subLocal[r.tarefa_id] || []).push(r.client_uuid)
    }
    const subDe = (r) => { if (r.rat_seq != null) return r.rat_seq; const a = subLocal[r.tarefa_id] || []; const i = a.indexOf(r.client_uuid); return i >= 0 ? i + 1 : null }
    const pad2 = (n) => String(n).padStart(2, '0')
    const tarLabel = (r) => { const n = tarNumeroDe(r); if (n == null) return ''; const s = subDe(r); return 'Tarefa Nº ' + osNo(n) + (s != null ? '/' + pad2(s) : '') + ' · ' }
    const ordenadas = rats.slice().sort((a, b) => prioStatus(tarStatusDe(a)) - prioStatus(tarStatusDe(b)) || (b.criado_em || '').localeCompare(a.criado_em || ''))
    box.innerHTML = ordenadas.map(r => {
      const ts = tarStatusDe(r); const sk = SKIN_STATUS[ts] || 'aguard'
      const lc = sk === 'info' ? 'lc-info' : sk === 'done' ? 'lc-done' : sk === 'warn' ? 'lc-warn' : ''
      const syncTxt = r.sync_status === 'confirmado' ? '✓ enviado' : ((BADGE[r.sync_status] || {}).txt || '')
      return `<div class="listcard ${lc}" data-uuid="${esc(r.client_uuid)}"><span class="edge e-${sk}"></span>
        <div class="t"><span class="cli">${esc(r.cliente_nome || 'Sem cliente')}</span><span class="badge b-${sk}">${esc(ratSit(r.status || 'em_andamento'))}</span></div>
        <div class="meta">${tarLabel(r)}<b>${esc(syncTxt)}</b></div>
        <div class="meta" style="display:flex;justify-content:space-between;align-items:center"><span>${fdt(r.criado_em, { withTime: true })}</span><button type="button" class="rat-del" data-del="${esc(r.client_uuid)}" title="Excluir RAT" style="background:none;border:none;cursor:pointer;font-size:15px">🗑</button></div>
      </div>`
    }).join('')
    box.querySelectorAll('.listcard').forEach(el => {
      el.onclick = (e) => { if (e.target.closest('[data-del]')) return; abrirExistente(el.dataset.uuid) }
    })
    box.querySelectorAll('[data-del]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); excluirRat(b.dataset.del) } })
  }

  async function excluirRat(client_uuid) {
    if (!confirm('Excluir esta RAT? Esta ação não pode ser desfeita.')) return
    const rat = await D().obterRat(client_uuid)
    // se já foi sincronizada, remove também do servidor (materiais → fotos → rat)
    if (rat && rat.recebido_em && navigator.onLine) {
      try {
        const sb = getSupabase()
        const { data: srv } = await sb.from('rats').select('id').eq('client_uuid', client_uuid).maybeSingle()
        if (srv) {
          await sb.from('materiais').delete().eq('rat_id', srv.id)
          await sb.from('relatorio_fotos').delete().eq('rat_id', srv.id)
          await sb.from('rats').delete().eq('id', srv.id)
        }
      } catch (e) { toast('Removida do aparelho; falha ao remover do servidor: ' + (e.message || e), 'err') }
    } else if (rat && rat.recebido_em && !navigator.onLine) {
      toast('Sem conexão — removida do aparelho, mas ainda está no servidor.', 'info')
    }
    await D().removerRat(client_uuid)
    toast('RAT excluída.', 'ok')
    await renderLista()
  }

  // ─────────────────────── Tarefas atribuídas (#7) ───────────────────────
  // RLS já filtra para as tarefas do técnico (via tarefa_tecnicos). Cacheia p/ offline.
  async function renderTarefas(force) {
    const box = document.getElementById('lista-tarefas')
    if (box && !tarefas.length) box.innerHTML = '<p class="dim" style="padding:14px 2px">Carregando…</p>'
    try {
      const sb = getSupabase()
      const { data, error } = await sb.from('tarefas')
        .select('id,numero,status,data_agendada,cliente_id,orientacao,observacoes,tipo_servico_id')
        .neq('status', 'faturada')
        .order('data_agendada', { ascending: true, nullsFirst: false })
        .order('numero', { ascending: false })
      if (error) throw error
      tarefas = data || []
      localStorage.setItem(TAREFAS_KEY, JSON.stringify(tarefas))
    } catch (e) {
      const cache = localStorage.getItem(TAREFAS_KEY)
      tarefas = cache ? JSON.parse(cache) : []
      if (force) toast('Offline — mostrando tarefas salvas.', 'info')
    }
    // Mescla tarefas criadas offline (ainda na fila) que ainda não vieram do servidor.
    let locais = []
    try { locais = await D().tarefasLocaisPendentes() } catch (e) { /* ignore */ }
    const idsServer = new Set(tarefas.map(t => t.id))
    const extras = locais.filter(l => !idsServer.has(l.id)).map(l => Object.assign({}, l, { numero: null, _local: true }))
    tarefas = extras.concat(tarefas)
    // Ordena por prioridade de status (Em execução → Devolvida → Aguardando → …), depois por data.
    tarefas.sort((a, b) => prioStatus(a.status) - prioStatus(b.status) || (a.data_agendada || '').localeCompare(b.data_agendada || ''))
    if (!box) return
    if (!tarefas.length) { box.innerHTML = '<p class="dim" style="padding:14px 2px">Nenhuma tarefa atribuída a você.</p>'; return }
    box.innerHTML = tarefas.map(t => {
      const ag = t.data_agendada ? 'Agendada ' + fdt(t.data_agendada) : 'Sem data'
      const metaNo = t._local ? '<b>Nova</b> · na fila ↑' : ('Nº <b>' + osNo(t.numero) + '</b>')
      const sk = SKIN_STATUS[t.status]
      const lc = sk === 'info' ? 'lc-info' : sk === 'done' ? 'lc-done' : sk === 'warn' ? 'lc-warn' : ''
      const edge = sk ? `<span class="edge e-${sk}"></span>` : `<span class="edge" style="background:${stCor(t.status)}"></span>`
      const badge = sk ? `<span class="badge b-${sk}">${esc(stLabel(t.status))}</span>` : `<span class="badge" style="background:${stCor(t.status)};color:#fff">${esc(stLabel(t.status))}</span>`
      return `<div class="listcard ${lc}" data-id="${esc(t.id)}">${edge}
        <div class="t"><span class="cli">${esc(cliNomeDe(t.cliente_id))}</span>${badge}</div>
        <div class="meta">${metaNo} · ${esc(ag)}</div>
      </div>`
    }).join('')
    box.querySelectorAll('.listcard').forEach(el => el.onclick = () => abrirTarefaDet(el.dataset.id))
  }

  async function criarTarefaTecnico() {
    const cliId = document.getElementById('nt-cliente').value
    const tipoId = document.getElementById('nt-tipo').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')
    const status = document.getElementById('nt-status').value || 'aguardando_execucao'
    const orientacao = document.getElementById('nt-orientacao').value.trim() || null
    const tecs = [...document.querySelectorAll('#nt-tecs input:checked')].map(c => c.value)
    if (!tecs.includes(tecnico.id)) tecs.push(tecnico.id)   // o próprio técnico sempre incluso
    // Offline-first: grava na fila local; o SyncEngine envia (tarefa antes das RATs).
    const t = await D().salvarTarefaLocal({
      id: crypto.randomUUID(), cliente_id: cliId, status, tipo_servico_id: tipoId, orientacao,
      data_agendada: document.getElementById('nt-data').value || null, criado_por: tecnico.id, tecnicos: tecs,
    })
    document.getElementById('modal-nt').classList.remove('open')
    toast(navigator.onLine ? 'Tarefa criada.' : 'Tarefa criada — será enviada quando houver internet.', 'ok')
    await renderTarefas()
    if (window.SyncEngine && navigator.onLine) window.SyncEngine.syncAll()
    if (navigator.onLine && window.notificarPush && tecs.some(id => id !== tecnico.id)) notificarPush('tarefa_atribuida', { tecnicos: tecs, cliente: cliNomeDe(cliId) })
    await abrirTarefaDet(t.id)
  }

  async function abrirTarefaDet(id) {
    const t = tarefas.find(x => x.id === id); if (!t) return
    tarefaAberta = t
    document.getElementById('t-det-no').textContent = t._local ? 'Nova tarefa (na fila ↑)' : ('Tarefa Nº ' + osNo(t.numero))
    const badge = document.getElementById('t-det-badge'); badge.textContent = stLabel(t.status)
    const sk = SKIN_STATUS[t.status]
    if (sk) { badge.className = 'badge b-' + sk; badge.style.cssText = '' }
    else { badge.className = 'badge'; badge.style.cssText = `background:${stCor(t.status)};color:#fff` }
    const card = document.getElementById('t-det-card'); if (card) card.style.borderLeftColor = stCor(t.status)
    document.getElementById('t-det-cli').textContent = cliNomeDe(t.cliente_id)
    document.getElementById('t-det-agenda').textContent = t.data_agendada ? 'Agendada para ' + fdt(t.data_agendada) : 'Sem data agendada'
    // Tipo de tarefa
    const tipoNome = (ref.tipos.find(x => x.id === t.tipo_servico_id) || {}).nome
    const tSec = document.getElementById('t-det-tipo')
    if (tipoNome) { tSec.textContent = 'Tipo: ' + tipoNome; tSec.style.display = 'block' } else tSec.style.display = 'none'
    const oSec = document.getElementById('t-det-orient-sec')
    if (t.orientacao) { document.getElementById('t-det-orient').textContent = t.orientacao; oSec.style.display = 'block' } else oSec.style.display = 'none'
    const obSec = document.getElementById('t-det-obs-sec')
    if (t.observacoes) { document.getElementById('t-det-obs').textContent = t.observacoes; obSec.style.display = 'block' } else obSec.style.display = 'none'
    // concluir exige ≥1 RAT salva desta tarefa (não dá pra concluir sem registro)
    const podeConcluir = !['aprovada_faturamento', 'faturada'].includes(t.status)
    const todas = await D().listarRats()
    // RAT "completa" = salva (o salvar() só promove de rascunho após validar os obrigatórios) e questionário ok
    let temRat = (todas || []).some(r => r.tarefa_id === id && r.sync_status !== D().STATUS.RASCUNHO && r.questionario_ok !== false)
    if (!temRat && navigator.onLine) {
      try {
        const { count } = await getSupabase().from('rats').select('id', { count: 'exact', head: true })
          .eq('tarefa_id', id).eq('questionario_ok', true)
        temRat = (count || 0) > 0
      } catch (e) { /* offline/erro: mantém o que tem local */ }
    }
    document.getElementById('t-det-concluir').style.display = (podeConcluir && temRat) ? 'flex' : 'none'
    document.getElementById('t-det-concluir-hint').style.display = (podeConcluir && !temRat) ? 'block' : 'none'
    mostrar('tarefa-det')
    await carregarMaterialDaTarefa(id)
    await carregarEquipDaTarefa(id)
    await carregarAnexosDaTarefa(id)
    await renderRatsDaTarefa(id)
  }

  // Material orçado/levado (view sem preço) — leitura
  async function carregarMaterialDaTarefa(id) {
    const sec = document.getElementById('t-det-mat-sec')
    const box = document.getElementById('t-det-mat')
    try {
      const { data } = await getSupabase().from('vw_tarefa_materiais_tecnico')
        .select('descricao,codigo_produto,unidade,qtd_orcada,qtd_levada,qtd_utilizada').eq('tarefa_id', id)
      if (!data || !data.length) { sec.style.display = 'none'; return }
      const qz = (n) => Number(n) || 0
      const fmt = (n, u) => { const v = qz(n); return (v ? v.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '—') + (v && u ? ' ' + u : '') }
      box.innerHTML = data.map(m => `<div class="prod">
        <div class="pn">${esc(m.descricao || m.codigo_produto || '—')}</div>
        <div class="chips">
          <span class="chip c-orc">Orçado ${fmt(m.qtd_orcada, m.unidade)}</span>
          <span class="chip c-lev">Levado ${fmt(m.qtd_levada, m.unidade)}</span>
          <span class="chip c-uti">Utilizado ${fmt(m.qtd_utilizada, m.unidade)}</span>
        </div>
      </div>`).join('')
      sec.style.display = 'block'
    } catch (e) { sec.style.display = 'none' }
  }

  // Anexos da tarefa — download por link assinado
  async function carregarAnexosDaTarefa(id) {
    const sec = document.getElementById('t-det-anexos-sec')
    const box = document.getElementById('t-det-anexos')
    try {
      const { data } = await getSupabase().from('tarefa_anexos').select('nome,url').eq('tarefa_id', id).order('criado_em')
      if (!data || !data.length) { sec.style.display = 'none'; return }
      box.innerHTML = data.map((a, i) => `<div class="t-det-anx"><span>📄</span><a data-anx="${i}">${esc(a.nome || 'arquivo')}</a></div>`).join('')
      box.querySelectorAll('[data-anx]').forEach(el => el.onclick = async () => {
        const a = data[Number(el.dataset.anx)]
        const { data: s, error } = await getSupabase().storage.from('rat-anexos').createSignedUrl(a.url, 120)
        if (error) return toast('Erro ao abrir: ' + error.message, 'err')
        window.open(s.signedUrl, '_blank')
      })
      sec.style.display = 'block'
    } catch (e) { sec.style.display = 'none' }
  }

  async function concluirTarefa(comPendencia) {
    if (!tarefaAberta) return
    if (!navigator.onLine) return toast('Sem conexão — conclua pela RAT ou quando estiver online.', 'err')
    let pend = null
    if (comPendencia) {
      pend = (prompt('Descreva a pendência da tarefa:') || '').trim()
      if (!pend) return toast('Pendência obrigatória.', 'err')
    }
    const novo = comPendencia ? 'concluida_pendencia' : 'concluida'
    const up = await getSupabase().from('tarefas').update({ status: novo, pendencias: pend }).eq('id', tarefaAberta.id)
    if (up.error) return toast('Erro ao concluir: ' + up.error.message, 'err')
    const id = tarefaAberta.id
    toast(comPendencia ? 'Tarefa concluída com pendência.' : 'Tarefa concluída.', 'ok')
    await renderTarefas()
    await abrirTarefaDet(id)
  }

  async function carregarEquipDaTarefa(id) {
    const sec = document.getElementById('t-det-equip-sec')
    const box = document.getElementById('t-det-equip')
    try {
      const sb = getSupabase()
      const { data: te } = await sb.from('tarefa_equipamentos').select('equipamento_id').eq('tarefa_id', id)
      const ids = (te || []).map(r => r.equipamento_id)
      if (!ids.length) { sec.style.display = 'none'; return }
      const { data: eqs } = await sb.from('equipamentos_axis').select('id,tipo,modelo,serial,part_number').in('id', ids)
      box.innerHTML = (eqs || []).map(e => {
        const sub = e.serial ? 'S/N ' + e.serial : (e.part_number ? 'PN ' + e.part_number : '')
        return `<div class="t-det-equip-item">${esc(e.modelo || e.tipo || 'Equipamento')}${sub ? ` <span class="sub">${esc(sub)}</span>` : ''}</div>`
      }).join('')
      sec.style.display = 'block'
    } catch (e) { sec.style.display = 'none' }
  }

  async function renderRatsDaTarefa(id) {
    const sec = document.getElementById('t-det-rats-sec')
    const box = document.getElementById('t-det-rats')
    const todas = await D().listarRats()
    const dela = (todas || []).filter(r => r.tarefa_id === id)
    if (!dela.length) { sec.style.display = 'none'; return }
    box.innerHTML = dela.map(r => {
      const conf = r.sync_status === 'confirmado'
        ? '<div class="conf"><i></i>Confirmado</div>'
        : '<div class="conf" style="color:var(--warn-fg)"><i style="background:var(--warn-m)"></i>na fila ↑</div>'
      return `<div class="ratmini" data-uuid="${esc(r.client_uuid)}">
        <div><div class="l">RAT</div><div class="s">${esc(ratSit(r.status))}</div></div>
        <div class="r">${conf}<div class="dt">${fdt(r.criado_em, { withTime: true })}</div></div>
      </div>`
    }).join('')
    box.querySelectorAll('.ratmini').forEach(el => el.onclick = () => abrirExistente(el.dataset.uuid))
    sec.style.display = 'block'
  }

  async function iniciarRatDaTarefa(t) {
    const tipoId = t.tipo_servico_id || ''
    const rat = await D().novoRat({ tarefa_id: t.id, tarefa_numero: t.numero || null, cliente_id: t.cliente_id || null, cliente_nome: cliNomeDe(t.cliente_id, null) })
    cur = { client_uuid: rat.client_uuid, campos: [], tarefa_id: t.id, tarefa_numero: t.numero }
    document.getElementById('form-titulo').textContent = 'Nova RAT'
    const tipoNome = (ref.tipos.find(x => x.id === tipoId) || {}).nome
    const banner = document.getElementById('f-tarefa-banner')
    banner.style.display = 'block'
    banner.textContent = `RAT da Tarefa Nº ${osNo(t.numero)} · ${cliNomeDe(t.cliente_id)}${tipoNome ? ' · ' + tipoNome : ''}`
    // cliente travado (vem da tarefa)
    document.getElementById('f-cliente').value = t.cliente_id || ''
    const cb = document.getElementById('f-cliente-busca')
    cb.value = cliNomeDe(t.cliente_id); cb.readOnly = true
    // tipo é SEMPRE da tarefa: o seletor nunca aparece na RAT
    document.getElementById('f-tipo').value = tipoId
    document.getElementById('f-tipo-wrap').style.display = 'none'
    document.getElementById('f-status').value = 'em_andamento'
    document.getElementById('f-pendencias').value = ''
    togglePendencias()
    document.getElementById('campos-container').innerHTML = ''
    mostrar('form')
    // carrega o formulário do tipo da tarefa (ou mostra aviso se a tarefa não tem tipo)
    const formId = (ref.tipos.find(x => x.id === tipoId) || {}).formulario_id || null
    await carregarFormularioPorId(formId)
    capturarGpsAuto()   // carimba o local automaticamente (se o GPS permitir)
  }
  // Captura o GPS do atendimento sem precisar de clique (só se ainda não houver).
  async function capturarGpsAuto() {
    if (!cur || !cur.client_uuid) return
    try {
      const r = await D().obterRat(cur.client_uuid)
      if (r && r.checkin_lat != null) return
      const pos = await getPos()
      if (!pos) return
      await D().salvarRat(cur.client_uuid, { checkin_lat: pos.lat, checkin_lng: pos.lng, checkin_precisao: pos.acc, checkin_em: new Date().toISOString() })
      refreshGpsRat()
    } catch (e) { /* sem permissão/sinal: usa o botão manual */ }
  }

  // ─────────────────────── Navegação (home + módulos) ───────────────────────
  let screen = 'home'
  const VIEWS = {
    home: 'view-home', lista: 'view-lista', form: 'view-form',
    tarefas: 'view-tarefas', 'tarefa-det': 'view-tarefa-det',
    'preorc-lista': 'view-preorc-lista', 'preorc-form': 'view-preorc-form',
    jornada: 'view-jornada', desloc: 'view-desloc',
  }
  const TITLES = {
    home: 'Service Report', lista: 'Minhas RATs', form: 'Nova RAT',
    tarefas: 'Minhas Tarefas', 'tarefa-det': 'Tarefa',
    'preorc-lista': 'Pré-Orçamento', 'preorc-form': 'Pré-Orçamento',
    jornada: 'Jornada do dia', desloc: 'Deslocamento',
  }
  // Telas que dependem de contexto em memória (some no reload) → guardamos o "pai".
  const SCREEN_PARENT = { 'tarefa-det': 'tarefas', 'form': 'tarefas', 'preorc-form': 'preorc-lista' }
  function mostrar(secao) {
    screen = secao
    for (const [k, id] of Object.entries(VIEWS)) {
      const el = document.getElementById(id); if (el) el.style.display = (k === secao) ? 'block' : 'none'
    }
    const t = document.getElementById('ft-title'); if (t) t.textContent = TITLES[secao] || 'Service Report'
    const b = document.getElementById('btn-voltar'); if (b) b.style.display = (secao === 'home') ? 'none' : 'block'
    try { sessionStorage.setItem('sr_tec_screen', SCREEN_PARENT[secao] || secao) } catch (e) { /* sem storage */ }
    if (secao === 'home') updateHomeResumo()
  }
  // Resumo do herói da home (apresentação) — lê dados já em memória/IndexedDB, sem novas chamadas Supabase.
  async function updateHomeResumo() {
    try {
      const d = new Date()
      const dataEl = document.getElementById('home-data')
      if (dataEl) dataEl.textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
      const temT = Array.isArray(tarefas) && tarefas.length
      set('home-st-tarefas', temT ? tarefas.length : '—')
      set('home-st-exec', temT ? tarefas.filter(t => t.status === 'em_execucao').length : '—')
      set('home-cnt-tarefas', temT ? tarefas.length : '')
      const rats = await D().listarRats()
      const PEND = [D().STATUS.SALVO_LOCAL, D().STATUS.NA_FILA, D().STATUS.ERRO]
      const fila = rats.filter(r => PEND.includes(r.sync_status)).length
        + (await D().tarefasLocaisPendentes()).length + (await D().deslocamentosPendentes()).length
      set('home-st-fila', fila)
      set('home-cnt-rats', rats.length || '')
    } catch (e) { /* presentacional */ }
  }
  // Sync trouxe mudanças do servidor (edição/exclusão) → re-renderiza a tela atual.
  window.onSyncChanged = () => {
    if (screen === 'desloc') renderDesloc()
    else if (screen === 'jornada') renderJornada()
    else if (screen === 'tarefas') renderTarefas()
    else if (screen === 'lista') renderLista()
    else if (screen === 'tarefa-det' && tarefaAberta) abrirTarefaDet(tarefaAberta.id)
  }
  // Terminou um ciclo de envio (tarefas/RATs subiram/sumiram) → atualiza a tela atual.
  window.onSyncDone = () => {
    if (screen === 'tarefas') renderTarefas()
    else if (screen === 'lista') renderLista()
  }
  function onVoltar() {
    if (screen === 'form') return cancelar()
    if (screen === 'preorc-form') return cancelarPreorc()
    if (screen === 'tarefa-det') return mostrar('tarefas')
    mostrar('home')
  }

  // ───────────────────── Jornada do dia (§10.1 dia contínuo) ─────────────────────
  const SEG_META = {
    trabalho: { ic: '🔧', lb: 'Trabalho' }, pausa: { ic: '⏸️', lb: 'Pausa' },
    almoco: { ic: '🍽️', lb: 'Almoço' }, deslocamento: { ic: '🚗', lb: 'Deslocamento' },
  }
  let segTipoSel = 'trabalho'
  let jorTick = null
  const jorHoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const segHHMM = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const segDur = (ini, fim) => { const a = new Date(ini).getTime(), b = (fim ? new Date(fim) : new Date()).getTime(); let m = Math.max(0, Math.round((b - a) / 60000)); const h = Math.floor(m / 60); return `${h}h ${String(m % 60).padStart(2, '0')}min` }

  function bindJornada() {
    document.getElementById('jor-voltar').onclick = () => mostrar('home')
    document.getElementById('seg-x').onclick = fecharSeg
    document.getElementById('seg-cancelar').onclick = fecharSeg
    document.getElementById('seg-confirmar').onclick = confirmarSeg
    document.querySelectorAll('#seg-tipos .seg-tipo').forEach(b => b.onclick = () => {
      segTipoSel = b.dataset.tipo
      document.querySelectorAll('#seg-tipos .seg-tipo').forEach(x => x.classList.toggle('on', x === b))
      document.getElementById('seg-trabalho').style.display = segTipoSel === 'trabalho' ? '' : 'none'
    })
    attachAutocomplete(document.getElementById('seg-cli-busca'), document.getElementById('seg-cli'), document.getElementById('seg-cli-list'), ref.clientes, c => ({ id: c.id, label: c.nome }))
    document.getElementById('seg-tiposerv').innerHTML = '<option value="">— selecione —</option>' + ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')
  }

  async function renderJornada() {
    const data = jorHoje()
    const segs = await D().listarSegmentos(data)
    const aberto = segs.find(s => !s.fim)
    const now = document.getElementById('jor-atual')
    const acoes = document.getElementById('jor-acoes')
    if (aberto) {
      const m = SEG_META[aberto.tipo] || {}
      const sub = aberto.tipo === 'trabalho' ? [cliNomeDe(aberto.cliente_id, ''), aberto.titulo].filter(Boolean).join(' · ') : ''
      now.innerHTML = `<div class="jor-now"><div class="jn-tp">${m.ic || ''} ${esc(m.lb || aberto.tipo)} · em andamento</div>
        ${(aberto.titulo && aberto.tipo === 'trabalho') ? `<div class="jn-tt">${esc(aberto.titulo)}</div>` : ''}
        <div class="jn-cron" id="jor-cron">${segDur(aberto.inicio)}</div>
        <div class="jn-sub">desde ${segHHMM(aberto.inicio)}${sub ? ` · ${esc(sub)}` : ''}</div></div>`
      acoes.innerHTML = `<button class="btn btn-primary" id="jor-trocar" style="flex:1">↻ Trocar atividade</button><button class="btn btn-ghost btn-auto" id="jor-encerrar">⏹ Encerrar dia</button>`
      document.getElementById('jor-trocar').onclick = () => abrirSeg('trocar')
      document.getElementById('jor-encerrar').onclick = encerrarDia
    } else {
      now.innerHTML = `<div class="jor-now idle">${segs.length ? 'Dia encerrado.' : 'Nenhuma atividade hoje.'}</div>`
      acoes.innerHTML = `<button class="btn btn-primary" id="jor-iniciar" style="flex:1">▶ ${segs.length ? 'Iniciar nova atividade' : 'Iniciar dia'}</button>`
      document.getElementById('jor-iniciar').onclick = () => abrirSeg('iniciar')
    }
    const tl = document.getElementById('jor-timeline')
    tl.innerHTML = !segs.length ? '<p class="dim" style="text-align:center;padding:16px">—</p>'
      : segs.slice().reverse().map(s => {
        const m = SEG_META[s.tipo] || {}
        const tt = s.tipo === 'trabalho' ? (s.titulo || 'Trabalho') : (m.lb || s.tipo)
        const sub = s.tipo === 'trabalho' ? cliNomeDe(s.cliente_id, '') : ''
        return `<div class="jor-seg${!s.fim ? ' aberto' : ''}"><span class="js-ic">${m.ic || ''}</span>
          <div class="js-main"><div class="js-tt">${esc(tt)}</div><div class="js-sub">${segHHMM(s.inicio)}–${s.fim ? segHHMM(s.fim) : 'agora'}${sub ? ` · ${esc(sub)}` : ''}</div></div>
          <div class="js-dur">${segDur(s.inicio, s.fim)}</div></div>`
      }).join('')
    if (jorTick) { clearInterval(jorTick); jorTick = null }
    if (aberto) jorTick = setInterval(() => { const el = document.getElementById('jor-cron'); if (el) el.textContent = segDur(aberto.inicio); else { clearInterval(jorTick); jorTick = null } }, 1000)
  }

  function abrirSeg(modo) {
    document.getElementById('seg-titulo').textContent = modo === 'trocar' ? 'Trocar atividade' : 'Nova atividade'
    document.getElementById('seg-hint').textContent = modo === 'trocar' ? 'A atividade atual fecha agora e a nova começa neste instante (sem buraco).' : ''
    segTipoSel = 'trabalho'
    document.querySelectorAll('#seg-tipos .seg-tipo').forEach(x => x.classList.toggle('on', x.dataset.tipo === 'trabalho'))
    document.getElementById('seg-trabalho').style.display = ''
    document.getElementById('seg-cli').value = ''; document.getElementById('seg-cli-busca').value = ''
    document.getElementById('seg-tiposerv').value = ''; document.getElementById('seg-titulo-in').value = ''
    document.getElementById('modal-seg').classList.add('open')
  }
  function fecharSeg() { document.getElementById('modal-seg').classList.remove('open') }

  async function confirmarSeg() {
    const data = jorHoje(), agora = new Date().toISOString(), tipo = segTipoSel
    let titulo = null, cliente_id = null, tipo_servico_id = null
    if (tipo === 'trabalho') {
      cliente_id = document.getElementById('seg-cli').value || null
      tipo_servico_id = document.getElementById('seg-tiposerv').value || null
      titulo = document.getElementById('seg-titulo-in').value.trim()
      if (!titulo) return toast('Dê um título à atividade.', 'err')
    }
    const aberto = await D().segmentoAberto(data)
    if (aberto) { aberto.fim = agora; await D().salvarSegmento(aberto) }
    await D().salvarSegmento({ tecnico_id: tecnico.id, data, tipo, titulo, cliente_id, tipo_servico_id, inicio: agora, fim: null })
    fecharSeg()
    await renderJornada()
    if (window.SyncEngine) SyncEngine.syncAll()
  }

  async function encerrarDia() {
    const aberto = await D().segmentoAberto(jorHoje())
    if (aberto) { aberto.fim = new Date().toISOString(); await D().salvarSegmento(aberto) }
    await renderJornada()
    if (window.SyncEngine) SyncEngine.syncAll()
    toast('Dia encerrado.', 'ok')
  }

  // ───────────────────── Deslocamento (pernoite) ─────────────────────
  const DL_SENT = { ida: 'Ida', volta: 'Volta', outro: 'Outro' }
  let dlSent = 'ida'
  let dlSaidaPos = null
  const nowLocal = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
  function getPos() {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null)
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
        () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
    })
  }
  async function marcarGpsRat() {
    if (!cur || !cur.client_uuid) return
    const btn = document.getElementById('f-gps-btn'), st = document.getElementById('f-gps-status'), old = btn.textContent
    btn.disabled = true; btn.textContent = 'Capturando GPS…'
    const pos = await getPos()
    btn.disabled = false; btn.textContent = old
    if (!pos) { st.textContent = 'Não foi possível obter o GPS (permita a localização no navegador).'; return }
    await D().salvarRat(cur.client_uuid, { checkin_lat: pos.lat, checkin_lng: pos.lng, checkin_precisao: pos.acc, checkin_em: new Date().toISOString() })
    st.innerHTML = `📍 Local marcado (±${pos.acc} m). <a href="https://www.google.com/maps?q=${pos.lat},${pos.lng}" target="_blank" rel="noopener">ver no mapa</a>`
  }
  async function refreshGpsRat() {
    const st = document.getElementById('f-gps-status'); if (!st || !cur || !cur.client_uuid) return
    const r = await D().obterRat(cur.client_uuid)
    if (r && r.checkin_lat != null) {
      st.innerHTML = `📍 Local marcado${r.checkin_precisao ? ` (±${r.checkin_precisao} m)` : ''}. <a href="https://www.google.com/maps?q=${r.checkin_lat},${r.checkin_lng}" target="_blank" rel="noopener">ver no mapa</a>`
    } else st.textContent = 'Opcional — registra onde o atendimento foi feito.'
  }
  // Geocodificação reversa: coordenadas → { cidade, uf }. Só online (Nominatim/OpenStreetMap, grátis).
  const UF_NOME = { 'Acre': 'AC', 'Alagoas': 'AL', 'Amapá': 'AP', 'Amazonas': 'AM', 'Bahia': 'BA', 'Ceará': 'CE', 'Distrito Federal': 'DF', 'Espírito Santo': 'ES', 'Goiás': 'GO', 'Maranhão': 'MA', 'Mato Grosso': 'MT', 'Mato Grosso do Sul': 'MS', 'Minas Gerais': 'MG', 'Pará': 'PA', 'Paraíba': 'PB', 'Paraná': 'PR', 'Pernambuco': 'PE', 'Piauí': 'PI', 'Rio de Janeiro': 'RJ', 'Rio Grande do Norte': 'RN', 'Rio Grande do Sul': 'RS', 'Rondônia': 'RO', 'Roraima': 'RR', 'Santa Catarina': 'SC', 'São Paulo': 'SP', 'Sergipe': 'SE', 'Tocantins': 'TO' }
  async function geoReverse(lat, lng) {
    if (lat == null || lng == null || !navigator.onLine) return null
    try {
      const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&accept-language=pt-BR`
      const r = await fetch(u, { headers: { Accept: 'application/json' } })
      if (!r.ok) return null
      const a = (await r.json()).address || {}
      const cidade = a.city || a.town || a.village || a.municipality || a.county || ''
      let uf = (a['ISO3166-2-lvl4'] || '').split('-')[1] || UF_NOME[a.state] || ''
      return { cidade, uf: (uf || '').toUpperCase() }
    } catch (e) { return null }
  }
  // Tenta extrair Cidade/UF do endereço-texto de um cliente. Cobre os dois formatos:
  //  • Omie:  "RUA X, 10, BAIRRO, SAO PAULO (SP), SP, 01311300"
  //  • CNPJ:  "Rua X, 10 · Bairro · São Paulo/SP · 01311-300"
  function cidadeUfDeEndereco(end) {
    const s = String(end || '')
    const par = s.match(/([A-Za-zÀ-ÿ0-9 .'-]+?)\s*\(([A-Za-z]{2})\)/)   // Cidade (UF)
    if (par) return { cidade: par[1].trim(), uf: par[2].toUpperCase() }
    for (const tok of s.split(/[·,]/)) {                                // Cidade/UF
      const m = tok.trim().match(/^(.+?)\/([A-Za-z]{2})$/)
      if (m) return { cidade: m[1].trim(), uf: m[2].toUpperCase() }
    }
    return null
  }
  function bindDesloc() {
    document.getElementById('desloc-novo').onclick = abrirDesloc
    document.getElementById('dl-x').onclick = fecharDesloc
    document.getElementById('dl-cancelar').onclick = fecharDesloc
    document.getElementById('dl-salvar').onclick = salvarDesloc
    document.querySelectorAll('#dl-sentido .seg-tipo').forEach(b => b.onclick = () => {
      dlSent = b.dataset.sent
      document.querySelectorAll('#dl-sentido .seg-tipo').forEach(x => x.classList.toggle('on', x === b))
      deslocAplicarSentido()
    })
    document.getElementById('dl-gps-saida').onclick = async () => {
      const btn = document.getElementById('dl-gps-saida'), old = btn.textContent
      btn.disabled = true; btn.textContent = 'Capturando GPS…'
      const pos = await getPos()
      btn.disabled = false; btn.textContent = old
      const st = document.getElementById('dl-gps-status')
      if (!pos) { st.textContent = 'Não foi possível obter o GPS (permita a localização no aparelho).'; return }
      dlSaidaPos = pos
      if (!document.getElementById('dl-saida').value) document.getElementById('dl-saida').value = nowLocal()
      st.textContent = `📍 Saída marcada (±${pos.acc} m). Buscando cidade…`
      const g = await geoReverse(pos.lat, pos.lng)
      if (g && (g.cidade || g.uf)) {
        const ci = document.getElementById('dl-origem-cidade'), uf = document.getElementById('dl-origem-uf')
        if (!ci.value && g.cidade) ci.value = g.cidade
        if (!uf.value && g.uf) uf.value = g.uf
        st.textContent = `📍 Saída marcada (±${pos.acc} m) · ${[g.cidade, g.uf].filter(Boolean).join('/')}`
      } else st.textContent = `📍 Saída marcada (±${pos.acc} m).`
    }
  }
  // Define cidade/UF de um lado (origem|destino) se ainda estiver vazio.
  function dlSetLocal(lado, cidade, uf) {
    const ci = document.getElementById('dl-' + lado + '-cidade'), u = document.getElementById('dl-' + lado + '-uf')
    if (ci && !ci.value && cidade) ci.value = cidade
    if (u && !u.value && uf) u.value = (uf || '').toUpperCase()
  }
  // Volta é sempre para a base (Traders): destino padrão = matriz.
  function deslocAplicarSentido() {
    if (dlSent === 'volta') dlSetLocal('destino', ref.base.cidade, ref.base.uf)
  }
  // Pré-preenche a partir do último trajeto do técnico:
  //  • último é IDA (ainda fora) → origem = destino dessa ida (onde ele está agora).
  //    Ex.: foi p/ Três Barras e não voltou → próxima saída parte de Três Barras.
  //  • último é Volta (voltou à base) ou sem histórico → origem em branco p/ o GPS
  //    (não assumimos a base).
  // A empresa do último trajeto é herdada (útil na volta).
  function deslocHerdaEmpresa(lst) {
    const meus = (lst || []).filter(d => (d.tecnicos || []).includes(tecnico.id) || d.criado_por === tecnico.id)
    const ult = meus[0]   // listarDeslocamentos já vem desc por saída
    if (!ult) return
    if (ult.sentido === 'ida' && (ult.destino_cidade || ult.destino_uf)) dlSetLocal('origem', ult.destino_cidade, ult.destino_uf)
    if (ult.cliente_id) {
      const cliEl = document.getElementById('dl-cli'), buscaEl = document.getElementById('dl-cli-busca')
      const c = ref.clientes.find(x => x.id === ult.cliente_id)
      if (cliEl && !cliEl.value && c) { cliEl.value = c.id; buscaEl.value = c.nome }
    }
  }
  async function abrirDesloc() {
    // (re)popula com os cadastros já carregados em ref — bindDesloc roda antes do carregarRef.
    // Ao escolher a empresa, puxa cidade/UF: na ida vai p/ o DESTINO (cliente);
    // na volta vai p/ a ORIGEM (de onde está voltando).
    attachAutocomplete(document.getElementById('dl-cli-busca'), document.getElementById('dl-cli'), document.getElementById('dl-cli-list'), ref.clientes, c => ({ id: c.id, label: c.nome }), (cli) => {
      const g = cli && cidadeUfDeEndereco(cli.endereco); if (!g) return
      dlSetLocal(dlSent === 'volta' ? 'origem' : 'destino', g.cidade, g.uf)
    })
    document.getElementById('dl-veiculo').innerHTML = '<option value="">— selecione —</option>' + ref.veiculos.map(v => `<option value="${esc(v.id)}">${esc((v.modelo || '') + ' (' + (v.placa || '') + ')')}</option>`).join('')
    document.getElementById('dl-tecs').innerHTML = ref.tecnicos.map(t => `<label><input type="checkbox" value="${esc(t.id)}"${t.id === tecnico.id ? ' checked' : ''}> ${esc(tcase(t.nome))}</label>`).join('')
    dlSent = 'ida'; dlSaidaPos = null
    document.querySelectorAll('#dl-sentido .seg-tipo').forEach(x => x.classList.toggle('on', x.dataset.sent === 'ida'))
    ;['dl-cli', 'dl-cli-busca', 'dl-origem-cidade', 'dl-origem-uf', 'dl-destino-cidade', 'dl-destino-uf', 'dl-saida', 'dl-chegada', 'dl-motivo'].forEach(id => { const e = document.getElementById(id); if (e) e.value = '' })
    document.getElementById('dl-veiculo').value = ''
    document.getElementById('dl-gps-status').textContent = ''
    deslocHerdaEmpresa(await D().listarDeslocamentos())
    document.querySelectorAll('#dl-tecs input').forEach(c => { c.checked = (c.value === tecnico.id) })
    document.getElementById('modal-desloc').classList.add('open')
  }
  function fecharDesloc() { document.getElementById('modal-desloc').classList.remove('open') }
  const dlISO = (v) => v ? new Date(v).toISOString() : null

  async function salvarDesloc() {
    const tecs = [...document.querySelectorAll('#dl-tecs input:checked')].map(c => c.value)
    const saida = dlISO(document.getElementById('dl-saida').value)
    if (!saida) return toast('Informe a data/hora de saída.', 'err')
    if (!tecs.length) return toast('Marque ao menos um técnico a bordo.', 'err')
    const oCid = document.getElementById('dl-origem-cidade').value.trim(), oUf = document.getElementById('dl-origem-uf').value.trim().toUpperCase()
    const dCid = document.getElementById('dl-destino-cidade').value.trim(), dUf = document.getElementById('dl-destino-uf').value.trim().toUpperCase()
    const compoe = (c, u) => [c, u].filter(Boolean).join('/') || null
    await D().salvarDeslocamento({
      sentido: dlSent, veiculo_id: document.getElementById('dl-veiculo').value || null,
      cliente_id: document.getElementById('dl-cli').value || null,
      origem_cidade: oCid || null, origem_uf: oUf || null, destino_cidade: dCid || null, destino_uf: dUf || null,
      origem: compoe(oCid, oUf), destino: compoe(dCid, dUf),
      saida_em: saida, chegada_em: dlISO(document.getElementById('dl-chegada').value),
      motivo: document.getElementById('dl-motivo').value.trim() || null,
      saida_lat: dlSaidaPos ? dlSaidaPos.lat : null, saida_lng: dlSaidaPos ? dlSaidaPos.lng : null, saida_precisao: dlSaidaPos ? dlSaidaPos.acc : null,
      tecnicos: tecs, criado_por: tecnico.id,
    })
    fecharDesloc()
    toast('Trajeto registrado.', 'ok')
    await renderDesloc()
    if (window.SyncEngine) SyncEngine.syncAll()
  }

  async function renderDesloc() {
    const box = document.getElementById('desloc-lista')
    if (window.SyncEngine) SyncEngine.pullChanges()   // reconcilia c/ servidor (edições/exclusões); re-renderiza via onSyncChanged
    const lst = await D().listarDeslocamentos()   // offline-first (este aparelho)
    if (!lst.length) { box.innerHTML = '<div class="prod-empty" style="padding:24px 0;text-align:center;color:var(--t-muted)">Nenhum trajeto ainda. Toque em <b>+ Novo trajeto</b>.</div>'; return }
    const veicLbl = (id) => { const v = ref.veiculos.find(x => x.id === id); return v ? `${v.modelo || ''} (${v.placa || ''})` : '—' }
    const dt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
    const SK = { ida: 'info', volta: 'done', outro: 'aguard' }
    box.innerHTML = lst.map(d => {
      const nomes = (d.tecnicos || []).map(id => tcase((ref.tecnicos.find(t => t.id === id) || {}).nome)).filter(Boolean).join(', ')
      const sk = SK[d.sentido] || 'aguard'
      const fila = d.sync_status !== 'confirmado' ? '<span class="badge b-warn">na fila ↑</span>' : ''
      return `<div class="listcard lc-${sk === 'info' ? 'info' : sk === 'done' ? 'done' : ''}"><span class="edge e-${sk}"></span>
        <div class="t"><span class="cli">${esc(cliNomeDe(d.cliente_id, '—'))}</span><span style="display:flex;gap:6px;align-items:center">${fila}<span class="badge b-${sk}">${esc(DL_SENT[d.sentido] || d.sentido)}</span></span></div>
        <div class="meta">${esc(d.origem || '—')} → ${esc(d.destino || '—')} · ${esc(veicLbl(d.veiculo_id))}</div>
        <div class="meta">Saída <b>${dt(d.saida_em)}</b>${d.saida_lat ? ' 📍' : ''}${d.chegada_em ? ` · Chegada <b>${dt(d.chegada_em)}</b>${d.chegada_lat ? ' 📍' : ''}` : ''}</div>
        <div class="meta">A bordo: ${esc(nomes || '—')}</div>
        ${!d.chegada_em ? `<button class="btn btn-ok btn-auto" data-chegada="${esc(d.id)}" style="margin-top:8px;font-size:13px;padding:9px 13px">📍 Marcar chegada agora</button>` : ''}
      </div>`
    }).join('')
    box.querySelectorAll('[data-chegada]').forEach(b => b.onclick = (e) => { e.stopPropagation(); marcarChegada(b.dataset.chegada) })
  }

  async function marcarChegada(id) {
    const d = (await D().listarDeslocamentos()).find(x => x.id === id)
    if (!d) return
    const btn = document.querySelector(`[data-chegada="${CSS.escape(id)}"]`); if (btn) { btn.disabled = true; btn.textContent = 'Capturando GPS…' }
    const pos = await getPos()
    d.chegada_em = new Date().toISOString()
    if (pos) {
      d.chegada_lat = pos.lat; d.chegada_lng = pos.lng; d.chegada_precisao = pos.acc
      const g = await geoReverse(pos.lat, pos.lng)
      if (g) {
        if (!d.destino_cidade && g.cidade) d.destino_cidade = g.cidade
        if (!d.destino_uf && g.uf) d.destino_uf = g.uf
        d.destino = [d.destino_cidade, d.destino_uf].filter(Boolean).join('/') || d.destino || null
      }
    }
    await D().salvarDeslocamento(d)
    toast('Chegada marcada' + (pos ? ` (GPS ±${pos.acc} m)` : ' (sem GPS)') + '.', 'ok')
    await renderDesloc()
    if (window.SyncEngine) SyncEngine.syncAll()
  }

  async function abrirExistente(client_uuid) {
    const rat = await D().obterRat(client_uuid)
    if (!rat) return
    cur = { client_uuid, campos: [], tarefa_id: rat.tarefa_id || null, tarefa_numero: rat.tarefa_numero || null }
    document.getElementById('form-titulo').textContent = 'Editar RAT'
    const banner = document.getElementById('f-tarefa-banner')
    const cb = document.getElementById('f-cliente-busca')
    // tipo é da Tarefa (não da RAT): busca pelo vínculo da tarefa, só para exibir
    const tarefaDela = tarefas.find(x => x.id === rat.tarefa_id)
    const tipoNomeR = (ref.tipos.find(x => x.id === (tarefaDela ? tarefaDela.tipo_servico_id : null)) || {}).nome
    const numR = (tarefaDela && tarefaDela.numero != null) ? tarefaDela.numero : rat.tarefa_numero
    const subR = (rat.rat_seq != null) ? '/' + String(rat.rat_seq).padStart(2, '0') : ''
    if (rat.tarefa_id) {
      banner.style.display = 'block'
      banner.textContent = `RAT da Tarefa ${numR != null ? 'Nº ' + osNo(numR) + subR : '(na fila ↑)'} · ${cliNomeDe(rat.cliente_id, rat.cliente_nome)}${tipoNomeR ? ' · ' + tipoNomeR : ''}`
      cb.readOnly = true
    } else { banner.style.display = 'none'; cb.readOnly = false }
    document.getElementById('f-cliente').value = rat.cliente_id || ''
    cb.value = (ref.clientes.find(c => c.id === rat.cliente_id) || {}).nome || rat.cliente_nome || ''
    document.getElementById('f-tipo-wrap').style.display = 'none'
    document.getElementById('f-status').value = RAT_SIT_LABEL[rat.status] ? rat.status : 'em_andamento'
    document.getElementById('f-pendencias').value = rat.pendencias || ''
    togglePendencias()
    // carrega o formulário que a RAT respondeu (snapshot), independente do tipo
    await carregarFormularioPorId(rat.formulario_id || (tarefaDela && ref.tipos.find(x => x.id === tarefaDela.tipo_servico_id)?.formulario_id) || null)
    // repopula respostas
    if (rat.respostas) {
      for (const c of cur.campos) {
        const v = rat.respostas[c.id]
        if (v == null) continue
        if (c.tipo === 'tecnicos') {
          const sel = new Set(String(v).split(',').map(s => s.trim()))
          document.querySelectorAll(`[data-multi="${CSS.escape(c.id)}"]`).forEach(chk => { chk.checked = sel.has(chk.value) })
        } else {
          const el = document.querySelector(`[data-campo="${CSS.escape(c.id)}"]`)
          if (el) el.value = v
        }
      }
    }
    atualizarTempo()
    aplicarCondicionais()
    montarTimerAtendimento()   // re-render: reflete as horas repopuladas
    mostrar('form')
  }

  // Tipo de serviço é da TAREFA; a RAT só guarda qual formulário respondeu (formulario_id).
  async function onTipoChange() {
    const tipo = ref.tipos.find(t => t.id === document.getElementById('f-tipo').value)
    await carregarFormularioPorId(tipo ? tipo.formulario_id : null)
  }
  async function carregarFormularioPorId(formId) {
    const cont = document.getElementById('campos-container')
    const fb = document.getElementById('form-fotos-btn'); if (fb) fb.style.display = 'none'  // só aparece se houver campo de foto
    cur.campos = []
    cur.formulario_id = formId || null
    const form = formId ? ref.formularios[formId] : null
    if (!form) { cont.innerHTML = formId ? '<p class="dim">Formulário não encontrado.</p>' : '<p class="dim">Esta tarefa não tem tipo de serviço/formulário configurado — peça ao administrativo.</p>'; return }
    cur.campos = form.campos || []
    cont.innerHTML = ''
    for (const c of cur.campos) cont.appendChild(renderCampo(c))
    const sc = cont.querySelector('canvas.sig-pad')
    if (sc) { sig = initSignature(sc); sig.resize() }
    const onFormChange = (e) => { aplicarEspelhos(e); atualizarTempo(); aplicarCondicionais(); const w = e.target.closest && e.target.closest('[data-field]'); if (w) w.classList.remove('campo-erro'); agendarAutosave() }
    cont.oninput = onFormChange
    cont.onchange = onFormChange
    atualizarTempo()
    aplicarCondicionais()
    montarTimerAtendimento()
    await refreshThumbs()
    await refreshGpsRat()
  }

  // ── Timer de atendimento: Iniciar/Encerrar preenche hora_inicio/hora_termino ──
  // Só aparece quando o formulário tem esses campos (ids estáveis usados no calcTempo).
  // O técnico continua podendo editar as horas manualmente nos campos.
  let atdTick = null
  let atdRender = null   // listener anterior — removido a cada montagem (evita acúmulo entre RATs)
  function montarTimerAtendimento() {
    const old = document.getElementById('atd-timer'); if (old) old.remove()
    if (atdTick) { clearInterval(atdTick); atdTick = null }
    const cont = document.getElementById('campos-container')
    if (atdRender) { cont.removeEventListener('change', atdRender); atdRender = null }
    const $ini = () => cont.querySelector('[data-campo="hora_inicio"]')
    const $fim = () => cont.querySelector('[data-campo="hora_termino"]')
    if (!$ini() || !$fim()) return
    const bar = document.createElement('div')
    bar.id = 'atd-timer'; bar.className = 'atd-timer'
    cont.parentNode.insertBefore(bar, cont)
    const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
    const decorrido = (ini) => {
      const [h, m] = String(ini).split(':').map(Number)
      if (isNaN(h) || isNaN(m)) return ''
      const d = new Date(); let t = (d.getHours() * 60 + d.getMinutes()) - (h * 60 + m)
      if (t < 0) t += 1440
      return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
    }
    const disparar = (el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
    function render() {
      const bar2 = document.getElementById('atd-timer'); if (!bar2) return
      const vi = ($ini() || {}).value || '', vf = ($fim() || {}).value || ''
      if (!vi) {
        bar2.className = 'atd-timer'
        bar2.innerHTML = '<div class="tt">Atendimento ainda não iniciado</div><button type="button" class="go">▶ Iniciar atendimento</button>'
        bar2.querySelector('.go').onclick = () => { const el = $ini(); if (!el) return; el.value = hhmm(); disparar(el); capturarGpsAuto(); render() }
      } else if (!vf) {
        bar2.className = 'atd-timer run'
        bar2.innerHTML = `<div class="tt">Em atendimento desde <b>${esc(vi)}</b> · <span class="el">${decorrido(vi)}</span></div><button type="button" class="stop">⏹ Encerrar</button>`
        bar2.querySelector('.stop').onclick = () => { const el = $fim(); if (!el) return; el.value = hhmm(); disparar(el); render() }
      } else {
        bar2.className = 'atd-timer'
        bar2.innerHTML = `<div class="tt">Atendimento <b>${esc(vi)}</b> – <b>${esc(vf)}</b> · <span class="el">${fmtMin(calcTempo())}</span> trabalhado</div>`
      }
    }
    render()
    atdRender = render
    cont.addEventListener('change', render)
    atdTick = setInterval(() => { if (!document.getElementById('atd-timer')) { clearInterval(atdTick); atdTick = null; return } render() }, 30000)
  }

  // ── Espelho: um campo copia o valor de outro quando este muda ──
  // (ex.: "Hora de Início (execução)" = "Deslocamento final - Ida")
  function aplicarEspelhos(e) {
    if (!cur || !cur.campos) return
    const src = (e && e.target && e.target.getAttribute) ? e.target.getAttribute('data-campo') : null
    if (!src) return
    for (const c of cur.campos) {
      if (c.espelha !== src) continue
      const tgt = document.querySelector(`#campos-container [data-campo="${CSS.escape(c.id)}"]`)
      const srcEl = document.querySelector(`#campos-container [data-campo="${CSS.escape(src)}"]`)
      if (tgt && srcEl) tgt.value = srcEl.value
    }
  }

  // ── Condicionais (E/OU): mostra/esconde campos conforme as respostas ──
  function valorCampo(id) {
    const c = (cur.campos || []).find(x => x.id === id)
    if (!c) return ''
    if (c.tipo === 'tecnicos') return Array.from(document.querySelectorAll(`[data-multi="${CSS.escape(id)}"]:checked`)).map(x => x.value).join(', ')
    const el = document.querySelector(`#campos-container [data-campo="${CSS.escape(id)}"]`)
    return el ? String(el.value || '').trim() : ''
  }
  function avaliarCond(c, visivel) {
    const cond = c.cond
    if (!cond || !cond.regras || !cond.regras.length) return true
    const res = cond.regras.map(rg => {
      const val = (visivel[rg.campo] === false) ? '' : valorCampo(rg.campo)   // ref oculto = vazio
      const alvo = String(rg.valor == null ? '' : rg.valor)
      switch (rg.op) {
        case 'igual': return val === alvo
        case 'diferente': return val !== alvo
        case 'contem': return val.toLowerCase().includes(alvo.toLowerCase())
        case 'preenchido': return val.trim() !== ''
        case 'vazio': return val.trim() === ''
        default: return true
      }
    })
    return cond.logica === 'OU' ? res.some(Boolean) : res.every(Boolean)
  }
  function aplicarCondicionais() {
    if (!cur || !cur.campos) return
    const visivel = {}
    cur.campos.forEach(c => { visivel[c.id] = true })
    // ponto-fixo (uma condição pode depender de outro campo condicional)
    for (let pass = 0; pass <= cur.campos.length; pass++) {
      let changed = false
      for (const c of cur.campos) {
        const v = avaliarCond(c, visivel)
        if (v !== visivel[c.id]) { visivel[c.id] = v; changed = true }
      }
      if (!changed) break
    }
    cur.campos.forEach(c => {
      const w = document.querySelector(`#campos-container [data-field="${CSS.escape(c.id)}"]`)
      if (w) w.style.display = visivel[c.id] ? '' : 'none'
    })
    curVisivel = visivel
  }

  function renderCampo(c) {
    const wrap = document.createElement('div')
    wrap.className = 'fg campo'
    wrap.dataset.field = c.id
    const req = c.obrigatorio ? ' <span style="color:var(--re)">*</span>' : ''
    const label = `<label>${esc(c.label)}${req}</label>`

    if (c.tipo === 'texto') {
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto"/>`
    } else if (c.tipo === 'texto_longo') {
      wrap.innerHTML = `${label}<textarea class="ta-longo" data-campo="${esc(c.id)}" data-tipo="texto_longo" placeholder="…"></textarea>
        <button type="button" class="ia-btn">✨ Melhorar escrita</button>`
      setTimeout(() => { const b = wrap.querySelector('.ia-btn'); if (b) b.onclick = () => melhorarTexto(c.id, b) }, 0)
    } else if (c.tipo === 'data') {
      const hoje = new Date().toISOString().slice(0, 10)
      wrap.innerHTML = `${label}<input type="date" value="${hoje}" data-campo="${esc(c.id)}" data-tipo="data"/>`
    } else if (c.tipo === 'hora') {
      wrap.innerHTML = `${label}<input type="time" data-campo="${esc(c.id)}" data-tipo="hora"/>`
    } else if (c.tipo === 'numero') {
      wrap.innerHTML = `${label}<input type="number" inputmode="decimal" data-campo="${esc(c.id)}" data-tipo="numero"/>`
    } else if (c.tipo === 'selecao') {
      const ops = (c.opcoes || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="selecao"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'tecnico') {
      const ops = (ref.tecnicos || []).map(t => { const n = tcase(t.nome); return `<option value="${esc(n)}"${n === tcase(tecnico.nome) ? ' selected' : ''}>${esc(n)}</option>` }).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="tecnico"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'tecnicos') {
      const checks = (ref.tecnicos || []).map(t => { const n = tcase(t.nome); return `<label><input type="checkbox" data-multi="${esc(c.id)}" value="${esc(n)}"> ${esc(n)}</label>` }).join('')
      wrap.innerHTML = `${label}<div class="multi-chk">${checks || '<span class="dim">Nenhum técnico cadastrado</span>'}</div>`
    } else if (c.tipo === 'veiculo') {
      const ops = (ref.veiculos || []).map(v => { const lbl = `${v.modelo || ''} (${v.placa || ''})`; return `<option value="${esc(lbl)}">${esc(lbl)}</option>` }).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="veiculo"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'produtos') {
      // Produtos têm o botão próprio no topo do formulário ("🧰 Produtos"); o campo só dispara a pré-carga dos levados.
      wrap.className = ''
      wrap.innerHTML = ''
      setTimeout(() => { precarregarLevados() }, 0)
    } else if (c.tipo === 'foto') {
      // Fotos têm botão próprio no topo ("Fotos") que abre o modal fullscreen; o campo só revela o botão.
      wrap.className = ''
      wrap.innerHTML = ''
      setTimeout(() => {
        const b = document.getElementById('form-fotos-btn'); if (b) b.style.display = ''
        refreshThumbs(); atualizarResumoFotos()
      }, 0)
    } else if (c.tipo === 'assinatura') {
      wrap.innerHTML = `${label}
        <div class="sig-wrap">
          <canvas class="sig-pad"></canvas>
          <button type="button" class="sig-clear" id="btn-sig-limpar">Limpar</button>
        </div>`
      setTimeout(() => { wrap.querySelector('#btn-sig-limpar').onclick = () => sig && sig.clear() }, 0)
    } else {
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto"/>`
    }
    return wrap
  }

  // ── ✨ Melhorar escrita (IA): reescreve o texto do técnico em PT correto ──
  // O texto vai à edge function melhorar-texto (Claude Haiku); volta numa PRÉVIA
  // antes/depois e o técnico decide usar ou manter o original. Exige internet.
  async function melhorarTexto(campoId, btn) {
    const ta = document.querySelector(`[data-campo="${CSS.escape(campoId)}"]`)
    if (!ta) return
    const texto = (ta.value || '').trim()
    if (!texto) return toast('Escreva o texto primeiro — a IA só ajusta o que você escreveu.', 'err')
    if (!navigator.onLine) return toast('Melhorar escrita precisa de internet.', 'err')
    btn.disabled = true
    const old = btn.textContent
    btn.textContent = '✨ Melhorando…'
    try {
      const { data, error } = await getSupabase().functions.invoke('melhorar-texto', { body: { texto } })
      if (error) throw new Error(error.message || 'falha na chamada')
      if (data && data.error) throw new Error(data.error)
      const novo = ((data && data.texto) || '').trim()
      if (!novo) throw new Error('a IA não retornou texto')
      abrirPreviaIA(texto, novo, (aceitou) => {
        if (aceitou) {
          ta.value = novo
          ta.dispatchEvent(new Event('input', { bubbles: true }))   // autosave + condicionais
          toast('Texto atualizado.', 'ok')
        }
      })
    } catch (e) {
      toast('Não consegui melhorar agora: ' + (e.message || e), 'err')
    } finally {
      btn.disabled = false
      btn.textContent = old
    }
  }
  function abrirPreviaIA(antes, depois, cb) {
    const m = document.getElementById('modal-ia')
    if (!m) return cb(true)
    document.getElementById('ia-antes').textContent = antes
    document.getElementById('ia-depois').textContent = depois
    m.classList.add('open')
    const fechar = (ok) => { m.classList.remove('open'); cb(ok) }
    document.getElementById('ia-usar').onclick = () => fechar(true)
    document.getElementById('ia-manter').onclick = () => fechar(false)
    document.getElementById('ia-x').onclick = () => fechar(false)
  }

  // ─────────────────────────── Fotos ───────────────────────────
  // Comprime/redimensiona a foto antes de salvar (sobe rápido no 4G; mantém qualidade boa).
  function comprimirFoto(file) {
    return new Promise((resolve) => {
      if (!file || !file.type || !file.type.startsWith('image/')) return resolve(file)
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        const MAX = 1600
        let w = img.naturalWidth, h = img.naturalHeight
        if (w > MAX || h > MAX) { const r = Math.min(MAX / w, MAX / h); w = Math.round(w * r); h = Math.round(h * r) }
        try {
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h
          cv.getContext('2d').drawImage(img, 0, 0, w, h)
          cv.toBlob(b => resolve(b && b.size < file.size ? b : file), 'image/jpeg', 0.72)
        } catch (e) { resolve(file) }
      }
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
      img.src = url
    })
  }
  async function adicionarFotos(fileList) {
    const files = Array.from(fileList || [])
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      const blob = await comprimirFoto(f)
      await D().adicionarFoto(cur.client_uuid, blob, null)   // legenda preenchida depois, por foto
    }
    await refreshThumbs()
  }
  async function refreshThumbs() {
    const box = document.getElementById('thumbs')
    if (!box) return
    const fotos = await D().listarFotos(cur.client_uuid)
    box.innerHTML = fotos.map(f => {
      const src = f.url || URL.createObjectURL(f.blob)
      return `<div class="thumb-card">
        <div class="thumb"><img src="${src}" alt=""><button type="button" class="thumb-x" data-id="${esc(f.id)}">×</button></div>
        <input type="text" class="thumb-leg" data-legid="${esc(f.id)}" placeholder="Legenda" value="${esc(f.legenda || '')}">
      </div>`
    }).join('')
    box.querySelectorAll('.thumb-x').forEach(b => {
      b.onclick = async (e) => { e.stopPropagation(); await D().removerFoto(b.dataset.id); await refreshThumbs() }
    })
    box.querySelectorAll('.thumb-leg').forEach(inp => {
      inp.onchange = () => D().atualizarLegendaFoto(inp.dataset.legid, inp.value.trim())
    })
    atualizarResumoFotos()
  }
  function abrirModalFotos() { if (!cur) return; document.getElementById('modal-fotos').classList.add('open'); refreshThumbs() }
  function fecharModalFotos() { document.getElementById('modal-fotos').classList.remove('open'); atualizarResumoFotos() }
  async function atualizarResumoFotos() {
    const b = document.getElementById('form-fotos-btn'); if (!b || !cur) return
    const n = (await D().listarFotos(cur.client_uuid)).length
    b.textContent = n ? `Fotos (${n})` : 'Fotos'
  }

  // ── Produtos (materiais, origem 'usado') — janela separada, abas Comigo / Adicionados ──
  function abrirModalProd() {
    if (!cur) return
    prodTab = 'comigo'
    document.querySelectorAll('#modal-prod .prod-tab').forEach(x => x.classList.toggle('on', x.dataset.tab === 'comigo'))
    document.getElementById('prod-busca').value = ''
    document.getElementById('modal-prod').classList.add('open')
    refreshMateriais()
  }
  function fecharModalProd() { document.getElementById('modal-prod').classList.remove('open'); atualizarResumoProd() }
  async function atualizarResumoProd() {
    const el = document.getElementById('prod-resumo'); if (!el || !cur) return
    const mats = await D().listarMateriais(cur.client_uuid)
    const usados = mats.filter(m => (Number(m.quantidade) || 0) > 0)
    const total = usados.reduce((s, m) => s + (Number(m.quantidade) || 0), 0)
    el.textContent = usados.length ? `${usados.length} item(ns) · ${total.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}` : 'nenhum'
  }
  async function adicionarAvulsoUI() {
    const desc = (document.getElementById('prod-busca').value || '').trim() || prompt('Descrição do item avulso:')
    if (!desc) return
    await D().adicionarMaterial(cur.client_uuid, { produto_id: null, codigo_produto: null, descricao: desc, unidade: null, quantidade: 0 })
    document.getElementById('prod-busca').value = ''
    prodTab = 'add'
    document.querySelectorAll('.prod-tab').forEach(x => x.classList.toggle('on', x.dataset.tab === 'add'))
    await refreshMateriais()
  }
  // Traz os produtos LEVADOS da tarefa para a RAT (qtd utilizada = 0), sem o técnico redigitar.
  async function precarregarLevados() {
    if (!cur || !cur.tarefa_id || !navigator.onLine) return
    try {
      const { data } = await getSupabase().from('vw_tarefa_materiais_tecnico')
        .select('produto_id,codigo_produto,descricao,unidade,qtd_levada').eq('tarefa_id', cur.tarefa_id)
      if (!data || !data.length) return
      const existentes = await D().listarMateriais(cur.client_uuid)
      const chave = (x) => `${x.produto_id || ''}|${x.codigo_produto || ''}|${(x.descricao || '').trim().toLowerCase()}`
      const have = new Set(existentes.map(chave))
      for (const m of data) {
        if (!(Number(m.qtd_levada) > 0)) continue   // só os efetivamente levados
        if (have.has(chave(m))) continue
        await D().adicionarMaterial(cur.client_uuid, {
          produto_id: m.produto_id, codigo_produto: m.codigo_produto, descricao: m.descricao,
          unidade: m.unidade, quantidade: 0, qtd_levada: m.qtd_levada,
        })
      }
    } catch (e) { /* offline/sem view: técnico adiciona na mão */ }
  }
  async function refreshMateriais() {
    const box = document.getElementById('prod-list'); if (!box) return
    const mats = await D().listarMateriais(cur.client_uuid)
    const busca = document.getElementById('prod-busca')
    const q = normStr(busca ? busca.value : '')
    const bate = (nome, cod) => !q || normStr(nome || '').includes(q) || normStr(cod || '').includes(q)
    const un = (m) => m.unidade ? ' ' + esc(m.unidade) : ''
    // linha de material (Adicionados/Comigo): qtd utilizada editável
    const rowMat = (m) => `<div class="prod-row">
        <div class="pr-main"><div class="pr-desc">${esc(m.descricao || m.codigo_produto || '—')}</div>
          ${m.qtd_levada != null ? `<div class="pr-sub">Levado: ${m.qtd_levada}${un(m)}</div>` : (m.codigo_produto ? `<div class="pr-sub">${esc(m.codigo_produto)}</div>` : '')}</div>
        <input type="number" class="pr-qtd" data-mid="${esc(m.id)}" inputmode="decimal" min="0" step="any" value="${m.quantidade || 0}">
        <button type="button" class="pr-x" data-mid="${esc(m.id)}">×</button>
      </div>`
    let lst
    if (prodTab === 'comigo') {
      // Todos os produtos levados para a tarefa; o técnico lança a quantidade utilizada aqui.
      lst = mats.filter(m => (Number(m.qtd_levada) || 0) > 0 && bate(m.descricao, m.codigo_produto))
      box.innerHTML = lst.length ? lst.map(rowMat).join('') : '<div class="prod-empty">Nenhum produto levado para esta tarefa.</div>'
    } else { // adicionados = o que será reportado: usados (qtd>0) + itens fora dos levados (avulsos)
      lst = mats.filter(m => ((Number(m.quantidade) || 0) > 0 || (Number(m.qtd_levada) || 0) <= 0) && bate(m.descricao, m.codigo_produto))
      box.innerHTML = lst.length ? lst.map(rowMat).join('') : '<div class="prod-empty">Nada utilizado ainda. Lance a quantidade na aba <b>Comigo</b> ou use <b>+ Item fora dos levados</b>.</div>'
    }
    box.querySelectorAll('.pr-qtd').forEach(inp => { inp.onchange = async () => { await D().atualizarMaterial(inp.dataset.mid, { quantidade: inp.value }); await refreshMateriais() } })
    box.querySelectorAll('.pr-x').forEach(b => { b.onclick = async () => { await D().removerMaterial(b.dataset.mid); await refreshMateriais() } })
    atualizarTotalProd(mats)
    atualizarResumoProd()
  }
  async function atualizarTotalProd(mats) {
    const el = document.getElementById('prod-total'); if (!el) return
    const arr = mats || await D().listarMateriais(cur.client_uuid)
    const total = arr.reduce((s, m) => s + (Number(m.quantidade) || 0), 0)
    el.textContent = total ? total.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '--'
  }

  // ───────────────────── Assinatura (canvas) ─────────────────────
  function initSignature(canvas) {
    const ctx = canvas.getContext('2d')
    let drawing = false, dirty = false
    function resize() {
      const r = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, r.width * dpr)
      canvas.height = Math.max(1, r.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1B2A4A'
    }
    function pt(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    canvas.addEventListener('pointerdown', e => { drawing = true; const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.setPointerCapture(e.pointerId); e.preventDefault() })
    canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); dirty = true; e.preventDefault() })
    canvas.addEventListener('pointerup', () => { drawing = false })
    return {
      resize,
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false },
      isEmpty() { return !dirty },
      dataURL() { return canvas.toDataURL('image/png') },
    }
  }

  // ─────────────────────────── Salvar ───────────────────────────
  // Tempo trabalhado: Sim → (final retorno − inicial ida); Não → (término − início);
  // sempre menos almoço e pausa (min). Resultado em minutos (>= 0).
  const minutosDe = (hhmm) => {
    if (!hhmm) return null
    const [h, m] = String(hhmm).split(':').map(Number)
    if (isNaN(h) || isNaN(m)) return null
    return h * 60 + m
  }
  // Cálculo puro a partir das respostas (compartilhado com o back-office).
  // Janela: deslocamento Sim → ida→retorno; senão → execução. Desconta almoço e pausa.
  function calcTempoDe(resp) {
    const dur = (ini, fim) => { const a = minutosDe(ini), b = minutosDe(fim); return (a == null || b == null) ? 0 : Math.max(0, b - a) }
    let ini, fim
    if (resp.deslocamento === 'Sim') { ini = resp.desloc_inicial_ida; fim = resp.desloc_final_retorno }
    else { ini = resp.hora_inicio; fim = resp.hora_termino }
    const a = minutosDe(ini), b = minutosDe(fim)
    if (a == null || b == null) return null
    const t = (b - a) - dur(resp.almoco_inicio, resp.almoco_termino) - dur(resp.pausa_inicio, resp.pausa_termino)
    return t < 0 ? 0 : t
  }
  function calcTempo() {
    const val = (id) => { const el = document.querySelector(`[data-campo="${CSS.escape(id)}"]`); return el ? el.value : '' }
    return calcTempoDe({
      deslocamento: val('deslocamento'),
      desloc_inicial_ida: val('desloc_inicial_ida'), desloc_final_retorno: val('desloc_final_retorno'),
      hora_inicio: val('hora_inicio'), hora_termino: val('hora_termino'),
      almoco_inicio: val('almoco_inicio'), almoco_termino: val('almoco_termino'),
      pausa_inicio: val('pausa_inicio'), pausa_termino: val('pausa_termino'),
    })
  }
  const fmtMin = (t) => t == null ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  function atualizarTempo() {
    const el = document.getElementById('f-tempo'); if (el) { const v = fmtMin(calcTempo()); if ('value' in el && el.tagName === 'INPUT') el.value = v; else el.textContent = v }
  }

  // ── Autosave: preserva o que foi digitado no rascunho local, a cada alteração ──
  // Só age sobre RASCUNHO (não altera RAT já salva/enviada sem um Salvar explícito).
  // respostas vazio grava null para manter a regra de "rascunho vazio" do descarte.
  let autosaveT = null
  function agendarAutosave() {
    if (!cur || !cur.client_uuid) return
    clearTimeout(autosaveT)
    autosaveT = setTimeout(async () => {
      try {
        if (!cur || !cur.client_uuid) return
        const r = await D().obterRat(cur.client_uuid)
        if (!r || r.sync_status !== D().STATUS.RASCUNHO) return
        const { respostas } = coletarRespostas()
        await D().salvarRat(cur.client_uuid, {
          respostas: Object.keys(respostas).length ? respostas : null,
          tempo_trabalhado: calcTempo(),
        })
      } catch (e) { /* autosave é melhor-esforço */ }
    }, 700)
  }

  function coletarRespostas() {
    const respostas = {}
    const faltando = [], faltandoIds = []
    for (const c of cur.campos) {
      if (curVisivel[c.id] === false) continue   // campo oculto por condição
      if (c.tipo === 'foto' || c.tipo === 'assinatura' || c.tipo === 'produtos') continue
      let v = ''
      if (c.tipo === 'tecnicos') {
        v = Array.from(document.querySelectorAll(`[data-multi="${CSS.escape(c.id)}"]:checked`)).map(x => x.value).join(', ')
      } else {
        const el = document.querySelector(`[data-campo="${CSS.escape(c.id)}"]`)
        v = el ? String(el.value || '').trim() : ''
      }
      if (c.obrigatorio && !v) { faltando.push(c.label); faltandoIds.push(c.id) }
      if (v) respostas[c.id] = v
    }
    return { respostas, faltando, faltandoIds }
  }
  // Validação inline: destaca os campos faltantes e rola até o primeiro.
  function limparErros() {
    document.querySelectorAll('#view-form .campo-erro').forEach(e => e.classList.remove('campo-erro'))
    document.querySelectorAll('#view-form .btn-erro').forEach(e => e.classList.remove('btn-erro'))
  }
  function marcarErros(ids, extraEls) {
    let primeiro = null
    for (const id of (ids || [])) {
      const w = document.querySelector(`#campos-container [data-field="${CSS.escape(id)}"]`)
      if (w) { w.classList.add('campo-erro'); primeiro = primeiro || w }
    }
    for (const el of (extraEls || [])) { if (el) { el.classList.add('btn-erro'); primeiro = primeiro || el } }
    if (primeiro) primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function salvar() {
    if (!cur) return
    const cliId = document.getElementById('f-cliente').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!cur.formulario_id) return toast('Esta tarefa não tem formulário configurado.', 'err')

    const sit = document.getElementById('f-status').value
    // Atendimento continua (em execução) → salva parcial, sem exigir os obrigatórios.
    const emExecucao = (sit === 'em_andamento')

    const { respostas, faltando, faltandoIds } = coletarRespostas()
    const vis = (c) => curVisivel[c.id] !== false
    const fotoObrig = cur.campos.some(c => c.tipo === 'foto' && c.obrigatorio && vis(c))
    const assinaturaObrig = cur.campos.some(c => c.tipo === 'assinatura' && c.obrigatorio && vis(c))
    const produtosObrig = cur.campos.some(c => c.tipo === 'produtos' && c.obrigatorio && vis(c))

    limparErros()
    const fotos = await D().listarFotos(cur.client_uuid)
    if (!emExecucao) {
      if (faltando.length) { marcarErros(faltandoIds); return toast('Preencha os campos destacados.', 'err') }
      if (fotoObrig && fotos.length === 0) { marcarErros([], [document.getElementById('form-fotos-btn')]); return toast('Anexe ao menos uma foto.', 'err') }
      if (produtosObrig && (await D().listarMateriais(cur.client_uuid)).length === 0) { marcarErros([], [document.getElementById('form-produtos-btn')]); return toast('Adicione ao menos um produto.', 'err') }
    }

    let assinatura_local = null
    const temAssinatura = sig && !sig.isEmpty()
    if (!emExecucao && assinaturaObrig && !temAssinatura) return toast('Capture a assinatura.', 'err')
    if (temAssinatura) assinatura_local = sig.dataURL()

    const pendencias = document.getElementById('f-pendencias').value.trim()
    if (sit === 'concluida_pendencia' && !pendencias) {
      const w = document.getElementById('f-pendencias-wrap'); if (w) { w.classList.add('campo-erro'); w.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
      return toast('Descreva a pendência.', 'err')
    }

    const cli = ref.clientes.find(c => c.id === cliId)

    await D().salvarRat(cur.client_uuid, {
      tarefa_id: cur.tarefa_id || null,
      tarefa_numero: cur.tarefa_numero || null,
      cliente_id: cliId,
      cliente_nome: cli?.nome || null,
      formulario_id: cur.formulario_id || null,
      tecnico_id: tecnico.id,
      tecnico_nome: tecnico.nome,
      status: sit,
      pendencias: sit === 'concluida_pendencia' ? pendencias : null,
      tempo_trabalhado: calcTempo(),
      data_tarefa: new Date().toISOString(),
      respostas,
      questionario_ok: faltando.length === 0,
      tem_assinatura: !!temAssinatura,
      assinatura_local,
    })
    await D().definirStatus(cur.client_uuid, D().STATUS.SALVO_LOCAL, 'salvo pelo técnico')
    toast('RAT salva no aparelho.', 'ok')
    // Notifica admin/gestor quando a RAT é concluída (push), se online.
    if (!emExecucao && navigator.onLine && window.notificarPush) {
      notificarPush('rat_concluida', { numero: cur.tarefa_numero, cliente: cli?.nome, tarefa_id: cur.tarefa_id })
    }
    cur = null; sig = null
    mostrar('lista')
    await renderLista()
    // Tenta sincronizar imediatamente se houver conexão (passo 5).
    if (window.SyncEngine && navigator.onLine) window.SyncEngine.syncAll()
  }

  async function cancelar() {
    // Descarta rascunho vazio (sem cliente, sem fotos) para não acumular lixo.
    if (cur) {
      const rat = await D().obterRat(cur.client_uuid)
      const fotos = await D().listarFotos(cur.client_uuid)
      const mats = await D().listarMateriais(cur.client_uuid)
      // "vazio" = rascunho recém-aberto sem trabalho real. Ignora cliente/tarefa
      // (vêm automáticos da tarefa) — assim abrir e sair de uma RAT não deixa rascunho órfão.
      const vazio = rat && rat.sync_status === D().STATUS.RASCUNHO
        && !rat.tem_foto && !rat.tem_assinatura && !rat.questionario_ok && !rat.respostas
        && fotos.length === 0
        && !mats.some(m => (Number(m.quantidade) || 0) > 0 || m.qtd_levada == null)
      if (vazio) await D().removerRat(cur.client_uuid)
    }
    cur = null; sig = null
    mostrar('lista')
    await renderLista()
  }

  // ═══════════════════════ Pré-orçamento (form fixo) ═══════════════════════
  let curPo = null   // { client_uuid }

  async function renderPreorcLista() {
    const box = document.getElementById('lista-preorc')
    if (!box) return
    const list = await D().listarPreorc()
    if (!list.length) {
      box.innerHTML = '<div class="prod-empty" style="padding:24px 0;text-align:center;color:var(--t-muted)">Nenhum pré-orçamento no aparelho. Toque em <b>+ Novo</b>.</div>'
      return
    }
    box.innerHTML = list.map(p => {
      const conf = p.sync_status === 'confirmado'
      const sk = conf ? 'done' : 'warn'
      return `<div class="listcard lc-${conf ? 'done' : 'warn'}" data-uuid="${esc(p.client_uuid)}"><span class="edge e-${sk}"></span>
        <div class="t"><span class="cli">${esc(p.cliente_nome || 'Sem cliente')}</span><span class="badge b-${sk}">${conf ? 'Enviado' : 'na fila ↑'}</span></div>
        <div class="meta">${p.numero ? 'Nº <b>' + esc(p.numero) + '</b> · ' : ''}${esc((p.descricao || '—').slice(0, 48))}</div>
        <div class="meta">${fdt(p.criado_em, { withTime: true })}</div>
      </div>`
    }).join('')
    box.querySelectorAll('.listcard').forEach(el => { el.onclick = () => abrirPreorc(el.dataset.uuid) })
  }

  function poBindAutocomplete() {
    attachAutocomplete(
      document.getElementById('po-cliente-busca'),
      document.getElementById('po-cliente'),
      document.getElementById('po-cliente-list'),
      ref.clientes, c => ({ id: c.id, label: c.nome })
    )
    attachAutocomplete(
      document.getElementById('po-prod-busca'),
      document.getElementById('po-prod-sel'),
      document.getElementById('po-prod-ac-list'),
      ref.produtos || [], p => ({ id: p.id, label: (p.codigo ? p.codigo + ' - ' : '') + (p.descricao || '') })
    )
  }

  function poLimparForm() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v }
    ;['po-cliente', 'po-cliente-busca', 'po-descricao', 'po-prod-sel', 'po-prod-busca', 'po-prod-qtd',
      'po-desloc', 'po-hora-inicio', 'po-hora-termino', 'po-ida', 'po-retorno', 'po-almoco', 'po-pausa'].forEach(id => set(id, ''))
    set('po-tempo', '—')
    onDeslocPoChange()
  }

  async function novoPreorcUI() {
    const po = await D().novoPreorc({})
    curPo = { client_uuid: po.client_uuid }
    document.getElementById('preorc-titulo').textContent = 'Novo pré-orçamento'
    poLimparForm()
    poBindAutocomplete()
    await poRefreshThumbs()
    await poRefreshItens()
    mostrar('preorc-form')
  }

  async function abrirPreorc(client_uuid) {
    const po = await D().obterPreorc(client_uuid)
    if (!po) return
    curPo = { client_uuid }
    document.getElementById('preorc-titulo').textContent = po.numero ? `Pré-orçamento Nº ${po.numero}` : 'Pré-orçamento'
    poLimparForm()
    document.getElementById('po-cliente').value = po.cliente_id || ''
    document.getElementById('po-cliente-busca').value =
      (ref.clientes.find(c => c.id === po.cliente_id) || {}).nome || po.cliente_nome || ''
    document.getElementById('po-descricao').value = po.descricao || ''
    const r = po.respostas || {}
    const set = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.value = v }
    set('po-desloc', r.deslocamento); set('po-hora-inicio', r.hora_inicio); set('po-hora-termino', r.hora_termino)
    set('po-ida', r.ida); set('po-retorno', r.retorno); set('po-almoco', r.almoco); set('po-pausa', r.pausa)
    onDeslocPoChange()
    poBindAutocomplete()
    await poRefreshThumbs()
    await poRefreshItens()
    mostrar('preorc-form')
  }

  function onDeslocPoChange() {
    const d = document.getElementById('po-desloc').value
    document.getElementById('po-bloco-sem').style.display = d === 'Não' ? 'block' : 'none'
    document.getElementById('po-bloco-com').style.display = d === 'Sim' ? 'block' : 'none'
    atualizarTempoPo()
  }
  function calcTempoPo() {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : '' }
    const d = v('po-desloc'); let ini, fim
    if (d === 'Sim') { ini = v('po-ida'); fim = v('po-retorno') }
    else if (d === 'Não') { ini = v('po-hora-inicio'); fim = v('po-hora-termino') }
    else return null
    const a = minutosDe(ini), b = minutosDe(fim)
    if (a == null || b == null) return null
    const t = b - a - (Number(v('po-almoco')) || 0) - (Number(v('po-pausa')) || 0)
    return t < 0 ? 0 : t
  }
  function atualizarTempoPo() {
    const el = document.getElementById('po-tempo'); if (el) el.value = fmtMin(calcTempoPo())
  }

  async function poAddFotos(fileList) {
    if (!curPo) return
    for (const f of Array.from(fileList || [])) {
      if (!f.type.startsWith('image/')) continue
      await D().adicionarFoto(curPo.client_uuid, f, null)
    }
    document.getElementById('po-foto-input').value = ''
    await poRefreshThumbs()
  }
  async function poRefreshThumbs() {
    const box = document.getElementById('po-thumbs')
    if (!box || !curPo) return
    const fotos = await D().listarFotos(curPo.client_uuid)
    box.innerHTML = fotos.map(f => {
      const src = f.url || URL.createObjectURL(f.blob)
      return `<div class="thumb-card">
        <div class="thumb"><img src="${src}" alt=""><button type="button" class="thumb-x" data-id="${esc(f.id)}">×</button></div>
        <input type="text" class="thumb-leg" data-legid="${esc(f.id)}" placeholder="Legenda" value="${esc(f.legenda || '')}">
      </div>`
    }).join('')
    box.querySelectorAll('.thumb-x').forEach(b => {
      b.onclick = async (e) => { e.stopPropagation(); await D().removerFoto(b.dataset.id); await poRefreshThumbs() }
    })
    box.querySelectorAll('.thumb-leg').forEach(inp => {
      inp.onchange = () => D().atualizarLegendaFoto(inp.dataset.legid, inp.value.trim())
    })
  }

  async function poAddItem() {
    if (!curPo) return
    const pid = document.getElementById('po-prod-sel').value
    const qtdEl = document.getElementById('po-prod-qtd')
    const qtd = Number(qtdEl.value)
    if (!pid) return toast('Selecione um produto.', 'err')
    if (!qtd || qtd <= 0) return toast('Informe a quantidade.', 'err')
    const p = (ref.produtos || []).find(x => x.id === pid)
    await D().adicionarItemPreorc(curPo.client_uuid, {
      produto_id: pid, codigo_produto: p ? p.codigo : null, descricao: p ? p.descricao : null,
      unidade: p ? p.unidade : null, quantidade: qtd,
    })
    document.getElementById('po-prod-sel').value = ''
    document.getElementById('po-prod-busca').value = ''
    qtdEl.value = ''
    await poRefreshItens()
  }
  async function poRefreshItens() {
    const box = document.getElementById('po-prod-list')
    if (!box || !curPo) return
    const itens = await D().listarItensPreorc(curPo.client_uuid)
    if (!itens.length) { box.innerHTML = '<span class="dim">Nenhum produto necessário adicionado.</span>'; return }
    box.innerHTML = itens.map(m => `<div class="prod-item">
      <span>${esc(m.descricao || m.codigo_produto || '—')}</span>
      <span class="prod-qtd">${m.quantidade}${m.unidade ? ' ' + esc(m.unidade) : ''}</span>
      <button type="button" class="thumb-x" data-mid="${esc(m.id)}">×</button>
    </div>`).join('')
    box.querySelectorAll('[data-mid]').forEach(b => { b.onclick = async () => { await D().removerItemPreorc(b.dataset.mid); await poRefreshItens() } })
  }

  async function concluirPreorc() {
    if (!curPo) return
    const cliId = document.getElementById('po-cliente').value
    const desc = document.getElementById('po-descricao').value.trim()
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!desc) return toast('Descreva o levantamento.', 'err')
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : '' }
    const cli = ref.clientes.find(c => c.id === cliId)
    await D().salvarPreorc(curPo.client_uuid, {
      cliente_id: cliId,
      cliente_nome: cli?.nome || null,
      tecnico_id: tecnico.id,
      tecnico_nome: tecnico.nome,
      descricao: desc,
      respostas: {
        deslocamento: v('po-desloc') || null,
        hora_inicio: v('po-hora-inicio') || null, hora_termino: v('po-hora-termino') || null,
        ida: v('po-ida') || null, retorno: v('po-retorno') || null,
        almoco: v('po-almoco') || null, pausa: v('po-pausa') || null,
      },
      tempo_trabalhado: calcTempoPo(),
      data: new Date().toISOString(),
      status: 'concluido',
    })
    await D().definirStatusPreorc(curPo.client_uuid, D().STATUS.SALVO_LOCAL)
    // TODO #4.5: ao concluir, disparar geração de PDF (servidor) + e-mail ao comercial.
    toast('Pré-orçamento salvo no aparelho.', 'ok')
    curPo = null
    mostrar('preorc-lista')
    await renderPreorcLista()
    if (window.SyncEngine && navigator.onLine) window.SyncEngine.syncAll()
  }

  async function cancelarPreorc() {
    if (curPo) {
      const po = await D().obterPreorc(curPo.client_uuid)
      const fotos = await D().listarFotos(curPo.client_uuid)
      const itens = await D().listarItensPreorc(curPo.client_uuid)
      const vazio = po && po.sync_status === D().STATUS.RASCUNHO && !po.cliente_id && !po.descricao && !fotos.length && !itens.length
      if (vazio) await D().removerPreorc(curPo.client_uuid)
    }
    curPo = null
    mostrar('preorc-lista')
    await renderPreorcLista()
  }

  // Atualiza a lista da tela visível após uma rodada de sync.
  async function refresh() {
    if (screen === 'preorc-lista' || screen === 'preorc-form') await renderPreorcLista()
    else await renderLista()
  }

  window.TecnicoApp = { init, refresh }
})()
