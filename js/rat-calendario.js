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
  // limites do mês em BR (offset fixo -03:00; Brasil sem horário de verão desde 2019)
  function boundsMes(y, m) {
    const ny = m === 11 ? y + 1 : y, nm = m === 11 ? 0 : m + 1
    return { start: `${y}-${pad(m + 1)}-01T00:00:00-03:00`, end: `${ny}-${pad(nm + 1)}-01T00:00:00-03:00` }
  }
  // estrutura do calendário via UTC (fatos civis: dia-da-semana do 1º, dias no mês — independem de fuso)
  const firstDow = (y, m) => new Date(Date.UTC(y, m, 1)).getUTCDay()
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

  let ym = null
  let corStatus = {}, labelStatus = {}   // chave -> cor / label (tabela status_tarefa)
  let rats = [], orcNo = {}
  const filtros = { tarefa: '', rat: '', tecnico: '', data: '', orientacao: '', orcamento: '', status: '', pc: '' }

  const osNo = (n) => n == null ? '—' : String(n).padStart(5, '0')

  function view(r) {
    const t = r.tarefa || {}
    return {
      id: r.id, seq: r.rat_seq, dia: diaBR(r.data_tarefa),
      tarefaId: t.id || null, numero: t.numero, status: t.status || '',
      cliente: r.cliente_nome || '—', tecnico: r.tecnico_nome || '—',
      pc: t.pedido_compra || '', orcamento: (t.orcamento_id && orcNo[t.orcamento_id] != null) ? String(orcNo[t.orcamento_id]) : '',
      orientacao: t.orientacao || '',
    }
  }
  const ratNo = (v) => v.numero != null ? osNo(v.numero) + (v.seq != null ? '/' + pad(v.seq) : '') : '—'
  const corDe = (status) => corStatus[status] || '#48506A'   // mesmo fallback do tarefa.js statusCor

  async function init() {
    const { data: st } = await sb().from('status_tarefa').select('chave,label,cor,ordem,ativo').order('ordem')
    corStatus = {}; labelStatus = {}
    for (const s of (st || [])) { corStatus[s.chave] = s.cor; labelStatus[s.chave] = s.label }
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
    const F = { 'rcf-tarefa': 'tarefa', 'rcf-rat': 'rat', 'rcf-tecnico': 'tecnico', 'rcf-data': 'data', 'rcf-orientacao': 'orientacao', 'rcf-orcamento': 'orcamento', 'rcf-status': 'status', 'rcf-pc': 'pc' }
    for (const [id, key] of Object.entries(F)) {
      const el = document.getElementById(id); if (!el) continue
      const ev = (el.tagName === 'SELECT' || el.type === 'date') ? 'change' : 'input'
      el.addEventListener(ev, () => { filtros[key] = el.value.trim(); render() })
    }
    document.getElementById('rcf-limpar').onclick = () => {
      Object.keys(filtros).forEach(k => filtros[k] = '')
      for (const id of Object.keys(F)) { const el = document.getElementById(id); if (el) el.value = '' }
      render()
    }
    document.getElementById('rc-mback').onclick = (e) => { if (e.target.id === 'rc-mback' || e.target.id === 'rc-modal-x') fecharModal() }
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
      .select('id,rat_seq,data_tarefa,tecnico_nome,cliente_nome,tarefa:tarefas(id,numero,status,pedido_compra,orcamento_id,orientacao)')
      .gte('data_tarefa', start).lt('data_tarefa', end)
      .order('data_tarefa', { ascending: true })
    if (error) { document.getElementById('rc-grid').innerHTML = `<div class="rc-empty" style="grid-column:1/-1;color:var(--re)">Erro ao carregar: ${esc(error.message)}</div>`; return }
    rats = data || []
    const oids = [...new Set(rats.map(r => r.tarefa && r.tarefa.orcamento_id).filter(Boolean))]
    orcNo = {}
    if (oids.length) { const { data: os } = await sb().from('orcamentos').select('id,numero').in('id', oids); for (const o of (os || [])) orcNo[o.id] = o.numero }
    render()
  }

  function passaFiltro(v) {
    const f = filtros, has = (campo, termo) => String(campo || '').toLowerCase().includes(termo.toLowerCase())
    if (f.tarefa) { const d = f.tarefa.replace(/\D/g, ''); if (!d || !String(v.numero == null ? '' : v.numero).includes(d)) return false }
    if (f.rat && !has(ratNo(v), f.rat)) return false
    if (f.tecnico && v.tecnico !== f.tecnico) return false
    if (f.data && v.dia !== f.data) return false
    if (f.orientacao && !has(v.orientacao, f.orientacao)) return false
    if (f.orcamento && !has(v.orcamento, f.orcamento)) return false
    if (f.status && v.status !== f.status) return false
    if (f.pc && !has(v.pc, f.pc)) return false
    return true
  }

  function popularSelects(views) {
    const selT = document.getElementById('rcf-tecnico')
    if (selT.dataset.k !== String(views.length) + ym.y + ym.m) {   // repopula quando o conjunto muda
      const tecs = [...new Set(views.map(v => v.tecnico).filter(x => x && x !== '—'))].sort((a, b) => a.localeCompare(b))
      selT.innerHTML = '<option value="">Todos</option>' + tecs.map(t => `<option${t === filtros.tecnico ? ' selected' : ''}>${esc(t)}</option>`).join('')
      selT.dataset.k = String(views.length) + ym.y + ym.m
    }
    const selS = document.getElementById('rcf-status')
    if (!selS.dataset.ready) {
      selS.innerHTML = '<option value="">Todos</option>' + Object.keys(corStatus).map(ch => `<option value="${esc(ch)}">${esc(labelStatus[ch] || ch)}</option>`).join('')
      selS.dataset.ready = '1'
    }
  }

  function chipHTML(v) {
    const cor = corDe(v.status)
    return `<button class="rc-chip" data-rat="${esc(v.id)}" title="Tarefa ${esc(osNo(v.numero))} · ${esc(v.cliente)} · ${esc(v.tecnico)}"
      style="background:${cor}1A;border-left:3px solid ${cor}">
      <span class="l1"><span class="dot" style="background:${cor}"></span><span class="task" style="color:${cor}">Nº ${esc(osNo(v.numero))}</span></span>
      <span class="cli">${esc(v.cliente)}</span>
      <span class="tec">${esc(v.tecnico)}</span>
    </button>`
  }

  function render() {
    const views = rats.map(view)
    popularSelects(views)
    const filtered = views.filter(passaFiltro)
    document.getElementById('rc-count').textContent = `${filtered.length} RAT${filtered.length === 1 ? '' : 's'} em ${MONTHS[ym.m]}`
    const byDay = {}
    filtered.forEach(v => { if (v.dia) (byDay[v.dia] = byDay[v.dia] || []).push(v) })

    const fdow = firstDow(ym.y, ym.m), dim = daysInMonth(ym.y, ym.m), hoje = hojeBR()
    const cells = []
    for (let i = 0; i < fdow; i++) cells.push('<div class="rc-cell rc-out"></div>')
    for (let d = 1; d <= dim; d++) {
      const dia = `${ym.y}-${pad(ym.m + 1)}-${pad(d)}`
      const list = byDay[dia] || []
      const shown = list.slice(0, 3), extra = list.length - shown.length
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
    grid.querySelectorAll('.rc-chip').forEach(b => b.onclick = () => abrir(b.dataset.rat))
    grid.querySelectorAll('.rc-more').forEach(b => b.onclick = () => abrirModal(b.dataset.dia, byDay[b.dataset.dia] || []))
  }

  function abrir(ratId) {
    const v = rats.map(view).find(x => x.id === ratId); if (!v) return
    if (v.tarefaId) location.href = `tarefa.html?t=${encodeURIComponent(v.tarefaId)}&aba=rats&rat=${encodeURIComponent(v.id)}`
    else location.href = `rat.html?id=${encodeURIComponent(v.id)}`   // RAT sem tarefa: cai no detalhe da RAT
  }

  function abrirModal(dia, list) {
    const [y, m, d] = dia.split('-')
    document.getElementById('rc-modal-t').textContent = `${Number(d)} de ${MONTHS[Number(m) - 1]} · ${list.length} RAT${list.length === 1 ? '' : 's'}`
    const body = document.getElementById('rc-modal-body')
    body.innerHTML = list.map(chipHTML).join('')
    body.querySelectorAll('.rc-chip').forEach(b => b.onclick = () => abrir(b.dataset.rat))
    document.getElementById('rc-mback').classList.add('open')
  }
  function fecharModal() { document.getElementById('rc-mback').classList.remove('open') }

  window.RatCalendarApp = { init }
})()
