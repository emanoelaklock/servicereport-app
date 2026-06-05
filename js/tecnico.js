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

  let ref = { clientes: [], tipos: [], formularios: {}, tecnicos: [], veiculos: [], produtos: [] }   // formularios: { [id]: {nome,campos} }
  let tecnico = { id: null, nome: null }
  let cur = null            // RAT em edição: { client_uuid, campos: [], tarefa_id?, tarefa_numero? }
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
  function togglePendencias() {
    const v = document.getElementById('f-status').value
    document.getElementById('f-pendencias-wrap').style.display = (v === 'concluida_pendencia') ? 'block' : 'none'
  }
  const osNo = (n) => n != null ? String(n).padStart(5, '0') : '—'
  const cliNomeDe = (id, fb) => (ref.clientes.find(c => c.id === id) || {}).nome || fb || '—'

  // Título-case: "marcelo oliveira" -> "Marcelo Oliveira"
  const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, m => m.toUpperCase())

  // Autocomplete com busca (listas grandes: clientes/produtos). Sem framework.
  // busca: input texto; hidden: input que guarda o id; list: div de sugestões.
  function attachAutocomplete(busca, hidden, list, items, fmt) {
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
    tecnico.nome = u?.nome || user?.email?.split('@')[0] || 'Técnico'
    const ftn = document.getElementById('ft-nome'); if (ftn) ftn.textContent = tecnico.nome

    const hello = document.getElementById('home-hello')
    if (hello) hello.textContent = 'Olá, ' + (tecnico.nome || 'técnico') + '!'

    bind()
    await carregarRef()
    mostrar('home')
  }

  function bind() {
    // RAT — sempre criada DENTRO de uma Tarefa (não há criação avulsa).
    document.getElementById('btn-cancelar').onclick = cancelar
    document.getElementById('btn-salvar').onclick = salvar
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
      document.getElementById('modal-nt').classList.add('open')
    }
    document.getElementById('nt-fechar').onclick = () => document.getElementById('modal-nt').classList.remove('open')
    document.getElementById('nt-cancelar').onclick = () => document.getElementById('modal-nt').classList.remove('open')
    document.getElementById('nt-criar').onclick = criarTarefaTecnico
    document.getElementById('btn-iniciar-rat').onclick = () => { if (tarefaAberta) iniciarRatDaTarefa(tarefaAberta) }
    document.getElementById('btn-concluir').onclick = () => concluirTarefa(false)
    document.getElementById('btn-concluir-pend').onclick = () => concluirTarefa(true)
    document.getElementById('nav-preorc').onclick = async () => { mostrar('preorc-lista'); await renderPreorcLista() }
    document.getElementById('nav-desloc').onclick = () => toast('Deslocamento (pernoite) — em breve.', 'info')
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
      const [cli, tip, forms, tec, veic, prod] = await Promise.all([
        sb.from('clientes').select('id,nome,documento').eq('oculto', false).order('nome'),
        sb.from('tipos_servico').select('id,nome,formulario_id,ativo').eq('ativo', true).order('nome'),
        sb.from('formulario_modelos').select('id,nome,campos').eq('ativo', true),
        sb.from('usuarios').select('id,nome').eq('role', 'tecnico_campo').eq('ativo', true).order('nome'),
        sb.from('veiculos').select('id,modelo,placa,ativo').eq('ativo', true).order('modelo'),
        sb.from('produtos').select('id,codigo,descricao,unidade,ativo').eq('ativo', true).eq('oculto', false).order('descricao'),
      ])
      if (cli.error || tip.error || forms.error) throw (cli.error || tip.error || forms.error)
      ref.clientes = cli.data || []
      ref.tipos = tip.data || []
      ref.formularios = {}
      ;(forms.data || []).forEach(f => { ref.formularios[f.id] = f })
      ref.tecnicos = tec.error ? [] : (tec.data || [])
      ref.veiculos = veic.error ? [] : (veic.data || [])
      ref.produtos = prod.error ? [] : (prod.data || [])
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
    box.innerHTML = rats.map(r => `
      <div class="rat-card" data-uuid="${esc(r.client_uuid)}">
        <div class="rat-card-top">
          <span class="rat-cli">${esc(r.cliente_nome || 'Sem cliente')}</span>
          <span style="display:flex;align-items:center;gap:8px">${badge(r.sync_status)}<button type="button" class="rat-del" data-del="${esc(r.client_uuid)}" title="Excluir RAT">🗑</button></span>
        </div>
        <div class="rat-meta">
          <span>${esc(ratSit(r.status || 'em_andamento'))}</span>
          <span>${fdt(r.criado_em, { withTime: true })}</span>
        </div>
      </div>`).join('')
    box.querySelectorAll('.rat-card').forEach(el => {
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
    if (!box) return
    if (!tarefas.length) { box.innerHTML = '<p class="dim" style="padding:14px 2px">Nenhuma tarefa atribuída a você.</p>'; return }
    box.innerHTML = tarefas.map(t => {
      const st = T_STATUS[t.status] || { t: t.status || '—', c: '' }
      const ag = t.data_agendada ? 'Agendada ' + fdt(t.data_agendada) : 'Sem data'
      return `<div class="t-card" data-id="${esc(t.id)}">
        <div class="t-card-top"><span class="t-card-cli">${esc(cliNomeDe(t.cliente_id))}</span><span class="t-badge ${st.c}">${esc(st.t)}</span></div>
        <div class="t-card-meta"><span class="t-card-no">Nº ${osNo(t.numero)}</span><span>${esc(ag)}</span></div>
      </div>`
    }).join('')
    box.querySelectorAll('.t-card').forEach(el => el.onclick = () => abrirTarefaDet(el.dataset.id))
  }

  async function criarTarefaTecnico() {
    const cliId = document.getElementById('nt-cliente').value
    const tipoId = document.getElementById('nt-tipo').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')
    if (!navigator.onLine) return toast('Sem conexão — crie a tarefa quando estiver online.', 'err')
    const sb = getSupabase()
    const newId = crypto.randomUUID()
    const ins = await sb.from('tarefas').insert({
      id: newId, cliente_id: cliId, status: 'aguardando_execucao', criado_por: tecnico.id,
      tipo_servico_id: tipoId,
      data_agendada: document.getElementById('nt-data').value || null,
    })
    if (ins.error) return toast('Erro ao criar tarefa: ' + ins.error.message, 'err')
    const at = await sb.from('tarefa_tecnicos').insert({ tarefa_id: newId, tecnico_id: tecnico.id })
    if (at.error) return toast('Tarefa criada, mas falha ao atribuir: ' + at.error.message, 'err')
    document.getElementById('modal-nt').classList.remove('open')
    toast('Tarefa criada.', 'ok')
    await renderTarefas()
    await abrirTarefaDet(newId)
  }

  async function abrirTarefaDet(id) {
    const t = tarefas.find(x => x.id === id); if (!t) return
    tarefaAberta = t
    const st = T_STATUS[t.status] || { t: t.status || '—', c: '' }
    document.getElementById('t-det-no').textContent = 'Tarefa Nº ' + osNo(t.numero)
    const badge = document.getElementById('t-det-badge'); badge.textContent = st.t; badge.className = 't-det-badge ' + st.c
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
    document.getElementById('t-det-concluir').style.display = (podeConcluir && temRat) ? 'grid' : 'none'
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
        .select('descricao,codigo_produto,unidade,qtd_orcada,qtd_levada').eq('tarefa_id', id)
      if (!data || !data.length) { sec.style.display = 'none'; return }
      const qz = (n) => Number(n) || 0
      const fmt = (n, u) => { const v = qz(n); return (v ? v.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '—') + (v && u ? ' ' + u : '') }
      box.innerHTML = data.map(m => `<div class="t-det-mat-item">
        <div class="nome">${esc(m.descricao || m.codigo_produto || '—')}</div>
        <div class="t-det-mat-chips">
          <span class="t-mat-chip orc${qz(m.qtd_orcada) ? '' : ' zero'}"><span class="k">Orçado</span>${fmt(m.qtd_orcada, m.unidade)}</span>
          <span class="t-mat-chip lev${qz(m.qtd_levada) ? '' : ' zero'}"><span class="k">Levado</span>${fmt(m.qtd_levada, m.unidade)}</span>
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
    box.innerHTML = dela.map(r => `<div class="rat-card" data-uuid="${esc(r.client_uuid)}">
      <div class="rat-card-top"><span class="rat-cli">RAT</span>${badge(r.sync_status)}</div>
      <div class="rat-meta"><span>${esc(ratSit(r.status))}</span><span>${fdt(r.criado_em, { withTime: true })}</span></div>
    </div>`).join('')
    box.querySelectorAll('.rat-card').forEach(el => el.onclick = () => abrirExistente(el.dataset.uuid))
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
  }

  // ─────────────────────── Navegação (home + módulos) ───────────────────────
  let screen = 'home'
  const VIEWS = {
    home: 'view-home', lista: 'view-lista', form: 'view-form',
    tarefas: 'view-tarefas', 'tarefa-det': 'view-tarefa-det',
    'preorc-lista': 'view-preorc-lista', 'preorc-form': 'view-preorc-form',
  }
  const TITLES = {
    home: 'Service Report', lista: 'Minhas RATs', form: 'Nova RAT',
    tarefas: 'Minhas Tarefas', 'tarefa-det': 'Tarefa',
    'preorc-lista': 'Pré-Orçamento', 'preorc-form': 'Pré-Orçamento',
  }
  function mostrar(secao) {
    screen = secao
    for (const [k, id] of Object.entries(VIEWS)) {
      const el = document.getElementById(id); if (el) el.style.display = (k === secao) ? 'block' : 'none'
    }
    const t = document.getElementById('ft-title'); if (t) t.textContent = TITLES[secao] || 'Service Report'
    const b = document.getElementById('btn-voltar'); if (b) b.style.display = (secao === 'home') ? 'none' : 'block'
  }
  function onVoltar() {
    if (screen === 'form') return cancelar()
    if (screen === 'preorc-form') return cancelarPreorc()
    if (screen === 'tarefa-det') return mostrar('tarefas')
    mostrar('home')
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
    if (rat.tarefa_id) {
      banner.style.display = 'block'
      banner.textContent = `RAT da Tarefa Nº ${osNo(rat.tarefa_numero)} · ${cliNomeDe(rat.cliente_id, rat.cliente_nome)}${tipoNomeR ? ' · ' + tipoNomeR : ''}`
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
    mostrar('form')
  }

  // Tipo de serviço é da TAREFA; a RAT só guarda qual formulário respondeu (formulario_id).
  async function onTipoChange() {
    const tipo = ref.tipos.find(t => t.id === document.getElementById('f-tipo').value)
    await carregarFormularioPorId(tipo ? tipo.formulario_id : null)
  }
  async function carregarFormularioPorId(formId) {
    const cont = document.getElementById('campos-container')
    cur.campos = []
    cur.formulario_id = formId || null
    const form = formId ? ref.formularios[formId] : null
    if (!form) { cont.innerHTML = formId ? '<p class="dim">Formulário não encontrado.</p>' : '<p class="dim">Esta tarefa não tem tipo de serviço/formulário configurado — peça ao administrativo.</p>'; return }
    cur.campos = form.campos || []
    cont.innerHTML = ''
    for (const c of cur.campos) cont.appendChild(renderCampo(c))
    const sc = cont.querySelector('canvas.sig-pad')
    if (sc) { sig = initSignature(sc); sig.resize() }
    const onFormChange = (e) => { aplicarEspelhos(e); atualizarTempo(); aplicarCondicionais() }
    cont.oninput = onFormChange
    cont.onchange = onFormChange
    atualizarTempo()
    aplicarCondicionais()
    await refreshThumbs()
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
      wrap.innerHTML = `${label}<textarea class="ta-longo" data-campo="${esc(c.id)}" data-tipo="texto_longo" placeholder="…"></textarea>`
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
      wrap.innerHTML = `${label}
        <div class="prod-box">
          <div class="prod-add">
            <div class="ac">
              <input type="text" id="prod-busca" placeholder="Buscar produto…" autocomplete="off">
              <input type="hidden" id="prod-sel">
              <div class="ac-list" id="prod-ac-list"></div>
            </div>
            <input type="number" id="prod-qtd" inputmode="decimal" placeholder="Qtd" min="0" step="any">
            <button type="button" class="btn btn-sm" id="prod-add-btn">+ Add</button>
          </div>
          <div class="prod-list" id="prod-list"></div>
        </div>`
      setTimeout(() => {
        attachAutocomplete(
          document.getElementById('prod-busca'),
          document.getElementById('prod-sel'),
          document.getElementById('prod-ac-list'),
          ref.produtos || [], p => ({ id: p.id, label: (p.codigo ? p.codigo + ' - ' : '') + (p.descricao || '') })
        )
        const b = document.getElementById('prod-add-btn'); if (b) b.onclick = adicionarMaterialUI
        refreshMateriais()
      }, 0)
    } else if (c.tipo === 'foto') {
      wrap.innerHTML = `${label}
        <div class="foto-box">
          <input type="file" accept="image/*" capture="environment" multiple id="foto-input" style="display:none">
          <button type="button" class="btn" id="btn-foto">📷 Adicionar foto</button>
          <div class="thumbs" id="thumbs"></div>
        </div>`
      // bind após inserir no DOM
      setTimeout(() => {
        const inp = wrap.querySelector('#foto-input')
        wrap.querySelector('#btn-foto').onclick = () => inp.click()
        inp.onchange = () => adicionarFotos(inp.files)
      }, 0)
    } else if (c.tipo === 'assinatura') {
      wrap.innerHTML = `${label}
        <div class="sig-wrap">
          <canvas class="sig-pad"></canvas>
          <button type="button" class="btn btn-sm sig-clear" id="btn-sig-limpar">Limpar</button>
        </div>`
      setTimeout(() => { wrap.querySelector('#btn-sig-limpar').onclick = () => sig && sig.clear() }, 0)
    } else {
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto"/>`
    }
    return wrap
  }

  // ─────────────────────────── Fotos ───────────────────────────
  async function adicionarFotos(fileList) {
    const files = Array.from(fileList || [])
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      await D().adicionarFoto(cur.client_uuid, f, null)   // legenda preenchida depois, por foto
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
  }

  // ── Produtos utilizados (materiais, origem 'usado') ──
  async function adicionarMaterialUI() {
    const pid = document.getElementById('prod-sel').value
    const qtdEl = document.getElementById('prod-qtd')
    const qtd = Number(qtdEl.value)
    if (!pid) return toast('Selecione um produto.', 'err')
    if (!qtd || qtd <= 0) return toast('Informe a quantidade.', 'err')
    const p = (ref.produtos || []).find(x => x.id === pid)
    await D().adicionarMaterial(cur.client_uuid, {
      produto_id: pid, codigo_produto: p ? p.codigo : null, descricao: p ? p.descricao : null,
      unidade: p ? p.unidade : null, quantidade: qtd,
    })
    document.getElementById('prod-sel').value = ''
    document.getElementById('prod-busca').value = ''
    qtdEl.value = ''
    await refreshMateriais()
  }
  async function refreshMateriais() {
    const box = document.getElementById('prod-list')
    if (!box) return
    const mats = await D().listarMateriais(cur.client_uuid)
    if (!mats.length) { box.innerHTML = '<span class="dim">Nenhum produto adicionado.</span>'; return }
    box.innerHTML = mats.map(m => `<div class="prod-item">
      <span>${esc(m.descricao || m.codigo_produto || '—')}</span>
      <span class="prod-qtd">${m.quantidade}${m.unidade ? ' ' + esc(m.unidade) : ''}</span>
      <button type="button" class="thumb-x" data-mid="${esc(m.id)}">×</button>
    </div>`).join('')
    box.querySelectorAll('[data-mid]').forEach(b => { b.onclick = async () => { await D().removerMaterial(b.dataset.mid); await refreshMateriais() } })
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
    const el = document.getElementById('f-tempo'); if (el) el.value = fmtMin(calcTempo())
  }

  function coletarRespostas() {
    const respostas = {}
    let faltando = []
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
      if (c.obrigatorio && !v) faltando.push(c.label)
      if (v) respostas[c.id] = v
    }
    return { respostas, faltando }
  }

  async function salvar() {
    if (!cur) return
    const cliId = document.getElementById('f-cliente').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!cur.formulario_id) return toast('Esta tarefa não tem formulário configurado.', 'err')

    const { respostas, faltando } = coletarRespostas()
    const temFotoCampo = cur.campos.some(c => c.tipo === 'foto')
    const temAssinaturaCampo = cur.campos.some(c => c.tipo === 'assinatura')
    const vis = (c) => curVisivel[c.id] !== false
    const fotoObrig = cur.campos.some(c => c.tipo === 'foto' && c.obrigatorio && vis(c))
    const assinaturaObrig = cur.campos.some(c => c.tipo === 'assinatura' && c.obrigatorio && vis(c))

    const fotos = await D().listarFotos(cur.client_uuid)
    if (faltando.length) return toast('Preencha: ' + faltando.join(', '), 'err')
    if (fotoObrig && fotos.length === 0) return toast('Anexe ao menos uma foto.', 'err')
    const produtosObrig = cur.campos.some(c => c.tipo === 'produtos' && c.obrigatorio && vis(c))
    if (produtosObrig && (await D().listarMateriais(cur.client_uuid)).length === 0) return toast('Adicione ao menos um produto.', 'err')

    let assinatura_local = null
    const temAssinatura = sig && !sig.isEmpty()
    if (assinaturaObrig && !temAssinatura) return toast('Capture a assinatura.', 'err')
    if (temAssinatura) assinatura_local = sig.dataURL()

    const sit = document.getElementById('f-status').value
    const pendencias = document.getElementById('f-pendencias').value.trim()
    if (sit === 'concluida_pendencia' && !pendencias) return toast('Descreva a pendência.', 'err')

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
      const vazio = rat && rat.sync_status === D().STATUS.RASCUNHO && !rat.cliente_id && fotos.length === 0
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
      box.innerHTML = '<p class="dim" style="padding:14px 2px">Nenhum pré-orçamento no aparelho. Toque em “+ Novo”.</p>'
      return
    }
    box.innerHTML = list.map(p => `
      <div class="rat-card" data-uuid="${esc(p.client_uuid)}">
        <div class="rat-card-top">
          <span class="rat-cli">${esc(p.cliente_nome || 'Sem cliente')}</span>
          ${badge(p.sync_status)}
        </div>
        <div class="rat-meta">
          <span>${p.numero ? 'Nº ' + esc(p.numero) + ' · ' : ''}${esc((p.descricao || '—').slice(0, 40))}</span>
          <span>${fdt(p.criado_em, { withTime: true })}</span>
        </div>
      </div>`).join('')
    box.querySelectorAll('.rat-card').forEach(el => { el.onclick = () => abrirPreorc(el.dataset.uuid) })
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
    if (!itens.length) { box.innerHTML = '<span class="dim">Nenhum material necessário adicionado.</span>'; return }
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
