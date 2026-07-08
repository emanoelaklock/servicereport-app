/* ═══════════════════════════════════════════════
   Service Report — rat-calendario.js
   Calendário MENSAL de RATs (portal admin) — só LEITURA + atalho.
   · Carrega só as RATs do mês visível (limites em offset fixo BR -03:00).
   · Agrupa por dia em America/Sao_Paulo (Intl) — sem off-by-one.
   · Cor da bolinha = status da TAREFA (mapa canônico da tabela status_tarefa).
   · Clicar numa RAT → tarefa.html?t=<tarefa>&aba=rats&rat=<rat> (abre a RAT certa).
   Exposto como window.RatCalendarApp.
═══════════════════════════════════════════════ */
(function () {
  const sb = () => getSupabase()
  const TZ = 'America/Sao_Paulo'
  const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
  const pad = (n) => String(n).padStart(2, '0')

  // dia (YYYY-MM-DD) em fuso BR de um INSTANTE (data_tarefa é timestamptz completo →
  // new Date(instante) é seguro; o off-by-one só ocorre com string só-data). Intl formata em BR.
  const fmtBR = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  const diaBR = (iso) => iso ? fmtBR.format(new Date(iso)) : null
  const hojeBR = () => fmtBR.format(new Date())
  // DATA da RAT: o campo declarado no formulário (respostas.data, 'YYYY-MM-DD' local) tem
  // prioridade; senão o timestamp da RAT em fuso BR. Mesma precedência do app (tecnico.js:661).
  const ratDia = (r) => {
    const d = r && r.respostas && r.respostas.data
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10)
    return diaBR(r.data_tarefa)
  }
  // limites do mês em UTC. data_tarefa é gravado como MEIA-NOITE UTC da data declarada
  // (respostas.data) — ex.: RAT de 01/07 tem data_tarefa='2026-07-01T00:00:00+00'. Se os limites
  // fossem em BR (-03:00), julho começaria em 01/07T03:00Z e as RATs do dia 1º (00:00Z) cairiam
  // ANTES do início → sumiriam (a query de junho pega, mas o grid de junho não tem célula "01/07").
  // A exibição já usa respostas.data (ratDia), então o UTC casa query com exibição.
  function boundsMes(y, m) {
    const ny = m === 11 ? y + 1 : y, nm = m === 11 ? 0 : m + 1
    return { start: `${y}-${pad(m + 1)}-01T00:00:00Z`, end: `${ny}-${pad(nm + 1)}-01T00:00:00Z` }
  }
  // estrutura do calendário via UTC (fatos civis: dia-da-semana do 1º, dias no mês — independem de fuso)
  const firstDow = (y, m) => new Date(Date.UTC(y, m, 1)).getUTCDay()
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

  let ym = null
  let corStatus = {}, labelStatus = {}   // chave -> cor / label (tabela status_tarefa)
  let rats = [], orcNo = {}, tecNomes = {}, ratTecMap = {}, vistas = [], clientesMes = []   // clientesMes: combobox de Cliente
  const filtros = { busca: '', cliente: '', tecnicos: [], status: '', tarefa: '', rat: '', de: '', ate: '' }

  const osNo = (n) => n == null ? '—' : String(n).padStart(5, '0')

  // TODOS os responsáveis: principal (rats.tecnico_nome) ∪ co-responsáveis (rat_tecnicos → nome)
  function tecnicosDe(r) {
    const set = new Set()
    if (r.tecnico_nome) set.add(r.tecnico_nome)
    for (const id of (ratTecMap[r.id] || [])) { const n = tecNomes[id]; if (n) set.add(n) }
    return [...set]
  }
  function view(r) {
    const t = r.tarefa || {}
    const tecs = tecnicosDe(r)
    const pc = t.pedido_compra || ''
    const orc = (t.orcamento_id && orcNo[t.orcamento_id] != null) ? String(orcNo[t.orcamento_id]) : ''
    const rno = t.numero != null ? osNo(t.numero) + (r.rat_seq != null ? '/' + pad(r.rat_seq) : '') : ''
    // haystack da busca livre: nº, cliente, técnicos, PC, orçamento, orientação, status
    // E TUDO que está descrito na RAT (respostas em JSON). Tudo minúsculo, calculado 1x por carga.
    const hay = [osNo(t.numero), rno, r.cliente_nome, tecs.join(' '), t.orientacao, pc, orc,
      labelStatus[t.status] || '', r.respostas ? JSON.stringify(r.respostas) : ''].join(' ').toLowerCase()
    return {
      id: r.id, seq: r.rat_seq, dia: ratDia(r),
      tarefaId: t.id || null, numero: t.numero, status: t.status || '', ratStatus: r.status || '',
      cliente: r.cliente_nome || '—', tecnicos: tecs, tecnico: tecs.join(', ') || '—',
      pc, orcamento: orc, orientacao: t.orientacao || '', hay,
    }
  }
  const ratNo = (v) => v.numero != null ? osNo(v.numero) + (v.seq != null ? '/' + pad(v.seq) : '') : '—'
  const corDe = (status) => corStatus[status] || '#48506A'   // mesmo fallback do tarefa.js statusCor
  // Situação da PRÓPRIA RAT (secundária — só no tooltip; a cor do chip segue o serviço/Tarefa).
  const RAT_SIT_LABEL = { em_andamento: 'Em andamento', registrado: 'Atendimento Realizado', concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência', improdutiva: 'Visita improdutiva' }
  const ratSitLabel = (s) => RAT_SIT_LABEL[s] || s || '—'

  async function init() {
    const { data: st } = await sb().from('status_tarefa').select('chave,label,cor,ordem,ativo').order('ordem')
    corStatus = {}; labelStatus = {}
    for (const s of (st || [])) { corStatus[s.chave] = s.cor; labelStatus[s.chave] = s.label }
    // técnicos (id -> nome) p/ resolver os co-responsáveis (rat_tecnicos guarda só o id)
    const { data: us } = await sb().rpc('sr_usuarios')
    tecNomes = {}; for (const u of (us || [])) tecNomes[u.id] = u.nome
    // mês corrente em BR
    const y = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()))
    const m = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' }).format(new Date())) - 1
    ym = { y, m }
    renderLegenda()
    bind()
    await carregarMes()
  }

  function bind() {
    document.getElementById('rc-prev').onclick = () => { ym = ym.m === 0 ? { y: ym.y - 1, m: 11 } : { y: ym.y, m: ym.m - 1 }; carregarMes() }
    document.getElementById('rc-next').onclick = () => { ym = ym.m === 11 ? { y: ym.y + 1, m: 0 } : { y: ym.y, m: ym.m + 1 }; carregarMes() }
    document.getElementById('rc-hoje').onclick = () => {
      ym = { y: Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date())), m: Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' }).format(new Date())) - 1 }
      carregarMes()
    }
    // BUSCA EXPLÍCITA: nada dispara ao digitar; só ao clicar "Buscar" (ou Enter no campo de busca).
    const CAMPOS = { 'rcf-busca': 'busca', 'rcf-cliente': 'cliente', 'rcf-status': 'status', 'rcf-tarefa': 'tarefa', 'rcf-rat': 'rat', 'rcf-de': 'de', 'rcf-ate': 'ate' }
    const lerTecnicos = () => [...document.querySelectorAll('#rcf-tecnicos input:checked')].map(c => c.value)
    const aplicar = () => {
      for (const [id, k] of Object.entries(CAMPOS)) { const el = document.getElementById(id); if (el) filtros[k] = el.value.trim() }
      filtros.tecnicos = lerTecnicos()
      render()
    }
    document.getElementById('rcf-buscar').onclick = aplicar
    document.querySelectorAll('#rcf-busca, #rcf-cliente').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aplicar() } }))
    document.getElementById('rcf-limpar').onclick = () => {
      for (const id of Object.keys(CAMPOS)) { const el = document.getElementById(id); if (el) el.value = '' }
      document.querySelectorAll('#rcf-tecnicos input:checked').forEach(c => { c.checked = false })
      Object.keys(filtros).forEach(k => { filtros[k] = (k === 'tecnicos') ? [] : '' })
      render()
    }
    const advT = document.getElementById('rcf-adv-toggle'), adv = document.getElementById('rcf-adv')
    advT.onclick = () => {
      const abrir = adv.hasAttribute('hidden')
      if (abrir) adv.removeAttribute('hidden'); else adv.setAttribute('hidden', '')
      advT.setAttribute('aria-expanded', String(abrir))
    }
    document.getElementById('rc-mback').onclick = (e) => { if (e.target.id === 'rc-mback' || e.target.id === 'rc-modal-x') fecharModal() }
    // combobox de Cliente: dropdown que filtra conforme digita; clique escolhe
    const cin = document.getElementById('rcf-cliente'), clist = document.getElementById('rcf-cliente-list')
    const abrirCombo = () => {
      const termo = cin.value.trim().toLowerCase()
      const opts = clientesMes.filter(c => !termo || c.toLowerCase().includes(termo)).slice(0, 60)
      clist.innerHTML = opts.length
        ? opts.map(c => `<div class="rc-combo-opt" data-c="${esc(c)}">${esc(c)}</div>`).join('')
        : '<div class="rc-combo-empty">Nenhum cliente neste mês</div>'
      clist.hidden = false
    }
    cin.addEventListener('focus', abrirCombo)
    cin.addEventListener('input', abrirCombo)
    clist.addEventListener('mousedown', (e) => {   // mousedown vem antes do blur
      const o = e.target.closest('.rc-combo-opt'); if (!o) return
      e.preventDefault(); cin.value = o.dataset.c; clist.hidden = true
    })
    cin.addEventListener('blur', () => setTimeout(() => { clist.hidden = true }, 130))
    cin.addEventListener('keydown', (e) => { if (e.key === 'Escape') clist.hidden = true })
  }

  function renderLegenda() {
    const box = document.getElementById('rc-legend')
    box.innerHTML = Object.keys(corStatus).map(ch =>
      `<span><i style="background:${corStatus[ch]}"></i>${esc(labelStatus[ch] || ch)}</span>`).join('')
  }

  async function carregarMes() {
    const { start, end } = boundsMes(ym.y, ym.m)
    document.getElementById('rc-title').textContent = `${MONTHS[ym.m]} de ${ym.y}`
    document.getElementById('rc-grid').innerHTML = '<div class="rc-empty" style="grid-column:1/-1">Carregando…</div>'
    const { data, error } = await sb().from('rats')
      .select('id,rat_seq,status,data_tarefa,tecnico_nome,cliente_nome,respostas,tarefa:tarefas(id,numero,status,pedido_compra,orcamento_id,orientacao)')
      .gte('data_tarefa', start).lt('data_tarefa', end)
      .order('data_tarefa', { ascending: true })
    if (error) { document.getElementById('rc-grid').innerHTML = `<div class="rc-empty" style="grid-column:1/-1;color:var(--re)">Erro ao carregar: ${esc(error.message)}</div>`; return }
    rats = data || []
    // co-responsáveis (RAT colaborativa): rat_tecnicos do mês → mapa rat_id -> [tecnico_id]
    ratTecMap = {}
    const ids = rats.map(r => r.id)
    if (ids.length) {
      const { data: rt } = await sb().from('rat_tecnicos').select('rat_id,tecnico_id').in('rat_id', ids)
      for (const x of (rt || [])) (ratTecMap[x.rat_id] = ratTecMap[x.rat_id] || []).push(x.tecnico_id)
    }
    const oids = [...new Set(rats.map(r => r.tarefa && r.tarefa.orcamento_id).filter(Boolean))]
    orcNo = {}
    if (oids.length) { const { data: os } = await sb().from('orcamentos').select('id,numero').in('id', oids); for (const o of (os || [])) orcNo[o.id] = o.numero }
    vistas = rats.map(view)   // calcula views + haystack 1x por carga de mês
    render()
  }

  function passaFiltro(v) {
    const f = filtros, has = (campo, termo) => String(campo || '').toLowerCase().includes(termo.toLowerCase())
    if (f.busca && !v.hay.includes(f.busca.toLowerCase())) return false   // busca geral (inclui cliente, técnico, PC, orçamento, orientação + respostas)
    if (f.cliente && !has(v.cliente, f.cliente)) return false             // campo dedicado de cliente
    if (f.tecnicos.length && !v.tecnicos.some(t => f.tecnicos.includes(t))) return false   // um ou mais técnicos
    if (f.status && v.status !== f.status) return false
    if (f.tarefa) { const d = f.tarefa.replace(/\D/g, ''); if (!d || !String(v.numero == null ? '' : v.numero).includes(d)) return false }
    if (f.rat && !has(ratNo(v), f.rat)) return false
    if (f.de && (!v.dia || v.dia < f.de)) return false      // período (de/até): compara datas YYYY-MM-DD (sem tz)
    if (f.ate && (!v.dia || v.dia > f.ate)) return false
    return true
  }

  function popularFiltros(views) {
    // técnicos como checkboxes (um ou mais); repopula quando o conjunto do mês muda
    const box = document.getElementById('rcf-tecnicos')
    const tecs = [...new Set(views.flatMap(v => v.tecnicos))].filter(Boolean).sort((a, b) => a.localeCompare(b))
    const key = tecs.join('|')
    if (box.dataset.k !== key) {
      box.innerHTML = tecs.length
        ? tecs.map(t => `<label class="rc-chk"><input type="checkbox" value="${esc(t)}"${filtros.tecnicos.includes(t) ? ' checked' : ''}>${esc(t)}</label>`).join('')
        : '<span style="font-size:12px;color:var(--tx2)">Sem técnicos neste mês</span>'
      box.dataset.k = key
    }
    // clientes presentes no mês — alimentam o combobox de Cliente
    clientesMes = [...new Set(views.map(v => v.cliente).filter(c => c && c !== '—'))].sort((a, b) => a.localeCompare(b))
    const selS = document.getElementById('rcf-status')
    if (!selS.dataset.ready) {
      selS.innerHTML = '<option value="">Todos</option>' + Object.keys(corStatus).map(ch => `<option value="${esc(ch)}">${esc(labelStatus[ch] || ch)}</option>`).join('')
      selS.dataset.ready = '1'
    }
  }

  const urlRat = (v) => v.tarefaId ? `tarefa.html?t=${encodeURIComponent(v.tarefaId)}&aba=rats&rat=${encodeURIComponent(v.id)}` : `rat.html?id=${encodeURIComponent(v.id)}`
  function chipHTML(v) {
    const cor = corDe(v.status)
    const titulo = `RAT ${ratNo(v)} · ${v.cliente} · ${v.tecnico}`
      + (v.ratStatus ? `\nAtendimento: ${ratSitLabel(v.ratStatus)}` : '')
      + (v.status ? `\nServiço: ${labelStatus[v.status] || v.status}` : '')
      + (v.orientacao ? `\n\nOrientação: ${v.orientacao}` : '')
    // link real: clique normal abre na mesma aba; ctrl/⌘/botão-do-meio/direito abrem em nova aba
    return `<a class="rc-chip" href="${urlRat(v)}" data-rat="${esc(v.id)}" title="${esc(titulo)}"
      style="background:${cor}1A;border-left:3px solid ${cor}">
      <span class="task" style="color:${corTextoLegivel(cor)}">Nº ${esc(ratNo(v))}</span>
      <span class="cli">${esc(v.cliente)}</span>
      <span class="tec">${esc(v.tecnico)}</span>
      ${v.orientacao ? `<span class="ori">${esc(v.orientacao)}</span>` : ''}
    </a>`
  }

  function render() {
    popularFiltros(vistas)
    const filtered = vistas.filter(passaFiltro)
    document.getElementById('rc-count').textContent = `${filtered.length} RAT${filtered.length === 1 ? '' : 's'} em ${MONTHS[ym.m]}`
    const byDay = {}
    filtered.forEach(v => { if (v.dia) (byDay[v.dia] = byDay[v.dia] || []).push(v) })

    const fdow = firstDow(ym.y, ym.m), dim = daysInMonth(ym.y, ym.m), hoje = hojeBR()
    const cells = []
    for (let i = 0; i < fdow; i++) cells.push('<div class="rc-cell rc-out"></div>')
    for (let d = 1; d <= dim; d++) {
      const dia = `${ym.y}-${pad(ym.m + 1)}-${pad(d)}`
      const list = byDay[dia] || []
      const shown = list.slice(0, 4), extra = list.length - shown.length
      const tdy = dia === hoje
      cells.push(`<div class="rc-cell">
        <div class="rc-dhead">
          <span class="rc-dnum${tdy ? ' today' : ''}">${d}</span>
          ${list.length ? `<span class="rc-dcount">${list.length}</span>` : ''}
        </div>
        ${shown.map(chipHTML).join('')}
        ${extra > 0 ? `<button class="rc-more" data-dia="${dia}">+${extra} mais</button>` : ''}
      </div>`)
    }
    while (cells.length % 7 !== 0) cells.push('<div class="rc-cell rc-out"></div>')
    const grid = document.getElementById('rc-grid')
    grid.innerHTML = cells.join('')
    grid.querySelectorAll('.rc-more').forEach(b => b.onclick = () => abrirModal(b.dataset.dia, byDay[b.dataset.dia] || []))
  }

  function abrirModal(dia, list) {
    const [y, m, d] = dia.split('-')
    document.getElementById('rc-modal-t').textContent = `${Number(d)} de ${MONTHS[Number(m) - 1]} · ${list.length} RAT${list.length === 1 ? '' : 's'}`
    const body = document.getElementById('rc-modal-body')
    body.innerHTML = list.map(chipHTML).join('')
    document.getElementById('rc-mback').classList.add('open')
  }
  function fecharModal() { document.getElementById('rc-mback').classList.remove('open') }

  window.RatCalendarApp = { init }
})()
