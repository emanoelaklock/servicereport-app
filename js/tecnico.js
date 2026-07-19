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
  let usoProd = null        // "Foi utilizado produto neste atendimento?" ('Sim' | 'Não' | null)
  let sig = null            // controlador do canvas de assinatura
  let curVisivel = {}       // id do campo -> visível? (condicionais)
  const TAREFAS_KEY = 'sr_tarefas_v1'
  const RESP_KEY = 'sr_resp_tarefa_v1'
  let tarefas = []          // tarefas atribuídas (cache)
  let respPorTarefa = {}    // tarefa_id → [tecnico_id] responsáveis (RLS 0063 deixa ver os co-responsáveis)
  let respTarefaIds = []    // responsáveis da tarefa da RAT aberta (pré-marca o campo de técnicos)
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
  const RAT_SIT_LABEL = { em_andamento: 'Em andamento', registrado: 'Atendimento Realizado', concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência', improdutiva: 'Visita improdutiva' }
  const ratSit = (s) => RAT_SIT_LABEL[s] || s || '—'
  // Motivos da visita improdutiva (chave salva → rótulo). 'outro' usa texto livre.
  const MOTIVO_IMPRODUTIVA = {
    cliente_nao_liberou: 'Cliente não liberou acesso',
    local_nao_pronto: 'Local não estava pronto',
    falta_material: 'Falta de peça / material',
    clima: 'Condições climáticas',
    equip_cliente_indisponivel: 'Equipamento do cliente indisponível',
    outro: 'Outro motivo',
  }
  // Prioridade de exibição por status da tarefa (menor = aparece primeiro).
  const STATUS_PRIORIDADE = { em_execucao: 1, devolvida: 2, aguardando_execucao: 3, concluida_pendencia: 4, concluida: 5, aprovada_faturamento: 6, faturada: 7 }
  const RAT_PARA_TAREFA = { em_andamento: 'em_execucao', registrado: 'em_execucao', concluida: 'concluida', concluida_pendencia: 'concluida_pendencia' }
  const prioStatus = (s) => (STATUS_PRIORIDADE[s] != null ? STATUS_PRIORIDADE[s] : 50)
  // Label/cor do status vindos de Configurações (status_tarefa); cai no T_STATUS fixo.
  const stLabel = (s) => (ref.status && ref.status[s] && ref.status[s].label) || (T_STATUS[s] && T_STATUS[s].t) || s || '—'
  const stCor = (s) => (ref.status && ref.status[s] && ref.status[s].cor) || '#48506A'
  const stStyle = (s) => `background:${stCor(s)}1A;color:${stCor(s)};border:none`
  // Mapeia status do sistema → variante visual do skin (info/done/warn/pend/aguard).
  const SKIN_STATUS = { em_execucao: 'info', em_pausa: 'pausa', aguardando_execucao: 'aguard', concluida: 'done', concluida_pendencia: 'warn', devolvida: 'pend', aprovada_faturamento: 'done', faturada: 'done' }
  // Motivo da devolução → HTML: chips das categorias na ORDEM gravada (= Tarefa→RAT, DOM order do
  // portal) + o detalhe. Labels do vocabulário único (utils.js:MOTIVO_LABEL). Fallback pro texto
  // renderizado (motivo_devolucao) nos registros anteriores à Fase A (sem cats).
  const hasDevol = (t) => !!(t && ((Array.isArray(t.motivo_devolucao_cats) && t.motivo_devolucao_cats.length) || t.motivo_devolucao))
  // Dias inteiros desde que a tarefa entrou em 'devolvida' (null se sem carimbo — devoluções antigas).
  const devolvidaDias = (t) => (t && t.devolvida_em) ? Math.floor((Date.now() - new Date(t.devolvida_em).getTime()) / 86400000) : null
  const devolvidaIdadeTxt = (dd) => dd <= 0 ? 'hoje' : (dd === 1 ? 'há 1 dia' : 'há ' + dd + ' dias')
  function devolMotivoHTML(t) {
    const cats = t && t.motivo_devolucao_cats, det = t && t.motivo_devolucao_detalhe, L = window.MOTIVO_LABEL || {}
    const dd = devolvidaDias(t)
    const idade = dd == null ? '' : `<div class="devol-idade${dd >= 1 ? ' urg' : ''}">Devolvida ${devolvidaIdadeTxt(dd)}${dd >= 1 ? ' · corrija o quanto antes' : ''}</div>`
    const corpo = (Array.isArray(cats) && cats.length)
      ? `<div class="devol-chips">${cats.map(c => `<span class="devol-chip">${esc(L[c] || c)}</span>`).join('')}</div>` + (det ? `<div class="devol-det">${esc(det)}</div>` : '')
      : ((t && t.motivo_devolucao)
          // fallback pré-Fase A (texto renderizado com bullets): vira um chip por item, como no portal
          ? `<div class="devol-chips">${String(t.motivo_devolucao).split('•').map(s => s.trim()).filter(Boolean).map(s => `<span class="devol-chip">${esc(s)}</span>`).join('')}</div>`
          : '')
    return idade + corpo
  }
  // Checkpoint de passagem: revelado ao tocar "Encerrar a RAT do dia". "Volta amanhã?"; se Não, o que falta/levar.
  let voltaAmanha = null
  let revelarPass = false   // o checkpoint só aparece quando o técnico opta por encerrar o dia
  function togglePassagem() {
    window.srStep && window.srStep('  tP: entrada')
    const box = document.getElementById('f-passagem')
    if (box) box.style.display = (atendExec === 'Sim' && revelarPass) ? 'block' : 'none'
    window.srStep && window.srStep('  tP: display set OK')
  }
  function setVoltaAmanha(v) {
    window.srStep && window.srStep('  setVoltaAmanha: entrada (v=' + v + ')')
    voltaAmanha = (v === 'Não') ? 'Não' : 'Sim'
    document.querySelectorAll('#f-volta-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === voltaAmanha))
    const nao = document.getElementById('f-passagem-nao')
    if (nao) nao.style.display = (voltaAmanha === 'Não') ? 'block' : 'none'
    if (voltaAmanha !== 'Não') document.querySelectorAll('#f-passagem-motivo input').forEach(r => { r.checked = false })
    window.srStep && window.srStep('  setVoltaAmanha: pre togglePassagemHandoff')
    togglePassagemHandoff()
    window.srStep && window.srStep('  setVoltaAmanha: pre atualizarBtnSalvar')
    atualizarBtnSalvar()   // "Não" revela o "Encerrar" final; "Sim" encerra direto (no handler do botão)
    window.srStep && window.srStep('  setVoltaAmanha: saida OK')
  }
  // Voltar do checkpoint: recolhe "Volta amanhã?" e devolve "Salvar e continuar" — o técnico não fica preso.
  function voltarDoCheckpoint() {
    revelarPass = false; voltaAmanha = null
    document.querySelectorAll('#f-volta-seg button').forEach(b => b.classList.remove('on'))
    const nao = document.getElementById('f-passagem-nao'); if (nao) nao.style.display = 'none'
    togglePassagem(); atualizarBtnSalvar()
  }
  // Sub-motivo do "Não volto amanhã": 'terminei' (vou concluir na Tarefa, sem handoff) |
  // 'volto_depois' (continua → o que falta / o que levar OBRIGATÓRIOS). 'Terminei' NÃO conclui aqui.
  const passMotivoVal = () => { const el = document.querySelector('#f-passagem-motivo input:checked'); return el ? el.value : null }
  // Espelha a classe .checked no .motopt do motivo marcado (destaque rosa do rótulo). Substitui o
  // seletor .motopt:has(input:checked) — que causava tempestade de recalc de estilo no WebView
  // Android a cada mutação de DOM. Idempotente; chamado em toda mudança de estado dos rádios.
  function syncMotivoChecked() {
    document.querySelectorAll('#f-passagem-motivo .motopt').forEach(opt => {
      const inp = opt.querySelector('input')
      opt.classList.toggle('checked', !!(inp && inp.checked))
    })
  }
  function togglePassagemHandoff() {
    window.srStep && window.srStep('  tPH: entrada')
    const m = (voltaAmanha === 'Não') ? passMotivoVal() : null
    const ho = document.getElementById('f-passagem-handoff'); if (ho) ho.style.display = (m === 'volto_depois') ? 'block' : 'none'
    const th = document.getElementById('f-passagem-terminei-hint'); if (th) th.style.display = (m === 'terminei') ? 'block' : 'none'
    syncMotivoChecked()   // mantém o destaque do rótulo em sincronia (interativo: H-motivo, setVoltaAmanha, re-hidratação)
    window.srStep && window.srStep('  tPH: saida OK')
  }
  // Execução é o padrão; o checkbox "visita improdutiva" troca pra 'Não' (motivo + tempo no local,
  // sem exigir execução; a tarefa fica aguardando). Estado em `atendExec` ('Sim'|'Não').
  let atendExec = 'Sim'
  function setExec(v) {
    atendExec = (v === 'Não') ? 'Não' : 'Sim'
    const sim = document.getElementById('f-exec-sim'), nao = document.getElementById('f-exec-nao')
    if (sim) sim.style.display = (atendExec === 'Não') ? 'none' : 'block'
    if (nao) nao.style.display = (atendExec === 'Não') ? 'block' : 'none'
    atualizarBtnSalvar()
    togglePassagem()
  }
  function toggleMotivoTexto() {
    const sel = document.querySelector('#f-motivos input[name="f-motivo"]:checked')
    const wrap = document.getElementById('f-motivo-texto-wrap')
    if (wrap) wrap.style.display = (sel && sel.value === 'outro') ? 'block' : 'none'
  }
  // Ação primária: "Encerrar a RAT do dia" (Sim) | "Registrar visita" (Não improdutiva).
  // Secundária "Salvar e continuar" (salva parcial em_andamento) só aparece no Sim.
  function atualizarBtnSalvar() {
    window.srStep && window.srStep('  aBS: entrada')
    const b = document.getElementById('btn-salvar'), bc = document.getElementById('btn-continuar')
    const bv = document.getElementById('btn-voltar-pass')
    const imp = (atendExec === 'Não')
    if (b) b.textContent = imp ? 'Registrar visita' : 'Encerrar RAT do Dia'
    // "Salvar e continuar": só no fluxo normal, antes de abrir o checkpoint de encerrar.
    if (bc) bc.style.display = (imp || revelarPass) ? 'none' : ''
    // "Voltar": só com o checkpoint aberto (execução) — pra o técnico não ficar preso.
    if (bv) bv.style.display = (!imp && revelarPass) ? '' : 'none'
    // "Encerrar": some enquanto espera a resposta do "Volta amanhã?" (Sim encerra sozinho) e
    // reaparece no caminho "Não" pra confirmar depois do motivo.
    if (b) b.style.display = (!imp && revelarPass && voltaAmanha !== 'Não') ? 'none' : ''
    window.srStep && window.srStep('  aBS: saida OK')
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
      // Busca por tokens: todas as palavras precisam aparecer, em QUALQUER ordem
      // (ex.: "rede cabo" acha "CABO DE REDE..."). Acentos/caixa normalizados via normStr.
      const toks = nq.split(/\s+/).filter(Boolean)
      const matches = []
      for (const it of items) {
        const f = fmt(it)
        const hay = normStr(f.label)
        if (toks.every(t => hay.includes(t))) { matches.push(f); if (matches.length >= 30) break }
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
  // Isola dados por usuário no mesmo aparelho: IndexedDB por uid + limpa caches/cursores ao trocar
  // de login (inclui a 1ª vez pós-update). NÃO apaga trabalho não-sincronizado (o IndexedDB do
  // usuário anterior fica intacto no banco dele). Resolve a colisão "logada como Pablo vendo RAT do Teste".
  function isolarPorUsuario(uid) {
    if (!uid) return   // uid nulo NÃO troca de banco (evita cair no banco legado service_report)
    try { D().setUser(uid) } catch (e) { /* nada */ }
    let last = null
    try { last = localStorage.getItem('sr_last_uid') } catch (e) { /* nada */ }
    if (uid && last !== uid) {
      try {
        ['sr_tarefas_v1', 'sr_resp_tarefa_v1', 'sr_tec_screen'].forEach(k => localStorage.removeItem(k))
        Object.keys(localStorage).filter(k => k.indexOf('sr_pull_') === 0).forEach(k => localStorage.removeItem(k))
        localStorage.setItem('sr_last_uid', uid)
      } catch (e) { /* nada */ }
    }
  }

  // Logout forçado (fim de dia / app fechado / sem sessão). Limpa marcas e volta pro login.
  // Re-login exige internet (decisão: bloquear offline) — o login.html valida a sessão.
  async function forcarLogout() {
    // OFFLINE NÃO DESLOGA: o re-login exige internet; sem rede o signOut falha, a sessão persiste
    // e login.html roteia de volta pra cá → LOOP/tela branca. Sem rede, mantém a sessão (o técnico
    // de campo segue trabalhando). A política de dia/fechamento é reavaliada quando voltar a rede.
    if (!navigator.onLine) return false
    try { localStorage.removeItem('sr_login_dia') } catch (e) { /* nada */ }
    try { sessionStorage.removeItem('sr_app_alive') } catch (e) { /* nada */ }
    try { await getSupabase().auth.signOut() } catch (e) { /* segue mesmo assim */ }
    location.href = 'login.html'
    return true
  }
  // Política de sessão do app do técnico (dispositivos compartilhados):
  //  (1) app FECHADO desde o último uso → exige login (heartbeat sr_app_alive some ao fechar; sobrevive a reload);
  //  (2) logout automático 1x/dia → na virada do dia (fuso de SP) exige login.
  // Retorna false (e dispara logout) quando a sessão não pode continuar.
  // FLAG: logout automático (diário + ao fechar) TEMPORARIAMENTE DESATIVADO.
  // Estava causando tela branca/loop no campo (forcarLogout → login.html acha a sessão em cache
  // → volta pra cá → forcarLogout… ; offline o signOut nem completa). Reintroduzir com cuidado e
  // teste, tratando o caminho offline/loop. Por ora: o app NÃO força logout sozinho (volta ao
  // comportamento estável anterior); o logout manual continua disponível.
  const LOGOUT_AUTO_ATIVO = false
  function verificarSessaoDia() {
    if (!tecnico.id) return true   // sem sessão: o fluxo normal mostra o login
    // Mantém a contabilidade (heartbeat/dia) pra quando o recurso for reativado — mas NÃO desloga.
    try { sessionStorage.setItem('sr_app_alive', '1') } catch (e) { /* nada */ }
    try { if (!localStorage.getItem('sr_login_dia')) localStorage.setItem('sr_login_dia', hojeBR()) } catch (e) { /* nada */ }
    if (!LOGOUT_AUTO_ATIVO) return true
    // (enforcement desativado — ver LOGOUT_AUTO_ATIVO)
    if (!navigator.onLine) return true
    const hoje = hojeBR()
    const dia = (() => { try { return localStorage.getItem('sr_login_dia') } catch (e) { return null } })()
    if (dia && dia !== hoje) { forcarLogout(); return false }
    return true
  }
  // Vira o dia com o app ABERTO → desloga. (Desativado por LOGOUT_AUTO_ATIVO.)
  function checarVirouDia() {
    if (!LOGOUT_AUTO_ATIVO || !tecnico.id || !navigator.onLine) return
    let dia = null; try { dia = localStorage.getItem('sr_login_dia') } catch (e) { /* nada */ }
    if (dia && dia !== hojeBR()) forcarLogout()
  }

  async function init() {
    // DIAG (branch diag/encerramento-hang-db): surface o ÚLTIMO breadcrumb do salvar — se o app
    // travou no encerramento, força-fechar+reabrir cai aqui e mostra ONDE o main thread morreu.
    try {
      var _trail = JSON.parse(localStorage.getItem('sr_diag_trail') || '[]')
      if (window.SR_DB_DEBUG && Array.isArray(_trail) && _trail.length) {
        var _p = _trail.map(function (s) { var i = s.lastIndexOf(' @'); return { l: s.slice(0, i), t: +s.slice(i + 2) } })
        var _total = _p[_p.length - 1].t - _p[0].t   // do click até o último passo (antes de travar)
        var _tail = _p.slice(-6).map(function (x, i, a) { return x.l + (i ? ' +' + (x.t - a[i - 1].t) + 'ms' : '') }).join(' › ')
        var _msg = '🔎 TRAVOU em "' + _p[_p.length - 1].l + '" | ' + _total + 'ms desde o click › ' + _tail
        setTimeout(function () { if (typeof toast === 'function') toast(_msg, 'err') }, 1600)
      }
    } catch (e) { /* nada */ }
    // uid SEMPRE da sessão LOCAL (offline-first). getUser() faz chamada de REDE e devolve null
    // num soluço de conexão / token renovando → o app abria o banco legado vazio e as RATs
    // "sumiam". SESSION já vem populada pelo _posLogin (auth.js) antes do init; getSession() é
    // o fallback local (não toca a rede), igual o resto do sistema (auth.js).
    let sess = (typeof SESSION !== 'undefined' && SESSION) ? SESSION : null
    if (!sess) { try { sess = (await getSupabase().auth.getSession()).data.session } catch (e) { sess = null } }
    tecnico.id = sess?.user?.id || null
    // Soluço/offline sem uid: cai pro último usuário conhecido do aparelho (mesma pessoa) — assim
    // o app abre offline com o banco certo em vez de travar.
    if (!tecnico.id) { try { tecnico.id = localStorage.getItem('sr_last_uid') || null } catch (e) { /* nada */ } }
    // Sem uid de jeito nenhum: NÃO redireciona offline (técnico não loga sem rede → tela branca/loop);
    // só manda pro login quando há internet pra logar.
    if (!tecnico.id) { if (navigator.onLine) location.href = 'login.html'; return }
    if (!verificarSessaoDia()) return            // app fechado / virou o dia → exige login
    isolarPorUsuario(tecnico.id)   // ANTES de qualquer acesso a IndexedDB/cache
    // Perfil/nome é COSMÉTICO no boot e não pode travar o app offline: getUserRole() faz getUser()
    // (rede), que offline fica re-tentando e pendura o boot → tela branca. Corre contra um timeout.
    const u = await Promise.race([getUserRole().catch(() => null), new Promise(res => setTimeout(() => res(null), 2500))])
    tecnico.nome = tcase(u?.nome || sess?.user?.email?.split('@')[0] || 'Técnico')
    const ftn = document.getElementById('ft-nome'); if (ftn) ftn.textContent = tecnico.nome

    const hello = document.getElementById('home-hello')
    if (hello) hello.textContent = 'Olá, ' + (tecnico.nome || 'técnico')

    bind()
    await carregarRef()
    await limparRascunhosVazios()
    await restaurarTela()
    // Pausa esquecida que cruzou a meia-noite: checa ao abrir e quando o app volta do 2º plano.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { checarVirouDia(); checarPausaEsquecida() } })
    setInterval(() => { window.srStep && window.srStep('  TICK checarVirouDia 5min'); checarVirouDia() }, 5 * 60 * 1000)   // virada do dia com o app aberto → logout
    await checarPausaEsquecida()
  }

  // ── Parte B: pausa esquecida que cruza a meia-noite (checagem ao reabrir o app) ──
  // RAT local AINDA ABERTA (em_andamento) com pausa em aberto (início sem término) de um dia
  // ANTERIOR. Comparação em America/Sao_Paulo por STRING 'YYYY-MM-DD' (nunca new Date('só-data'),
  // que erra em UTC). 100% local (IndexedDB) → funciona offline. Aviso OBRIGATÓRIO (sem fechar).
  const _fmtDiaBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
  const hojeBR = () => _fmtDiaBR.format(new Date())
  const diaBR = (iso) => iso ? _fmtDiaBR.format(new Date(iso)) : null   // iso é instante completo → seguro
  const diaDaRat = (r) => (r.respostas && r.respostas.data) || diaBR(r.criado_em) || hojeBR()
  const pausaAberta = (r) => { const s = r.respostas || {}; return s.pausa === 'Sim' && !!s.pausa_inicio && !s.pausa_termino }
  let _resolvendoPausaEsq = false

  async function checarPausaEsquecida() {
    if (_resolvendoPausaEsq) return
    let pend = []
    try {
      const hoje = hojeBR()
      const rats = await D().listarRats()
      // só RAT do DIA AINDA ABERTO (em_andamento) com pausa em aberto e dia < hoje (BR)
      pend = (rats || []).filter(r => r.status === 'em_andamento' && pausaAberta(r) && diaDaRat(r) < hoje)
    } catch (e) { return }   // melhor-esforço: nunca trava a abertura do app
    if (!pend.length) return
    _resolvendoPausaEsq = true
    try {
      for (const r of pend) {                       // uma de cada vez, em sequência
        const escolha = await mostrarModalPausaEsq(r)
        await aplicarResolucaoPausa(r.client_uuid, escolha)
      }
    } finally { _resolvendoPausaEsq = false }
    if (window.SyncEngine && navigator.onLine) SyncEngine.syncAll()
    mostrar('home'); await renderHome()
  }

  function mostrarModalPausaEsq(rat) {
    return new Promise((resolve) => {
      const no = rat.tarefa_numero != null ? '#' + String(rat.tarefa_numero).padStart(5, '0') : 'avulsa'
      const dia = (diaDaRat(rat) || '').split('-').reverse().join('/')
      const info = document.getElementById('pe-info')
      if (info) info.innerHTML = `RAT <b>${esc(no)}</b> · ${esc(rat.cliente_nome || '—')} · dia <b>${esc(dia)}</b>`
      const m = document.getElementById('modal-pausa-esq')
      const bV = document.getElementById('pe-volto'), bT = document.getElementById('pe-terminei')
      const fechar = (escolha) => { bV.onclick = null; bT.onclick = null; m.classList.remove('open'); resolve(escolha) }
      bV.onclick = () => fechar('volto')
      bT.onclick = () => fechar('terminei')
      m.classList.add('open')
    })
  }

  // Tarefa devolvida: o técnico ESCOLHE entre corrigir a RAT devolvida e abrir RAT nova
  // de hoje (decisão 15/07). O motivo da devolução (chips) orienta; ✕ resolve null (não abre nada).
  function mostrarModalDevolEscolha(t, corrigir, doDia) {
    return new Promise((resolve) => {
      const mot = document.getElementById('de-motivo')
      if (mot) mot.innerHTML = devolMotivoHTML(t) || 'Sem motivo registrado.'
      const dia = (diaDaRat(corrigir) || '').split('-').reverse().join('/')
      const subC = document.getElementById('de-corrigir-sub')
      if (subC) subC.textContent = `RAT de ${dia} — ajustar o que foi apontado`
      // já existe RAT de hoje (1 RAT por tarefa/dia): "nova" vira reabrir a de hoje
      const tN = document.getElementById('de-nova-t'), subN = document.getElementById('de-nova-sub')
      if (tN) tN.textContent = doDia ? 'Abrir a RAT de hoje' : 'Nova RAT de hoje'
      if (subN) subN.textContent = doDia ? 'Continuar o registro do dia de hoje' : 'Registrar novo dia de trabalho'
      const m = document.getElementById('modal-devol-escolha')
      const bC = document.getElementById('de-corrigir'), bN = document.getElementById('de-nova'), bX = document.getElementById('de-x')
      const fechar = (escolha) => { bC.onclick = null; bN.onclick = null; bX.onclick = null; m.classList.remove('open'); resolve(escolha) }
      bC.onclick = () => fechar('corrigir')
      bN.onclick = () => fechar('nova')
      bX.onclick = () => fechar(null)
      m.classList.add('open')
    })
  }

  // Resolve relendo o estado FRESCO (a RAT pode ter sido fechada por sync/pull no meio) — evita
  // falso/duplo. Espelha o ramo 'registrado' do salvar(); descarta o cronômetro da pausa.
  async function aplicarResolucaoPausa(client_uuid, escolha) {
    const fresh = await D().obterRat(client_uuid)
    if (!fresh || fresh.status !== 'em_andamento' || !pausaAberta(fresh)) return
    const rs = { ...(fresh.respostas || {}) }
    const pend = (rs.pausa_pendencia || '').trim()
    // descarta a pausa (término esquecido — não inventa horário)
    delete rs.pausa_inicio; delete rs.pausa_termino; delete rs.pausa_motivo; delete rs.pausa_pendencia
    rs.pausa = 'Não'
    if (escolha === 'volto') {                       // (a) não terminei → Tarefa vai pra Em Pausa (trigger 0069)
      rs.volta_amanha = 'Não'; rs.passagem_motivo = 'volto_depois'
      rs.passagem_falta = pend || 'Atendimento interrompido — pausa não encerrada no dia anterior'
      rs.passagem_levar = null                       // não obrigatório neste caso automático
    } else {                                         // (b) já terminei → encerra SÓ o dia; Tarefa segue Em Execução
      rs.volta_amanha = 'Sim'; rs.passagem_motivo = null; rs.passagem_falta = null; rs.passagem_levar = null
    }
    await D().salvarRat(client_uuid, { status: 'registrado', atendimento_executado: true, respostas: rs })
    await D().definirStatus(client_uuid, D().STATUS.SALVO_LOCAL, escolha === 'volto' ? 'pausa esquecida: volto depois' : 'pausa esquecida: dia concluído')
  }

  // Varredura na abertura: remove rascunhos órfãos (abertos e abandonados sem nenhum
  // conteúdo real — sem respostas, fotos, assinatura ou produtos). Complementa o
  // descarte do cancelar(): cobre quem saiu fechando o navegador no meio.
  async function limparRascunhosVazios() {
    try {
      const rs = await D().listarRats({ status: D().STATUS.RASCUNHO })
      for (const r of rs) {
        if (cur && cur.client_uuid === r.client_uuid) continue
        if (r.tem_foto || r.tem_assinatura || r.questionario_ok || r.respostas || r.uso_produtos) continue
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
    // Texto livre: ao sair do campo, capitaliza a 1a letra de cada frase (alem do autocapitalize do teclado).
    document.addEventListener('focusout', (e) => {
      const el = e.target
      if (!el || !el.matches || !el.matches('textarea,[data-tipo="texto"],.cap-frase')) return
      const v = el.value || ''
      if (!v) return
      const nv = v.replace(/(^\s*|[.!?]\s+)(\p{Ll})/gu, (m, sep, ch) => sep + ch.toUpperCase())
      if (nv !== v) el.value = nv
    })
    // RAT — sempre criada DENTRO de uma Tarefa (não há criação avulsa).
    document.getElementById('btn-cancelar').onclick = cancelar
    // Ação primária: encerrar o dia (Sim, revela o checkpoint) ou registrar visita (Não improdutiva).
    document.getElementById('btn-salvar').onclick = () => {
      var S = window.srStep || function () {}
      S('⟳ click btn-salvar | atendExec=' + atendExec + ' revelarPass=' + revelarPass)
      if (atendExec === 'Não') { S('A: salvar() improdutiva'); return salvar() }
      S('B: pre revelarPass-check')
      if (!revelarPass) {                                        // 1º toque: revela o checkpoint, sem salvar
        S('C: revelarPass=true'); revelarPass = true
        S('D: pre togglePassagem()'); togglePassagem()
        S('E: pre atualizarBtnSalvar()'); atualizarBtnSalvar()
        S('F: pos atualizarBtnSalvar, pre return')
        Promise.resolve().then(function () { S('POST-micro: handler retornou (microtask)') })
        setTimeout(function () { S('POST-macro: handler retornou (macrotask/pos-paint)') }, 0)
        return
      }
      S('G: pre salvar(registrado)'); salvar('registrado')      // caminho "Não": confirma depois do motivo
    }
    // Secundária: salvar parcial e continuar editando hoje (em_andamento).
    document.getElementById('btn-continuar').onclick = () => salvar('em_andamento')
    // Botões do formulário da RAT
    document.getElementById('form-produtos-btn').onclick = abrirModalProd
    document.getElementById('form-fotos-btn').onclick = abrirModalFotos
    document.getElementById('form-desloc-btn').onclick = abrirModalDesloc   // deslocamento DO DIA (pernoite é à parte, na home)
    document.getElementById('dr-x').onclick = fecharModalDesloc
    document.getElementById('dr-ok').onclick = fecharModalDesloc
    document.getElementById('form-pausa-btn').onclick = abrirModalAlmoco
    document.getElementById('pa-x').onclick = fecharModalAlmoco
    document.getElementById('pa-ok').onclick = fecharModalAlmoco
    document.getElementById('fotos-x').onclick = fecharModalFotos
    document.getElementById('fotos-ok').onclick = fecharModalFotos
    document.getElementById('btn-foto').onclick = () => document.getElementById('foto-input').click()
    document.getElementById('foto-input').onchange = (e) => { adicionarFotos(e.target.files); e.target.value = '' }
    const bfg = document.getElementById('btn-foto-gal')
    if (bfg) bfg.onclick = () => document.getElementById('foto-input-gal').click()
    const fig = document.getElementById('foto-input-gal')
    if (fig) fig.onchange = (e) => { adicionarFotos(e.target.files); e.target.value = '' }
    // Modal Produtos da RAT (Voltar e Salvar fecham; tudo persiste na hora)
    document.getElementById('prod-x').onclick = fecharModalProd
    document.getElementById('prod-ok').onclick = fecharModalProd
    document.querySelectorAll('#prod-uso-seg button').forEach(b => { b.onclick = () => responderUsoProd(b.dataset.v) })
    document.getElementById('prod-avulso-btn').onclick = () => { document.getElementById('prod-avulso-form').style.display = ''; document.getElementById('pav-nome').focus() }
    document.getElementById('pav-cancelar').onclick = () => { document.getElementById('prod-avulso-form').style.display = 'none' }
    document.getElementById('pav-add').onclick = adicionarAvulso
    const dtx = document.getElementById('dltec-x'); if (dtx) dtx.onclick = fecharModalTecDl
    const dto = document.getElementById('dltec-ok'); if (dto) dto.onclick = fecharModalTecDl
    const dtb = document.getElementById('dltec-busca'); if (dtb) dtb.oninput = renderDlTecLista
    document.getElementById('tec-x').onclick = fecharModalTecnicos
    document.getElementById('tec-ok').onclick = fecharModalTecnicos
    document.getElementById('tec-busca').oninput = filtrarTecnicos
    const pcb = document.getElementById('prod-cat-busca')
    if (pcb) { pcb.readOnly = true; pcb.onclick = abrirModalBuscaProd }   // campo vira gatilho do modal fullscreen de busca
    const pbb = document.getElementById('pb-busca'); if (pbb) pbb.oninput = renderBuscaProd
    const pbx = document.getElementById('pb-x'); if (pbx) pbx.onclick = fecharModalBuscaProd
    document.getElementById('f-tipo').onchange = onTipoChange
    // Execução é o padrão; marcar "visita improdutiva" troca o modo (recolhe o checkpoint).
    document.getElementById('f-improdutiva-chk').onchange = (e) => { revelarPass = false; setExec(e.target.checked ? 'Não' : 'Sim'); if (e.target.checked) revelarNoForm(document.getElementById('f-exec-nao')) }
    document.querySelectorAll('#f-volta-seg button').forEach(b => { b.onclick = () => { window.srStep && window.srStep('⟳ H-volta: click v=' + b.dataset.v); setVoltaAmanha(b.dataset.v); if (b.dataset.v === 'Sim') { window.srStep && window.srStep('  H-volta: pre salvar'); salvar('registrado') } else { window.srStep && window.srStep('  H-volta: pre revelarNoForm(nao)'); revelarNoForm(document.getElementById('f-passagem-nao')); window.srStep && window.srStep('  H-volta: FIM') } } })
    document.getElementById('btn-voltar-pass').onclick = voltarDoCheckpoint
    document.querySelectorAll('#f-passagem-motivo input[name="f-pass-motivo"]').forEach(r => { r.onchange = () => { var S = window.srStep || function () {}; S('⟳ H-motivo: change v=' + r.value); togglePassagemHandoff(); if (r.value === 'volto_depois') { S('  H-motivo: pre revelarNoForm(handoff)'); revelarNoForm(document.getElementById('f-passagem-handoff')); S('  H-motivo: FIM') } else { S('  H-motivo: FIM (terminei)') } Promise.resolve().then(function () { S('  H-motivo: POST-micro') }); setTimeout(function () { S('  H-motivo: POST-macro (pos-paint)') }, 0) } })
    document.querySelectorAll('#f-motivos input[name="f-motivo"]').forEach(r => { r.onchange = () => { toggleMotivoTexto(); if (r.value === 'outro') revelarNoForm(document.getElementById('f-motivo-texto-wrap')) } })
    // Navegação da home
    document.getElementById('btn-voltar').onclick = onVoltar
    document.getElementById('nav-os').onclick = async () => { mostrar('lista'); await renderLista() }
    document.getElementById('nav-tarefas').onclick = async () => { mostrar('tarefas'); await renderTarefas() }
    document.getElementById('btn-tarefas-sync').onclick = async () => { await renderTarefas(true) }
    const tbq = document.getElementById('tarefas-busca'); if (tbq) tbq.oninput = () => agendarBuscaTarefas(tbq.value)
    const rbq = document.getElementById('rats-busca'); if (rbq) { rbq.oninput = () => { clearTimeout(_ratBuscaT); _ratBuscaT = setTimeout(() => renderLista(), 200) }; rbq.onfocus = () => topUpRats90() }
    document.querySelectorAll('#tabbar .tab').forEach(b => b.onclick = () => irParaTab(b.dataset.tab))
    document.getElementById('btn-nova-tarefa').onclick = () => abrirModalNovaTarefa(false)
    const hnt = document.getElementById('home-nova-tarefa'); if (hnt) hnt.onclick = () => abrirModalNovaTarefa(true)
    document.getElementById('nt-fechar').onclick = () => document.getElementById('modal-nt').classList.remove('open')
    document.getElementById('nt-cancelar').onclick = () => document.getElementById('modal-nt').classList.remove('open')
    document.getElementById('nt-criar').onclick = criarTarefaTecnico
    document.getElementById('btn-iniciar-rat').onclick = () => { if (tarefaAberta) abrirRatDeHoje(tarefaAberta) }
    document.getElementById('btn-concluir').onclick = () => concluirTarefa(false)
    document.getElementById('btn-concluir-pend').onclick = () => concluirTarefa(true)
    document.getElementById('cp-fechar').onclick = () => document.getElementById('modal-conc-pend').classList.remove('open')
    document.getElementById('cp-cancelar').onclick = () => document.getElementById('modal-conc-pend').classList.remove('open')
    document.getElementById('cp-confirmar').onclick = confirmarConcluirPend
    document.getElementById('nav-preorc').onclick = async () => { mostrar('preorc-lista'); await renderPreorcLista() }
    document.getElementById('nav-jornada').onclick = async () => { mostrar('jornada'); await renderJornada() }
    document.getElementById('nav-desloc').onclick = async () => { mostrar('desloc'); await renderDesloc() }
    bindJornada()
    bindDesloc()
    const bsh = document.getElementById('btn-sync-home'); if (bsh) bsh.onclick = () => window.SyncEngine && SyncEngine.syncAll()
    // Pré-orçamento
    document.getElementById('btn-preorc-novo').onclick = novoPreorcUI
    document.getElementById('po-btn-cancelar').onclick = cancelarPreorc
    document.getElementById('po-btn-rascunho').onclick = salvarRascunhoPreorc
    document.getElementById('po-btn-salvar').onclick = concluirPreorc
    document.getElementById('po-desloc').onchange = onDeslocPoChange
    document.getElementById('view-preorc-form').addEventListener('input', atualizarTempoPo)
    document.getElementById('view-preorc-form').addEventListener('input', atualizarEstimativaPo)
    // "Serviço a ser orçado": 1ª letra de cada linha (após "- ") em MAIÚSCULA. No nível do form
    // (delegação) p/ pegar o campo de forma robusta. Troca só 1 caractere/linha → cursor preservado.
    document.getElementById('view-preorc-form').addEventListener('input', (e) => {
      if (!e.target || e.target.id !== 'po-descricao') return
      const ta = e.target, pos = ta.selectionStart
      const novo = ta.value.split('\n').map(l => l.replace(/^(\s*-\s*)?([a-zà-ÿ])/, (m, pre, ch) => (pre || '') + ch.toUpperCase())).join('\n')
      if (novo !== ta.value) { ta.value = novo; try { ta.setSelectionRange(pos, pos) } catch (_) {} }
    })
    document.getElementById('po-prod-add-btn').onclick = poAddItem
    // Produtos: item avulso (fora de catálogo), como na RAT.
    document.getElementById('po-prod-avulso-btn').onclick = () => { const f = document.getElementById('po-prod-avulso-form'); f.style.display = (f.style.display === 'none' || !f.style.display) ? '' : 'none' }
    document.getElementById('po-pav-cancelar').onclick = () => { document.getElementById('po-prod-avulso-form').style.display = 'none' }
    document.getElementById('po-pav-add').onclick = poAddAvulso
    // Item avulso: nome sempre em MAIÚSCULAS (preserva a posição do cursor).
    document.getElementById('po-pav-nome').addEventListener('input', (e) => {
      const s = e.target.selectionStart, en = e.target.selectionEnd
      e.target.value = e.target.value.toUpperCase()
      try { e.target.setSelectionRange(s, en) } catch (_) {}
    })
    // Deslocamento: segmentado Sim/Não (como a RAT) gravando no hidden po-desloc.
    document.querySelectorAll('#po-desloc-seg button').forEach(b => { b.onclick = () => poSetDesloc(b.dataset.v) })
    document.querySelectorAll('#po-pausa-seg button').forEach(b => { b.onclick = () => poSetTevePausa(b.dataset.v) })
    // Edição manual de horários nos modais (fora do #view-preorc-form) recalcula tempo + barras.
    ;['modal-po-desloc', 'modal-po-pausa'].forEach(id => { const m = document.getElementById(id); if (m) m.addEventListener('input', () => { atualizarTempoPo(); atualizarCardsPo(); poTimersRender() }) })
    // Timers Iniciar/Encerrar (igual à RAT) p/ visita, deslocamento, almoço e pausa.
    document.getElementById('view-preorc-form').addEventListener('input', poTimersRender)
    poTimersRender()
    const pf = document.getElementById('po-foto-input')
    document.getElementById('po-btn-foto').onclick = () => pf.click()
    pf.onchange = () => poAddFotos(pf.files)
    // Cards do pré-orçamento abrem modais PRÓPRIOS (curPo) — reusam o visual, não tocam na RAT.
    const poOpen = (id) => { const m = document.getElementById(id); if (m) m.classList.add('open') }
    ;[['po-card-prod', 'modal-po-prod'], ['po-card-fotos', 'modal-po-fotos'], ['po-card-desloc', 'modal-po-desloc'], ['po-card-pausa', 'modal-po-pausa']]
      .forEach(([card, modal]) => { const c = document.getElementById(card); if (c) c.onclick = () => poOpen(modal) })
    document.querySelectorAll('[data-poclose]').forEach(b => b.onclick = () => {
      const m = document.getElementById(b.dataset.poclose); if (m) m.classList.remove('open')
      atualizarCardsPo(); atualizarTempoPo()
    })
    // "Serviço a ser orçado": auto-bullets (mesmo comportamento do campo de serviço da RAT)
    const poServ = document.getElementById('po-descricao')
    if (poServ) {
      poServ.addEventListener('focus', () => { if (!poServ.value.trim()) { poServ.value = '- '; poServ.dispatchEvent(new Event('input', { bubbles: true })) } })
      poServ.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const s = poServ.selectionStart, f = poServ.selectionEnd, v = poServ.value
        poServ.value = v.slice(0, s) + '\n- ' + v.slice(f)
        poServ.selectionStart = poServ.selectionEnd = s + 3
      })
    }
    // A fila (Home) depende de estado do servidor — responsável — que NÃO passa pelo SYNC_MAP de
    // RATs/deslocamentos; logo mudança feita no portal não dispara onSyncChanged. Enquanto a Home
    // estiver visível, atualizamos a fila por conta própria: ao reganhar foco, ao reconectar e a
    // cada 60s. (Propagação via realtime/tombstone em tarefa_tecnicos fica como melhoria futura.)
    const refreshFilaSeHome = () => { if (screen === 'home' && !document.hidden && navigator.onLine) renderFila() }
    document.addEventListener('visibilitychange', refreshFilaSeHome)
    window.addEventListener('online', refreshFilaSeHome)
    setInterval(() => { window.srStep && window.srStep('  TICK refreshFilaSeHome 60s'); refreshFilaSeHome() }, 60 * 1000)
  }

  // ───────────────────── Dados de referência ─────────────────────
  // Online: busca do Supabase e cacheia (localStorage) para uso offline.
  // Offline: usa o cache.
  async function carregarRef() {
    if (navigator.onLine) {
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
    } else {
      // OFFLINE: cache na hora — não toca a rede (re-tentativas do supabase-js penduram o boot = tela branca)
      try { const _c = localStorage.getItem(REF_KEY); if (_c) ref = JSON.parse(_c) } catch (e) { /* nada */ }
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
      const n = tcase(t.nome)
      const rl = t.cargo ? `${t.cargo} · Técnico` : 'Técnico'
      const foto = (typeof avatarUrl === 'function') ? avatarUrl(t.foto_url) : null
      const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))
      return `<label class="tec-row"><input type="checkbox" value="${esc(t.id)}"${souEu ? ' checked' : ''}><span class="av">${av}</span><span class="ti"><span class="nm">${esc(n)}${souEu ? ' (você)' : ''}</span><span class="rl">${esc(rl)}</span></span><span class="pl">+</span></label>`
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

  // Estende a busca de RATs ao SERVIDOR: ao focar a busca, traz as RATs do técnico (RLS titular,
  // tarefas_tecnico_select) dos últimos 90 dias que ainda não estão no aparelho e re-renderiza —
  // depois a busca local (matchRat) cobre tudo, e abrir funciona normal (hidrata os filhos).
  // Bounded: 1 fetch, guardado por 60s; offline cai no que já é local.
  async function topUpRats90() {
    if (!navigator.onLine || (Date.now() - _ratsTopUpAt) < 60000) return
    _ratsTopUpAt = Date.now()
    try {
      const sb = getSupabase()
      const d90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
      const { data, error } = await sb.from('rats').select('*').gte('data_tarefa', d90).order('data_tarefa', { ascending: false }).limit(500)
      if (error) return
      let novas = 0
      for (const row of (data || [])) { try { if (await D().aplicarDoServidor(D().SYNC_MAP.rats.store, row)) novas++ } catch (e) { /* segue */ } }
      if (novas && screen === 'lista') await renderLista()
    } catch (e) { /* offline/erro: a busca segue local */ }
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
    // Subnumeração por tarefa (/01, /02…): usa rat_seq do servidor; se ainda local (não rascunho),
    // ordem de criação. Rascunho NÃO recebe nº (não colide com o /NN do servidor de outra RAT).
    const subLocal = {}
    for (const r of [...rats].filter(r => r.sync_status !== D().STATUS.RASCUNHO).sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''))) {
      (subLocal[r.tarefa_id] = subLocal[r.tarefa_id] || []).push(r.client_uuid)
    }
    const subDe = (r) => { if (r.rat_seq != null) return r.rat_seq; if (r.sync_status === D().STATUS.RASCUNHO) return null; const a = subLocal[r.tarefa_id] || []; const i = a.indexOf(r.client_uuid); return i >= 0 ? i + 1 : null }
    const pad2 = (n) => String(n).padStart(2, '0')
    const tarLabel = (r) => { const n = tarNumeroDe(r); if (n == null) return ''; const s = subDe(r); return 'Tarefa Nº ' + osNo(n) + (s != null ? '/' + pad2(s) : '') + ' · ' }
    const ordenadas = rats.slice().sort((a, b) => prioStatus(tarStatusDe(a)) - prioStatus(tarStatusDe(b)) || (b.criado_em || '').localeCompare(a.criado_em || ''))
    // Mesmo padrão de Tarefas: janela padrão de 14 dias (sempre mostra as em andamento e as
    // não-enviadas) e a BUSCA alcança TODAS as RATs locais (a lista é toda do aparelho).
    const termo = ((document.getElementById('rats-busca') || {}).value || '').trim().toLowerCase()
    const matchRat = (r) => {
      const n = tarNumeroDe(r), s = subDe(r)
      const hay = [r.cliente_nome, (n != null ? osNo(n) : ''), (n != null && s != null ? osNo(n) + '/' + pad2(s) : ''), ratSit(r.status || 'em_andamento')].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(termo)
    }
    const lim14 = _fmtDiaBR.format(new Date(Date.now() - 14 * 86400000))   // 'YYYY-MM-DD' (fuso SP)
    let filtradas, hintTxt = ''
    if (termo) {
      filtradas = ordenadas.filter(matchRat)
      hintTxt = `${filtradas.length} RAT(s) encontrada(s).`
    } else {
      filtradas = ordenadas.filter(r => diaDaRat(r) >= lim14 || r.status === 'em_andamento' || r.sync_status !== D().STATUS.CONFIRMADO)
      const ocultas = ordenadas.length - filtradas.length
      if (ocultas > 0) hintTxt = `Mostrando os últimos 14 dias. Busque por nº ou cliente para ver as ${ocultas} mais antigas.`
    }
    const hint = document.getElementById('rats-busca-hint')
    if (hint) { hint.style.display = hintTxt ? '' : 'none'; hint.textContent = hintTxt }
    if (!filtradas.length) { box.innerHTML = `<p class="dim" style="padding:14px 2px">${termo ? 'Nenhuma RAT encontrada.' : 'Nenhuma RAT nos últimos 14 dias.'}</p>`; return }
    box.innerHTML = filtradas.map(r => {
      const emPausa = pausaAberta(r) && r.status === 'em_andamento'   // pausa aberta nesta RAT (local, imediato)
      const ts = emPausa ? 'em_pausa' : tarStatusDe(r); const sk = SKIN_STATUS[ts] || 'aguard'
      const lc = sk === 'info' ? 'lc-info' : sk === 'done' ? 'lc-done' : sk === 'warn' ? 'lc-warn' : ''
      const syncTxt = r.sync_status === 'confirmado' ? '✓ enviado' : ((BADGE[r.sync_status] || {}).txt || '')
      return `<div class="listcard ${lc}" data-uuid="${esc(r.client_uuid)}"><span class="edge e-${sk}"></span>
        <div class="t"><span class="cli">${esc(r.cliente_nome || 'Sem cliente')}</span><span class="badge b-${sk}">${esc(emPausa ? 'Em pausa' : ratSit(r.status || 'em_andamento'))}</span></div>
        <div class="meta">${tarLabel(r)}<b>${esc(syncTxt)}</b></div>
        <div class="meta" style="display:flex;justify-content:space-between;align-items:center"><span>${fdt(r.criado_em, { withTime: true })}</span><button type="button" class="rat-del" data-del="${esc(r.client_uuid)}" title="Excluir RAT" style="background:none;border:none;cursor:pointer"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m4 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button></div>
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
  // Carrega as tarefas do técnico (RLS já filtra por tarefa_tecnicos) e mescla as criadas
  // offline ainda na fila. Cacheia p/ offline. Popula o global `tarefas` (sem renderizar).
  async function carregarTarefas(force) {
    if (navigator.onLine) {
    try {
      const sb = getSupabase()
      // Janela offline de 14 dias: histórico antigo JÁ RESOLVIDO sai da lista padrão (cache enxuto),
      // mas tarefa ativa/pendente OU sem data NUNCA some (o técnico ainda precisa dela). Histórico
      // mais antigo é alcançável pela busca (3 meses, online). RLS (os_tecnico_sel) já escopa ao técnico.
      const d14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)
      const { data, error } = await sb.from('tarefas')
        .select('id,numero,status,data_agendada,cliente_id,orientacao,observacoes,tipo_servico_id,local_servico,previsao_dias,motivo_devolucao,motivo_devolucao_cats,motivo_devolucao_detalhe,devolvida_em')
        .neq('status', 'faturada')
        .or(`data_agendada.gte.${d14},data_agendada.is.null,status.in.(aguardando_execucao,em_execucao,em_pausa,devolvida)`)
        .order('data_agendada', { ascending: true, nullsFirst: false })
        .order('numero', { ascending: false })
      if (error) throw error
      tarefas = data || []
      localStorage.setItem(TAREFAS_KEY, JSON.stringify(tarefas))
      // Responsáveis das tarefas (a RAT pré-preenche a equipe). RLS 0063: técnico vê os co-responsáveis das tarefas dele.
      const { data: tts } = await sb.from('tarefa_tecnicos').select('tarefa_id,tecnico_id')
      respPorTarefa = {}
      for (const r of (tts || [])) (respPorTarefa[r.tarefa_id] = respPorTarefa[r.tarefa_id] || []).push(r.tecnico_id)
      localStorage.setItem(RESP_KEY, JSON.stringify(respPorTarefa))
    } catch (e) {
      const cache = localStorage.getItem(TAREFAS_KEY)
      tarefas = cache ? JSON.parse(cache) : []
      try { respPorTarefa = JSON.parse(localStorage.getItem(RESP_KEY) || '{}') } catch (_) { respPorTarefa = {} }
      if (force) toast('Offline — mostrando tarefas salvas.', 'info')
    }
    } else {
      // OFFLINE: cache na hora — não toca a rede (re-tentativas penduram o boot)
      const cache = localStorage.getItem(TAREFAS_KEY)
      tarefas = cache ? JSON.parse(cache) : []
      try { respPorTarefa = JSON.parse(localStorage.getItem(RESP_KEY) || '{}') } catch (_) { respPorTarefa = {} }
    }
    // Mescla tarefas criadas offline (ainda na fila) que ainda não vieram do servidor.
    let locais = []
    try { locais = await D().tarefasLocaisPendentes() } catch (e) { /* ignore */ }
    const idsServer = new Set(tarefas.map(t => t.id))
    const extras = locais.filter(l => !idsServer.has(l.id)).map(l => Object.assign({}, l, { numero: null, _local: true }))
    tarefas = extras.concat(tarefas)
    // Ordena por prioridade de status (Em execução → Devolvida → Aguardando → …), depois por data.
    tarefas.sort((a, b) => prioStatus(a.status) - prioStatus(b.status) || (a.data_agendada || '').localeCompare(b.data_agendada || ''))
    return tarefas
  }

  function cardTarefaHTML(t) {
    const ag = t.data_agendada ? 'Agendada ' + fdt(t.data_agendada) : 'Sem data'
    const metaNo = t._local ? '<b>Nova</b> · na fila ↑' : ('Nº <b>' + osNo(t.numero) + '</b>')
    const sk = SKIN_STATUS[t.status]
    const lc = sk === 'info' ? 'lc-info' : sk === 'done' ? 'lc-done' : sk === 'warn' ? 'lc-warn' : ''
    const edge = sk ? `<span class="edge e-${sk}"></span>` : `<span class="edge" style="background:${stCor(t.status)}"></span>`
    const badge = sk ? `<span class="badge b-${sk}">${esc(stLabel(t.status))}</span>` : `<span class="badge" style="background:${stCor(t.status)};color:#fff">${esc(stLabel(t.status))}</span>`
    return `<div class="listcard ${lc}" data-id="${esc(t.id)}">${edge}
        <div class="t"><span class="cli">${esc(cliNomeDe(t.cliente_id))}</span>${badge}</div>
        <div class="meta">${metaNo} · ${esc(ag)}</div>
        ${t.orientacao ? `<div class="t-ori">${esc(t.orientacao)}</div>` : ''}
      </div>`
  }
  function pintarTarefas(box, lista) {
    box.innerHTML = lista.map(cardTarefaHTML).join('')
    box.querySelectorAll('.listcard').forEach(el => el.onclick = () => abrirTarefaDet(el.dataset.id))
  }
  async function renderTarefas(force) {
    const box = document.getElementById('lista-tarefas')
    if (box && !tarefas.length) box.innerHTML = '<p class="dim" style="padding:14px 2px">Carregando…</p>'
    await carregarTarefas(force)
    if (!box) return
    const busca = document.getElementById('tarefas-busca')
    if (busca && busca.value.trim()) return buscarTarefas(busca.value)   // preserva o resultado da busca após um refresh
    const hint = document.getElementById('tarefas-busca-hint'); if (hint) hint.style.display = 'none'
    if (!tarefas.length) { box.innerHTML = '<p class="dim" style="padding:14px 2px">Nenhuma tarefa atribuída a você.</p>'; return }
    pintarTarefas(box, tarefas)
  }

  // Busca de OS. Online: 3 meses no servidor (SELECT na sessão do técnico → RLS os_tecnico_sel
  // escopa a titular+co-responsável; sem service role). Offline: filtra o cache de 14 dias, c/ aviso.
  const matchTarefa = (t, termo) => {
    const hay = [cliNomeDe(t.cliente_id), osNo(t.numero), String(t.numero || ''), t.orientacao, t.local_servico, tipoNomeDe(t.tipo_servico_id)]
      .filter(Boolean).join(' ').toLowerCase()
    return hay.includes(termo)
  }
  let buscaTarTimer = null
  let _ratBuscaT = null
  let _ratsTopUpAt = 0
  function agendarBuscaTarefas(v) { clearTimeout(buscaTarTimer); buscaTarTimer = setTimeout(() => buscarTarefas(v), 250) }
  async function buscarTarefas(termoRaw) {
    const box = document.getElementById('lista-tarefas'), hint = document.getElementById('tarefas-busca-hint')
    if (!box) return
    const termo = (termoRaw || '').trim().toLowerCase()
    if (!termo) { if (hint) hint.style.display = 'none'; pintarTarefas(box, tarefas || []); return }
    if (!navigator.onLine) {
      const res = (tarefas || []).filter(t => matchTarefa(t, termo))
      pintarTarefas(box, res)
      if (hint) { hint.style.display = ''; hint.textContent = `Offline — busca nos últimos 14 dias (${res.length}). Conecte pra buscar 3 meses.` }
      return
    }
    try {
      const sb = getSupabase()
      const d90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
      const { data, error } = await sb.from('tarefas')
        .select('id,numero,status,data_agendada,cliente_id,orientacao,local_servico,tipo_servico_id')
        .neq('status', 'faturada')
        .or(`data_agendada.gte.${d90},data_agendada.is.null`)
        .order('numero', { ascending: false }).limit(300)
      if (error) throw error
      const res = (data || []).filter(t => matchTarefa(t, termo))
      pintarTarefas(box, res)
      if (hint) { hint.style.display = ''; hint.textContent = res.length ? `${res.length} resultado(s) nos últimos 3 meses.` : 'Nenhuma OS encontrada nos últimos 3 meses.' }
    } catch (e) {
      const res = (tarefas || []).filter(t => matchTarefa(t, termo))
      pintarTarefas(box, res)
      if (hint) { hint.style.display = ''; hint.textContent = `Sem servidor — mostrando dos últimos 14 dias (${res.length}).` }
    }
  }

  // ───────────────────── Home — agenda do dia + fila ─────────────────────
  const tipoNomeDe = (id) => (ref.tipos.find(x => x.id === id) || {}).nome || ''
  const LC_SK = { info: 'lc-info', done: 'lc-done', warn: 'lc-warn', pausa: 'lc-pausa' }
  const isHoje = (d) => { if (!d) return false; const x = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d); if (isNaN(x)) return false; const h = new Date(); return x.getFullYear() === h.getFullYear() && x.getMonth() === h.getMonth() && x.getDate() === h.getDate() }
  // RAT do dia (uma por tarefa/dia): reusa a de hoje — inclusive RASCUNHO ainda não enviado —
  // pra "Iniciar RAT" reabrir em vez de criar outra. Não reusa improdutiva (visita fechada à parte).
  const ratDoDiaDe = (rs, tid) => rs.find(r => r.tarefa_id === tid && (r.status === 'em_andamento' || r.status === 'registrado') && isHoje((r.respostas && r.respostas.data) || r.criado_em))
  function estadoAgenda(t, temRatHoje) {
    if (t.status === 'em_execucao') return { sk: 'info', txt: temRatHoje ? 'Atendimento continua' : 'Em execução' }
    if (t.status === 'em_pausa') return { sk: 'pausa', txt: temRatHoje ? 'Atendimento continua' : 'Em pausa — retomar' }
    if (t.status === 'devolvida') { const dd = devolvidaDias(t); return { sk: 'pend', txt: (dd != null && dd >= 1) ? `Devolvida ${devolvidaIdadeTxt(dd)} — corrigir` : 'Devolvida — corrigir' } }
    return { sk: 'aguard', txt: 'Aguardando' }
  }

  async function renderHome() {
    await carregarTarefas()
    updateHomeResumo()
    const ratsLocais = await D().listarRats()
    // (1) Minhas tarefas de hoje: agendada hoje OU em execução (atividade contínua)
    const FECHADAS = ['concluida', 'concluida_pendencia', 'aprovada_faturamento', 'faturada']
    const hoje = (tarefas || []).filter(t => !FECHADAS.includes(t.status) && (isHoje(t.data_agendada) || t.status === 'em_execucao' || t.status === 'em_pausa'))
    const hojeBox = document.getElementById('home-hoje'), hojeCt = document.getElementById('home-hoje-ct')
    if (hojeCt) hojeCt.textContent = hoje.length || ''
    if (hojeBox) {
      hojeBox.innerHTML = !hoje.length
        ? '<div class="home-empty">Nada agendado pra hoje. Pegue uma da fila ou crie uma nova.</div>'
        : hoje.map(t => {
            const temRatHoje = !!ratDoDiaDe(ratsLocais, t.id)
            const e = estadoAgenda(t, temRatHoje)
            const dias = new Set(ratsLocais.filter(r => r.tarefa_id === t.id && r.sync_status !== D().STATUS.RASCUNHO)
              .map(r => (r.respostas && r.respostas.data) || (r.criado_em || '').slice(0, 10)).filter(Boolean)).size
            const multi = t.previsao_dias ? `<div class="tkprog num">Dia ${dias + (temRatHoje ? 0 : 1)} · previsto ~${t.previsao_dias}</div>` : ''
            const sub = [tipoNomeDe(t.tipo_servico_id), t.local_servico].filter(Boolean).join(' · ')
            const orient = t.orientacao ? `<div class="orient"><div class="k">Orientação</div><div class="v">${esc(t.orientacao)}</div></div>` : ''
            return `<div class="listcard ${LC_SK[e.sk] || ''}" data-hoje="${esc(t.id)}"><span class="edge e-${e.sk}"></span>
              <div class="t"><span class="cli">${esc(cliNomeDe(t.cliente_id))}</span></div>
              ${sub ? `<div class="meta">${esc(sub)}</div>` : ''}${multi}${orient}
              <div class="tkact"><span class="badge b-${e.sk}">${esc(e.txt)}</span><span class="tkgo">${temRatHoje ? 'RAT de hoje' : 'Iniciar'} <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span></div>
            </div>`
          }).join('')
      hojeBox.querySelectorAll('[data-hoje]').forEach(el => el.onclick = () => { const t = (tarefas || []).find(x => x.id === el.dataset.hoje); if (t) abrirRatDeHoje(t) })
    }
    // (2) Fila — em função própria: ela se atualiza sozinha (visibilitychange/online/tick no bind()),
    //     já que mudança de responsável no portal não passa pelo SYNC_MAP (RATs/deslocamentos).
    await renderFila()
    // (3) Meu Placar (F2) — fire-and-forget: gate no servidor (painel desligado = invisível)
    //     e cache offline dentro do módulo; NUNCA bloqueia a home.
    try { window.PlacarCard && PlacarCard.montarHome(document.getElementById('home-placar')) } catch (e) { /* placar é opcional */ }
  }

  // Fila — tarefas abertas (sem responsável). Só online (consulta o servidor via RPC).
  // Chamada pelo renderHome e, enquanto a Home estiver à frente, pelos gatilhos do bind()
  // (foco/reconexão/tick): o app de campo não recebe a mudança de responsável pelo sync.
  async function renderFila() {
    const filaBox = document.getElementById('home-fila'), filaCt = document.getElementById('home-fila-ct')
    if (!filaBox) return
    if (!navigator.onLine) { filaBox.innerHTML = '<div class="home-empty">Sem conexão — a fila aparece quando houver internet.</div>'; if (filaCt) filaCt.textContent = ''; return }
    try {
      const { data, error } = await getSupabase().rpc('fila_tarefas')
      if (error) throw error
      const fila = data || []
      if (filaCt) filaCt.textContent = fila.length || ''
      filaBox.innerHTML = !fila.length
        ? '<div class="home-empty">Nenhuma tarefa aberta na fila.</div>'
        : fila.map(t => {
            const sub = [tipoNomeDe(t.tipo_servico_id), t.local_servico].filter(Boolean).join(' · ')
            const orient = t.orientacao ? `<div class="orient"><div class="k">Orientação</div><div class="v">${esc(t.orientacao)}</div></div>` : ''
            return `<div class="listcard lc-info"><span class="edge e-info"></span>
              <div class="t"><span class="cli">${esc(cliNomeDe(t.cliente_id))}</span></div>
              ${sub ? `<div class="meta">${esc(sub)}</div>` : ''}${orient}
              <div class="tkact"><span class="badge b-info">Na fila</span><button class="tkpick" data-pegar="${esc(t.id)}">Pegar</button></div>
            </div>`
          }).join('')
      filaBox.querySelectorAll('[data-pegar]').forEach(b => b.onclick = (e) => { e.stopPropagation(); pegarDaFila(b.dataset.pegar) })
    } catch (e) { filaBox.innerHTML = '<div class="home-empty">Não foi possível carregar a fila.</div>'; if (filaCt) filaCt.textContent = '' }
  }

  // RAT a corrigir numa tarefa DEVOLVIDA: a última RAT registrada/em andamento já
  // existente (a devolução pede CORREÇÃO do que foi enviado — material/foto incluídos —,
  // não uma RAT nova do dia, que abriria vazia).
  const ratParaCorrigir = (rs, tid) => (rs || [])
    .filter(r => r.tarefa_id === tid && r.sync_status !== D().STATUS.RASCUNHO && (r.status === 'registrado' || r.status === 'em_andamento'))
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''))[0]

  // Abre a RAT de hoje da tarefa: reabre a do dia se já existe (local), senão cria.
  async function abrirRatDeHoje(t) {
    const rs = await D().listarRats()
    const doDia = ratDoDiaDe(rs, t.id)
    // Tarefa devolvida pelo admin: o técnico ESCOLHE (decisão 15/07) — corrigir a RAT
    // devolvida (traz material+foto do servidor via hidratarFilhosDevolucao) ou abrir a
    // RAT de hoje (novo dia de trabalho; NÃO destrava a devolução — regra no sync.js).
    if (t.status === 'devolvida') {
      const corrigir = ratParaCorrigir(rs, t.id)
      if (!corrigir) return doDia ? abrirExistente(doDia.client_uuid) : iniciarRatDaTarefa(t)
      // a RAT devolvida É a de hoje: corrigir e "nova de hoje" seriam o mesmo registro
      if (doDia && doDia.client_uuid === corrigir.client_uuid) return abrirExistente(corrigir.client_uuid)
      const escolha = await mostrarModalDevolEscolha(t, corrigir, doDia)
      if (escolha === 'corrigir') return abrirExistente(corrigir.client_uuid)
      if (escolha === 'nova') return doDia ? abrirExistente(doDia.client_uuid) : iniciarRatDaTarefa(t)
      return   // fechou sem escolher
    }
    if (doDia) return abrirExistente(doDia.client_uuid)
    return iniciarRatDaTarefa(t)
  }

  // Pega uma tarefa da fila: vira responsável (RPC) e abre a RAT do dia.
  async function pegarDaFila(tarefaId) {
    try {
      const { error } = await getSupabase().rpc('pegar_tarefa', { p_tarefa: tarefaId })
      if (error) throw error
    } catch (e) {
      return toast((e && e.message && /já tem responsável/.test(e.message)) ? 'Outro técnico já pegou essa tarefa.' : 'Não foi possível pegar a tarefa.', 'err')
    }
    toast('Tarefa atribuída a você.', 'ok')
    await carregarTarefas(true)
    const t = (tarefas || []).find(x => x.id === tarefaId)
    if (t) await abrirRatDeHoje(t); else await renderHome()
  }

  // Abre o modal Nova tarefa. emCampo = atalho da home (corretivo na hora): nasce
  // "Em execução" e já agendada pra hoje, pois o técnico está no local.
  function abrirModalNovaTarefa(emCampo) {
    document.getElementById('nt-cliente').value = ''; document.getElementById('nt-cliente-busca').value = ''
    document.getElementById('nt-tipo').value = ''
    const loc = document.getElementById('nt-local'); if (loc) loc.value = ''
    const hojeISO = new Date().toISOString().slice(0, 10)
    document.getElementById('nt-data').value = emCampo ? hojeISO : ''
    document.getElementById('nt-status').value = emCampo ? 'em_execucao' : 'aguardando_execucao'
    document.getElementById('nt-orientacao').value = ''
    montarNtTecnicos()
    document.getElementById('modal-nt').classList.add('open')
  }

  async function criarTarefaTecnico() {
    const cliId = document.getElementById('nt-cliente').value
    const tipoId = document.getElementById('nt-tipo').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')
    const status = document.getElementById('nt-status').value || 'aguardando_execucao'
    const orientacao = document.getElementById('nt-orientacao').value.trim() || null
    const localServico = (document.getElementById('nt-local') || {}).value
    const tecs = [...document.querySelectorAll('#nt-tecs input:checked')].map(c => c.value)
    if (!tecs.includes(tecnico.id)) tecs.push(tecnico.id)   // o próprio técnico sempre incluso
    // Offline-first: grava na fila local; o SyncEngine envia (tarefa antes das RATs).
    const t = await D().salvarTarefaLocal({
      id: crypto.randomUUID(), cliente_id: cliId, status, tipo_servico_id: tipoId, orientacao,
      local_servico: (localServico || '').trim() || null,
      data_agendada: document.getElementById('nt-data').value || null, criado_por: tecnico.id, tecnicos: tecs,
    })
    document.getElementById('modal-nt').classList.remove('open')
    toast(navigator.onLine ? 'Tarefa criada.' : 'Tarefa criada — será enviada quando houver internet.', 'ok')
    await renderTarefas()
    if (window.SyncEngine && navigator.onLine) window.SyncEngine.syncAll()
    if (navigator.onLine && window.notificarPush && tecs.some(id => id !== tecnico.id)) notificarPush('tarefa_atribuida', { tecnicos: tecs, cliente: cliNomeDe(cliId) })
    await abrirTarefaDet(t.id)
  }

  // Passagem "vou voltar depois pra terminar" em aberto? Olha a RAT mais recente da tarefa que
  // respondeu o checkpoint: se a última foi volta_amanha=Não + motivo volto_depois, o retorno
  // está aberto (serviço não acabou). Não inventa status — usa a passagem já gravada nas respostas.
  function passagemAberta(rats) {
    const comP = (rats || []).filter(r => r.respostas && r.respostas.volta_amanha)
    if (!comP.length) return false
    const chave = (r) => (r.respostas.data || r.data_tarefa || r.criado_em || '')
    comP.sort((a, b) => chave(b).localeCompare(chave(a)))
    const u = comP[0]
    return u.respostas.volta_amanha === 'Não' && u.respostas.passagem_motivo === 'volto_depois'
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
    const dSec = document.getElementById('t-det-devol-sec')
    if (dSec) { if (t.status === 'devolvida' && hasDevol(t)) { document.getElementById('t-det-devol').innerHTML = devolMotivoHTML(t); dSec.style.display = 'block' } else dSec.style.display = 'none' }
    const oSec = document.getElementById('t-det-orient-sec')
    if (t.orientacao) { document.getElementById('t-det-orient').textContent = t.orientacao; oSec.style.display = 'block' } else oSec.style.display = 'none'
    const obSec = document.getElementById('t-det-obs-sec')
    if (t.observacoes) { document.getElementById('t-det-obs').textContent = t.observacoes; obSec.style.display = 'block' } else obSec.style.display = 'none'
    // Tarefa já encerrada p/ o técnico: concluída (com/sem pendência) ou em faturamento.
    // Nessas, não há "Concluir serviço" (já concluiu) nem "Iniciar RAT" (serviço fechado; reabrir é do admin = devolvida).
    const TAREFA_FECHADA = ['concluida', 'concluida_pendencia', 'aprovada_faturamento', 'faturada']
    document.getElementById('btn-iniciar-rat-wrap').style.display = TAREFA_FECHADA.includes(t.status) ? 'none' : 'block'
    // concluir exige ≥1 RAT REGISTRADA (o dia precisa estar fechado; "em andamento" não conta)
    const podeConcluir = !TAREFA_FECHADA.includes(t.status)
    const RAT_FECHADA = ['registrado', 'concluida', 'concluida_pendencia']   // concluida* = histórico
    const todas = await D().listarRats()
    const ratsLocais = (todas || []).filter(r => r.tarefa_id === id)
    let temRat = ratsLocais.some(r => r.sync_status !== D().STATUS.RASCUNHO && RAT_FECHADA.includes(r.status))
    let retAberto = passagemAberta(ratsLocais)
    if (navigator.onLine) {
      window.srCriticalBegin?.()   // 4º site: SIGNED_OUT no select do detalhe (spinner do "Concluir Agora") não navega
      try {
        const { data: srv } = await getSupabase().from('rats')
          .select('respostas,data_tarefa,criado_em,status').eq('tarefa_id', id)
        if (srv) { temRat = temRat || srv.some(r => RAT_FECHADA.includes(r.status)); retAberto = passagemAberta(srv) }   // servidor é autoritativo (vê RAT de coautor)
      } catch (e) { /* offline/erro: mantém o que tem local */ }
      finally { window.srCriticalEnd?.() }
    }
    // Concluir bloqueado se há "retorno em aberto" (RAT marcada como "vou voltar depois pra terminar").
    // O técnico não pode; o admin pode forçar pelo portal (com ciência).
    const liberado = podeConcluir && temRat && !retAberto
    document.getElementById('t-det-concluir').style.display = liberado ? 'flex' : 'none'
    const hintEl = document.getElementById('t-det-concluir-hint')
    if (podeConcluir && !liberado) {
      hintEl.style.display = 'block'
      hintEl.innerHTML = retAberto
        ? 'Esta tarefa tem uma RAT marcada como <b>“retornar para finalizar”</b>. Conclua o retorno antes de finalizar a tarefa.'
        : 'Para concluir o serviço, encerre ao menos uma RAT desta tarefa com <b>todos os campos obrigatórios</b> preenchidos.'
    } else { hintEl.style.display = 'none' }
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
          <span class="chip c-lev">Disponível ${fmt(m.qtd_levada, m.unidade)}</span>
          <span class="chip c-uti">Utilizado ${fmt(m.qtd_utilizada, m.unidade)}</span>
        </div>
      </div>`).join('')
      sec.style.display = 'block'
    } catch (e) { sec.style.display = 'none' }
  }

  // Anexos da tarefa — imagens viram MINIATURA visível (não link); assina todas em lote.
  // Não-imagens (pdf etc.) seguem como linha com ícone. Clicar abre o arquivo assinado.
  async function carregarAnexosDaTarefa(id) {
    const sec = document.getElementById('t-det-anexos-sec')
    const box = document.getElementById('t-det-anexos')
    try {
      const { data } = await getSupabase().from('tarefa_anexos').select('nome,url').eq('tarefa_id', id).order('criado_em')
      if (!data || !data.length) { sec.style.display = 'none'; return }
      const urlByPath = {}
      try {
        const { data: signed } = await getSupabase().storage.from('rat-anexos').createSignedUrls(data.map(a => a.url), 3600)
        ;(signed || []).forEach(s => { if (s && s.signedUrl) urlByPath[s.path] = s.signedUrl })
      } catch (e) { /* offline/erro: cai pro modo link (assina no clique) */ }
      // só formatos que o <img> renderiza (HEIC/HEIF não pintam no Android → ficam como link)
      const ehImg = (n) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n || '')
      box.setAttribute('data-lb-scope', '')   // agrupa só os anexos-imagem no lightbox
      box.innerHTML = data.map((a, i) => {
        const nome = esc(a.nome || 'arquivo')
        const url = urlByPath[a.url]
        return (url && ehImg(a.nome))
          ? `<div class="anx-card" data-lb="${url}" data-lb-cap="${nome}" title="${nome}" style="cursor:zoom-in"><div class="thumb"><img src="${url}" alt="${nome}" loading="lazy"></div><span class="anx-nome">${nome}</span></div>`
          : `<div class="t-det-anx" data-anx="${i}"><span class="anx-ic">${fileIcon(a.nome, 18)}</span><a>${nome}</a></div>`
      }).join('')
      box.querySelectorAll('[data-anx]').forEach(el => el.onclick = async () => {
        const a = data[Number(el.dataset.anx)]
        let url = urlByPath[a.url]
        if (!url) {
          const { data: s, error } = await getSupabase().storage.from('rat-anexos').createSignedUrl(a.url, 120)
          if (error) return toast('Erro ao abrir: ' + error.message, 'err')
          url = s.signedUrl
        }
        window.open(url, '_blank')
      })
      sec.style.display = 'block'
    } catch (e) { sec.style.display = 'none' }
  }

  // Concluir o SERVIÇO (nível Tarefa, deliberado, uma vez) — separado de encerrar a RAT do dia.
  async function concluirTarefa(comPendencia, skipConfirm) {
    if (!tarefaAberta) return
    if (!navigator.onLine) return toast('Sem conexão — conclua o serviço quando estiver online.', 'err')
    if (comPendencia) return abrirModalConcPend()
    if (!skipConfirm && !confirm('Concluir o serviço desta tarefa?\n\nIsso fecha a Tarefa inteira (não só o dia). Se o trabalho continua, use "RAT de hoje".')) return
    const id = tarefaAberta.id
    let up
    window.srCriticalBegin?.()   // guard: SIGNED_OUT durante o update não navega no meio do fluxo
    try {
      up = await getSupabase().from('tarefas').update({ status: 'concluida', pendencias: null }).eq('id', id)
    } finally { window.srCriticalEnd?.() }
    if (up.error) return toast('Erro ao concluir: ' + up.error.message, 'err')
    toast('Serviço concluído.', 'ok')
    await renderTarefas()
    await abrirTarefaDet(id)
  }

  // Modal guiado ao ENCERRAR a RAT do dia (handoff). Dois casos acionáveis:
  //  'pausa'    → "Vou voltar depois": informa que a Tarefa foi pra EM PAUSA (volta a Em Execução
  //               na próxima RAT). Botões: Ir para a Tarefa / Continuar na agenda.
  //  'concluir' → "Terminei o serviço": ALERTA que encerrar a RAT não conclui o serviço e GUIA a
  //               concluir a Tarefa agora (resolve o esquecimento — caso 4773/4774).
  function fecharModalHandoff() { document.getElementById('modal-handoff').classList.remove('open') }
  function abrirModalHandoff(tipo, tId) {
    const ICO = {
      pausa: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
      check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
      clip: '<svg viewBox="0 0 24 24"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/></svg>',
      info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    }
    const box = document.getElementById('hf-box')
    if (tipo === 'pausa') {
      box.innerHTML = `
        <div class="hf-ico hf-pausa">${ICO.pausa}</div>
        <div class="hf-title">RAT finalizada!</div>
        <p class="hf-sub">Você informou que não tem certeza se voltará amanhã para continuar.</p>
        <div class="hf-card hf-card-pausa">${ICO.clip}<span>A Tarefa foi alterada para <b>EM PAUSA</b>.</span></div>
        <div class="hf-info">${ICO.info}<span>Quando você abrir uma nova RAT desta Tarefa, o status volta para <b>EM EXECUÇÃO</b>.</span></div>
        <div class="hf-foot">
          <button class="btn btn-p" id="hf-ir">Ir para a Tarefa</button>
          <button class="btn hf-ghost" id="hf-agenda">Continuar na agenda</button>
        </div>`
      document.getElementById('hf-ir').onclick = async () => { fecharModalHandoff(); await renderTarefas(); if (tId) await abrirTarefaDet(tId) }
    } else {
      box.innerHTML = `
        <div class="hf-ico hf-done">${ICO.check}</div>
        <div class="hf-title">RAT do dia encerrada</div>
        <p class="hf-sub">Encerrar a RAT registra o dia, mas <b>não conclui o serviço</b>. Para concluir, vá até a Tarefa.</p>
        <div class="hf-foot">
          <button class="btn btn-g" id="hf-concluir">Concluir Tarefa Agora</button>
          <button class="btn hf-ghost" id="hf-agenda">Concluir Tarefa Depois</button>
        </div>`
      document.getElementById('hf-concluir').onclick = async () => { fecharModalHandoff(); await renderTarefas(); if (tId) { await abrirTarefaDet(tId); concluirTarefa(false, true) } }
    }
    document.getElementById('hf-agenda').onclick = () => { fecharModalHandoff(); mostrar('home') }
    document.getElementById('modal-handoff').classList.add('open')
  }

  // Modal: concluir com pendência (texto). A tarefa de retorno é decisão do admin no portal.
  function abrirModalConcPend() {
    const t = tarefaAberta; if (!t) return
    document.getElementById('cp-texto').value = (t.pendencias || '').trim()
    document.getElementById('modal-conc-pend').classList.add('open')
  }
  async function confirmarConcluirPend() {
    const t = tarefaAberta; if (!t) return
    if (!navigator.onLine) return toast('Sem conexão — conclua quando estiver online.', 'err')
    const texto = document.getElementById('cp-texto').value.trim()
    if (!texto) return toast('Descreva a pendência.', 'err')
    const up = await getSupabase().from('tarefas').update({ status: 'concluida_pendencia', pendencias: texto }).eq('id', t.id)
    if (up.error) return toast('Erro ao concluir: ' + up.error.message, 'err')
    // Avisa o admin/gestor: como o retorno é gerado no portal, este push é o gatilho pra reagendar.
    if (navigator.onLine && window.notificarPush) {
      notificarPush('tarefa_pendencia', { numero: t.numero, cliente: cliNomeDe(t.cliente_id), tarefa_id: t.id, pendencia: texto.slice(0, 160) })
    }
    document.getElementById('modal-conc-pend').classList.remove('open')
    toast('Serviço concluído com pendência.', 'ok')
    const id = t.id
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
    // RAT nova: pré-marca a equipe da tarefa (responsáveis). Cai pro técnico logado se ainda não carregou.
    respTarefaIds = (respPorTarefa[t.id] && respPorTarefa[t.id].length) ? respPorTarefa[t.id].slice() : [tecnico.id]
    // tarefa entra em execução assim que ganha uma RAT (o servidor confirma via trigger)
    if (t.status === 'aguardando_execucao') t.status = 'em_execucao'
    const rat = await D().novoRat({ tarefa_id: t.id, tarefa_numero: t.numero || null, cliente_id: t.cliente_id || null, cliente_nome: cliNomeDe(t.cliente_id, null), data_tarefa: jorHoje() })
    cur = { client_uuid: rat.client_uuid, campos: [], tarefa_id: t.id, tarefa_numero: t.numero }
    usoProd = null
    const tipoNome = (ref.tipos.find(x => x.id === tipoId) || {}).nome
    // card de contexto: nº da RAT dentro da tarefa + cliente + tipo
    const seqNova = (await D().listarRats()).filter(r => r.tarefa_id === t.id).length
    preencherCtx({
      no: t.numero != null ? `Nº ${osNo(t.numero)}${seqNova ? '/' + String(seqNova).padStart(2, '0') : ''}` : '',
      cliente: cliNomeDe(t.cliente_id), tipo: tipoNome || '', clienteEditavel: false,
      orientacao: t.orientacao || '',
    })
    // cliente vem da tarefa (campo oculto usado no salvar)
    document.getElementById('f-cliente').value = t.cliente_id || ''
    document.getElementById('f-cliente-busca').value = cliNomeDe(t.cliente_id)
    // tipo é SEMPRE da tarefa: o seletor nunca aparece na RAT
    document.getElementById('f-tipo').value = tipoId
    document.getElementById('f-tipo-wrap').style.display = 'none'
    // RAT nova nasce como atendimento executado (Sim); limpa motivo de improdutiva anterior
    document.querySelectorAll('#f-motivos input[name="f-motivo"]').forEach(r => { r.checked = false })
    const mtx = document.getElementById('f-motivo-texto'); if (mtx) mtx.value = ''
    // checkpoint de passagem: começa recolhido e limpo ("volta amanhã?" e os textos)
    revelarPass = false
    voltaAmanha = null
    document.querySelectorAll('#f-volta-seg button').forEach(b => b.classList.remove('on'))
    document.querySelectorAll('#f-passagem-motivo input').forEach(r => { r.checked = false })
    syncMotivoChecked()   // RAT nova: limpa o destaque .checked do motivo (tPH não roda aqui)
    ;['f-passagem-falta', 'f-passagem-levar'].forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
    const pnao = document.getElementById('f-passagem-nao'); if (pnao) pnao.style.display = 'none'
    const pho = document.getElementById('f-passagem-handoff'); if (pho) pho.style.display = 'none'
    const pth = document.getElementById('f-passagem-terminei-hint'); if (pth) pth.style.display = 'none'
    const ic = document.getElementById('f-improdutiva-chk'); if (ic) ic.checked = false   // RAT nova nasce como execução
    toggleMotivoTexto()
    setExec('Sim')
    document.getElementById('campos-container').innerHTML = ''
    mostrar('form')
    // carrega o formulário do tipo da tarefa (ou mostra aviso se a tarefa não tem tipo)
    const formId = (ref.tipos.find(x => x.id === tipoId) || {}).formulario_id || null
    await carregarFormularioPorId(formId)
    // GPS NÃO carimba na abertura do formulário (decisão 14/07): o local é capturado
    // no INÍCIO DA EXECUÇÃO — quando hora_inicio é preenchida (timer ou digitada).
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

  // ── Data automática pra RAT VAZIA reaberta em dia posterior (decisão 14/07, trava tripla) ──
  // RAT 'em_andamento' de dia anterior ganha Data = hoje no PRIMEIRO GESTO de trabalho do dia
  // (coerente com a âncora do GPS v635). AUTOMÁTICO, sem pergunta — mas só com as três travas:
  //  1. "VAZIA" = ausência PROVADA de conteúdo de trabalho: nenhum campo de trabalho respondido
  //     (hora início/término, deslocamento, almoço/pausa, serviço, observações, uso de produtos),
  //     sem foto/assinatura/material E nenhum respostas_ts além do bootstrap da criação
  //     (data/técnicos/veículo). O carimbo por campo (0096) é o juiz: toque de ontem = não é vazia.
  //  2. Dispara no primeiro input/change de campo ≠ 'data' — nunca na abertura do formulário.
  //  3. Transparência: toast + evento na trilha imutável (sync_eventos, padrão da auditoria).
  // Borda da chave (tarefa+dia): se JÁ existe outra RAT desta tarefa com Data = hoje (local ou,
  // online, no servidor), NÃO ajusta e avisa — colisão é decisão humana, não automática.
  const TS_BOOTSTRAP = new Set(['data', 'tecnicos_responsaveis', 'veiculo'])
  const CAMPOS_TRABALHO = ['hora_inicio', 'hora_termino', 'servico_executado', 'observacoes',
    'almoco', 'almoco_inicio', 'almoco_termino', 'pausa', 'pausa_inicio', 'pausa_termino',
    'deslocamento', 'desloc_ida', 'desloc_retorno', 'desloc_inicial_ida', 'desloc_final_ida',
    'desloc_inicial_retorno', 'desloc_final_retorno', 'uso_produtos', 'volta_amanha', 'passagem_motivo']
  async function ratVaziaDeTrabalho(r) {
    const resp = r.respostas || {}
    const tem = (v) => String(v ?? '').trim() !== ''
    if (CAMPOS_TRABALHO.some(k => tem(resp[k]))) return false
    if (Object.keys(r.respostas_ts || {}).some(k => !TS_BOOTSTRAP.has(k))) return false
    if (r.tem_foto || r.tem_assinatura || r.uso_produtos || r.questionario_ok) return false
    try { if ((await D().listarFotos(r.client_uuid)).length) return false } catch (e) { return false }
    try { if ((await D().listarMateriais(r.client_uuid)).length) return false } catch (e) { return false }
    return true
  }
  async function existeOutraRatDaTarefaHoje(tarefaId, hoje, meuUuid) {
    if (!tarefaId) return false
    try {
      const rs = await D().listarRats()
      if ((rs || []).some(x => x.client_uuid !== meuUuid && x.tarefa_id === tarefaId &&
        x.status !== 'improdutiva' && (((x.respostas || {}).data) || null) === hoje)) return true
    } catch (e) {}
    if (navigator.onLine) {
      try {
        const { data } = await getSupabase().from('rats').select('id')
          .eq('tarefa_id', tarefaId).eq('respostas->>data', hoje).neq('client_uuid', meuUuid).limit(1)
        if (data && data.length) return true
      } catch (e) {}   // offline/erro: segue só com a checagem local
    }
    return false
  }
  let ajusteDataVisto = null   // client_uuid já avaliado nesta sessão (avalia UMA vez, no 1º gesto)
  async function ajustarDataRatVazia(campoTocado) {
    try {
      if (!cur || !cur.client_uuid || ajusteDataVisto === cur.client_uuid) return
      ajusteDataVisto = cur.client_uuid
      if (campoTocado === 'data') return   // mexeu na própria Data = decisão explícita dele
      const hoje = jorHoje()
      const r = await D().obterRat(cur.client_uuid)
      if (!r || r.status !== 'em_andamento') return
      const dataRat = (r.respostas || {}).data
      if (!dataRat || dataRat === hoje) return
      if (!(await ratVaziaDeTrabalho(r))) return
      const fmtBR = (s) => String(s).split('-').reverse().join('/')
      if (await existeOutraRatDaTarefaHoje(r.tarefa_id, hoje, cur.client_uuid)) {
        toast(`Já existe RAT de hoje desta tarefa — a Data ficou em ${fmtBR(dataRat)}. Confira antes de preencher.`, 'err')
        return
      }
      const el = document.querySelector('[data-campo="data"]')
      if (el) { el.value = hoje; el.dispatchEvent(new Event('change', { bubbles: true })) }   // autosave leva a Data nova
      await D().definirStatus(cur.client_uuid, D().STATUS.SALVO_LOCAL, `data ajustada automaticamente: ${dataRat} → ${hoje}`)
      toast(`Data ajustada para hoje — ${fmtBR(hoje)}.`, 'ok')
    } catch (e) { /* melhor-esforço: nunca trava o preenchimento */ }
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
    if (secao === 'home') {
      renderHome()
      // voltou pra home = momento natural de ociosidade → deixa o auto-update tentar trocar a versão
      if (typeof window.srTentarUpdate === 'function') { try { window.srTentarUpdate() } catch (e) { /* nada */ } }
    }
    // Rodapé: barra de abas nas telas principais; no formulário da RAT some e aparecem as ações
    // da RAT (Salvar/Encerrar). Esconde a barra também no pré-orçamento (tem ações próprias).
    const tb = document.getElementById('tabbar'), ff = document.getElementById('form-foot')
    const focoForm = (secao === 'form')
    if (ff) ff.style.display = focoForm ? '' : 'none'
    if (tb) {
      tb.style.display = (focoForm || secao === 'preorc-form') ? 'none' : 'flex'
      const ativa = TAB_DE[secao] || TAB_DE[SCREEN_PARENT[secao]] || ''
      tb.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === ativa))
    }
  }

  // Layout do shell é 100% CSS (.field-wrap{height:100dvh} + html,body travados + overscroll-behavior).
  // SEM JS de tamanho: o antigo fitShell brigava com o scroll/rubber-band do iOS (rodapé descolava,
  // tela branca). O iOS cuida do scroll e do teclado nativamente.
  // Traz uma seção recém-revelada (no fim do formulário) pra vista, pra o técnico não precisar rolar
  // pra cima pra achá-la. Chamado nos gatilhos de AÇÃO (não nas funções toggle*, que também rodam na
  // repopulação ao reabrir a RAT — ali não se quer rolar a tela).
  function revelarNoForm(el) {
    window.srStep && window.srStep('  revelarNoForm: entrada (id=' + (el && el.id) + ')')
    // REDE DE SEGURANÇA (hotfix Android, engatilhado): NÃO rola NADA. Replica exatamente o
    // comportamento pré-Patch (antes da v542), em que revelar o checkpoint/handoff era só o
    // display:block feito pelos handlers — SEM scroll — e que NUNCA crashou o Android. O git provou
    // que o gatilho da tela branca é o scroll (o reveal sozinho, sem scroll, sempre funcionou).
    // Sem scroll (nem smooth, nem instantâneo) não há como o animador/compositor derrubar a tela.
    // Os campos revelados aparecem logo abaixo do que o técnico tocou. Mantém TODO o resto (fim do
    // "RAT sumiu", rodapé iOS, indicador de versão, etc.). Se um dia o reveal ficar longe da vista,
    // resolver com layout/âncora — não com scroll programático neste container.
    return
  }
  // Alvo de scroll ciente da plataforma: no Android o DOCUMENTO rola (fix da layer composta de
  // altura cheia — ver Commit 1, html.android em tecnico.html); no iOS/desktop o scroller é o
  // .field-body interno. Único ponto de scroll ativo hoje (revelarNoForm é no-op; o PTR já usa
  // window.scrollY, correto pros dois modelos).
  function scrollerEl() {
    return document.documentElement.classList.contains('android')
      ? (document.scrollingElement || document.documentElement)
      : document.querySelector('.field-body')
  }
  const TAB_DE = { home: 'home', tarefas: 'tarefas', lista: 'lista', desloc: 'desloc', 'tarefa-det': 'tarefas' }
  async function irParaTab(tab) {
    if (screen === tab) { const sc = scrollerEl(); if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' }); return }
    mostrar(tab)   // 'home' já renderiza dentro do mostrar
    const R = { tarefas: renderTarefas, lista: renderLista, desloc: renderDesloc }
    if (R[tab]) { try { await R[tab]() } catch (e) { /* offline: mostra cache */ } }
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
    if (screen === 'home') renderHome()
    else if (screen === 'desloc') renderDesloc()
    else if (screen === 'jornada') renderJornada()
    else if (screen === 'tarefas') renderTarefas()
    else if (screen === 'lista') renderLista()
    else if (screen === 'tarefa-det' && tarefaAberta) abrirTarefaDet(tarefaAberta.id)
  }
  // Terminou um ciclo de envio (tarefas/RATs subiram/sumiram) → atualiza a tela atual.
  window.onSyncDone = () => {
    if (screen === 'home') renderHome()
    else if (screen === 'tarefas') renderTarefas()
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
    trabalho: { ic: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;vertical-align:-2px"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>', lb: 'Trabalho' }, pausa: { ic: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;vertical-align:-2px"><path d="M9 5v14M15 5v14"/></svg>', lb: 'Pausa' },
    almoco: { ic: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;vertical-align:-2px"><path d="M5 3v7a2 2 0 0 0 4 0V3M7 12v9M17 21V3c-1.8 1-3 3.2-3 6 0 2.4 1.2 4 3 4"/></svg>', lb: 'Almoço' }, deslocamento: { ic: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;vertical-align:-2px"><path d="M3 17h2m14 0h2M5 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/><path d="M5 17V8a1 1 0 0 1 1-1h8l4 4v6"/></svg>', lb: 'Deslocamento' },
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
      acoes.innerHTML = `<button class="btn btn-primary" id="jor-trocar" style="flex:1">Trocar atividade</button><button class="btn btn-ghost btn-auto" id="jor-encerrar">Encerrar dia</button>`
      document.getElementById('jor-trocar').onclick = () => abrirSeg('trocar')
      document.getElementById('jor-encerrar').onclick = encerrarDia
    } else {
      now.innerHTML = `<div class="jor-now idle">${segs.length ? 'Dia encerrado.' : 'Nenhuma atividade hoje.'}</div>`
      acoes.innerHTML = `<button class="btn btn-primary" id="jor-iniciar" style="flex:1"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>${segs.length ? 'Iniciar nova atividade' : 'Iniciar dia'}</button>`
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
    if (aberto) jorTick = setInterval(() => { window.srStep && window.srStep('  TICK jorTick 1s'); const el = document.getElementById('jor-cron'); if (el) el.textContent = segDur(aberto.inicio); else { clearInterval(jorTick); jorTick = null } }, 1000)
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

  // ───────────────────── Deslocamento (pernoite): viagem com TRECHOS ─────────────────────
  // Tempo é da pessoa (§8): a participação na viagem deriva dos trechos (a bordo por trecho).
  // Trecho novo herda veículo, direção e passageiros do anterior. GPS é pontual e automático
  // ao marcar saída/chegada (sem botão). Sem km/odômetro/rastreamento contínuo.
  const DL_SENT = { ida: 'Ida', volta: 'Volta', outro: 'Outro' }   // só p/ registros legados
  let dlCur = null            // viagem em edição (cópia de trabalho)
  let dlSnap = null           // roteiro como CARREGADO (snapshot): o auto-save do "Marcar agora" grava
                              // carimbos sobre ele — edição estrutural (remover/alterar trecho) só sobe no Salvar
  let dlModalTrecho = null    // trecho em edição nos modais (destino/veículo/direção)
  let dldirSel = null         // técnico selecionado no modal de direção
  const nowLocal = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
  function getPos() {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null)
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
        () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
    })
  }
  async function refreshGpsRat() {
    const st = document.getElementById('f-gps-status'); if (!st || !cur || !cur.client_uuid) return
    const r = await D().obterRat(cur.client_uuid)
    if (r && r.checkin_lat != null) {
      st.innerHTML = `Local marcado${r.checkin_precisao ? ` (±${r.checkin_precisao} m)` : ''}. <a href="https://www.google.com/maps?q=${r.checkin_lat},${r.checkin_lng}" target="_blank" rel="noopener">ver no mapa</a>`
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
    // cidade em Title Case (cadastros do Omie vêm em CAIXA ALTA); UF sempre maiúscula
    const par = s.match(/([A-Za-zÀ-ÿ0-9 .'-]+?)\s*\(([A-Za-z]{2})\)/)   // Cidade (UF)
    if (par) return { cidade: tcase(par[1].trim()), uf: par[2].toUpperCase() }
    for (const tok of s.split(/[·,]/)) {                                // Cidade/UF
      const m = tok.trim().match(/^(.+?)\/([A-Za-z]{2})$/)
      if (m) return { cidade: tcase(m[1].trim()), uf: m[2].toUpperCase() }
    }
    return null
  }
  const hhmmDe = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  // soma minutos a um "HH:MM" (ex.: término sugerido do almoço = início + 1h)
  const horaMais = (hhmm, min) => { const [h, m] = String(hhmm).split(':').map(Number); if (isNaN(h)) return ''; const t = (h * 60 + (m || 0) + min) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
  const diaLabel = (s) => { try { const [y, m, dd] = String(s).split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) } catch (e) { return s } }
  // distância haversine em metros (validação de proximidade do local)
  function distM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2
    return Math.round(2 * R * Math.asin(Math.sqrt(a)))
  }
  // Locais de clientes (cadastro do portal): destinos de trecho. Cada local sabe
  // de QUAL cliente é — não existe "empresa da viagem"; o cliente é por trecho.
  let locaisTodos = null
  async function carregarLocaisTodos() {
    if (locaisTodos || !navigator.onLine) return locaisTodos || []
    try {
      const { data } = await getSupabase().from('cliente_locais')
        .select('id,cliente_id,nome,cidade,uf,lat,lng').eq('ativo', true).order('nome')
      locaisTodos = data || []
    } catch (e) { return locaisTodos || [] }
    return locaisTodos
  }
  const localDe = (lid) => (locaisTodos || []).find(l => l.id === lid) || null
  const avDe = (tid) => {
    const u = (ref.tecnicos || []).find(x => x.id === tid) || {}
    const n = tcase(u.nome || '—')
    const foto = (typeof avatarUrl === 'function') ? avatarUrl(u.foto_url) : null
    return `<span class="av" title="${esc(n)}">${foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))}</span>`
  }
  const nomeTec = (tid) => tcase(((ref.tecnicos || []).find(x => x.id === tid) || {}).nome || '—')

  function novoTrecho(base) {
    const t = {
      id: D().uuid(), origem: '', destino: '', destino_local_id: null, destino_cliente_id: null, tarefa_id: null,
      almoco_inicio: null, almoco_fim: null,
      data: jorHoje(), saida_em: null, chegada_em: null,
      saida_lat: null, saida_lng: null, saida_precisao: null,
      chegada_lat: null, chegada_lng: null, chegada_precisao: null,
      veiculo_id: null, sem_veiculo: false, nota_transporte: null,
      motoristas: [], tecnicos: [tecnico.id],
    }
    if (base) {   // trecho novo herda veículo, direção, passageiros e data do anterior
      t.veiculo_id = base.veiculo_id; t.sem_veiculo = base.sem_veiculo; t.nota_transporte = base.nota_transporte
      t.tecnicos = [...(base.tecnicos || [])]
      if (base.data) t.data = base.data
      const ult = (base.motoristas || [])[(base.motoristas || []).length - 1]
      t.motoristas = ult ? [{ tecnico_id: ult.tecnico_id, hora_de: null, hora_ate: null }] : []
      const loc = localDe(base.destino_local_id)
      t.origem = loc ? loc.nome : (base.destino || '')
    }
    return t
  }

  // Rótulo do destino de um trecho p/ preencher a origem do próximo (texto/cidade; senão o Local).
  const destinoLabelTrecho = (tr) => { const d = (tr && tr.destino) || ''; if (d) return d; const l = localDe(tr && tr.destino_local_id); return l ? l.nome : '' }
  // Cada trecho (a partir do 2º) herda a origem = destino do anterior, SÓ se a origem estiver vazia
  // (não sobrescreve edição manual). Corrige o par ida→volta do pernoite e dados antigos.
  function sincronizarOrigens() {
    const T = dlCur && dlCur.trechos; if (!T) return
    for (let i = 1; i < T.length; i++) {
      if (!T[i].origem || !String(T[i].origem).trim()) T[i].origem = destinoLabelTrecho(T[i - 1])
      // Técnicos a bordo NÃO re-herdam aqui: a herança acontece na CRIAÇÃO do trecho (novoTrecho).
      // Esvaziar de propósito é permitido (ex.: colega voltou de avião) — vazio persiste, inclusive
      // vindo do servidor via pull. (O fallback de dados antigos não tem mais dado a servir: base auditada.)
    }
  }

  function bindDesloc() {
    // "Nova viagem" é só pra PERNOITE — confirma antes (evita confundir com o desloc do dia, que é na RAT).
    document.getElementById('desloc-novo').onclick = () => { const m = document.getElementById('modal-pernoite'); if (m) m.classList.add('open'); else abrirDeslocNova() }
    const pnSim = document.getElementById('pn-sim'); if (pnSim) pnSim.onclick = () => { document.getElementById('modal-pernoite').classList.remove('open'); abrirDeslocNova() }
    const pnNao = document.getElementById('pn-nao'); if (pnNao) pnNao.onclick = () => document.getElementById('modal-pernoite').classList.remove('open')
    document.getElementById('dl-x').onclick = fecharDesloc
    document.getElementById('dl-cancelar').onclick = fecharDesloc
    document.getElementById('dl-salvar').onclick = salvarDesloc
    document.getElementById('dl-addleg').onclick = () => {
      if (!dlCur) return
      dlCur.trechos.push(novoTrecho(dlCur.trechos[dlCur.trechos.length - 1] || null))
      renderTrechos()
    }
    // Ref. Tarefa do trecho (tarefas em aberto do cliente do destino)
    document.getElementById('dltar-x').onclick = fecharDlModal('modal-dl-tarefa')
    document.getElementById('dltar-ok').onclick = fecharDlModal('modal-dl-tarefa')
    // modais do trecho: destino / veículo / direção
    document.getElementById('dldest-x').onclick = fecharDlModal('modal-dl-dest')
    document.getElementById('dldest-ok').onclick = concluirDlDest
    document.getElementById('dldest-busca').oninput = () => renderDlDestLista()
    document.getElementById('dlveic-x').onclick = fecharDlModal('modal-dl-veic')
    document.getElementById('dlveic-ok').onclick = concluirDlVeic
    document.getElementById('dldir-x').onclick = fecharDlModal('modal-dl-dir')
    document.getElementById('dldir-ok').onclick = fecharDlModal('modal-dl-dir')
    document.getElementById('dldir-add').onclick = addTurnoDirecao
  }
  const fecharDlModal = (id) => () => { document.getElementById(id).classList.remove('open'); renderTrechos() }

  async function abrirDeslocNova() {
    dlSnap = null   // viagem nova: nada no servidor a proteger — auto-save pode gravar o roteiro inteiro (aditivo)
    dlCur = { id: D().uuid(), cliente_id: null, criado_por: tecnico.id, modelo: 'trechos', trechos: [], tarefas: [], almocos: [], observacoes: null }
    // nasce SÓ com a ida — volta e demais trechos entram por "+ Adicionar trecho",
    // que herda veículo/direção/passageiros e origem = destino do anterior
    const ida = novoTrecho(null)
    ida.origem = [ref.base.cidade, ref.base.uf].filter(Boolean).join('/') || 'Base'
    dlCur.trechos.push(ida)
    await abrirDeslocEditor()
  }
  async function abrirDeslocExistente(id) {
    const d = (await D().listarDeslocamentos()).find(x => x.id === id)
    if (!d || !Array.isArray(d.trechos)) return
    dlCur = JSON.parse(JSON.stringify(d))
    dlCur.tarefas = dlCur.tarefas || []
    dlSnap = JSON.parse(JSON.stringify(d))
    await abrirDeslocEditor()
  }
  async function abrirDeslocEditor() {
    dlModalTrecho = null
    carregarLocaisTodos().then(() => renderTrechos())   // nomes dos Locais nos cards
    renderTrechos()
    const obs = document.getElementById('dl-obs')
    if (obs) { obs.value = dlCur.observacoes || ''; obs.oninput = () => { dlCur.observacoes = obs.value.trim() || null } }
    document.getElementById('modal-desloc').classList.add('open')
  }
  function fecharDesloc() { document.getElementById('modal-desloc').classList.remove('open'); dlCur = null; dlSnap = null; dlModalTrecho = null }

  // A DATA do trecho é a única fonte de data: os horários ancoram nela.
  // Fallback pelo dia LOCAL do timestamp (toISOString daria o dia UTC — saída noturna mudaria de dia).
  const diaLocalDe = (iso) => { const x = new Date(iso); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
  const isoNoDia = (dia, hhmm, fallbackIso) => {
    if (!hhmm) return null
    const d = dia || (fallbackIso ? diaLocalDe(fallbackIso) : jorHoje())
    return new Date(`${d}T${hhmm}:00`).toISOString()
  }
  // Limpeza EXPLÍCITA de campo (vs "não mexi"): o merge do servidor trata null como "não mexi"
  // (união preenche vazio); só zera campo listado em t._limpar — senão a limpeza reverte no pull.
  const marcaLimpar = (t, campo, limpou) => {
    const l = new Set(t._limpar || [])
    if (limpou) l.add(campo); else l.delete(campo)
    t._limpar = [...l]
  }
  // chegada "antes" da saída = virou o dia (chegou de madrugada) → soma 1 dia.
  // ESTRITO (<): saída e chegada no MESMO minuto é trecho de 0 min (toque rápido), não +24h.
  const ajustaMadrugada = (t) => {
    if (t.saida_em && t.chegada_em && new Date(t.chegada_em) < new Date(t.saida_em)) {
      t.chegada_em = new Date(new Date(t.chegada_em).getTime() + 86400000).toISOString()
    }
  }
  // ── Ref. Tarefa do TRECHO: tarefas EM ABERTO do cliente do destino dele ──
  const TAREFA_ABERTA = ['aguardando_execucao', 'em_execucao', 'devolvida']
  const tarefaLbl = (t) => `Nº ${osNo(t.numero)} · ${cliNomeDe(t.cliente_id, '—')}`
  const tarefaDe = (id) => (tarefas || []).find(t => t.id === id) || null
  function abrirDlTarefas(i) {
    if (!dlCur) return
    dlModalTrecho = i
    const t = dlCur.trechos[i]; if (!t) return
    const lista = document.getElementById('dltar-lista')
    const abertas = (tarefas || []).filter(x => TAREFA_ABERTA.includes(x.status)
      && (!t.destino_cliente_id || x.cliente_id === t.destino_cliente_id || x.id === t.tarefa_id))
    const SVG_LISTA = '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>'
    lista.innerHTML = (t.tarefa_id ? `<button type="button" class="opt-row" data-tar="">
        <span class="oic"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></span>
        <span class="ot"><span class="on1">Sem tarefa</span><span class="on2">Remover o vínculo deste trecho</span></span>
      </button>` : '')
      + (abertas.map(x => `<button type="button" class="opt-row${t.tarefa_id === x.id ? ' on' : ''}" data-tar="${esc(x.id)}">
          <span class="oic">${SVG_LISTA}</span>
          <span class="ot"><span class="on1">${esc(tarefaLbl(x))}</span><span class="on2">${esc((T_STATUS[x.status] || {}).t || x.status)}${x.orientacao ? ' · ' + esc(String(x.orientacao).slice(0, 60)) : ''}</span></span>
        </button>`).join('')
        || `<div class="prod-empty">${t.destino_cliente_id ? 'Nenhuma tarefa em aberto para o cliente deste destino.' : 'Escolha primeiro o Destino do trecho (cliente da parada).'}</div>`)
    lista.querySelectorAll('[data-tar]').forEach(b => {
      b.onclick = () => {
        t.tarefa_id = b.dataset.tar || null
        marcaLimpar(t, 'tarefa_id', !t.tarefa_id)   // "Sem tarefa" = limpeza explícita (propaga no merge)
        document.getElementById('modal-dl-tarefa').classList.remove('open')
        renderTrechos()
      }
    })
    document.getElementById('modal-dl-tarefa').classList.add('open')
  }

  // GPS pontual automático ao marcar saída/chegada do trecho (sem botão dedicado)
  async function marcarTrecho(i, qual) {
    const t = dlCur && dlCur.trechos[i]; if (!t) return
    if (qual === 'saida' && !t.data) t.data = jorHoje()
    const ag = new Date()
    const hh = `${String(ag.getHours()).padStart(2, '0')}:${String(ag.getMinutes()).padStart(2, '0')}`
    // A virada de madrugada (+1 dia na chegada) NUNCA nasce em silêncio: confirma antes.
    const seria = isoNoDia(t.data, hh)
    if (qual === 'chegada' && t.saida_em && seria && new Date(seria) < new Date(t.saida_em)) {
      if (!confirm(`Saída marcada às ${hhmmDe(t.saida_em)} e chegada agora às ${hh} — confirma que a chegada foi DEPOIS da meia-noite (conta no dia seguinte)?`)) return
    }
    if (qual === 'saida' && t.chegada_em && seria && new Date(seria) >= new Date(t.chegada_em)) {
      if (!confirm(`A chegada deste trecho já está marcada às ${hhmmDe(t.chegada_em)}. Marcar a saída às ${hh} empurra a chegada para o DIA SEGUINTE — está certo? (Se a saída foi antes da chegada, corrija com o escritório.)`)) return
    }
    t[qual + '_em'] = isoNoDia(t.data, hh)   // hora de agora, no DIA do trecho
    ajustaMadrugada(t)
    renderTrechos()   // mostra a hora já; o GPS chega em seguida
    const pos = await getPos()
    if (pos) { t[qual + '_lat'] = pos.lat; t[qual + '_lng'] = pos.lng; t[qual + '_precisao'] = pos.acc }
    renderTrechos()
    // Horário marcado não se perde: salva SÓ o carimbo (data-âncora, hora e GPS) sobre o roteiro
    // como CARREGADO (dlSnap) — nunca o roteiro em edição: remover trecho "só olhando" no editor
    // não pode virar deleção real no servidor via auto-save (trabalho não se apaga sem Salvar).
    const rec = JSON.parse(JSON.stringify(dlSnap || dlCur))
    if (dlSnap) {
      const alvo = rec.trechos.find(x => x.id === t.id)
      const CARIMBO = ['data', 'saida_em', 'chegada_em', 'saida_lat', 'saida_lng', 'saida_precisao', 'chegada_lat', 'chegada_lng', 'chegada_precisao']
      if (alvo) { for (const f of CARIMBO) alvo[f] = t[f] ?? null }
      else rec.trechos.push(JSON.parse(JSON.stringify(t)))   // trecho novo: aditivo, seguro
    }
    rec.tecnicos = [...new Set(rec.trechos.flatMap(x => x.tecnicos || []))]
    rec.saida_em = (rec.trechos[0] || {}).saida_em || null
    await D().salvarDeslocamento(rec)
    dlSnap = dlSnap ? rec : JSON.parse(JSON.stringify(rec))   // próximos carimbos acumulam sobre o que foi salvo
    if (window.SyncEngine) SyncEngine.syncAll()
  }

  // tempo de UM trecho: (chegada − saída) − a REFEIÇÃO do próprio trecho
  // (desconta só a parte que cai dentro do horário do trecho)
  function tempoTrechoMin(t) {
    if (!t || !t.saida_em) return null
    const a = new Date(t.saida_em).getTime()
    const aberto = !t.chegada_em
    const b = aberto ? Date.now() : new Date(t.chegada_em).getTime()
    if (b <= a) return { total: 0, almoco: 0, aberto }
    const dia = t.data || diaLocalDe(t.saida_em)   // dia LOCAL (slice do ISO daria o dia UTC)
    let alm = 0
    if (t.almoco_inicio && t.almoco_fim) {
      const ai = new Date(`${dia}T${t.almoco_inicio}:00`).getTime(), af = new Date(`${dia}T${t.almoco_fim}:00`).getTime()
      alm = Math.max(0, Math.min(b, af) - Math.max(a, ai)) / 60000
    }
    return { total: Math.max(0, Math.round((b - a) / 60000 - alm)), almoco: Math.round(alm), aberto }
  }
  // total da viagem = Σ dos trechos (cada um já líquido da própria refeição)
  function tempoViagemMin(trechos) {
    let total = 0, almoco = 0, aberto = false, temTempo = false
    for (const t of (trechos || [])) {
      const tt = tempoTrechoMin(t)
      if (!tt) continue
      temTempo = true
      if (tt.aberto) aberto = true
      total += tt.total; almoco += tt.almoco
    }
    return { total, bruto: total + almoco, almoco, aberto, temTempo }
  }
  const fmtHm = (m) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`
  function renderDlTotal() {
    const box = document.getElementById('dl-total'); if (!box || !dlCur) return
    const { total, bruto, almoco, aberto, temTempo } = tempoViagemMin(dlCur.trechos)
    if (!temTempo) { box.innerHTML = ''; return }
    box.innerHTML = `<div class="dl-totcard"><span class="k">Tempo de deslocamento${aberto ? ' · em andamento' : ''}</span><span class="v">${fmtHm(total)}</span>
      <span class="s">${almoco ? `${fmtHm(bruto)} marcados − ${fmtHm(almoco)} de refeição` : 'sem refeição descontada'}${aberto ? ' · trecho aberto contando até agora' : ''}</span></div>`
  }

  function noitesPorPessoa() {
    const noites = {}
    const ts = (dlCur && dlCur.trechos) || []
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i], b = ts[i + 1]
      if (!a.data || !b.data || b.data <= a.data) continue
      const n = Math.round((new Date(b.data) - new Date(a.data)) / 86400000)
      const antes = new Set(); ts.slice(0, i + 1).forEach(t => (t.tecnicos || []).forEach(x => antes.add(x)))
      const depois = new Set(); ts.slice(i + 1).forEach(t => (t.tecnicos || []).forEach(x => depois.add(x)))
      for (const tid of antes) if (depois.has(tid)) noites[tid] = (noites[tid] || 0) + n
    }
    return noites
  }

  const SVG_CAR = '<svg viewBox="0 0 24 24"><path d="M3 17h2m14 0h2M5 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/><path d="M5 17V8a1 1 0 0 1 1-1h8l4 4v6"/></svg>'
  const SVG_VOL = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v6.5M4.2 16.5l6-3M19.8 16.5l-6-3"/></svg>'
  const SVG_PIN = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-5.1-7-11a7 7 0 0 1 14 0c0 5.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>'
  const SVG_BED = '<svg viewBox="0 0 24 24"><path d="M3 18v-7a2 2 0 0 1 2-2h9a5 5 0 0 1 5 5v4M3 18h16M3 18v2m16-2v2M7 11V9"/><circle cx="7.5" cy="11.5" r="1.6"/></svg>'
  // resumo do destino/veículo/direção exibido na linha-botão do trecho
  // (cliente do destino é explícito: "BENTELER — Porto Real · Porto Real/RJ")
  const destinoLbl = (t) => {
    const l = localDe(t.destino_local_id)
    if (l) { const cli = cliNomeDe(t.destino_cliente_id, ''); return cli ? `${cli} · ${l.nome}` : l.nome }
    if (t.destino_cliente_id) { const cli = cliNomeDe(t.destino_cliente_id, ''); return cli ? `${cli}${t.destino ? ' · ' + t.destino : ''}` : (t.destino || '') }
    return t.destino || ''
  }
  const veiculoLbl = (t) => {
    if (t.veiculo_id) { const v = (ref.veiculos || []).find(x => x.id === t.veiculo_id); return v ? `${v.modelo || ''} · ${v.placa || ''}` : 'Veículo' }
    return t.nota_transporte ? `Sem veículo da empresa · ${t.nota_transporte}` : ''
  }
  const direcaoLbl = (t) => {
    const ms = t.motoristas || []
    if (!ms.length) return ''
    if (ms.length === 1 && !ms[0].hora_de && !ms[0].hora_ate) return `${nomeTec(ms[0].tecnico_id)} · trecho todo`
    return ms.map(m => `${nomeTec(m.tecnico_id).split(' ')[0]} ${m.hora_de || 'início'}→${m.hora_ate || 'fim'}`).join(' · ')
  }

  function renderTrechos() {
    const box = document.getElementById('dl-trechos'); if (!box || !dlCur) return
    sincronizarOrigens()   // origem de cada trecho = destino do anterior (quando vazia)
    const partes = []
    dlCur.trechos.forEach((t, i) => {
      const loc = localDe(t.destino_local_id)
      // sugestões de origem: base e destino do trecho anterior
      const sugs = []
      const baseLbl = [ref.base.cidade, ref.base.uf].filter(Boolean).join('/') || 'Base'
      sugs.push(baseLbl)
      if (i > 0) { const ant = destinoLbl(dlCur.trechos[i - 1]); if (ant) sugs.push(ant) }
      const sugUnicas = [...new Set(sugs)].filter(s => s && s !== t.origem).slice(0, 4)
      const sugChips = sugUnicas.length ? `<div class="sug-chips">${sugUnicas.map(s => `<button type="button" data-suorig="${i}" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''
      // linhas-botão (modal fullscreen, padrão dos registros da RAT)
      const dest = destinoLbl(t)
      const vei = veiculoLbl(t)
      const dir = direcaoLbl(t)
      const linha = (icone, k, v, data) => `<button type="button" class="dlrow" data-${data}="${i}">
          <span class="ic">${icone}</span>
          <span class="tx"><span class="k">${k}</span><span class="v${v ? '' : ' pend'}">${v ? esc(v) : 'Toque para escolher'}</span></span>
          <span class="chev">›</span></button>`
      const gpsLin = (() => {
        if (t.chegada_lat != null && loc && loc.lat != null && loc.lng != null) {
          return `<div class="lgps">${SVG_PIN}GPS confirmado · chegada a ${distM(t.chegada_lat, t.chegada_lng, loc.lat, loc.lng)} m de ${esc(loc.nome)}</div>`
        }
        if (t.chegada_em && t.chegada_lat == null) return `<div class="lgps off">${SVG_PIN}chegada sem GPS</div>`
        if (t.saida_em && t.saida_lat == null && !t.chegada_em) return `<div class="lgps off">${SVG_PIN}saída sem GPS</div>`
        if (t.saida_lat != null && !t.chegada_em) return `<div class="lgps">${SVG_PIN}GPS da saída marcado (±${esc(String(t.saida_precisao || '?'))} m)</div>`
        return ''
      })()
      const tbx = (qual, lbl) => t[qual + '_em']
        ? `<div class="tbx"><div class="k">${lbl}</div><div class="v">${hhmmDe(t[qual + '_em'])}</div></div>`
        : `<div class="tbx"><div class="k">${lbl}</div><div class="v" style="color:var(--tx3);font-size:12px;font-weight:600">aguardando</div><button type="button" data-marca="${i}:${qual}">Marcar agora</button></div>`
      const cards = (t.tecnicos || []).map(tid => {
        const u = (ref.tecnicos || []).find(x => x.id === tid) || {}
        const n = tcase(u.nome || '—')
        const rl = u.cargo ? `${u.cargo} · Técnico` : 'Técnico'
        const foto = (typeof avatarUrl === 'function') ? avatarUrl(u.foto_url) : null
        const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))
        return `<div class="tec-card"><span class="av">${av}</span><span class="ti"><span class="nm">${esc(n)}</span><span class="rl">${esc(rl)}</span></span><button type="button" class="tc-x" data-bdrem="${i}:${esc(tid)}" title="Remover">×</button></div>`
      }).join('') || '<div class="tec-vazio">Ninguém a bordo ainda.</div>'
      partes.push(`<div class="leg">
        <div class="lh"><span class="ln">${i + 1}</span><span class="route">Trecho ${i + 1}${t.origem || dest ? ` — ${esc(t.origem || '…')} → <span class="to">${esc(dest || '…')}</span>` : ''}</span>${dlCur.trechos.length > 1 ? `<button type="button" class="tc-del" data-delleg="${i}" title="Remover trecho">×</button>` : ''}</div>
        <label class="flab">Origem (de onde sai)</label>
        <input type="text" data-lorigem="${i}" value="${esc(t.origem || '')}" placeholder="Toque numa sugestão ou digite">
        ${sugChips}
        <label class="flab">Data do trecho</label>
        <input type="date" data-ldata="${i}" value="${esc(t.data || '')}">
        <div style="height:9px"></div>
        ${linha(SVG_PIN, 'Destino (para onde vai)', dest, 'mdest')}
        ${(() => { const tr = t.tarefa_id ? tarefaDe(t.tarefa_id) : null; return `<button type="button" class="dlrow" data-mtar="${i}">
          <span class="ic"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg></span>
          <span class="tx"><span class="k">Ref. Tarefa (opcional)</span><span class="v${t.tarefa_id ? '' : ' pend'}">${tr ? esc(tarefaLbl(tr)) : (t.tarefa_id ? 'Tarefa vinculada' : 'Vincular tarefa em aberto do cliente')}</span></span>
          <span class="chev">›</span></button>` })()}
        <label class="flab">A bordo neste trecho</label>
        <div class="tec-cards">${cards}</div>
        <button type="button" class="tec-add-btn" data-bd="${i}">+ Adicionar técnico</button>
        <div style="height:10px"></div>
        ${linha(SVG_CAR, 'Veículo', vei, 'mveic')}
        ${t.veiculo_id
          ? linha(SVG_VOL, 'Motorista — direção (dá pra revezar)', dir, 'mdir')
          : `<button type="button" class="dlrow" data-mdirveic="${i}">
              <span class="ic">${SVG_VOL}</span>
              <span class="tx"><span class="k">Motorista — direção (dá pra revezar)</span><span class="v${t.nota_transporte ? '' : ' pend'}">${t.nota_transporte ? 'Sem veículo da empresa — dispensado' : 'Escolha o veículo da empresa primeiro'}</span></span>
              <span class="chev">›</span></button>`}
        <div style="height:3px"></div>
        <div class="ltimers">${tbx('saida', 'Saída')}${tbx('chegada', 'Chegada')}</div>
        ${gpsLin}
        <label class="flab">Refeição no trecho (opcional)</label>
        <div class="lrow"><input type="time" class="grow" data-lalmini="${i}" value="${esc(t.almoco_inicio || '')}" title="Início da refeição"><input type="time" class="grow" data-lalmfim="${i}" value="${esc(t.almoco_fim || '')}" title="Término da refeição"></div>
        ${(() => { const tt = tempoTrechoMin(t); return tt ? `<div class="leg-tot"><span>Tempo do trecho${tt.aberto ? ' · em andamento' : ''}${tt.almoco ? ` <i>(− ${fmtHm(tt.almoco)} refeição)</i>` : ''}</span><b>${fmtHm(tt.total)}</b></div>` : '' })()}
      </div>`)
      // pernoite sugerido entre trechos de dias diferentes (derivado, ninguém digita)
      const prox = dlCur.trechos[i + 1]
      if (prox && t.data && prox.data && prox.data > t.data) {
        const n = Math.round((new Date(prox.data) - new Date(t.data)) / 86400000)
        const cid = (loc && loc.cidade) ? [loc.cidade, loc.uf].filter(Boolean).join('/') : (dest || '—')
        partes.push(`<div class="between"><span class="pn-chip">${SVG_BED}<span>Pernoite · ${esc(cid)} — ${n} noite${n > 1 ? 's' : ''} <i style="font-weight:600">(derivado)</i></span></span></div>`)
      }
    })
    box.innerHTML = partes.join('')
    // noites por pessoa (derivado da participação nos trechos)
    const noites = noitesPorPessoa()
    const nb = document.getElementById('dl-noites')
    if (nb) nb.innerHTML = Object.keys(noites).length
      ? `<div class="dl-noites">Noites por pessoa (derivado): ${Object.entries(noites).map(([tid, n]) => `${esc(nomeTec(tid))} ${n}`).join(' · ')}</div>` : ''
    // bindings
    const T = dlCur.trechos
    box.querySelectorAll('[data-lorigem]').forEach(el => { el.oninput = () => { T[+el.dataset.lorigem].origem = el.value } })
    box.querySelectorAll('[data-suorig]').forEach(el => { el.onclick = () => { T[+el.dataset.suorig].origem = el.dataset.v; renderTrechos() } })
    box.querySelectorAll('[data-ldata]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.ldata]
        t.data = el.value || t.data || null   // limpar o campo não apaga a data (a âncora dos horários)
        // re-ancora os horários já marcados na nova data (mantém as horas)
        if (t.saida_em) t.saida_em = isoNoDia(t.data, hhmmDe(t.saida_em), t.saida_em)
        if (t.chegada_em) { t.chegada_em = isoNoDia(t.data, hhmmDe(t.chegada_em), t.chegada_em); ajustaMadrugada(t) }
        renderTrechos()
      }
    })
    box.querySelectorAll('[data-mdest]').forEach(el => { el.onclick = () => abrirDlDest(+el.dataset.mdest) })
    box.querySelectorAll('[data-mtar]').forEach(el => { el.onclick = () => abrirDlTarefas(+el.dataset.mtar) })
    box.querySelectorAll('[data-mveic]').forEach(el => { el.onclick = () => abrirDlVeic(+el.dataset.mveic) })
    box.querySelectorAll('[data-mdir]').forEach(el => { el.onclick = () => abrirDlDir(+el.dataset.mdir) })
    box.querySelectorAll('[data-mdirveic]').forEach(el => { el.onclick = () => abrirDlVeic(+el.dataset.mdirveic) })   // sem veículo definido → leva pro veículo
    box.querySelectorAll('[data-marca]').forEach(el => { el.onclick = () => { const [i, q] = el.dataset.marca.split(':'); marcarTrecho(+i, q) } })
    box.querySelectorAll('[data-lalmini]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.lalmini]
        t.almoco_inicio = el.value || null
        marcaLimpar(t, 'almoco_inicio', !el.value)
        // término sugerido: 1h depois (editável); corrige término anterior ao início
        if (el.value && (!t.almoco_fim || t.almoco_fim <= el.value)) { t.almoco_fim = horaMais(el.value, 60); marcaLimpar(t, 'almoco_fim', false) }
        renderTrechos()
      }
    })
    box.querySelectorAll('[data-lalmfim]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.lalmfim]
        if (el.value && t.almoco_inicio && el.value <= t.almoco_inicio) {
          toast('O término da refeição não pode ser antes do início.', 'err')
          t.almoco_fim = horaMais(t.almoco_inicio, 60)
        } else t.almoco_fim = el.value || null
        marcaLimpar(t, 'almoco_fim', !t.almoco_fim)
        renderTrechos()
      }
    })
    box.querySelectorAll('[data-bd]').forEach(el => { el.onclick = () => abrirModalTecDl(+el.dataset.bd) })
    box.querySelectorAll('[data-bdrem]').forEach(el => {
      el.onclick = () => {
        const [i, tid] = el.dataset.bdrem.split(':')
        const t = T[+i]
        t.tecnicos = (t.tecnicos || []).filter(x => x !== tid)
        t.motoristas = (t.motoristas || []).filter(m => m.tecnico_id !== tid)
        t._tecEditado = true   // edição manual: a re-herança não recoloca (trecho pode ficar sem ninguém)
        t._tec_remover = [...new Set([...(t._tec_remover || []), tid])]   // remoção explícita: propaga no merge
        renderTrechos()
      }
    })
    box.querySelectorAll('[data-delleg]').forEach(el => { el.onclick = () => { T.splice(+el.dataset.delleg, 1); renderTrechos() } })
    const pill = document.getElementById('dl-pill')
    if (pill) pill.style.display = T.some(t => t.saida_em && !t.chegada_em) ? '' : 'none'
    renderDlTotal()
  }

  // ── Modal: Destino do trecho (Local do cliente ou texto livre) ──
  function abrirDlDest(i) {
    dlModalTrecho = i
    const t = dlCur.trechos[i]
    document.getElementById('dldest-busca').value = ''
    document.getElementById('dldest-outro').value = t.destino_local_id ? '' : (t.destino || '')
    renderDlDestLista()
    document.getElementById('modal-dl-dest').classList.add('open')
  }
  function renderDlDestLista() {
    const t = dlCur && dlCur.trechos[dlModalTrecho]; if (!t) return
    const q = normStr(document.getElementById('dldest-busca').value || '')
    const lista = document.getElementById('dldest-lista')
    const SVG_PREDIO = '<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M9 8h2m-2 4h2m-2 4h2M15 10h4a1 1 0 0 1 1 1v10"/></svg>'
    const SVG_CASA = '<svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8M5 10v10h14V10M9 20v-6h6v6"/></svg>'
    const cidadeDe = (c) => { const g = c && cidadeUfDeEndereco(c.endereco); return g ? [g.cidade, g.uf].filter(Boolean).join('/') : '' }
    const escolheTexto = (valor, clienteId) => {
      t.destino_local_id = null
      t.destino_cliente_id = clienteId || null
      t.destino = valor
      marcaLimpar(t, 'destino_local_id', true); marcaLimpar(t, 'destino_cliente_id', !t.destino_cliente_id)
      // tarefa vinculada de OUTRO cliente não vale mais para este destino
      if (t.tarefa_id) { const x = tarefaDe(t.tarefa_id); if (!x || x.cliente_id !== t.destino_cliente_id) { t.tarefa_id = null; marcaLimpar(t, 'tarefa_id', true) } }
      document.getElementById('modal-dl-dest').classList.remove('open')
      renderTrechos()
    }
    // Base (a volta quase sempre termina aqui)
    const baseLbl = [ref.base.cidade, ref.base.uf].filter(Boolean).join('/') || 'Base'
    const baseRow = (!q || normStr(`base ${baseLbl}`).includes(q))
      ? `<button type="button" class="opt-row${!t.destino_local_id && t.destino === baseLbl ? ' on' : ''}" data-basedest="1">
          <span class="oic">${SVG_CASA}</span>
          <span class="ot"><span class="on1">Base (Traders)</span><span class="on2">${esc(baseLbl)}</span></span>
        </button>` : ''
    // Locais cadastrados (cada local diz de qual cliente é)
    const locaisRows = (locaisTodos || [])
      .filter(l => !q || normStr(`${l.nome} ${l.cidade || ''} ${cliNomeDe(l.cliente_id, '')}`).includes(q))
      .map(l => `<button type="button" class="opt-row${t.destino_local_id === l.id ? ' on' : ''}" data-loc="${esc(l.id)}">
        <span class="oic">${SVG_PIN}</span>
        <span class="ot"><span class="on1">${esc(cliNomeDe(l.cliente_id, ''))}${cliNomeDe(l.cliente_id, '') ? ' — ' : ''}${esc(l.nome)}</span>${l.cidade ? `<span class="on2">${esc([l.cidade, l.uf].filter(Boolean).join('/'))}${l.lat != null ? ' · valida chegada por GPS' : ''}</span>` : ''}</span>
      </button>`).join('')
    // Empresas (clientes): destino = a sede (cidade do cadastro)
    const empresas = (ref.clientes || [])
      .filter(c => !q || normStr(c.nome || '').includes(q)).slice(0, q ? 8 : 5)
      .map(c => `<button type="button" class="opt-row${!t.destino_local_id && t.destino_cliente_id === c.id ? ' on' : ''}" data-clidest="${esc(c.id)}">
          <span class="oic">${SVG_PREDIO}</span>
          <span class="ot"><span class="on1">${esc(c.nome)}</span><span class="on2">Cliente${cidadeDe(c) ? ' · ' + esc(cidadeDe(c)) : ''}</span></span>
        </button>`).join('')
    lista.innerHTML = (baseRow + locaisRows + empresas)
      || `<div class="prod-empty">Nada encontrado para a busca — digite o destino abaixo.</div>`
    lista.querySelectorAll('[data-basedest]').forEach(b => { b.onclick = () => escolheTexto(baseLbl, null) })
    lista.querySelectorAll('[data-clidest]').forEach(b => {
      b.onclick = () => {
        const c = (ref.clientes || []).find(x => x.id === b.dataset.clidest)
        escolheTexto(cidadeDe(c) || (c && c.nome) || '', c && c.id)
      }
    })
    lista.querySelectorAll('[data-loc]').forEach(b => {
      b.onclick = () => {
        const l = localDe(b.dataset.loc)
        t.destino_local_id = b.dataset.loc
        t.destino_cliente_id = (l && l.cliente_id) || null   // o cliente vem do Local
        t.destino = l ? ([l.cidade, l.uf].filter(Boolean).join('/') || l.nome) : null
        marcaLimpar(t, 'destino_local_id', false); marcaLimpar(t, 'destino_cliente_id', !t.destino_cliente_id)
        if (t.tarefa_id) { const x = tarefaDe(t.tarefa_id); if (!x || x.cliente_id !== t.destino_cliente_id) { t.tarefa_id = null; marcaLimpar(t, 'tarefa_id', true) } }
        document.getElementById('modal-dl-dest').classList.remove('open')
        renderTrechos()
      }
    })
  }
  function concluirDlDest() {
    const t = dlCur && dlCur.trechos[dlModalTrecho]; if (!t) return
    const outro = document.getElementById('dldest-outro').value.trim()
    if (outro) {
      t.destino_local_id = null; t.destino_cliente_id = null; t.destino = outro
      marcaLimpar(t, 'destino_local_id', true); marcaLimpar(t, 'destino_cliente_id', true)   // destino livre: solta o Local
    }
    document.getElementById('modal-dl-dest').classList.remove('open')
    renderTrechos()
  }

  // ── Modal: Veículo do trecho ──
  function abrirDlVeic(i) {
    dlModalTrecho = i
    const t = dlCur.trechos[i]
    document.getElementById('dlveic-outro').value = t.veiculo_id ? '' : (t.nota_transporte || '')
    const lista = document.getElementById('dlveic-lista')
    lista.innerHTML = (ref.veiculos || []).map(v => `<button type="button" class="opt-row${t.veiculo_id === v.id ? ' on' : ''}" data-veic="${esc(v.id)}">
        <span class="oic">${SVG_CAR}</span>
        <span class="ot"><span class="on1">${esc(v.modelo || 'Veículo')}</span><span class="on2">${esc(v.placa || '')}</span></span>
      </button>`).join('') || '<div class="prod-empty">Nenhum veículo cadastrado.</div>'
    lista.querySelectorAll('[data-veic]').forEach(b => {
      b.onclick = () => {
        t.veiculo_id = b.dataset.veic; t.sem_veiculo = false; t.nota_transporte = null
        marcaLimpar(t, 'veiculo_id', false); marcaLimpar(t, 'nota_transporte', true)
        document.getElementById('modal-dl-veic').classList.remove('open')
        // só um a bordo? ele é o motorista (trecho todo) — sem passo extra
        if (!(t.motoristas || []).length && (t.tecnicos || []).length === 1) {
          t.motoristas = [{ tecnico_id: t.tecnicos[0], hora_de: null, hora_ate: null }]
        }
        renderTrechos()
        if (!(t.motoristas || []).length) abrirDlDir(dlModalTrecho)   // já emenda: quem dirige?
      }
    })
    document.getElementById('modal-dl-veic').classList.add('open')
  }
  function concluirDlVeic() {
    const t = dlCur && dlCur.trechos[dlModalTrecho]; if (!t) return
    const outro = document.getElementById('dlveic-outro').value.trim()
    if (outro) {
      t.veiculo_id = null; t.sem_veiculo = true; t.nota_transporte = outro; t.motoristas = []
      marcaLimpar(t, 'veiculo_id', true); marcaLimpar(t, 'nota_transporte', false)   // trocou p/ sem veículo: limpeza explícita
    }
    document.getElementById('modal-dl-veic').classList.remove('open')
    renderTrechos()
  }

  // ── Modal: Direção do trecho (motorista + revezamento) ──
  function abrirDlDir(i) {
    dlModalTrecho = i
    dldirSel = null
    document.getElementById('dldir-hora').value = ''
    renderDlDir()
    document.getElementById('modal-dl-dir').classList.add('open')
  }
  function renderDlDir() {
    const t = dlCur && dlCur.trechos[dlModalTrecho]; if (!t) return
    const ms = t.motoristas || []
    document.getElementById('dldir-turnos').innerHTML = ms.length
      ? ms.map((m, mi) => `<div class="tec-card"><span class="av">${avInner(m.tecnico_id)}</span><span class="ti"><span class="nm">${esc(nomeTec(m.tecnico_id))}</span><span class="rl">${(m.hora_de || m.hora_ate) ? `${esc(m.hora_de || 'da saída')} → ${esc(m.hora_ate || 'até a chegada')}` : 'Trecho todo'}</span></span><button type="button" class="tc-x" data-deldrv="${mi}" title="Remover">×</button></div>`).join('')
      : '<div class="tec-vazio">Ninguém definido ainda — escolha abaixo quem dirigiu.</div>'
    document.getElementById('dldir-add-titulo').textContent = ms.length ? 'Revezamento — quem assumiu' : 'Definir motorista'
    document.getElementById('dldir-hora-wrap').style.display = ms.length ? '' : 'none'
    document.getElementById('dldir-add').textContent = ms.length ? '+ Adicionar revezamento' : '+ Definir como motorista'
    document.getElementById('dldir-tecs').innerHTML = (t.tecnicos || []).map(tid => `<button type="button" class="opt-row${dldirSel === tid ? ' on' : ''}" data-dirtec="${esc(tid)}">
        <span class="oic">${SVG_VOL}</span>
        <span class="ot"><span class="on1">${esc(nomeTec(tid))}</span></span>
      </button>`).join('') || '<div class="prod-empty">Adicione técnicos a bordo primeiro.</div>'
    document.querySelectorAll('#dldir-tecs [data-dirtec]').forEach(b => { b.onclick = () => { dldirSel = b.dataset.dirtec; renderDlDir() } })
    document.querySelectorAll('#dldir-turnos [data-deldrv]').forEach(b => {
      b.onclick = () => {
        t.motoristas.splice(+b.dataset.deldrv, 1)
        const ult = t.motoristas[t.motoristas.length - 1]
        if (ult) ult.hora_ate = null   // o último turno volta a ir até a chegada
        renderDlDir()
      }
    })
  }
  const avInner = (tid) => {
    const u = (ref.tecnicos || []).find(x => x.id === tid) || {}
    const foto = (typeof avatarUrl === 'function') ? avatarUrl(u.foto_url) : null
    return foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(tcase(u.nome || '—')))
  }
  function addTurnoDirecao() {
    const t = dlCur && dlCur.trechos[dlModalTrecho]; if (!t) return
    if (!dldirSel) return toast('Escolha o técnico que dirigiu.', 'err')
    if ((t.motoristas || []).length) {
      const hora = document.getElementById('dldir-hora').value
      if (!hora) return toast('Informe a hora da troca.', 'err')
      t.motoristas[t.motoristas.length - 1].hora_ate = hora   // turnos contíguos
      t.motoristas.push({ tecnico_id: dldirSel, hora_de: hora, hora_ate: null })
    } else {
      t.motoristas = [{ tecnico_id: dldirSel, hora_de: null, hora_ate: null }]   // trecho todo
    }
    dldirSel = null
    document.getElementById('dldir-hora').value = ''
    renderDlDir()
  }

  async function salvarDesloc() {
    if (!dlCur) return
    if (!dlCur.trechos.length) return toast('Adicione ao menos um trecho.', 'err')
    if (!(dlCur.trechos[0].tecnicos || []).length) return toast('Marque quem está a bordo.', 'err')
    for (let i = 0; i < dlCur.trechos.length; i++) {
      const t = dlCur.trechos[i]
      if (!t.data) return toast(`Trecho ${i + 1}: informe a data.`, 'err')   // a data é a âncora dos horários
      if (t.veiculo_id && !(t.motoristas || []).length) {
        // só um a bordo? resolve sozinho (motorista = ele, trecho todo)
        if ((t.tecnicos || []).length === 1) {
          t.motoristas = [{ tecnico_id: t.tecnicos[0], hora_de: null, hora_ate: null }]
          continue
        }
        toast(`Trecho ${i + 1}: defina quem dirigiu (veículo da empresa).`, 'err')
        abrirDlDir(i)   // abre direto onde resolver, em vez de só reclamar
        return
      }
    }
    // cliente "principal" do registro = o do primeiro trecho com cliente (derivado)
    dlCur.cliente_id = (dlCur.trechos.find(t => t.destino_cliente_id) || {}).destino_cliente_id || null
    // tarefas da viagem = união das tarefas dos trechos (derivado)
    dlCur.tarefas = [...new Set(dlCur.trechos.map(t => t.tarefa_id).filter(Boolean))]
    // almoço por pessoa/dia derivado da REFEIÇÃO de cada trecho × quem estava a bordo
    // (um por técnico/dia: o primeiro trecho do dia com refeição vale; o servidor deduplica
    //  de novo contra RATs/outras viagens)
    dlCur.almocos = []
    const visto = new Set()
    for (const t of dlCur.trechos) {
      if (!t.data || !t.almoco_inicio || !t.almoco_fim) continue
      for (const tid of (t.tecnicos || [])) {
        const k = `${tid}|${t.data}`
        if (visto.has(k)) continue
        visto.add(k)
        dlCur.almocos.push({ tecnico_id: tid, dia: t.data, inicio: t.almoco_inicio, fim: t.almoco_fim })
      }
    }
    // derivados p/ a lista local e a leitura "estou a bordo" (união dos trechos)
    dlCur.tecnicos = [...new Set(dlCur.trechos.flatMap(t => t.tecnicos || []))]
    dlCur.saida_em = dlCur.trechos[0].saida_em || null   // só p/ ordenação local
    await D().salvarDeslocamento(dlCur)
    fecharDesloc()
    toast('Deslocamento salvo.', 'ok')
    await renderDesloc()
    if (window.SyncEngine) SyncEngine.syncAll()
  }

  async function renderDesloc() {
    const box = document.getElementById('desloc-lista')
    if (window.SyncEngine) SyncEngine.pullChanges()   // reconcilia c/ servidor (edições/exclusões); re-renderiza via onSyncChanged
    // auto-reparo de viagens que ficaram como "esqueleto" sem trechos (puxadas antes da hidratação)
    try { if (window.SyncEngine && await SyncEngine.repararDeslocViagens()) { /* re-render abaixo já pega o reparo */ } } catch (e) { /* online só */ }
    const lst = await D().listarDeslocamentos()   // offline-first (este aparelho)
    if (!lst.length) { box.innerHTML = '<div class="prod-empty" style="padding:24px 0;text-align:center;color:var(--t-muted)">Nenhuma viagem ainda. Toque em <b>+ Nova viagem</b>.</div>'; return }
    const veicLbl = (id) => { const v = ref.veiculos.find(x => x.id === id); return v ? `${v.modelo || ''} (${v.placa || ''})` : '—' }
    const dt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
    const SK = { ida: 'info', volta: 'done', outro: 'aguard' }
    const btnDescartar = (id) => `<button class="btn btn-auto" data-descartar="${esc(id)}" style="margin-top:8px;font-size:13px;padding:9px 13px;color:#E5403A;border-color:#E5403A"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7"/></svg> Descartar do aparelho</button>`
    box.innerHTML = lst.map(d => {
      const tomb = !!d.tombstoned
      const fila = tomb ? '<span class="badge b-pend">Removido pelo escritório</span>'
        : (d.sync_status !== 'confirmado' ? '<span class="badge b-warn">na fila ↑</span>' : '')
      if (Array.isArray(d.trechos)) {
        // modelo novo: viagem com trechos
        const ts = d.trechos
        const nomes = [...new Set(ts.flatMap(t => t.tecnicos || []))].map(nomeTec).filter(Boolean).join(', ')
        const emViagem = ts.some(t => t.saida_em && !t.chegada_em)
        const fechada = ts.length && ts.every(t => t.chegada_em)
        const badge = tomb ? '' : (emViagem ? '<span class="badge b-warn">Em viagem</span>' : (fechada ? '<span class="badge b-done">Concluída</span>' : '<span class="badge b-info">Planejada</span>'))
        const datas = ts.map(t => t.data).filter(Boolean).sort()
        const per = datas.length ? `${diaLabel(datas[0])}${datas.length > 1 && datas[datas.length - 1] !== datas[0] ? ' → ' + diaLabel(datas[datas.length - 1]) : ''}` : '—'
        const ultimo = ts[ts.length - 1] || {}
        const loc = localDe((ts[0] || {}).destino_local_id)
        const rota = `${esc((ts[0] || {}).origem || '—')} → ${esc(loc ? loc.nome : ((ts[0] || {}).destino || (ultimo.destino || '—')))}`
        const clisVisita = [...new Set([...ts.map(t => t.destino_cliente_id).filter(Boolean), ...(d.cliente_id ? [d.cliente_id] : [])])]
          .map(id => cliNomeDe(id, '')).filter(Boolean)
        return `<div class="listcard${fechada ? ' lc-done' : ''}"${tomb ? '' : ` data-viagem="${esc(d.id)}" style="cursor:pointer"`}><span class="edge e-${tomb ? 'pend' : emViagem ? 'warn' : fechada ? 'done' : 'info'}"></span>
          <div class="t"><span class="cli">${esc(clisVisita.join(' · ') || cliNomeDe(d.cliente_id, '—'))}</span><span style="display:flex;gap:6px;align-items:center">${fila}${badge}</span></div>
          <div class="meta">${rota} · ${ts.length} trecho${ts.length > 1 ? 's' : ''} · ${esc(per)}${(() => { const tv = tempoViagemMin(ts); return tv.temTempo ? ` · <b>${fmtHm(tv.total)}</b>${tv.aberto ? '…' : ''}${tv.almoco ? ' (− refeição)' : ''}` : '' })()}</div>
          <div class="meta">A bordo: ${esc(nomes || '—')}</div>
          ${(d.tarefas || []).length ? `<div class="meta">Ref.: ${esc((d.tarefas).map(id => { const t = (tarefas || []).find(x => x.id === id); return t ? 'Tarefa Nº ' + osNo(t.numero) : null }).filter(Boolean).join(' · ') || d.tarefas.length + ' tarefa(s)')}</div>` : ''}
          ${tomb ? `<div class="meta" style="color:#C0362C">O escritório excluiu esta viagem — ela não será mais enviada. Se quiser, descarte a cópia local.</div>${btnDescartar(d.id)}` : ''}
        </div>`
      }
      // registro legado (1 perna): leitura + marcar chegada, como antes
      const nomes = (d.tecnicos || []).map(id => tcase((ref.tecnicos.find(t => t.id === id) || {}).nome)).filter(Boolean).join(', ')
      const sk = SK[d.sentido] || 'aguard'
      return `<div class="listcard lc-${sk === 'info' ? 'info' : sk === 'done' ? 'done' : ''}"><span class="edge e-${tomb ? 'pend' : sk}"></span>
        <div class="t"><span class="cli">${esc(cliNomeDe(d.cliente_id, '—'))}</span><span style="display:flex;gap:6px;align-items:center">${fila}<span class="badge b-${sk}">${esc(DL_SENT[d.sentido] || d.sentido)}</span></span></div>
        <div class="meta">${esc(d.origem || '—')} → ${esc(d.destino || '—')} · ${esc(veicLbl(d.veiculo_id))}</div>
        <div class="meta">Saída <b>${dt(d.saida_em)}</b>${d.saida_lat ? ' · GPS' : ''}${d.chegada_em ? ` · Chegada <b>${dt(d.chegada_em)}</b>${d.chegada_lat ? ' · GPS' : ''}` : ''}</div>
        <div class="meta">A bordo: ${esc(nomes || '—')}</div>
        ${tomb ? `<div class="meta" style="color:#C0362C">O escritório excluiu este trajeto — ele não será mais enviado.</div>${btnDescartar(d.id)}` : ''}
        ${!tomb && !d.chegada_em ? `<button class="btn btn-ok btn-auto" data-chegada="${esc(d.id)}" style="margin-top:8px;font-size:13px;padding:9px 13px"><svg viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg> Marcar chegada agora</button>` : ''}
      </div>`
    }).join('')
    box.querySelectorAll('[data-chegada]').forEach(b => b.onclick = (e) => { e.stopPropagation(); marcarChegada(b.dataset.chegada) })
    box.querySelectorAll('[data-viagem]').forEach(c => { c.onclick = () => abrirDeslocExistente(c.dataset.viagem) })
    box.querySelectorAll('[data-descartar]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation()
      if (!confirm('Descartar esta cópia do aparelho? O registro já foi excluído pelo escritório.')) return
      await D().removerDeslocamento(b.dataset.descartar)
      renderDesloc()
    })
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

  // Reabrir RAT sincronizada (ex.: tarefa DEVOLVIDA pelo admin): material/foto moram em
  // tabelas-filhas que não vêm no pull → traz do servidor pro local, senão a RAT reabre sem
  // produto/foto. Só quando NÃO há trabalho local pendente (não clobbera edição em andamento).
  const _PEND_LOCAL = new Set(['rascunho', 'salvo_local', 'na_fila', 'enviando', 'erro'])
  async function hidratarFilhosDevolucao(rat) {
    if (!navigator.onLine || _PEND_LOCAL.has(rat.sync_status)) return
    try {
      const sb = getSupabase(); if (!sb) return
      let ratId = rat.id
      if (!ratId) { const { data: rr } = await sb.from('rats').select('id').eq('client_uuid', rat.client_uuid).maybeSingle(); ratId = rr && rr.id }
      if (!ratId) return
      const [mres, fres] = await Promise.all([
        sb.from('materiais').select('id,produto_id,codigo_produto,descricao,quantidade,criado_em,created_by,device_id').eq('rat_id', ratId).eq('origem', 'usado'),
        sb.from('relatorio_fotos').select('id,url,legenda,criado_em').eq('rat_id', ratId),
      ])
      await D().hidratarMateriaisDaRat(rat.client_uuid, mres.data || [])
      let fotos = fres.data || []
      if (fotos.length) {
        const paths = fotos.map(f => f.url).filter(Boolean)
        const { data: signed } = await sb.storage.from('rat-anexos').createSignedUrls(paths, 3600)
        const sig = {}; (signed || []).forEach(s => { if (s && s.signedUrl) sig[s.path] = s.signedUrl })
        fotos = fotos.map(f => ({ ...f, signedUrl: sig[f.url] || null }))
      }
      await D().hidratarFotosDaRat(rat.client_uuid, fotos)
    } catch (e) { /* melhor-esforço: se falhar, mostra o que houver local */ }
  }

  async function abrirExistente(client_uuid) {
    const rat = await D().obterRat(client_uuid)
    if (!rat) return
    await hidratarFilhosDevolucao(rat)   // devolução/admin: traz material+foto do servidor (não vêm no pull)
    cur = { client_uuid, campos: [], tarefa_id: rat.tarefa_id || null, tarefa_numero: rat.tarefa_numero || null }
    await precarregarLevados()   // restaura o plano da tarefa (orçada/disponibilizada) que a hidratação não traz
    usoProd = rat.uso_produtos || (rat.respostas && rat.respostas.uso_produtos) || null
    const cb = document.getElementById('f-cliente-busca')
    // tipo é da Tarefa (não da RAT): busca pelo vínculo da tarefa, só para exibir
    const tarefaDela = tarefas.find(x => x.id === rat.tarefa_id)
    const tipoNomeR = (ref.tipos.find(x => x.id === (tarefaDela ? tarefaDela.tipo_servico_id : null)) || {}).nome
    const numR = (tarefaDela && tarefaDela.numero != null) ? tarefaDela.numero : rat.tarefa_numero
    const subR = (rat.rat_seq != null) ? '/' + String(rat.rat_seq).padStart(2, '0') : ''
    preencherCtx({
      no: rat.tarefa_id ? (numR != null ? `Nº ${osNo(numR)}${subR}` : 'na fila ↑') : '',
      cliente: (ref.clientes.find(c => c.id === rat.cliente_id) || {}).nome || rat.cliente_nome || '—',
      tipo: tipoNomeR || '', clienteEditavel: !rat.tarefa_id,
      orientacao: (tarefaDela && tarefaDela.orientacao) || '',
      devol: (tarefaDela && tarefaDela.status === 'devolvida') ? tarefaDela : null,
    })
    document.getElementById('f-cliente').value = rat.cliente_id || ''
    cb.value = (ref.clientes.find(c => c.id === rat.cliente_id) || {}).nome || rat.cliente_nome || ''
    cb.readOnly = false
    document.getElementById('f-tipo-wrap').style.display = 'none'
    const improd = rat.status === 'improdutiva' || rat.atendimento_executado === false
    // RAT registrada reabre com o checkpoint visível; em_andamento/histórico, recolhido.
    const reabreStatus = (rat.status === 'em_andamento' || rat.status === 'registrado') ? rat.status : 'em_andamento'
    revelarPass = (!improd && reabreStatus === 'registrado')
    // Checkpoint de passagem salvo (relevante quando a RAT foi registrada)
    const rs0 = rat.respostas || {}
    if (!improd && reabreStatus === 'registrado' && rs0.volta_amanha) {
      setVoltaAmanha(rs0.volta_amanha)
      if (rs0.volta_amanha === 'Não' && rs0.passagem_motivo) {
        const mr = document.querySelector(`#f-passagem-motivo input[value="${CSS.escape(rs0.passagem_motivo)}"]`)
        if (mr) mr.checked = true
        togglePassagemHandoff()
      }
      const ff = document.getElementById('f-passagem-falta'); if (ff) ff.value = rs0.passagem_falta || ''
      const fl = document.getElementById('f-passagem-levar'); if (fl) fl.value = rs0.passagem_levar || ''
    } else {
      voltaAmanha = null
      document.querySelectorAll('#f-volta-seg button').forEach(b => b.classList.remove('on'))
    }
    // Eixo "atendimento executado?" e motivo (visita improdutiva)
    if (improd && rat.motivo_improdutiva) {
      const mr = document.querySelector(`#f-motivos input[value="${CSS.escape(rat.motivo_improdutiva)}"]`)
      if (mr) mr.checked = true
      document.getElementById('f-motivo-texto').value = rat.motivo_texto || ''
      toggleMotivoTexto()
    }
    const ic = document.getElementById('f-improdutiva-chk'); if (ic) ic.checked = improd
    setExec(improd ? 'Não' : 'Sim')
    // pré-marca a equipe da tarefa (a seleção salva da RAT, repopulada abaixo, ainda prevalece)
    respTarefaIds = (respPorTarefa[rat.tarefa_id] && respPorTarefa[rat.tarefa_id].length) ? respPorTarefa[rat.tarefa_id].slice() : [tecnico.id]
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
      tecPart = (rat.respostas.tecnicos_part && typeof rat.respostas.tecnicos_part === 'object') ? { ...rat.respostas.tecnicos_part } : {}
    }
    atualizarTempo()
    aplicarCondicionais()
    montarTimers()   // re-render: reflete as horas repopuladas
    sincronizarSegmentados()
    atualizarResumoTecnicos()
    atualizarResumoAlmoco()
    atualizarBadgeDesloc()
    atualizarBadgeProd()
    atualizarProgresso()
    mostrar('form')
    document.getElementById('ft-title').textContent = 'Editar RAT'
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
    tecPart = {}   // horários por técnico: recomeça com o formulário (abrirExistente repõe depois)
    const form = formId ? ref.formularios[formId] : null
    if (!form) { cont.innerHTML = formId ? '<p class="dim">Formulário não encontrado.</p>' : '<p class="dim">Esta tarefa não tem tipo de serviço/formulário configurado — peça ao administrativo.</p>'; return }
    cur.campos = form.campos || []
    cont.innerHTML = ''
    for (const c of cur.campos) cont.appendChild(renderCampo(c))
    organizarCamposForm()   // ordem cronológica + almoço no modal
    const sc = cont.querySelector('canvas.sig-pad')
    if (sc) { sig = initSignature(sc); sig.resize() }
    const onFormChange = (e) => { var S = window.srStep || function () {}; S('⟳ onFormChange (campo=' + (e && e.target && e.target.getAttribute && e.target.getAttribute('data-campo')) + ')'); S('  oFC: aplicarEspelhos'); aplicarEspelhos(e); S('  oFC: atualizarTempo'); atualizarTempo(); S('  oFC: aplicarCondicionais'); aplicarCondicionais(); S('  oFC: atualizarResumoAlmoco'); atualizarResumoAlmoco(); S('  oFC: atualizarBadgeDesloc'); atualizarBadgeDesloc(); S('  oFC: atualizarProgresso'); atualizarProgresso(); S('  oFC: timersRender'); if (timersRender) timersRender(); const w = e.target.closest && e.target.closest('[data-field]'); if (w) w.classList.remove('campo-erro'); S('  oFC: agendarAutosave'); agendarAutosave(); const cid = e.target && e.target.getAttribute && e.target.getAttribute('data-campo'); if (cid === 'pausa' || cid === 'pausa_inicio' || cid === 'pausa_termino') agendarPersistPausa(); S('  oFC: FIM') }
    cont.oninput = onFormChange
    cont.onchange = onFormChange
    // 1º gesto de trabalho do dia → avalia o ajuste automático da Data (RAT vazia de dia anterior)
    if (!cont.dataset.dataHook) {
      cont.dataset.dataHook = '1'
      cont.addEventListener('input', (e) => {
        const c = e.target && e.target.getAttribute && e.target.getAttribute('data-campo')
        ajustarDataRatVazia(c)
      }, true)
    }
    const dCont = document.getElementById('desloc-campos')
    if (dCont) { dCont.oninput = onFormChange; dCont.onchange = onFormChange }
    const pCont = document.getElementById('pausa-campos')
    if (pCont) { pCont.oninput = onFormChange; pCont.onchange = onFormChange }
    atualizarTempo()
    aplicarCondicionais()
    montarTimers()
    await refreshThumbs()
    await refreshGpsRat()
    // GPS = momento do INÍCIO DA EXECUÇÃO: carimba quando hora_inicio ganha valor
    // (pelo botão "Iniciar atendimento" ou digitada à mão). Primeira captura vence.
    const hiGps = document.querySelector('[data-campo="hora_inicio"]')
    if (hiGps && !hiGps.dataset.gpsHook) {
      hiGps.dataset.gpsHook = '1'
      hiGps.addEventListener('change', () => { if (hiGps.value) capturarGpsAuto() })
    }
    atualizarBadgeProd()
  }

  // ── Timer de atendimento: Iniciar/Encerrar preenche hora_inicio/hora_termino ──
  // Só aparece quando o formulário tem esses campos (ids estáveis usados no calcTempo).
  // O técnico continua podendo editar as horas manualmente nos campos.
  // ── Timers Iniciar/Encerrar/Reabrir para pares de horário ──
  // Atendimento (no formulário), Almoço e Pausa (modal Pausa), Ida e Retorno
  // (modal Deslocamento). Cada barra preenche os campos de hora do par e permite
  // DESFAZER o início e REABRIR depois de encerrado (imprevistos no caminho).
  // A barra só aparece quando o formulário tem os dois campos do par.
  let timersTick = null
  let timersRender = null
  function montarTimers() {
    document.querySelectorAll('.atd-timer').forEach(el => el.remove())
    if (timersTick) { clearInterval(timersTick); timersTick = null }
    timersRender = null
    if (!cur || !cur.campos || !cur.campos.length) return
    const $c = (id) => document.querySelector(`[data-campo="${CSS.escape(id)}"]`)
    // a barra fica logo ACIMA do campo inicial do par (form ou modal) e
    // acompanha a visibilidade dele (revelação progressiva Sim/Não)
    const antesDoCampo = (id) => (bar) => { const w = wrapDe(id); if (!w) return; const host = w.closest('.fg-row') || w; if (host.parentNode) host.parentNode.insertBefore(bar, host) }
    const DEFS = [
      { ini: 'hora_inicio', fim: 'hora_termino', lb: 'atendimento', gps: true, mount: antesDoCampo('hora_inicio') },
      { ini: 'almoco_inicio', fim: 'almoco_termino', lb: 'almoço', mount: antesDoCampo('almoco_inicio') },
      { ini: 'pausa_inicio', fim: 'pausa_termino', lb: 'pausa', mount: antesDoCampo('pausa_inicio') },
      { ini: 'desloc_inicial_ida', fim: 'desloc_final_ida', lb: 'ida', mount: antesDoCampo('desloc_inicial_ida') },
      { ini: 'desloc_inicial_retorno', fim: 'desloc_final_retorno', lb: 'retorno', mount: antesDoCampo('desloc_inicial_retorno') },
    ]
    const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
    const decorrido = (ini) => {
      const [h, m] = String(ini).split(':').map(Number)
      if (isNaN(h) || isNaN(m)) return ''
      const d = new Date(); let t = (d.getHours() * 60 + d.getMinutes()) - (h * 60 + m)
      if (t < 0) t += 1440
      return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
    }
    const disparar = (el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
    const SVGP = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>'
    const SVGS = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'
    const SVGU = '<svg viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.6L3 13"/></svg>'
    const bars = []
    for (const d of DEFS) {
      if (!$c(d.ini) || !$c(d.fim)) continue
      const bar = document.createElement('div')
      bar.className = 'atd-timer'
      d.mount(bar)
      bars.push({ d, bar })
    }
    if (!bars.length) return
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
    function renderBar({ d, bar }) {
      window.srStep && window.srStep('    renderBar: ' + d.lb)
      if (!document.body.contains(bar)) return
      const wIni = wrapDe(d.ini)
      bar.style.display = (!wIni || wIni.style.display === 'none') ? 'none' : ''
      if (bar.style.display === 'none') return
      const vi = ($c(d.ini) || {}).value || '', vf = ($c(d.fim) || {}).value || ''
      if (!vi) {
        bar.className = 'atd-timer'
        bar.innerHTML = `<div class="tt">${cap(d.lb)} ainda não iniciado</div><button type="button" class="go">${SVGP}Iniciar ${esc(d.lb)}</button>`
        bar.querySelector('.go').onclick = () => {
          const el = $c(d.ini); if (!el) return
          el.value = hhmm(); disparar(el)
          // almoço: já sugere o término 1h depois (editável/reabrível)
          if (d.lb === 'almoço') { const ef = $c(d.fim); if (ef && !ef.value) { ef.value = horaMais(el.value, 60); disparar(ef) } }
          if (d.gps) capturarGpsAuto(); renderAll()
        }
      } else if (!vf) {
        bar.className = 'atd-timer run'
        bar.innerHTML = `<div class="tt">${cap(d.lb)} desde <b>${esc(vi)}</b> · <span class="el">${decorrido(vi)}</span></div><button type="button" class="redo" title="Desfazer início">${SVGU}</button><button type="button" class="stop">${SVGS}Encerrar</button>`
        bar.querySelector('.stop').onclick = () => { const el = $c(d.fim); if (!el) return; el.value = hhmm(); disparar(el); renderAll() }
        bar.querySelector('.redo').onclick = () => { const el = $c(d.ini); if (!el) return; el.value = ''; disparar(el); renderAll() }
      } else {
        bar.className = 'atd-timer'
        const extra = d.ini === 'hora_inicio' ? ` · <span class="el">${fmtMin(calcTempo())}</span> trabalhado` : ''
        bar.innerHTML = `<div class="tt">${cap(d.lb)} <b>${esc(vi)}</b> – <b>${esc(vf)}</b>${extra}</div><button type="button" class="redo" title="Reabrir para refazer o término">${SVGU}Reabrir</button>`
        bar.querySelector('.redo').onclick = () => { const el = $c(d.fim); if (!el) return; el.value = ''; disparar(el); renderAll() }
      }
    }
    function renderAll() { window.srStep && window.srStep('  renderAll: entrada'); bars.forEach(renderBar); window.srStep && window.srStep('  renderAll: saida OK') }
    timersRender = renderAll
    renderAll()
    timersTick = setInterval(() => { var S = window.srStep || function () {}; S('  TICK timersTick 30s'); if (!document.querySelector('.atd-timer')) { clearInterval(timersTick); timersTick = null; return } renderAll(); Promise.resolve().then(function () { S('  timersTick POST-micro') }); setTimeout(function () { S('  timersTick POST-macro (setTimeout0, PRE-paint)') }, 0); requestAnimationFrame(function () { requestAnimationFrame(function () { S('  timersTick POST-PAINT (2x rAF, apos o paint real)') }) }) }, 30000)
  }

  // ── Espelho: um campo copia o valor de outro quando este muda ──
  // (ex.: "Hora de Início (execução)" = "Deslocamento final - Ida")
  function aplicarEspelhos(e) {
    if (!cur || !cur.campos) return
    const src = (e && e.target && e.target.getAttribute) ? e.target.getAttribute('data-campo') : null
    if (!src) return
    for (const c of cur.campos) {
      if (c.espelha !== src) continue
      // busca no documento: campos de desloc/pausa moram nos modais
      const tgt = document.querySelector(`[data-campo="${CSS.escape(c.id)}"]`)
      const srcEl = document.querySelector(`[data-campo="${CSS.escape(src)}"]`)
      if (tgt && srcEl) tgt.value = srcEl.value
    }
  }

  // ── Condicionais (E/OU): mostra/esconde campos conforme as respostas ──
  function valorCampo(id) {
    const c = (cur.campos || []).find(x => x.id === id)
    if (!c) return ''
    if (c.tipo === 'tecnicos') return Array.from(document.querySelectorAll(`[data-multi="${CSS.escape(id)}"]:checked`)).map(x => x.value).join(', ')
    const el = document.querySelector(`[data-campo="${CSS.escape(id)}"]`)
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
      const w = document.querySelector(`[data-field="${CSS.escape(c.id)}"]`)
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
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto" autocapitalize="sentences"/>`
    } else if (c.tipo === 'texto_longo') {
      // campos com orientação + bullets automáticos
      const TA_DICAS = {
        servico_executado: 'Descreva o serviço executado, atividades realizadas e resultados obtidos',
        observacoes: 'Materiais necessários, observações ou retorno programado',
      }
      const ehServico = !!TA_DICAS[c.id]
      const ph = TA_DICAS[c.id] || '…'
      wrap.innerHTML = `${label}<textarea class="ta-longo${ehServico ? ' ta-servico' : ''}" data-campo="${esc(c.id)}" data-tipo="texto_longo" autocapitalize="sentences" placeholder="${esc(ph)}"></textarea>`
      if (ehServico) setTimeout(() => {
        const ta = wrap.querySelector('textarea'); if (!ta) return
        // bullets automáticos: "- " ao focar vazio e a cada Enter
        ta.addEventListener('focus', () => {
          if (!ta.value.trim()) { ta.value = '- '; ta.dispatchEvent(new Event('input', { bubbles: true })) }
        })
        ta.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          const s = ta.selectionStart, f = ta.selectionEnd, v = ta.value
          ta.value = v.slice(0, s) + '\n- ' + v.slice(f)
          ta.selectionStart = ta.selectionEnd = s + 3
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }, 0)
    } else if (c.tipo === 'data') {
      const hoje = jorHoje()   // data LOCAL (UTC viraria o dia à noite no fuso BR)
      wrap.innerHTML = `${label}<input type="date" value="${hoje}" data-campo="${esc(c.id)}" data-tipo="data"/>`
    } else if (c.tipo === 'hora') {
      wrap.innerHTML = `${label}<input type="time" data-campo="${esc(c.id)}" data-tipo="hora"/>`
    } else if (c.tipo === 'numero') {
      wrap.innerHTML = `${label}<input type="number" inputmode="decimal" data-campo="${esc(c.id)}" data-tipo="numero"/>`
    } else if (c.tipo === 'selecao') {
      const PERG_SEG = { deslocamento: 'Houve deslocamento?', desloc_ida: 'Deslocamento de ida', desloc_retorno: 'Deslocamento de retorno', pausa: 'Houve pausa?', almoco: 'Houve almoço?' }
      if (PERG_SEG[c.id]) {
        // pergunta em botões grandes Sim/Não — salva o MESMO valor do dropdown antigo
        wrap.innerHTML = `<label>${esc(PERG_SEG[c.id])}${req}</label>
          <input type="hidden" data-campo="${esc(c.id)}" data-tipo="selecao">
          <div class="segq">${(c.opcoes || ['Sim', 'Não']).map(o => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`
        setTimeout(() => {
          const hid = wrap.querySelector('[data-campo]')
          wrap.querySelectorAll('.segq button').forEach(b => {
            b.onclick = () => {
              hid.value = b.dataset.v
              wrap.querySelectorAll('.segq button').forEach(x => x.classList.toggle('on', x === b))
              hid.dispatchEvent(new Event('input', { bubbles: true }))
              hid.dispatchEvent(new Event('change', { bubbles: true }))
            }
          })
        }, 0)
        return wrap
      }
      const ops = (c.opcoes || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="selecao"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'tecnico') {
      const ops = (ref.tecnicos || []).map(t => { const n = tcase(t.nome); return `<option value="${esc(n)}"${n === tcase(tecnico.nome) ? ' selected' : ''}>${esc(n)}</option>` }).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="tecnico"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'tecnicos') {
      // cards dos selecionados (padrão do painel admin) + "+ Adicionar Técnico" → modal
      tecCampoId = c.id
      const checks = (ref.tecnicos || []).map(t => {
        const n = tcase(t.nome); const eu = n === tcase(tecnico.nome)
        const resp = eu || respTarefaIds.includes(t.id)   // pré-marca todos os responsáveis da tarefa
        const rl = t.cargo ? `${t.cargo} · Técnico` : 'Técnico'
        const foto = (typeof avatarUrl === 'function') ? avatarUrl(t.foto_url) : null
        const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))
        return `<label class="tec-row" data-nome="${esc(n)}"><input type="checkbox" data-multi="${esc(c.id)}" value="${esc(n)}"${resp ? ' checked' : ''}><span class="av">${av}</span><span class="ti"><span class="nm">${esc(n)}</span><span class="rl">${esc(rl)}</span></span><span class="pl">+</span></label>`
      }).join('')
      wrap.innerHTML = `${label}<div class="tec-cards" data-teccards="${esc(c.id)}"></div><button type="button" class="tec-add-btn" data-tecbtn="${esc(c.id)}">+ Adicionar Técnico</button>`
      setTimeout(() => {
        const lista = document.getElementById('tec-modal-lista')
        if (lista) {
          lista.innerHTML = checks || '<div class="prod-empty">Nenhum técnico cadastrado.</div>'
          lista.onchange = () => { atualizarResumoTecnicos(); filtrarTecnicos(); agendarAutosave() }
        }
        const b = wrap.querySelector('[data-tecbtn]')
        if (b) b.onclick = () => abrirModalTecnicos(c.id)
        atualizarResumoTecnicos()
      }, 0)
    } else if (c.tipo === 'veiculo') {
      const ops = (ref.veiculos || []).map(v => { const lbl = `${v.modelo || ''} (${v.placa || ''})`; return `<option value="${esc(lbl)}">${esc(lbl)}</option>` }).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="veiculo"><option value="">Selecione…</option><option value="Sem veículo">Sem veículo</option>${ops}</select>`
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
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto" autocapitalize="sentences"/>`
    }
    return wrap
  }

  // ── Organização do formulário (ordem cronológica) + modal Almoço ──
  // Deslocamento e Pausa são perguntas Sim/Não INLINE no formulário, com
  // revelação progressiva (condicionais já existentes). Ordem do bloco de tempo:
  // Houve deslocamento? (+detalhes) → Hora início → Houve pausa? (+detalhes) → Hora término.
  // O Almoço NÃO muda neste pacote: segue no modal do botão "Almoço".
  const ALMOCO_ID = /^almoco/i
  const idsModalDesloc = new Set()   // campos que moram no modal Deslocamento
  const idsModalPausa = new Set()    // campos que moram no modal Pausa/Almoço
  const wrapDe = (id) => document.querySelector(`[data-field="${CSS.escape(id)}"]`)
  function organizarCamposForm() {
    const campos = (cur && cur.campos) || []
    const dependeDe = (c, alvo) => !!(c.cond && (c.cond.regras || []).some(r => r.campo === alvo))
    // 1) pausa (+detalhes) e almoço → modal do botão "Pausa/Almoço"
    idsModalPausa.clear()
    const ac = document.getElementById('pausa-campos')
    if (ac) ac.innerHTML = ''
    let nA = 0
    for (const c of campos) {                      // pausa primeiro, depois almoço
      if (!(c.id === 'pausa' || dependeDe(c, 'pausa'))) continue
      const w = document.querySelector(`#campos-container [data-field="${CSS.escape(c.id)}"]`)
      if (w && ac) { ac.appendChild(w); idsModalPausa.add(c.id); nA++ }
    }
    for (const c of campos) {
      if (!ALMOCO_ID.test(c.id)) continue
      const w = document.querySelector(`#campos-container [data-field="${CSS.escape(c.id)}"]`)
      if (w && ac) { ac.appendChild(w); idsModalPausa.add(c.id); nA++ }
    }
    if (ac && nA) {
      ac.insertAdjacentHTML('beforeend', '<div id="almoco-pessoas"></div>')
      ac.oninput = () => renderAlmocoPessoas()   // horários/Sim-Não mudaram → chips por pessoa
      ac.onchange = (e) => {
        // término do almoço nunca antes do início — corrige p/ início + 1h
        const id = e.target && e.target.getAttribute && e.target.getAttribute('data-campo')
        if (id === 'almoco_inicio' || id === 'almoco_termino') {
          const vi = valorCampo('almoco_inicio'), vf = valorCampo('almoco_termino')
          if (vi && vf && vf <= vi) {
            toast('O término do almoço não pode ser antes do início.', 'err')
            const el = document.querySelector('[data-campo="almoco_termino"]')
            if (el) { el.value = horaMais(vi, 60); el.dispatchEvent(new Event('input', { bubbles: true })) }
            if (typeof timersRender === 'function') timersRender()
          }
        }
        renderAlmocoPessoas()
      }
    }
    const pb = document.getElementById('form-pausa-btn'); if (pb) pb.style.display = nA ? '' : 'none'
    // 2) deslocamento DO DIA → modal do botão "Deslocamento" (pernoite é à parte, na home)
    idsModalDesloc.clear()
    const dc = document.getElementById('desloc-campos')
    if (dc) dc.innerHTML = ''
    let nD = 0
    // ida/retorno são perguntas independentes; `deslocamento` (legado) ainda é aceito
    const DESLOC_Q = ['deslocamento', 'desloc_ida', 'desloc_retorno']
    for (const c of campos) {
      if (!(DESLOC_Q.includes(c.id) || DESLOC_Q.some(q => dependeDe(c, q)))) continue
      if (c.tipo === 'veiculo') continue   // veículo fica no formulário, abaixo da Data
      const w = document.querySelector(`#campos-container [data-field="${CSS.escape(c.id)}"]`)
      if (w && dc) { dc.appendChild(w); idsModalDesloc.add(c.id); nD++ }
    }
    if (dc && nD) { dc.insertAdjacentHTML('beforeend', '<div id="desloc-soma"></div>'); dc.oninput = dc.onchange = atualizarSomaDesloc }
    // veículo logo abaixo da Data (continua condicionado a "Houve deslocamento? = Sim")
    const wVei = (campos.find(c => c.tipo === 'veiculo') || {}).id
    if (wVei) { const wV = wrapDe(wVei), wDt = wrapDe('data'); if (wV && wDt) wDt.after(wV) }
    const db = document.getElementById('form-desloc-btn'); if (db) db.style.display = nD ? '' : 'none'
    // 3) sequência cronológica inline do restante: hora início → hora término
    const SEQ = ['hora_inicio', 'hora_termino']
    let refW = null
    for (const id of SEQ) {
      const w = wrapDe(id); if (!w || idsModalDesloc.has(id)) continue
      if (refW) refW.after(w)
      refW = w
    }
    // pares lado a lado: Data+Veículo · Hora início+Hora término
    const parear = (idA, idB) => {
      const a = wrapDe(idA), b = wrapDe(idB)
      if (!a || !b || !a.parentNode) return
      const row = document.createElement('div')
      row.className = 'fg-row'
      a.parentNode.insertBefore(row, a)
      row.appendChild(a); row.appendChild(b)
    }
    if (wVei) parear('data', wVei)
    parear('hora_inicio', 'hora_termino')
    atualizarResumoAlmoco()
    atualizarBadgeDesloc()
  }
  // segmented Sim/Não: reflete o valor do input oculto nos botões (após repopular)
  function sincronizarSegmentados() {
    document.querySelectorAll('.segq').forEach(sg => {
      const hid = sg.parentElement && sg.parentElement.querySelector('[data-campo]')
      if (!hid) return   // ex.: pergunta de produtos (sincroniza no próprio modal)
      const v = hid.value || ''
      sg.querySelectorAll('button').forEach(b => b.classList.toggle('on', !!v && b.dataset.v === v))
    })
  }
  function atualizarResumoAlmoco() {
    const card = document.getElementById('form-pausa-btn'), st = document.getElementById('reg-pausa-st')
    if (!card || !st) return
    const campos = (cur && cur.campos) || []
    const perguntas = ['pausa', 'almoco'].filter(id => campos.some(c => c.id === id))
    if (!perguntas.length) return
    const ok = perguntas.every(id => !!valorCampo(id))
    if (ok) {
      const nenhum = perguntas.every(id => valorCampo(id) === 'Não')
      st.className = 'st st-ok'; st.textContent = nenhum ? 'Não houve ✓' : '✓'
      card.classList.remove('btn-erro')
    } else { st.className = 'st st-pend'; st.textContent = 'Pendente' }
  }
  // badge do botão Deslocamento: Pendente / resposta ✓ (considera ida e retorno)
  function atualizarBadgeDesloc() {
    const card = document.getElementById('form-desloc-btn'), st = document.getElementById('reg-desloc-st')
    if (!card || !st || !cur) return
    const qs = (cur.campos || []).filter(c => ['deslocamento', 'desloc_ida', 'desloc_retorno'].includes(c.id)).map(c => c.id)
    if (!qs.length) return
    const vals = qs.map(id => valorCampo(id))
    if (!vals.every(Boolean)) { st.className = 'st st-pend'; st.textContent = 'Pendente'; return }
    const algumSim = vals.some(v => v === 'Sim')
    st.className = 'st st-ok'; st.textContent = algumSim ? 'Houve ✓' : 'Não houve ✓'; card.classList.remove('btn-erro')
    atualizarSomaDesloc()
  }
  // rodapé do modal: soma de ida + retorno que existiram (entra no tempo da tarefa)
  function atualizarSomaDesloc() {
    const box = document.getElementById('desloc-soma'); if (!box) return
    const dur = (a, b) => { const x = minutosDe(valorCampo(a)), y = minutosDe(valorCampo(b)); if (x == null || y == null) return null; let d = y - x; if (d < 0) d += 1440; return d }
    // ida=Sim usa desloc_ida; formulário legado (sem desloc_ida) cai no `deslocamento`
    const temIda = (cur.campos || []).some(c => c.id === 'desloc_ida')
    const idaOn = (temIda ? valorCampo('desloc_ida') : valorCampo('deslocamento')) === 'Sim'
    const retOn = (cur.campos || []).some(c => c.id === 'desloc_retorno')
      ? valorCampo('desloc_retorno') === 'Sim'
      : (!temIda && valorCampo('deslocamento') === 'Sim')   // legado: a janela única cobre o retorno
    const di = idaOn ? dur('desloc_inicial_ida', 'desloc_final_ida') : 0
    const dr = retOn ? dur('desloc_inicial_retorno', 'desloc_final_retorno') : 0
    if (!idaOn && !retOn) {
      box.innerHTML = `<div class="dl-totcard"><span class="k">Deslocamento</span><span class="v">0 min</span><span class="s">Sem deslocamento — não soma ao tempo da tarefa</span></div>`
      return
    }
    const incompleto = (idaOn && di == null) || (retOn && dr == null)
    const total = (di || 0) + (dr || 0)
    box.innerHTML = `<div class="dl-totcard"><span class="k">Soma ao tempo da tarefa</span><span class="v">${incompleto ? '— parcial' : '+ ' + fmtMin(total)}</span><span class="s">ida + retorno que existiram</span></div>`
  }
  function abrirModalDesloc() { if (!cur) return; document.getElementById('modal-desloc-rat').classList.add('open') }
  function fecharModalDesloc() { document.getElementById('modal-desloc-rat').classList.remove('open'); atualizarBadgeDesloc() }
  // ── Progresso da RAT: itens obrigatórios para concluir ──
  // Conta campos obrigatórios visíveis + pergunta de produtos + foto obrigatória.
  async function atualizarProgresso() {
    const fill = document.getElementById('rat-prog-fill'), txt = document.getElementById('rat-prog-txt')
    if (!fill || !txt || !cur || !cur.campos || !cur.campos.length) return
    const vis = (c) => curVisivel[c.id] !== false
    let total = 0, ok = 0
    for (const c of cur.campos) {
      if (!vis(c) || !c.obrigatorio) continue
      if (c.tipo === 'foto' || c.tipo === 'assinatura' || c.tipo === 'produtos') continue
      total++
      if (valorCampo(c.id)) ok++
    }
    if (cur.campos.some(c => c.tipo === 'produtos' && vis(c))) { total++; if (usoProd) ok++ }
    if (cur.campos.some(c => c.tipo === 'foto' && c.obrigatorio && vis(c))) { total++; if ((await D().listarFotos(cur.client_uuid)).length) ok++ }
    const pct = total ? Math.round(ok / total * 100) : 0
    fill.style.width = pct + '%'
    fill.style.background = pct >= 100 ? '#179A47' : '#1B7FC4'
    txt.textContent = `${ok}/${total} · ${pct}%`
  }

  // ── Técnicos responsáveis: cards (padrão admin) + modal de adição ──
  let tecCampoId = null
  // Horário PRÓPRIO por técnico (tempo é da pessoa, §8): { "Nome": {inicio,fim} } só nas
  // exceções — ausente = herda o horário da RAT. Vai em respostas.tecnicos_part; o servidor
  // materializa rat_tecnicos (trigger fn_rat_sync_tempo).
  let tecPart = {}
  const iniciaisDe = (n) => String(n || '').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase()
  function chipHorario(n) {
    const p = tecPart[n]
    const rIni = valorCampo('hora_inicio'), rFim = valorCampo('hora_termino')
    if (p && (p.inicio || p.fim)) {
      return `<button type="button" class="hchip h-edit" data-hr="${esc(n)}">${esc(p.inicio || rIni || '—')}–${esc(p.fim || rFim || '—')} <span class="tag">AJUSTADO</span></button>`
    }
    const faixa = (rIni && rFim) ? `${rIni}–${rFim}` : (rIni ? `${rIni}–…` : 'horário')
    return `<button type="button" class="hchip h-inherit" data-hr="${esc(n)}">${esc(faixa)} · da RAT</button>`
  }
  // Toque no chip → editor inline (dois horários + OK / "da RAT" volta a herdar)
  function abrirEditorHorario(n, chipEl) {
    const p = tecPart[n] || {}
    const wrap = document.createElement('span')
    wrap.className = 'hedit'
    wrap.innerHTML = `<input type="time" class="he-ini" value="${esc(p.inicio || valorCampo('hora_inicio') || '')}">–<input type="time" class="he-fim" value="${esc(p.fim || valorCampo('hora_termino') || '')}"><button type="button" class="he-ok">OK</button><button type="button" class="he-clear" title="Voltar a herdar o horário da RAT">da RAT</button>`
    chipEl.replaceWith(wrap)
    wrap.querySelector('.he-ok').onclick = () => {
      const ini = wrap.querySelector('.he-ini').value, fim = wrap.querySelector('.he-fim').value
      if (ini || fim) tecPart[n] = { inicio: ini || null, fim: fim || null }
      else delete tecPart[n]
      renderTecCards(); agendarAutosave(); renderAlmocoPessoas()
    }
    wrap.querySelector('.he-clear').onclick = () => { delete tecPart[n]; renderTecCards(); agendarAutosave(); renderAlmocoPessoas() }
  }
  function renderTecCards() {
    if (!tecCampoId) return
    const box = document.querySelector(`[data-teccards="${CSS.escape(tecCampoId)}"]`); if (!box) return
    const sel = Array.from(document.querySelectorAll(`[data-multi="${CSS.escape(tecCampoId)}"]:checked`)).map(x => x.value)
    box.innerHTML = sel.map(n => {
      const t = (ref.tecnicos || []).find(x => tcase(x.nome) === n) || {}
      const rl = t.cargo ? `${t.cargo} · Técnico` : 'Técnico'
      const foto = (typeof avatarUrl === 'function') ? avatarUrl(t.foto_url) : null
      const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))
      return `<div class="tec-card"><span class="av">${av}</span><span class="ti"><span class="nm">${esc(n)}</span><span class="rl">${esc(rl)}</span>${chipHorario(n)}</span><button type="button" class="tc-x" data-rem="${esc(n)}" title="Remover">×</button></div>`
    }).join('') || '<div class="tec-vazio">Nenhum técnico selecionado.</div>'
    box.querySelectorAll('[data-rem]').forEach(b => {
      b.onclick = () => {
        const chk = document.querySelector(`[data-multi="${CSS.escape(tecCampoId)}"][value="${CSS.escape(b.dataset.rem)}"]`)
        if (chk) chk.checked = false
        delete tecPart[b.dataset.rem]
        atualizarResumoTecnicos(); filtrarTecnicos(); agendarAutosave()
      }
    })
    box.querySelectorAll('[data-hr]').forEach(b => { b.onclick = () => abrirEditorHorario(b.dataset.hr, b) })
  }
  function abrirModalTecnicos(campoId) {
    if (!cur) return
    if (campoId) tecCampoId = campoId
    document.getElementById('tec-busca').value = ''
    filtrarTecnicos()
    document.getElementById('modal-tec').classList.add('open')
    atualizarResumoTecnicos()
  }
  function fecharModalTecnicos() {
    document.getElementById('modal-tec').classList.remove('open')
    atualizarResumoTecnicos()
    agendarAutosave()
  }
  function filtrarTecnicos() {
    const q = normStr(document.getElementById('tec-busca').value || '')
    let visiveis = 0
    document.querySelectorAll('#tec-modal-lista .tec-row').forEach(r => {
      const chk = r.querySelector('input')
      const mostra = !(chk && chk.checked) && (!q || normStr(r.textContent).includes(q))
      r.style.display = mostra ? '' : 'none'
      if (mostra) visiveis++
    })
    const vz = document.getElementById('tec-modal-vazio')
    if (vz) vz.style.display = visiveis ? 'none' : ''
  }
  function atualizarResumoTecnicos() {
    if (!tecCampoId) return
    const sel = Array.from(document.querySelectorAll(`[data-multi="${CSS.escape(tecCampoId)}"]:checked`)).map(x => x.value)
    renderTecCards()
    if (sel.length) {
      const btn = document.querySelector(`[data-tecbtn="${CSS.escape(tecCampoId)}"]`)
      if (btn) { const w = btn.closest('[data-field]'); if (w) w.classList.remove('campo-erro') }
    }
    const foot = document.getElementById('tec-resumo-foot')
    if (foot) foot.textContent = sel.length ? `${sel.length} na RAT` : 'Nenhum selecionado'
    atualizarProgresso()
  }

  // ── Técnicos a bordo: cards com foto (padrão RAT), POR TRECHO da viagem ──
  let dlTecSel = new Set()
  let dlTecTrecho = null   // índice do trecho sendo editado
  function renderDlTecLista() {
    const lista = document.getElementById('dltec-lista'); if (!lista) return
    const q = normStr((document.getElementById('dltec-busca') || {}).value || '')
    const card = (t, modo) => {
      const n = tcase(t.nome || '—')
      const rl = t.cargo ? `${t.cargo} · Técnico` : 'Técnico'
      const foto = (typeof avatarUrl === 'function') ? avatarUrl(t.foto_url) : null
      const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))
      return `<div class="tec-row" data-${modo}="${esc(t.id)}"><span class="av">${av}</span><span class="ti"><span class="nm">${esc(n)}</span><span class="rl">${esc(rl)}</span></span><span class="pl ${modo === 'add' ? 'pl-add' : 'pl-rem'}">${modo === 'add' ? '+' : '×'}</span></div>`
    }
    const aBordo = (ref.tecnicos || []).filter(t => dlTecSel.has(t.id))
    const disp = (ref.tecnicos || []).filter(t => !dlTecSel.has(t.id) && (!q || normStr(t.nome || '').includes(q)))
    lista.innerHTML = aBordo.map(t => card(t, 'rem')).join('') + disp.map(t => card(t, 'add')).join('')
    const vz = document.getElementById('dltec-vazio'); if (vz) vz.style.display = (aBordo.length + disp.length) ? 'none' : ''
    const foot = document.getElementById('dltec-foot'); if (foot) foot.textContent = `${dlTecSel.size} a bordo`
    lista.querySelectorAll('[data-add]').forEach(r => { r.onclick = () => { dlTecSel.add(r.dataset.add); renderDlTecLista() } })
    lista.querySelectorAll('[data-rem]').forEach(r => { r.onclick = () => { dlTecSel.delete(r.dataset.rem); renderDlTecLista() } })
  }
  function abrirModalTecDl(i) {
    dlTecTrecho = (typeof i === 'number') ? i : null
    dlTecSel = new Set((dlCur && dlTecTrecho != null && dlCur.trechos[dlTecTrecho] && dlCur.trechos[dlTecTrecho].tecnicos) || [])
    const b = document.getElementById('dltec-busca'); if (b) b.value = ''
    renderDlTecLista()
    document.getElementById('modal-tec-dl').classList.add('open')
  }
  function fecharModalTecDl() {
    document.getElementById('modal-tec-dl').classList.remove('open')
    if (dlCur && dlTecTrecho != null && dlCur.trechos[dlTecTrecho]) {
      const t = dlCur.trechos[dlTecTrecho]
      const antes = new Set(t.tecnicos || [])
      t.tecnicos = [...dlTecSel]
      // motorista que saiu do carro sai da direção
      t.motoristas = (t.motoristas || []).filter(m => dlTecSel.has(m.tecnico_id))
      const mudou = antes.size !== dlTecSel.size || [...dlTecSel].some(x => !antes.has(x))
      if (mudou) t._tecEditado = true
      // quem saiu = remoção explícita (propaga no merge); quem voltou sai da lista de remoção
      const removidos = [...antes].filter(x => !dlTecSel.has(x))
      t._tec_remover = [...new Set([...(t._tec_remover || []).filter(x => !dlTecSel.has(x)), ...removidos])]
      renderTrechos()
    }
    dlTecTrecho = null
  }

  // Card de contexto no topo da RAT (funde a faixa azul + Cliente & Serviço)
  function preencherCtx({ no, cliente, tipo, clienteEditavel, orientacao, devol }) {
    const noEl = document.getElementById('ctx-no'); if (noEl) noEl.textContent = no || ''
    const cli = document.getElementById('ctx-cli')
    if (cli) { cli.style.display = clienteEditavel ? 'none' : ''; cli.textContent = cliente || '—' }
    const tp = document.getElementById('ctx-tipo')
    if (tp) { tp.style.display = tipo ? '' : 'none'; tp.textContent = tipo || '' }
    // Motivo da devolução (quando o admin devolveu a tarefa) — o que o técnico precisa corrigir.
    const dvEl = document.getElementById('ctx-devol')
    if (dvEl) { const has = hasDevol(devol); dvEl.style.display = has ? '' : 'none'; dvEl.innerHTML = has ? '<span class="ctx-devol-k">Motivo da devolução</span>' + devolMotivoHTML(devol) : '' }
    // Orientação ao técnico (da Tarefa) — sem ela o técnico fica no escuro durante a RAT.
    const orEl = document.getElementById('ctx-orient')
    if (orEl) { const o = (orientacao || '').trim(); orEl.style.display = o ? '' : 'none'; orEl.innerHTML = o ? `<span class="ctx-orient-k">Orientação</span>${esc(o)}` : '' }
    const cw = document.getElementById('f-cliente-wrap')
    if (cw) cw.style.display = clienteEditavel ? '' : 'none'
  }
  function abrirModalAlmoco() {
    if (!cur) return
    document.getElementById('modal-pausa').classList.add('open')
    renderAlmocoPessoas()
    // estado "já almoçou hoje" vem do servidor (almocos por pessoa/dia); offline usa o último cache
    const dia = valorCampo('data') || jorHoje()
    const ids = nomesSelecionados().map(n => ((ref.tecnicos || []).find(x => tcase(x.nome) === n) || {}).id).filter(Boolean)
    carregarAlmocosDia(dia, ids).then(renderAlmocoPessoas)
  }
  function fecharModalAlmoco() { document.getElementById('modal-pausa').classList.remove('open'); atualizarResumoAlmoco() }

  // ── Almoço é DA PESSOA: um por técnico/dia em qualquer artefato (§8) ──
  // O servidor materializa e deduplica (trigger da RAT + fn_registrar_almoco);
  // aqui só mostramos PARA QUEM o almoço vai valer e quem já tem o do dia.
  let almocoDia = { dia: null, rows: [] }
  const nomesSelecionados = () => tecCampoId ? String(valorCampo(tecCampoId) || '').split(',').map(s => s.trim()).filter(Boolean) : []
  async function carregarAlmocosDia(dia, ids) {
    if (!navigator.onLine || !ids.length) return
    try {
      const { data } = await getSupabase().from('almocos')
        .select('tecnico_id,inicio,fim,origem,artefato_tipo').eq('dia', dia).in('tecnico_id', ids)
      almocoDia = { dia, rows: data || [] }
    } catch (e) { /* offline/erro: mantém o cache anterior */ }
  }
  function renderAlmocoPessoas() {
    const box = document.getElementById('almoco-pessoas'); if (!box || !cur) return
    const houve = valorCampo('almoco') === 'Sim'
    const nomes = nomesSelecionados()
    if (!houve || !nomes.length) { box.innerHTML = ''; return }
    const aIni = valorCampo('almoco_inicio'), aFim = valorCampo('almoco_termino')
    const hhmm = (t) => String(t || '').slice(0, 5)
    const rIni = valorCampo('hora_inicio'), rFim = valorCampo('hora_termino')
    box.innerHTML = '<span class="alm-lab">Registrado para</span>' + nomes.map(n => {
      const t = (ref.tecnicos || []).find(x => tcase(x.nome) === n) || {}
      const foto = (typeof avatarUrl === 'function') ? avatarUrl(t.foto_url) : null
      const av = foto ? `<img src="${esc(foto)}" alt="">` : esc(iniciaisDe(n))
      const reg = almocoDia.rows.find(r => r.tecnico_id === t.id)
      const p = tecPart[n] || {}
      const pIni = p.inicio || rIni, pFim = p.fim || rFim
      const cobre = !aIni || !pIni || !pFim || (aIni >= pIni && aIni < pFim)
      let chip
      if (reg && !(reg.artefato_tipo === 'rat' && hhmm(reg.inicio) === aIni && hhmm(reg.fim) === aFim)) {
        const onde = reg.origem === 'ponto' ? 'ponto' : (reg.artefato_tipo === 'deslocamento' ? 'Deslocamento' : 'outra RAT')
        chip = `<span class="pst p-skip">já registrado hoje · ${esc(onde)}</span>`
      } else if (!cobre) {
        chip = '<span class="pst p-wait">fora do horário dele</span>'
      } else if (aIni && aFim) {
        chip = `<span class="pst p-ok">✓ ${esc(aIni)}–${esc(aFim)}</span>`
      } else {
        chip = '<span class="pst p-wait">aguardando horários</span>'
      }
      return `<div class="pcard"><span class="av">${av}</span><span class="nm">${esc(n)}</span>${chip}</div>`
    }).join('') + '<div class="alm-hint">O almoço vale pra quem estava na tarefa nesse horário. Quem já almoçou em outra RAT ou Deslocamento <b>não duplica</b> — o sistema mantém o primeiro e avisa o admin.</div>'
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
    box.setAttribute('data-lb-scope', '')   // fotos da RAT navegam entre si no lightbox
    box.innerHTML = fotos.map(f => {
      // blob local → objectURL; foto hidratada (sem blob) → preview assinado; nunca usa o path cru.
      const src = f.blob ? URL.createObjectURL(f.blob) : (f.preview || f.url || '')
      return `<div class="thumb-card">
        <div class="thumb"><img src="${src}" data-lb="${src}"${f.legenda ? ` data-lb-cap="${esc(f.legenda)}"` : ''} alt=""><button type="button" class="thumb-x" data-id="${esc(f.id)}">×</button></div>
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
    const card = document.getElementById('form-fotos-btn'), st = document.getElementById('reg-fotos-st')
    if (!card || !st || !cur) return
    const n = (await D().listarFotos(cur.client_uuid)).length
    if (n) { st.className = 'st st-ok'; st.textContent = `${n} foto${n === 1 ? '' : 's'} ✓`; card.classList.remove('btn-erro') }
    else { st.className = 'st st-pend'; st.textContent = 'Pendente' }
    atualizarProgresso()
  }

  // ── Produtos da RAT: pergunta obrigatória + apontamento com stepper ──
  // 1) "Foi utilizado produto neste atendimento?" (Sim/Não) — obrigatória p/ concluir.
  //    A resposta fica no rascunho local (uso_produtos) e dentro de respostas (sync).
  // 2) Sim → linhas da tarefa (orçado/levado) com stepper −/+ e edição direta ao tocar
  //    no número (decimal p/ unidades fracionárias como m — salvo SEM arredondar;
  //    inteiro p/ PC). Pode passar do levado: fica vermelho, o back-office acusa.
  // 3) Não → registro explícito "sem material utilizado" (zera apontamentos).
  const UN_FRAC = /^(m|mt|m2|m²|m3|m³|kg|g|l|lt|ml|km)$/i
  const ehFracionaria = (u) => UN_FRAC.test(String(u || '').trim())
  const fmtQtd = (n) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  async function abrirModalProd() {
    if (!cur) return
    document.getElementById('prod-avulso-form').style.display = 'none'
    document.getElementById('modal-prod').classList.add('open')
    await renderProdModal()
  }
  async function fecharModalProd() {
    document.getElementById('modal-prod').classList.remove('open')
    await atualizarBadgeProd()
  }
  // Busca de produto em tela cheia (lista extensa, ate 50 + "refine"). Mesma busca tolerante,
  // nos dois grupos: ja na RAT/tarefa (+1) e catalogo (+ Incluir). Pode adicionar varios sem fechar.
  function abrirModalBuscaProd() {
    if (!cur) return
    const m = document.getElementById('modal-prod-busca'); if (!m) return
    const i = document.getElementById('pb-busca'); if (i) i.value = ''
    const r = document.getElementById('pb-res'); if (r) r.innerHTML = '<div class="prod-empty">Digite ao menos 2 letras.</div>'
    m.classList.add('open')
    if (i) setTimeout(() => i.focus(), 60)
  }
  async function fecharModalBuscaProd() {
    document.getElementById('modal-prod-busca').classList.remove('open')
    await refreshMateriais()   // reflete na lista de cima o que foi lancado
  }
  async function renderBuscaProd() {
    const box = document.getElementById('pb-res'); if (!box || !cur) return
    const toks = normStr(document.getElementById('pb-busca').value || '').split(/\s+/).filter(t => t.length >= 2)
    if (!toks.length) { box.innerHTML = '<div class="prod-empty">Digite ao menos 2 letras.</div>'; return }
    const casa = (s) => { const hay = normStr(s); return toks.every(t => hay.includes(t)) }
    const mats = await D().listarMateriais(cur.client_uuid)
    const naRat = mats.filter(m => casa((m.descricao || '') + ' ' + (m.codigo_produto || '')))
    const ja = new Set(mats.map(m => m.produto_id).filter(Boolean))
    const catAll = (ref.produtos || []).filter(p => !ja.has(p.id) && casa((p.descricao || '') + ' ' + (p.codigo || '')))
    const LIM = 50, cat = catAll.slice(0, LIM)
    if (!naRat.length && !cat.length) { box.innerHTML = '<div class="prod-empty">Nenhum produto encontrado.</div>'; return }
    box.innerHTML =
      naRat.map(m => `
        <div class="prod-row2">
          <div class="pr-main"><div class="pr-desc">${esc(m.descricao || m.codigo_produto || '—')}${m.unidade ? ` <span class="pr-un">${esc(m.unidade)}</span>` : ''}</div><div class="pr-sub">já na RAT · ${fmtQtd(Number(m.quantidade) || 0)}</div></div>
          <button type="button" class="btn btn-sm btn-p pr-inc" data-mid="${esc(m.id)}" style="width:auto;padding:9px 13px;font-size:13px">+1</button>
        </div>`).join('') +
      cat.map(p => `
        <div class="prod-row2">
          <div class="pr-main"><div class="pr-desc">${esc(p.descricao || '—')}${p.unidade ? ` <span class="pr-un">${esc(p.unidade)}</span>` : ''}</div>${p.codigo ? `<div class="pr-sub">${esc(p.codigo)}</div>` : ''}</div>
          <button type="button" class="btn btn-sm btn-p pr-add" data-pid="${esc(p.id)}" style="width:auto;padding:9px 13px;font-size:13px">+ Incluir</button>
        </div>`).join('') +
      (catAll.length > LIM ? `<div class="prod-empty">Mostrando ${LIM} de ${catAll.length} — refine a busca.</div>` : '')
    box.querySelectorAll('.pr-inc').forEach(b => { b.onclick = async () => { await ajustarQtd(b.dataset.mid, +1); await renderBuscaProd() } })
    box.querySelectorAll('.pr-add').forEach(b => {
      b.onclick = async () => {
        const p = (ref.produtos || []).find(x => x.id === b.dataset.pid); if (!p) return
        await D().adicionarMaterial(cur.client_uuid, { produto_id: p.id, codigo_produto: p.codigo || null, descricao: p.descricao, unidade: p.unidade || null, quantidade: 1 })
        await renderBuscaProd()   // permanece na busca pra adicionar varios
      }
    })
  }
  async function responderUsoProd(v) {
    if (!cur) return
    if (v === 'Não') {
      const mats = await D().listarMateriais(cur.client_uuid)
      const usados = mats.filter(m => (Number(m.quantidade) || 0) > 0)
      if (usados.length && !confirm(`Zerar os ${usados.length} item(ns) já apontados?`)) return
      for (const m of usados) await D().atualizarMaterial(m.id, { quantidade: 0 })
    }
    usoProd = v
    await D().salvarRat(cur.client_uuid, { uso_produtos: v })
    const fb = document.getElementById('form-produtos-btn'); if (fb) fb.classList.remove('btn-erro')
    await renderProdModal()
  }
  async function renderProdModal() {
    document.querySelectorAll('#prod-uso-seg button').forEach(b => b.classList.toggle('on', usoProd === b.dataset.v))
    document.getElementById('prod-semuso').style.display = usoProd === 'Não' ? '' : 'none'
    document.getElementById('prod-lista-wrap').style.display = usoProd === 'Sim' ? '' : 'none'
    if (usoProd === 'Sim') await refreshMateriais()
    else await atualizarResumoFoot()
  }
  async function atualizarResumoFoot() {
    const el = document.getElementById('prod-resumo-foot'); if (!el || !cur) return
    if (usoProd === 'Não') { el.textContent = 'Sem material utilizado'; return }
    if (usoProd !== 'Sim') { el.textContent = 'Responda a pergunta acima'; return }
    const n = (await D().listarMateriais(cur.client_uuid)).filter(m => (Number(m.quantidade) || 0) > 0).length
    el.textContent = `${n} ite${n === 1 ? 'm' : 'ns'} com uso`
  }
  // badge de estado no botão "Produtos" do formulário
  async function atualizarBadgeProd() {
    const card = document.getElementById('form-produtos-btn'), st = document.getElementById('reg-prod-st')
    if (!card || !st || !cur) return
    const temCampo = (cur.campos || []).some(c => c.tipo === 'produtos')
    card.style.display = temCampo ? '' : 'none'
    if (!temCampo) return
    if (usoProd === 'Não') { st.className = 'st st-ok'; st.textContent = 'Sem uso ✓' }
    else if (usoProd === 'Sim') {
      const n = (await D().listarMateriais(cur.client_uuid)).filter(m => (Number(m.quantidade) || 0) > 0).length
      st.className = 'st st-ok'; st.textContent = `${n} ite${n === 1 ? 'm' : 'ns'} ✓`
    } else { st.className = 'st st-pend'; st.textContent = 'Pendente' }
    atualizarProgresso()
  }
  // Busca no catálogo (ref.produtos — cacheado p/ offline): sugere e inclui com qtd 1.
  async function renderCatalogoSug() {
    const box = document.getElementById('prod-cat-sug'); if (!box || !cur) return
    // Busca tolerante por tokens (sem acento, em qualquer ordem) em descrição + código.
    // Procura nos DOIS grupos: (1) produtos já na RAT/tarefa (orçado/levado pré-carregado) → ajusta qtd;
    // (2) catálogo (o que ainda não está na RAT) → inclui. Ex.: "cabo azul" acha "CABO UTP CAT6 CMX AZUL".
    const toks = normStr(document.getElementById('prod-cat-busca').value || '').split(/\s+/).filter(t => t.length >= 2)
    if (!toks.length) { box.innerHTML = ''; return }
    const casa = (s) => { const hay = normStr(s); return toks.every(t => hay.includes(t)) }
    const mats = await D().listarMateriais(cur.client_uuid)
    const naRat = mats.filter(m => casa((m.descricao || '') + ' ' + (m.codigo_produto || ''))).slice(0, 8)
    const ja = new Set(mats.map(m => m.produto_id).filter(Boolean))
    const cat = (ref.produtos || []).filter(p => !ja.has(p.id) && casa((p.descricao || '') + ' ' + (p.codigo || ''))).slice(0, 8)
    if (!naRat.length && !cat.length) { box.innerHTML = '<div class="prod-empty">Nenhum produto encontrado.</div>'; return }
    box.innerHTML =
      naRat.map(m => `
        <div class="prod-row2">
          <div class="pr-main"><div class="pr-desc">${esc(m.descricao || m.codigo_produto || '—')}${m.unidade ? ` <span class="pr-un">${esc(m.unidade)}</span>` : ''}</div><div class="pr-sub">já na RAT · ${fmtQtd(Number(m.quantidade) || 0)}</div></div>
          <button type="button" class="btn btn-sm btn-p pr-inc" data-mid="${esc(m.id)}" style="width:auto;padding:9px 13px;font-size:13px">+1</button>
        </div>`).join('') +
      cat.map(p => `
        <div class="prod-row2">
          <div class="pr-main"><div class="pr-desc">${esc(p.descricao || '—')}${p.unidade ? ` <span class="pr-un">${esc(p.unidade)}</span>` : ''}</div>${p.codigo ? `<div class="pr-sub">${esc(p.codigo)}</div>` : ''}</div>
          <button type="button" class="btn btn-sm btn-p pr-add" data-pid="${esc(p.id)}" style="width:auto;padding:9px 13px;font-size:13px">+ Incluir</button>
        </div>`).join('')
    box.querySelectorAll('.pr-inc').forEach(b => { b.onclick = async () => { await ajustarQtd(b.dataset.mid, +1); await renderCatalogoSug() } })
    box.querySelectorAll('.pr-add').forEach(b => {
      b.onclick = async () => {
        const p = (ref.produtos || []).find(x => x.id === b.dataset.pid); if (!p) return
        await D().adicionarMaterial(cur.client_uuid, { produto_id: p.id, codigo_produto: p.codigo || null, descricao: p.descricao, unidade: p.unidade || null, quantidade: 1 })
        document.getElementById('prod-cat-busca').value = ''
        box.innerHTML = ''
        await refreshMateriais()
      }
    })
  }
  async function adicionarAvulso() {
    const nome = (document.getElementById('pav-nome').value || '').trim()
    const un = (document.getElementById('pav-un').value || '').trim()
    if (!nome) return toast('Informe o nome do item.', 'err')
    let v = Number(String(document.getElementById('pav-qtd').value || '').trim().replace(',', '.'))
    if (!isFinite(v) || v < 0) v = 0
    if (!ehFracionaria(un)) v = Math.round(v)
    await D().adicionarMaterial(cur.client_uuid, { produto_id: null, codigo_produto: null, descricao: nome, unidade: un || null, quantidade: v })
    document.getElementById('pav-nome').value = ''; document.getElementById('pav-un').value = ''; document.getElementById('pav-qtd').value = ''
    document.getElementById('prod-avulso-form').style.display = 'none'
    await refreshMateriais()
  }
  // Traz os produtos da TAREFA (orçados/levados) para a RAT com qtd 0, sem redigitar.
  async function precarregarLevados() {
    if (!cur || !cur.tarefa_id || !navigator.onLine) return
    try {
      const { data } = await getSupabase().from('vw_tarefa_materiais_tecnico')
        .select('produto_id,codigo_produto,descricao,unidade,qtd_orcada,qtd_levada,qtd_utilizada').eq('tarefa_id', cur.tarefa_id)
      if (!data || !data.length) return
      const existentes = await D().listarMateriais(cur.client_uuid)
      const chave = (x) => `${x.produto_id || ''}|${x.codigo_produto || ''}|${(x.descricao || '').trim().toLowerCase()}`
      const byChave = new Map(existentes.map(e => [chave(e), e]))
      for (const m of data) {
        if (!(Number(m.qtd_levada) > 0) && !(Number(m.qtd_orcada) > 0)) continue   // levados OU orçados da tarefa
        const ex = byChave.get(chave(m))
        if (ex) {
          // Já existe (ex.: RAT reaberta/hidratada). Restaura o plano (orçada/levada) se tiver sumido.
          if (ex.qtd_levada == null && ex.qtd_orcada == null) {
            await D().atualizarMaterial(ex.id, {
              qtd_levada: m.qtd_levada, qtd_orcada: m.qtd_orcada,
              qtd_usada_tarefa: m.qtd_utilizada, unidade: ex.unidade || m.unidade,
            })
          }
          continue
        }
        await D().adicionarMaterial(cur.client_uuid, {
          produto_id: m.produto_id, codigo_produto: m.codigo_produto, descricao: m.descricao,
          unidade: m.unidade, quantidade: 0, qtd_levada: m.qtd_levada,
          qtd_orcada: m.qtd_orcada, qtd_usada_tarefa: m.qtd_utilizada,
        })
      }
    } catch (e) { /* offline/sem view: técnico usa item avulso */ }
  }
  async function refreshMateriais() {
    const box = document.getElementById('prod-list'); if (!box || !cur) return
    const mats = await D().listarMateriais(cur.client_uuid)
    if (!mats.length) {
      box.innerHTML = '<div class="prod-empty">Nenhum produto vinculado à tarefa. Use <b>+ Item avulso</b>.</div>'
    } else {
      box.innerHTML = mats.map(m => {
        const lev = Number(m.qtd_levada) || 0, orc = Number(m.qtd_orcada) || 0
        const v = Number(m.quantidade) || 0
        const daTarefa = lev > 0 || orc > 0
        const acima = daTarefa && v > lev
        const un = m.unidade ? ' ' + esc(m.unidade) : ''
        const refHtml = daTarefa
          ? `<span class="chip c-orc">Orçado ${orc > 0 ? fmtQtd(orc) + un : '—'}</span><span class="chip c-lev">Levado ${lev > 0 ? fmtQtd(lev) + un : '—'}</span>`
          : `<span class="pr-code">${m.codigo_produto ? esc(m.codigo_produto) : 'item avulso'}</span>`
        return `<div class="prod-row2">
          <div class="pr-main">
            <div class="pr-desc">${esc(m.descricao || m.codigo_produto || '—')}${m.unidade ? ` <span class="pr-un">${esc(m.unidade)}</span>` : ''}</div>
            <div class="pr-sub">${refHtml}</div>
          </div>
          <div class="stp" data-mid="${esc(m.id)}">
            <button type="button" class="stp-m" aria-label="menos">−</button>
            <button type="button" class="stp-n${acima ? ' over' : ''}">${fmtQtd(v)}</button>
            <button type="button" class="stp-p" aria-label="mais">+</button>
          </div>
          ${daTarefa ? '' : `<button type="button" class="pr-x" data-mid="${esc(m.id)}">×</button>`}
        </div>`
      }).join('')
      box.querySelectorAll('.stp').forEach(st => {
        const mid = st.dataset.mid
        st.querySelector('.stp-m').onclick = () => ajustarQtd(mid, -1)
        st.querySelector('.stp-p').onclick = () => ajustarQtd(mid, +1)
        st.querySelector('.stp-n').onclick = () => editarQtdDireto(mid, st)
      })
      box.querySelectorAll('.pr-x').forEach(b => { b.onclick = async () => { await D().removerMaterial(b.dataset.mid); await refreshMateriais() } })
    }
    await atualizarResumoFoot()
  }
  async function ajustarQtd(mid, delta) {
    const m = (await D().listarMateriais(cur.client_uuid)).find(x => x.id === mid); if (!m) return
    const v = Math.max(0, (Number(m.quantidade) || 0) + delta)
    await D().atualizarMaterial(mid, { quantidade: v })
    await refreshMateriais()
  }
  // tocar no número abre a edição direta (teclado numérico); decimais p/ "m",
  // inteiro p/ "PC"; o decimal é salvo EXATAMENTE como digitado (sem arredondar).
  async function editarQtdDireto(mid, st) {
    const m = (await D().listarMateriais(cur.client_uuid)).find(x => x.id === mid); if (!m) return
    const frac = ehFracionaria(m.unidade)
    const n = st.querySelector('.stp-n'); if (!n) return
    const inp = document.createElement('input')
    inp.className = 'stp-i'
    inp.inputMode = frac ? 'decimal' : 'numeric'
    inp.value = (Number(m.quantidade) || 0) ? String(m.quantidade).replace('.', ',') : ''
    n.replaceWith(inp)
    inp.focus(); inp.select()
    let feito = false
    const commit = async () => {
      if (feito) return
      feito = true
      let v = Number(String(inp.value || '').trim().replace(',', '.'))
      if (!isFinite(v) || v < 0) v = Number(m.quantidade) || 0
      if (!frac) v = Math.round(v)
      await D().atualizarMaterial(mid, { quantidade: v })
      await refreshMateriais()
    }
    inp.onblur = commit
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur() }
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
  const minutosAgora = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
  // Hora de Término (execução) não pode ser depois do relógio real (no futuro).
  // Ignora virada de meia-noite (término < início = madrugada do dia seguinte, já passada).
  function horaTerminoNoFuturo() {
    const tEnd = minutosDe(valorCampo('hora_termino')); if (tEnd == null) return false
    // só é "futuro" se a RAT for de HOJE — RAT de dia passado já está toda no passado.
    const dataRat = valorCampo('data')
    if (dataRat && dataRat !== jorHoje()) return false
    const tIni = minutosDe(valorCampo('hora_inicio'))
    if (tIni != null && tEnd < tIni) return false
    return tEnd > minutosAgora()
  }
  // Coerência cronológica do dia, tratando a virada de meia-noite: compara pela DISTÂNCIA
  // de relógio (gap pequeno = ordem certa; gap > 12h = ordem invertida = erro real). Só valida
  // quando os dois campos do confronto têm valor.
  //  · deslocamento de IDA não pode ser DEPOIS da Hora de Início da execução
  //  · deslocamento de RETORNO não pode ser ANTES da Hora de Término da execução
  //  · a PAUSA tem de ficar entre o início da ida e o fim do retorno (a janela do dia)
  function erroCronologia() {
    const m = (id) => minutosDe(valorCampo(id))
    const adiante = (a, b) => ((b - a) % 1440 + 1440) % 1440   // distância a→b no relógio (0..1439)
    const LIM = 720   // 12h: gap acima disso = ordem invertida (não é só virada de meia-noite)
    const dbtn = document.getElementById('form-desloc-btn'), pbtn = document.getElementById('form-pausa-btn')
    const ini = m('hora_inicio'), fim = m('hora_termino')
    // Término numericamente ANTES do início + duração "rolada" > 12h = o "+1 dia" silencioso
    // (ex.: 14:11→13:30 virava 23h19min). Atendimento noturno legítimo (< 12h) passa.
    if (ini != null && fim != null && fim < ini && adiante(ini, fim) > LIM) {
      return { btns: [], campos: ['hora_inicio', 'hora_termino'],
        msg: `Hora de Término (${valorCampo('hora_termino')}) está antes da Hora de Início (${valorCampo('hora_inicio')}). Corrija o horário.` }
    }
    if (ini != null) {
      for (const id of ['desloc_inicial_ida', 'desloc_final_ida']) {
        const t = m(id); if (t != null && adiante(t, ini) > LIM) return { btns: [dbtn], msg: 'Deslocamento de ida não pode ser depois da Hora de Início da execução.' }
      }
    }
    if (fim != null) {
      for (const id of ['desloc_inicial_retorno', 'desloc_final_retorno']) {
        const t = m(id); if (t != null && adiante(fim, t) > LIM) return { btns: [dbtn], msg: 'Deslocamento de retorno não pode ser antes da Hora de Término da execução.' }
      }
    }
    const dia0 = m('desloc_inicial_ida'), diaN = m('desloc_final_retorno')
    if (dia0 != null && diaN != null) {
      const span = adiante(dia0, diaN)   // duração da janela do dia (trata virada)
      for (const id of ['pausa_inicio', 'pausa_termino']) {
        const t = m(id); if (t != null && adiante(dia0, t) > span) return { btns: [pbtn], msg: 'A pausa tem de ficar entre o deslocamento de ida e o de retorno.' }
      }
    }
    // Teto de plausibilidade: nenhuma RAT de um dia fatura ~14h+. Acima disso é quase certo erro
    // de digitação (término/deslocamento) que inflou o tempo — backstop geral (pega o que os pares acima não pegam).
    const totCron = calcTempo()
    if (totCron != null && totCron > 14 * 60) {
      return { btns: [], campos: ['hora_inicio', 'hora_termino'],
        msg: `Tempo calculado (${fmtMin(totCron)}) improvável para um atendimento de um dia — confira os horários.` }
    }
    return null
  }
  // O "tempo no local" da visita improdutiva usa os campos do formulário Hora de Início /
  // Hora de Término (execução) — não há mais campos próprios de permanência.
  // Cálculo puro a partir das respostas (compartilhado com o back-office).
  // NOVO: tempo = execução + ida + retorno (que existiram) − almoço − pausa.
  // LEGADO: RAT antiga (só a chave `deslocamento`) usa a janela única ida→retorno.
  // horários são só HH:MM (sem data): término < início = virou a meia-noite → +24h.
  function calcTempoDe(resp) {
    resp = resp || {}
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
    let bruto = b - a; if (bruto < 0) bruto += 1440   // atendimento que virou o dia
    const t = bruto - alm - pau
    return t < 0 ? 0 : t
  }
  function calcTempo() {
    const val = (id) => { const el = document.querySelector(`[data-campo="${CSS.escape(id)}"]`); return el ? el.value : '' }
    return calcTempoDe({
      deslocamento: val('deslocamento'),
      desloc_ida: val('desloc_ida'), desloc_retorno: val('desloc_retorno'),
      desloc_inicial_ida: val('desloc_inicial_ida'), desloc_final_ida: val('desloc_final_ida'),
      desloc_inicial_retorno: val('desloc_inicial_retorno'), desloc_final_retorno: val('desloc_final_retorno'),
      hora_inicio: val('hora_inicio'), hora_termino: val('hora_termino'),
      almoco_inicio: val('almoco_inicio'), almoco_termino: val('almoco_termino'),
      pausa_inicio: val('pausa_inicio'), pausa_termino: val('pausa_termino'),
    })
  }
  const fmtMin = (t) => t == null ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  function atualizarTempo() {
    const el = document.getElementById('f-tempo'); if (!el) return
    const t = calcTempo(), v = fmtMin(t)
    if ('value' in el && el.tagName === 'INPUT') el.value = v; else el.textContent = v
    // Aviso ao vivo: término antes do início, ou tempo implausível → sinaliza na hora (não só no salvar).
    const ini = minutosDe(valorCampo('hora_inicio')), fim = minutosDe(valorCampo('hora_termino'))
    const invert = ini != null && fim != null && fim < ini
    const alto = t != null && t > 14 * 60
    const calc = el.closest('.calc')
    if (!calc) return
    calc.classList.toggle('tempo-alerta', invert || alto)
    let hint = calc.querySelector('.tempo-hint')
    if (invert || alto) {
      if (!hint) { hint = document.createElement('div'); hint.className = 'tempo-hint'; (el.parentElement || calc).appendChild(hint) }
      hint.textContent = invert ? 'Hora de Término está antes da de Início — confira.' : 'Tempo muito alto — confira os horários.'
    } else if (hint) hint.remove()
  }

  // ── Autosave: preserva o que foi digitado no rascunho local, a cada alteração ──
  // Só age sobre RASCUNHO (não altera RAT já salva/enviada sem um Salvar explícito).
  // respostas vazio grava null para manter a regra de "rascunho vazio" do descarte.
  let autosaveT = null
  let autosavePend = false   // RAT com gravação em debounce ainda não persistida → trava o auto-reload
  function agendarAutosave() {
    if (!cur || !cur.client_uuid) return
    autosavePend = true
    clearTimeout(autosaveT)
    autosaveT = setTimeout(async () => {
      window.srStep && window.srStep('  TICK autosave (700ms)')
      try {
        if (!cur || !cur.client_uuid) return
        const r = await D().obterRat(cur.client_uuid)
        const S = D().STATUS
        // Autosalva rascunho E RAT reaberta pra correção (confirmada/salvo_local). NÃO mexe
        // enquanto está subindo (na_fila/enviando) pra não competir com o envio.
        if (!r || r.sync_status === S.NA_FILA || r.sync_status === S.ENVIANDO) return
        const eraConfirmada = r.sync_status === S.CONFIRMADO
        const { respostas } = coletarRespostas()
        if (usoProd) respostas.uso_produtos = usoProd
        await D().salvarRat(cur.client_uuid, {
          respostas: Object.keys(respostas).length ? respostas : null,
          tempo_trabalhado: calcTempo(),
          uso_produtos: usoProd || null,
        })
        // RAT já confirmada sendo editada (correção de devolução): vira pendente pra (1) o pull
        // do servidor NÃO sobrescrever a edição (aplicarDoServidor: local pendente vence) e
        // (2) a correção voltar a subir no próximo sync.
        if (eraConfirmada) await D().definirStatus(cur.client_uuid, S.SALVO_LOCAL, 'edição pós-confirmação')
      } catch (e) { /* autosave é melhor-esforço */ }
      finally { autosavePend = false }   // sempre limpa (inclusive nos early-returns) — não trava p/ sempre
    }, 700)
  }

  // ── Pausa em TEMPO REAL: ao iniciar/encerrar a pausa (ou editar os horários dela), salva a
  // RAT como em_andamento e SINCRONIZA na hora — assim o servidor recebe a pausa aberta e o
  // trigger 0072 coloca a Tarefa em "Em Pausa" pro admin acompanhar (e volta ao retomar).
  // Diferente do autosave (que só toca rascunho e não sobe): aqui empurra pro servidor.
  let persistPausaT = null
  let pausaPend = false   // persistência de pausa em debounce ainda não concluída → trava o auto-reload
  function agendarPersistPausa() {
    if (!cur || !cur.client_uuid) return
    pausaPend = true
    clearTimeout(persistPausaT)
    persistPausaT = setTimeout(() => { persistirPausaSync().catch(() => {}).finally(() => { pausaPend = false }) }, 700)
  }
  async function persistirPausaSync() {
    window.srStep && window.srStep('  TICK persistirPausaSync (700ms)')
    if (!cur || !cur.client_uuid) return
    const cliId = (document.getElementById('f-cliente') || {}).value || null
    const cli = ref.clientes.find(c => c.id === cliId)
    const { respostas } = coletarRespostas()
    if (usoProd) respostas.uso_produtos = usoProd
    await D().salvarRat(cur.client_uuid, {
      tarefa_id: cur.tarefa_id || null, tarefa_numero: cur.tarefa_numero || null,
      cliente_id: cliId, cliente_nome: (cli && cli.nome) || null,
      formulario_id: cur.formulario_id || null, tecnico_id: tecnico.id, tecnico_nome: tecnico.nome,
      status: 'em_andamento', atendimento_executado: true,
      tempo_trabalhado: calcTempo(), respostas, uso_produtos: usoProd || null,
    })
    await D().definirStatus(cur.client_uuid, D().STATUS.SALVO_LOCAL, 'pausa (status em tempo real)')
    if (window.SyncEngine && navigator.onLine) SyncEngine.syncAll()
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
    // horário próprio por técnico (só exceções, só dos selecionados) → tecnicos_part
    if (tecCampoId && respostas[tecCampoId]) {
      const partes = {}
      for (const n of String(respostas[tecCampoId]).split(',').map(s => s.trim()).filter(Boolean)) {
        if (tecPart[n] && (tecPart[n].inicio || tecPart[n].fim)) partes[n] = tecPart[n]
      }
      if (Object.keys(partes).length) respostas.tecnicos_part = partes
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
      const w = document.querySelector(`[data-field="${CSS.escape(id)}"]`)
      if (w) { w.classList.add('campo-erro'); primeiro = primeiro || w }
    }
    for (const el of (extraEls || [])) { if (el) { el.classList.add('btn-erro'); primeiro = primeiro || el } }
    if (primeiro) revelarNoForm(primeiro)   // rola no field-body (não scrollIntoView, que rola o documento no iOS)
  }

  // modo: 'em_andamento' (botão "Salvar e continuar") | 'registrado' (botão "Encerrar a RAT do dia").
  async function salvar(modo) {
    window.srStep && window.srStep('salvar: 0 topo (modo=' + modo + ')')
    if (!cur) return
    window.srStep && window.srStep('salvar: 1 leu f-cliente')
    const cliId = document.getElementById('f-cliente').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    window.srStep && window.srStep('salvar: 2 pre improdutiva/formulario-check')
    // Visita improdutiva: fui e não executei → registra motivo, sem exigir execução.
    if (atendExec === 'Não') return salvarImprodutiva(cliId)
    if (!cur.formulario_id) return toast('Esta tarefa não tem formulário configurado.', 'err')

    const sit = (modo === 'em_andamento') ? 'em_andamento' : 'registrado'
    // "Salvar e continuar" (em_andamento) → salva parcial, sem exigir os obrigatórios.
    const emExecucao = (sit === 'em_andamento')
    window.srStep && window.srStep('salvar: entrada (' + sit + ')')

    // Hora de Término não pode estar no futuro (vale também ao salvar parcial).
    if (horaTerminoNoFuturo()) { limparErros(); marcarErros(['hora_termino'], []); return toast('A Hora de Término não pode ser depois do horário atual.', 'err') }

    window.srStep && window.srStep('salvar: coletarRespostas')
    const { respostas, faltando, faltandoIds } = coletarRespostas()
    const vis = (c) => curVisivel[c.id] !== false
    const fotoObrig = cur.campos.some(c => c.tipo === 'foto' && c.obrigatorio && vis(c))
    const assinaturaObrig = cur.campos.some(c => c.tipo === 'assinatura' && c.obrigatorio && vis(c))
    const produtosObrig = cur.campos.some(c => c.tipo === 'produtos' && c.obrigatorio && vis(c))

    limparErros()
    window.srStep && window.srStep('salvar: listarFotos (IndexedDB)')
    const fotos = await D().listarFotos(cur.client_uuid)
    window.srStep && window.srStep('salvar: validacao campos/produtos/desloc')
    if (!emExecucao) {
      // Pergunta de produtos é obrigatória para concluir (resposta explícita Sim/Não)
      const temProdutosCampo = cur.campos.some(c => c.tipo === 'produtos' && vis(c))
      if (temProdutosCampo && !usoProd) {
        marcarErros([], [document.getElementById('form-produtos-btn')])
        return toast('Informe se houve uso de produtos.', 'err')
      }
      // Marcou "Sim" mas não lançou nenhum produto (qtd > 0): bloqueia.
      // Itens da tarefa pré-carregados (orçado/levado) ficam com qtd 0 e NÃO contam.
      if (temProdutosCampo && usoProd === 'Sim') {
        const matsU = await D().listarMateriais(cur.client_uuid)
        if (!matsU.some(m => Number(m.quantidade) > 0)) {
          marcarErros([], [document.getElementById('form-produtos-btn')])
          return toast('Você marcou que usou produtos — lance ao menos um (qtd maior que zero) ou marque “Não”.', 'err')
        }
      }
      // Deslocamento do dia precisa ser respondido (mora no botão "Deslocamento")
      const temDesloc = cur.campos.some(c => c.id === 'deslocamento' && vis(c))
      if (temDesloc && !respostas.deslocamento) {
        marcarErros([], [document.getElementById('form-desloc-btn')])
        return toast('Abra "Deslocamento" e responda.', 'err')
      }
      if (faltando.length) {
        // campos dos modais (Deslocamento/Almoço) destacam o botão; o resto inline
        const noForm = [], botoes = []
        for (const id of faltandoIds) {
          if (idsModalPausa.has(id) || ALMOCO_ID.test(id)) botoes.push(document.getElementById('form-pausa-btn'))
          else if (idsModalDesloc.has(id)) botoes.push(document.getElementById('form-desloc-btn'))
          else noForm.push(id)
        }
        marcarErros(noForm, botoes)
        return toast('Preencha os campos destacados.', 'err')
      }
      if (fotoObrig && fotos.length === 0) { marcarErros([], [document.getElementById('form-fotos-btn')]); return toast('Anexe ao menos uma foto.', 'err') }
      if (produtosObrig && usoProd !== 'Não' && (await D().listarMateriais(cur.client_uuid)).filter(m => (Number(m.quantidade) || 0) > 0).length === 0) { marcarErros([], [document.getElementById('form-produtos-btn')]); return toast('Aponte os produtos utilizados (ou responda "Não").', 'err') }
    }

    window.srStep && window.srStep('salvar: assinatura (dataURL)')
    let assinatura_local = null
    const temAssinatura = sig && !sig.isEmpty()
    if (!emExecucao && assinaturaObrig && !temAssinatura) return toast('Capture a assinatura.', 'err')
    if (temAssinatura) assinatura_local = sig.dataURL()

    // Checkpoint de passagem (ao encerrar o dia): "volta amanhã?" obrigatório. Se Não → por quê?
    // 'volto_depois' exige o handoff (o que falta / o que levar); 'terminei' dispensa (NÃO conclui aqui).
    if (sit === 'registrado') {
      window.srStep && window.srStep('salvar: erroCronologia + checkpoint')
      const ec = erroCronologia()
      if (ec) { limparErros(); marcarErros(ec.campos || [], ec.btns.filter(Boolean)); return toast(ec.msg, 'err') }
      if (!voltaAmanha) return toast('Responda se volta amanhã pra continuar.', 'err')
      if (voltaAmanha === 'Não') {
        const m = passMotivoVal()
        if (!m) return toast('Diga por que não volta amanhã.', 'err')
        if (m === 'volto_depois') {
          if (!document.getElementById('f-passagem-falta').value.trim()) return toast('Informe o que falta pra terminar.', 'err')
          if (!document.getElementById('f-passagem-levar').value.trim()) return toast('Informe o que levar na próxima ida.', 'err')
        }
      }
    }

    const cli = ref.clientes.find(c => c.id === cliId)
    if (usoProd) respostas.uso_produtos = usoProd
    if (sit === 'registrado') {
      const m = (voltaAmanha === 'Não') ? passMotivoVal() : null
      respostas.volta_amanha = voltaAmanha
      respostas.passagem_motivo = m
      respostas.passagem_falta = (m === 'volto_depois') ? (document.getElementById('f-passagem-falta').value.trim() || null) : null
      respostas.passagem_levar = (m === 'volto_depois') ? (document.getElementById('f-passagem-levar').value.trim() || null) : null
    }

    // sit = 'em_andamento' (continua) | 'registrado' (encerra o dia). A RAT NUNCA conclui
    // o serviço — isso é deliberado na Tarefa ("Concluir serviço").
    // Guard de op crítica: SIGNED_OUT durante a gravação+notify não navega no meio do encerramento.
    // (salvarRat/definirStatus são locais; notificarPush é fire-and-forget — valor marginal, ver PR.)
    window.srStep && window.srStep('salvar: calcTempo + write salvarRat (IndexedDB)')
    window.srCriticalBegin?.()
    try {
    await D().salvarRat(cur.client_uuid, {
      tarefa_id: cur.tarefa_id || null,
      tarefa_numero: cur.tarefa_numero || null,
      cliente_id: cliId,
      cliente_nome: cli?.nome || null,
      formulario_id: cur.formulario_id || null,
      tecnico_id: tecnico.id,
      tecnico_nome: tecnico.nome,
      status: sit,
      pendencias: null,
      // execução normal: atendimento_executado=true limpa qualquer marca de improdutiva e SOBE no sync
      // (campo null é pulado no upload → servidor ficaria com false e remarcaria o checkbox ao reabrir).
      atendimento_executado: true,
      motivo_improdutiva: null,
      motivo_texto: null,
      tempo_trabalhado: calcTempo(),
      // data_tarefa fixado na criação (jorHoje, local) — não re-carimbar a cada save (evitava virar o dia em UTC)
      respostas,
      uso_produtos: usoProd || null,
      questionario_ok: faltando.length === 0,
      tem_assinatura: !!temAssinatura,
      assinatura_local,
    })
    await D().definirStatus(cur.client_uuid, D().STATUS.SALVO_LOCAL, 'salvo pelo técnico')
    // Avisa admin/gestor quando a RAT do dia é encerrada (registrada), se online.
    if (!emExecucao && navigator.onLine && window.notificarPush) {
      notificarPush('rat_registrada', { numero: cur.tarefa_numero, cliente: cli?.nome, tarefa_id: cur.tarefa_id })
    }
    } finally { window.srCriticalEnd?.() }
    window.srStep && window.srStep('salvar: write OK; abrindo handoff/sync')
    // Handoff ao encerrar (volta amanhã = Não) → modal guiado:
    //  volto_depois → Tarefa foi pra EM PAUSA (informa + leva à Tarefa).
    //  terminei     → guia a CONCLUIR o serviço (encerrar a RAT não conclui — resolve 4773/4774).
    //  Sim / em_andamento → sem modal, só toast (não encher de pop-up à toa).
    const handoff = (sit === 'registrado' && voltaAmanha === 'Não') ? passMotivoVal() : null
    const tId = cur.tarefa_id || null
    cur = null; sig = null; usoProd = null
    // Abre o handoff SOBRE o form (NÃO via mostrar('home') — isso dispararia o auto-update e
    // recarregaria por cima do modal → tela branca). Os botões do modal fazem a navegação.
    if (handoff === 'volto_depois') { abrirModalHandoff('pausa', tId) }
    else if (handoff === 'terminei') { abrirModalHandoff('concluir', tId) }
    else { toast(emExecucao ? 'RAT salva no aparelho.' : 'Atendimento do dia realizado.', 'ok'); mostrar('lista'); await renderLista() }
    // Tenta sincronizar imediatamente se houver conexão (passo 5).
    if (window.SyncEngine && navigator.onLine) window.SyncEngine.syncAll()
  }

  // Visita improdutiva (§ "RAT improdutiva"): registra deslocamento + tempo de quem foi,
  // execução zerada, motivo. A RAT fecha como 'improdutiva' e a Tarefa fica aguardando
  // (o trigger 0053 não promove quando atendimento_executado=false). Avisa o admin.
  async function salvarImprodutiva(cliId) {
    const motivoEl = document.querySelector('#f-motivos input[name="f-motivo"]:checked')
    if (!motivoEl) return toast('Escolha o motivo de não ter executado.', 'err')
    const motivo = motivoEl.value
    let motivoTexto = null
    if (motivo === 'outro') {
      motivoTexto = (document.getElementById('f-motivo-texto').value || '').trim()
      if (!motivoTexto) { const w = document.getElementById('f-motivo-texto-wrap'); if (w) w.classList.add('campo-erro'); return toast('Descreva o motivo.', 'err') }
    }
    // Tempo no local = Hora de Início / Hora de Término (execução) — obrigatório (faturável:
    // cliente paga deslocamento + permanência). Reusa os campos do formulário, não há bloco próprio.
    const mIni = minutosDe(valorCampo('hora_inicio')), mFim = minutosDe(valorCampo('hora_termino'))
    if (mIni == null || mFim == null) { marcarErros(['hora_inicio', 'hora_termino'], []); return toast('Informe Hora de Início e Hora de Término (tempo no local).', 'err') }
    if (mFim < mIni) { marcarErros(['hora_termino'], []); return toast('A Hora de Término não pode ser antes da de Início.', 'err') }
    if (horaTerminoNoFuturo()) { marcarErros(['hora_termino'], []); return toast('A Hora de Término não pode ser depois do horário atual.', 'err') }
    const ecImp = erroCronologia()
    if (ecImp) { limparErros(); marcarErros(ecImp.campos || [], ecImp.btns.filter(Boolean)); return toast(ecImp.msg, 'err') }
    // Mantém o que já foi apontado no formulário (deslocamento, início/término).
    const { respostas } = coletarRespostas()
    // Improdutiva não tem pausa/almoço (não houve execução) → remove resquício de rascunho, pra não
    // vazar dado sujo pro PDF/relatório. Não afeta a conta: o tempo aqui é só o tempo no local (mFim−mIni).
    for (const k of ['pausa', 'pausa_inicio', 'pausa_termino', 'pausa_motivo',
                     'almoco', 'almoco_inicio', 'almoco_termino']) delete respostas[k]
    const cli = ref.clientes.find(c => c.id === cliId)
    await D().salvarRat(cur.client_uuid, {
      tarefa_id: cur.tarefa_id || null,
      tarefa_numero: cur.tarefa_numero || null,
      cliente_id: cliId,
      cliente_nome: cli?.nome || null,
      formulario_id: cur.formulario_id || null,
      tecnico_id: tecnico.id,
      tecnico_nome: tecnico.nome,
      status: 'improdutiva',
      atendimento_executado: false,
      motivo_improdutiva: motivo,
      motivo_texto: motivoTexto,
      tempo_trabalhado: (mFim - mIni),   // tempo no local pelos campos de execução (sem serviço concluído)
      // data_tarefa fixado na criação (jorHoje, local) — não re-carimbar
      respostas: Object.keys(respostas).length ? respostas : null,
      uso_produtos: null,
      questionario_ok: true,
      tem_assinatura: false,
      assinatura_local: null,
    })
    await D().definirStatus(cur.client_uuid, D().STATUS.SALVO_LOCAL, 'visita improdutiva')
    toast('Visita improdutiva registrada.', 'ok')
    if (navigator.onLine && window.notificarPush) {
      notificarPush('rat_improdutiva', { numero: cur.tarefa_numero, cliente: cli?.nome, tarefa_id: cur.tarefa_id, motivo: MOTIVO_IMPRODUTIVA[motivo] || motivo })
    }
    cur = null; sig = null; usoProd = null
    mostrar('lista')
    await renderLista()
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
        && !rat.tem_foto && !rat.tem_assinatura && !rat.questionario_ok && !rat.respostas && !rat.uso_produtos
        && fotos.length === 0
        && !mats.some(m => (Number(m.quantidade) || 0) > 0 || m.qtd_levada == null)
      if (vazio) await D().removerRat(cur.client_uuid)
    }
    cur = null; sig = null; usoProd = null
    mostrar('lista')
    await renderLista()
  }

  // ═══════════════════════ Pré-orçamento (form fixo) ═══════════════════════
  let curPo = null   // { client_uuid }
  let poReadonly = false   // pré-orçamento que já virou orçamento (orcamento_em) → só leitura
  let poTecSel = new Set()   // IDs dos técnicos do levantamento (equipe)

  // Trava de UI quando o pré-orçamento já virou orçamento (a 0114 tb bloqueia no servidor).
  // Desabilita os campos, esconde Salvar/Enviar (Cancelar vira "Voltar") e mostra o aviso.
  // A classe .po-ro no form sobrevive ao re-render dos timers (bloqueio via CSS).
  function poAplicarReadonly(on) {
    poReadonly = !!on
    const form = document.getElementById('view-preorc-form'); if (!form) return
    form.classList.toggle('po-ro', poReadonly)
    form.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = poReadonly })
    const g = (id) => document.getElementById(id)
    if (g('po-btn-rascunho')) g('po-btn-rascunho').style.display = poReadonly ? 'none' : ''
    if (g('po-btn-salvar')) g('po-btn-salvar').style.display = poReadonly ? 'none' : ''
    if (g('po-btn-cancelar')) g('po-btn-cancelar').textContent = poReadonly ? 'Voltar' : 'Cancelar'
    if (g('po-ro-aviso')) g('po-ro-aviso').style.display = poReadonly ? '' : 'none'
  }
  // (Seção "Técnico do levantamento" removida — pré-orçamento é de 1 técnico só, o criador,
  //  automático. poTecSel segue semeado com o criador para respostas.tecnicos/PDF/jornada.)

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
      const rasc = !conf && (p.sync_status === 'rascunho' || p.status === 'rascunho')
      const orcado = !!p.orcamento_em   // já virou orçamento → só leitura
      const sk = conf ? 'done' : 'warn'
      const badge = orcado ? 'Orçado' : (conf ? 'Enviado' : (rasc ? 'Rascunho' : 'na fila ↑'))
      return `<div class="listcard lc-${conf ? 'done' : 'warn'}" data-uuid="${esc(p.client_uuid)}"><span class="edge e-${sk}"></span>
        <div class="t"><span class="cli">${esc(p.cliente_nome || 'Sem cliente')}</span><span class="badge b-${sk}">${badge}</span></div>
        <div class="meta">${p.numero ? 'Nº <b>' + esc(p.numero) + '</b> · ' : ''}${esc((p.descricao || '—').slice(0, 48))}</div>
        <div class="meta" style="display:flex;justify-content:space-between;align-items:center"><span>${fdt(p.criado_em, { withTime: true })}</span>${orcado ? '' : `<button type="button" class="rat-del" data-del="${esc(p.client_uuid)}" title="Excluir pré-orçamento" style="background:none;border:none;cursor:pointer"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m4 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>`}</div>
      </div>`
    }).join('')
    box.querySelectorAll('.listcard').forEach(el => {
      el.onclick = (e) => { if (e.target.closest('[data-del]')) return; abrirPreorc(el.dataset.uuid) }
    })
    box.querySelectorAll('[data-del]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); excluirPreorc(b.dataset.del) } })
  }

  async function excluirPreorc(client_uuid) {
    if (!confirm('Excluir este pré-orçamento? Esta ação não pode ser desfeita.')) return
    const po = await D().obterPreorc(client_uuid)
    if (po && po.recebido_em && navigator.onLine) {
      try {
        const sb = getSupabase()
        const { data: srv } = await sb.from('pre_orcamentos').select('id').eq('client_uuid', client_uuid).maybeSingle()
        if (srv) {
          await sb.from('pre_orcamento_itens').delete().eq('pre_orcamento_id', srv.id)
          await sb.from('relatorio_fotos').delete().eq('pre_orcamento_id', srv.id)
          await sb.from('pre_orcamentos').delete().eq('id', srv.id)
        }
      } catch (e) { toast('Removido do aparelho; falha no servidor: ' + (e.message || e), 'err') }
    }
    await D().removerPreorc(client_uuid)
    await renderPreorcLista()
    toast('Pré-orçamento excluído.', 'ok')
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
      'po-desloc', 'po-visita-ini', 'po-visita-fim', 'po-ida', 'po-retorno',
      'po-almoco-ini', 'po-almoco-fim', 'po-pausa-ini', 'po-pausa-fim',
      'po-est-tec', 'po-est-qtd', 'po-observacoes'].forEach(id => set(id, ''))
    set('po-est-un', 'dias')
    set('po-tempo', '—')
    poSetDesloc('')
    poSetTevePausa('')
    poTecSel = new Set(tecnico.id ? [tecnico.id] : [])   // técnico do levantamento = o logado (só ele)
    atualizarEstimativaPo()
    poAplicarReadonly(false)   // toda abertura começa editável; abrirPreorc reaplica se travado
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
    preencherLevantamentoPo(); atualizarCardsPo()
    poTrilhaRender(null)                   // pré novo não tem trilha — esconde resto de outro pré
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
    set('po-desloc', r.deslocamento); set('po-visita-ini', r.visita_inicio); set('po-visita-fim', r.visita_termino)
    set('po-ida', r.ida); set('po-retorno', r.retorno)
    set('po-almoco-ini', r.almoco_inicio); set('po-almoco-fim', r.almoco_termino)
    set('po-pausa-ini', r.pausa_inicio); set('po-pausa-fim', r.pausa_termino)
    const tevePausa = r.teve_pausa || ((r.almoco_inicio || r.pausa_inicio) ? 'Sim' : '')
    const est = r.estimativa || {}
    set('po-est-tec', est.tecnicos); set('po-est-qtd', est.qtd); if (est.unidade) set('po-est-un', est.unidade)
    set('po-observacoes', r.observacoes)
    // Técnico(s) do levantamento (respostas.tecnicos): preserva o que foi gravado — os
    // antigos com 2+ ficam como estão; novos têm só o criador. Sem UI de seleção.
    const tecsSalvos = (r.tecnicos || []).map(t => (t && t.id) ? t.id : t).filter(Boolean)
    poTecSel = new Set(tecsSalvos.length ? tecsSalvos : (po.tecnico_id ? [po.tecnico_id] : []))
    poSetDesloc(r.deslocamento || ''); poSetTevePausa(tevePausa); atualizarEstimativaPo()
    poBindAutocomplete()
    await poRefreshThumbs()
    await poRefreshItens()
    mostrar('preorc-form')
    preencherLevantamentoPo(); atualizarCardsPo()
    poAplicarReadonly(!!po.orcamento_em)   // já virou orçamento → só leitura (server tb trava)
    poTrilhaRender(po)                     // Trilha comercial (C4) — online, nunca bloqueia
  }

  // ── Trilha comercial (C4) ─────────────────────────────────────────────
  // Orçamentos deste levantamento + a OS de cada um, via RPC trilha_do_pre
  // (0116): UMA chamada, autorização e campos mínimos NO SERVIDOR — a RPC não
  // expõe preço/valores/observações. Leitura online e apenas informativa:
  // pré só-local (sem id do servidor), offline ou erro → seção oculta, o app
  // offline-first segue intacto. "OS removida" só aparece quando existe o
  // evento tarefa_removida (flag calculado pela RPC, nunca inferido aqui).
  let poTrilhaReq = 0
  async function poTrilhaRender(po) {
    const req = ++poTrilhaReq   // ANTES de qualquer return: invalida resposta em voo de outro pré
    const box = document.getElementById('po-trilha'), body = document.getElementById('po-trilha-body')
    if (!box || !body) return
    box.style.display = 'none'; body.innerHTML = ''
    if (!po || !po.id || !po.orcamento_em || !navigator.onLine) return
    try {
      const cli = getSupabase(); if (!cli) return
      const { data: d, error } = await cli.rpc('trilha_do_pre', { p_pre: po.id })
      if (req !== poTrilhaReq) return   // já abriu outro pré
      if (error || !d || !(d.orcamentos || []).length) return
      const lab = { rascunho: 'Aguardando aprovação', enviado: 'Enviado', aprovado: 'Aprovado', nao_aprovado: 'Não aprovado', arquivado: 'Arquivado' }
      const osNo5 = (n) => String(n).padStart(5, '0')
      body.innerHTML = d.orcamentos.map(o => {
        const os = o.tarefa ? `OS Nº <b>${esc(osNo5(o.tarefa.numero))}</b>`
          : o.tarefa_removida ? '<span style="color:#E5403A;font-weight:600">OS removida</span>'
          : '<span style="color:var(--tx3,#7C8698)">sem OS</span>'
        return `<div style="padding:4px 0">Orçamento Nº <b>${esc(o.numero)}</b> <span style="color:var(--tx3,#7C8698)">· ${esc(lab[o.status] || o.status)}</span> — ${os}</div>`
      }).join('')
      box.style.display = ''
    } catch (e) { /* trilha é informativa — nunca quebra o app do técnico */ }
  }

  function onDeslocPoChange() {
    const d = document.getElementById('po-desloc').value
    // "Sim" mostra ida/retorno; "Não" não abre nada (a visita tem início/término próprios).
    document.getElementById('po-bloco-com').style.display = d === 'Sim' ? 'block' : 'none'
    atualizarTempoPo(); atualizarCardsPo(); poTimersRender()
  }
  // Timers Iniciar/Encerrar/Reabrir (igual à RAT) para os pares de horário do pré-orçamento.
  let poTimersTick = null
  function poTimersRender() {
    window.srStep && window.srStep('  poRender: entrada')
    const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
    const decorrido = (ini) => {
      const [h, m] = String(ini).split(':').map(Number); if (isNaN(h) || isNaN(m)) return ''
      const d = new Date(); let t = (d.getHours() * 60 + d.getMinutes()) - (h * 60 + m); if (t < 0) t += 1440
      return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
    }
    const P = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>'
    const S = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'
    const U = '<svg viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.6L3 13"/></svg>'
    const defs = [
      { host: 'po-tmr-visita', ini: 'po-visita-ini', fim: 'po-visita-fim', iniciar: 'Iniciar o pré-orçamento', curto: 'Pré-orçamento', tempo: true },
      { host: 'po-tmr-desloc', ini: 'po-ida', fim: 'po-retorno', iniciar: 'Iniciar deslocamento', curto: 'Deslocamento' },
      { host: 'po-tmr-almoco', ini: 'po-almoco-ini', fim: 'po-almoco-fim', iniciar: 'Iniciar almoço', curto: 'Almoço' },
      { host: 'po-tmr-pausa', ini: 'po-pausa-ini', fim: 'po-pausa-fim', iniciar: 'Iniciar pausa', curto: 'Pausa' },
    ]
    // Atualiza direto: os modais (deslocamento/pausa) ficam FORA do #view-preorc-form,
    // então o evento 'input' não borbulha até o listener do form. Sem isso, a barra não troca pra "Encerrar".
    const stamp = (el, val) => { if (el) { el.value = val; atualizarTempoPo(); atualizarCardsPo(); poTimersRender() } }
    for (const d of defs) {
      window.srStep && window.srStep('    poRenderBar: ' + d.host)
      const bar = document.getElementById(d.host); if (!bar) continue
      const eIni = document.getElementById(d.ini), eFim = document.getElementById(d.fim)
      const vi = eIni ? eIni.value : '', vf = eFim ? eFim.value : ''
      if (!vi) {
        bar.className = 'atd-timer'
        bar.innerHTML = `<div class="tt">${esc(d.curto)} ainda não iniciado</div><button type="button" class="go">${P}${esc(d.iniciar)}</button>`
        bar.querySelector('.go').onclick = () => stamp(eIni, hhmm())
      } else if (!vf) {
        bar.className = 'atd-timer run'
        bar.innerHTML = `<div class="tt">${esc(d.curto)} desde <b>${esc(vi)}</b> · <span class="el">${esc(decorrido(vi))}</span></div><button type="button" class="redo" title="Desfazer início">${U}</button><button type="button" class="stop">${S}Encerrar</button>`
        bar.querySelector('.stop').onclick = () => stamp(eFim, hhmm())
        bar.querySelector('.redo').onclick = () => stamp(eIni, '')
      } else {
        bar.className = 'atd-timer'
        const extra = d.tempo ? ` · <span class="el">${esc(fmtMin(calcTempoPo()))}</span>` : ''
        bar.innerHTML = `<div class="tt">${esc(d.curto)} <b>${esc(vi)}</b> – <b>${esc(vf)}</b>${extra}</div><button type="button" class="redo" title="Reabrir para refazer o término">${U}Reabrir</button>`
        bar.querySelector('.redo').onclick = () => stamp(eFim, '')
      }
    }
    window.srStep && window.srStep('  poRender: saida (pre-setInterval)')
    if (!poTimersTick) poTimersTick = setInterval(() => { var S = window.srStep || function () {}; S('  TICK poTimersTick 30s'); var run = !!document.querySelector('#view-preorc-form .atd-timer.run'); S('  poTick: guard run=' + run); if (run) poTimersRender(); S('  poTick: pos-guard'); Promise.resolve().then(function () { S('  poTick POST-micro') }); setTimeout(function () { S('  poTick POST-macro (PRE-paint)') }, 0); requestAnimationFrame(function () { requestAnimationFrame(function () { S('  poTick POST-PAINT (2x rAF)') }) }) }, 30000)
  }
  // Deslocamento segmentado (Sim/Não) → grava no hidden po-desloc + marca o botão ativo.
  function poSetDesloc(v) {
    const h = document.getElementById('po-desloc'); if (h) h.value = v || ''
    document.querySelectorAll('#po-desloc-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v))
    onDeslocPoChange()
  }
  // "Teve pausa / almoço?" Sim/Não — "Não" esconde e zera os campos; "Sim" revela.
  function poSetTevePausa(v) {
    const h = document.getElementById('po-teve-pausa'); if (h) h.value = v || ''
    document.querySelectorAll('#po-pausa-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v))
    const bloco = document.getElementById('po-bloco-pausa'); if (bloco) bloco.style.display = v === 'Sim' ? 'block' : 'none'
    if (v === 'Não') {['po-almoco-ini', 'po-almoco-fim', 'po-pausa-ini', 'po-pausa-fim'].forEach(id => { const e = document.getElementById(id); if (e) e.value = '' }) }
    atualizarTempoPo(); atualizarCardsPo(); poTimersRender()
  }
  // Item avulso (fora de catálogo) no pré-orçamento — mesmo conceito da RAT.
  async function poAddAvulso() {
    if (!curPo) return
    const nome = document.getElementById('po-pav-nome').value.trim().toUpperCase()
    const qtd = Number(document.getElementById('po-pav-qtd').value)
    if (!nome) return toast('Informe o nome do item.', 'err')
    if (!qtd || qtd <= 0) return toast('Informe a quantidade.', 'err')
    await D().adicionarItemPreorc(curPo.client_uuid, { produto_id: null, codigo_produto: null, descricao: nome, unidade: null, quantidade: qtd })
    document.getElementById('po-pav-nome').value = ''
    document.getElementById('po-pav-qtd').value = ''
    document.getElementById('po-prod-avulso-form').style.display = 'none'
    await poRefreshItens()
  }
  // Duração em minutos de um par início/término (padrão da RAT). 0 se incompleto/inválido.
  function poDur(iniId, fimId) {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : '' }
    const i = minutosDe(v(iniId)), f = minutosDe(v(fimId))
    return (i != null && f != null && f > i) ? (f - i) : 0
  }
  function calcTempoPo() {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : '' }
    // Tempo = visita (término - início) + deslocamento (ida→retorno) - almoço - pausa.
    const a = minutosDe(v('po-visita-ini')), b = minutosDe(v('po-visita-fim'))
    if (a == null || b == null) return null
    const t = (b - a) + poDur('po-ida', 'po-retorno') - poDur('po-almoco-ini', 'po-almoco-fim') - poDur('po-pausa-ini', 'po-pausa-fim')
    return t < 0 ? 0 : t
  }
  function atualizarTempoPo() {
    const el = document.getElementById('po-tempo'); if (el) el.value = fmtMin(calcTempoPo())
  }
  // Badge dos cards do pré-orçamento (mesmo visual da RAT: st-ok quando preenchido).
  function setBadgePo(el, txt, ok) { if (el) { el.textContent = txt; el.className = 'st ' + (ok ? 'st-ok' : 'st-pend') } }
  async function atualizarCardsPo() {
    if (!curPo) return
    try {
      const itens = await D().listarItensPreorc(curPo.client_uuid)
      const fotos = await D().listarFotos(curPo.client_uuid)
      setBadgePo(document.getElementById('po-st-prod'), itens.length ? `${itens.length} ${itens.length > 1 ? 'itens' : 'item'}` : 'Nenhum', itens.length > 0)
      setBadgePo(document.getElementById('po-st-fotos'), fotos.length ? `${fotos.length} ${fotos.length > 1 ? 'fotos' : 'foto'}` : 'Nenhuma', fotos.length > 0)
    } catch (e) { /* offline/erro: mantém o badge */ }
    const d = (document.getElementById('po-desloc') || {}).value || ''
    setBadgePo(document.getElementById('po-st-desloc'), d || '—', !!d)
    const teve = (document.getElementById('po-teve-pausa') || {}).value || ''
    const tot = poDur('po-almoco-ini', 'po-almoco-fim') + poDur('po-pausa-ini', 'po-pausa-fim')
    setBadgePo(document.getElementById('po-st-pausa'), teve === 'Não' ? 'Não' : (tot ? `${tot} min` : (teve === 'Sim' ? 'Sim' : '—')), !!teve)
  }
  // Data + técnico (logado, como na RAT) no card "O levantamento".
  function preencherLevantamentoPo() {
    const dEl = document.getElementById('po-lev-data')
    if (dEl) dEl.textContent = hojeBR().split('-').reverse().join('/')
  }
  // Estimativa de execução: "N técnicos × N dias/horas" (resumo + linha no card Tempo). Sem total.
  function atualizarEstimativaPo() {
    const tec = Number((document.getElementById('po-est-tec') || {}).value) || 0
    const qtd = Number((document.getElementById('po-est-qtd') || {}).value) || 0
    const un = (document.getElementById('po-est-un') || {}).value || 'dias'
    const resumoEl = document.getElementById('po-est-resumo')
    const destaqueEl = document.getElementById('po-est-destaque')   // caixa verde do card Tempo
    const mostra = tec > 0 && qtd > 0
    const txt = mostra
      ? `${tec} ${tec > 1 ? 'técnicos' : 'técnico'} × ${qtd} ${un === 'horas' ? (qtd > 1 ? 'horas' : 'hora') : (qtd > 1 ? 'dias' : 'dia')}`
      : ''
    if (resumoEl) { resumoEl.textContent = txt; resumoEl.style.display = mostra ? '' : 'none' }
    if (destaqueEl) destaqueEl.textContent = mostra ? txt : '—'
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
      // blob local → objectURL; foto hidratada (sem blob) → preview assinado; nunca usa o path cru.
      const src = f.blob ? URL.createObjectURL(f.blob) : (f.preview || f.url || '')
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

  // Monta o payload do pré-orçamento a partir do formulário (usado por Salvar e Enviar).
  function poMontarPayload(status) {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : '' }
    const cliId = document.getElementById('po-cliente').value
    const cli = ref.clientes.find(c => c.id === cliId)
    return {
      cliente_id: cliId || null,
      cliente_nome: cli?.nome || null,
      tecnico_id: tecnico.id,
      tecnico_nome: tecnico.nome,
      descricao: document.getElementById('po-descricao').value.trim(),
      respostas: {
        deslocamento: v('po-desloc') || null,
        visita_inicio: v('po-visita-ini') || null, visita_termino: v('po-visita-fim') || null,
        ida: v('po-ida') || null, retorno: v('po-retorno') || null,
        teve_pausa: v('po-teve-pausa') || null,
        almoco_inicio: v('po-almoco-ini') || null, almoco_termino: v('po-almoco-fim') || null,
        pausa_inicio: v('po-pausa-ini') || null, pausa_termino: v('po-pausa-fim') || null,
        estimativa: ((Number(v('po-est-tec')) || 0) || (Number(v('po-est-qtd')) || 0))
          ? { tecnicos: Number(v('po-est-tec')) || 0, qtd: Number(v('po-est-qtd')) || 0, unidade: v('po-est-un') || 'dias' }
          : null,
        observacoes: v('po-observacoes').trim() || null,
        tecnicos: [...poTecSel].map(id => {
          const t = (ref.tecnicos || []).find(x => x.id === id) || (id === tecnico.id ? { id, nome: tecnico.nome } : { id, nome: null })
          return { id, nome: t.nome || null }
        }),
      },
      tempo_trabalhado: calcTempoPo(),
      data: new Date().toISOString(),
      status,
    }
  }
  // Salvar (rascunho): grava o progresso e mantém RASCUNHO (não sincroniza) — continuar depois.
  async function salvarRascunhoPreorc() {
    if (!curPo || poReadonly) return
    await D().salvarPreorc(curPo.client_uuid, poMontarPayload('rascunho'))
    toast('Salvo. Você pode continuar depois.', 'ok')
    await renderPreorcLista()
  }
  async function concluirPreorc() {
    if (!curPo || poReadonly) return
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
        visita_inicio: v('po-visita-ini') || null, visita_termino: v('po-visita-fim') || null,
        ida: v('po-ida') || null, retorno: v('po-retorno') || null,
        teve_pausa: v('po-teve-pausa') || null,
        almoco_inicio: v('po-almoco-ini') || null, almoco_termino: v('po-almoco-fim') || null,
        pausa_inicio: v('po-pausa-ini') || null, pausa_termino: v('po-pausa-fim') || null,
        estimativa: ((Number(v('po-est-tec')) || 0) || (Number(v('po-est-qtd')) || 0))
          ? { tecnicos: Number(v('po-est-tec')) || 0, qtd: Number(v('po-est-qtd')) || 0, unidade: v('po-est-un') || 'dias' }
          : null,
        observacoes: v('po-observacoes').trim() || null,
        tecnicos: [...poTecSel].map(id => {
          const t = (ref.tecnicos || []).find(x => x.id === id) || (id === tecnico.id ? { id, nome: tecnico.nome } : { id, nome: null })
          return { id, nome: t.nome || null }
        }),
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

  // Fonte da verdade do auto-reload: só TRUE quando o app está 100% ocioso na HOME.
  // Na dúvida, FALSE. Bloqueia se: fora da home; RAT aberta (cur); deslocamento/viagem em
  // edição (dlCur, em memória até salvar); gravação em debounce (autosave/pausa); ou qualquer
  // modal aberto. Garante a regra inviolável: dado não-salvo do técnico nunca se perde no reload.
  function podeRecarregar() {
    try {
      if (screen !== 'home') return false
      if (cur || dlCur) return false
      if (autosavePend || pausaPend) return false
      if (document.querySelector('.tm-back.open')) return false   // modal aberto (overlays do app são .tm-back)
      return true
    } catch (e) { return false }
  }

  window.TecnicoApp = { init, refresh, podeRecarregar }
})()
