/* ═══════════════════════════════════════════════
   Service Report — deslocamento-calendario.js  (portal admin)
   Calendário MENSAL de viagens (deslocamento) — MESMO esqueleto do rat-calendario.
   · Carrega só as viagens do MÊS visível (filtro pela DATA dos trechos); troca de mês refaz.
   · Agrupa por dia em America/Sao_Paulo (Intl, sem off-by-one). 1 chip por viagem, no dia de INÍCIO.
   · Cor por estado: azul (em curso) · verde (finalizada, falta revisar) · cinza (revisado).
   · Clique → detalhe (só leitura) + Editar (deep-link p/ o editor da lista) + Marcar revisado.
   Exposto como window.DeslocCalApp.
═══════════════════════════════════════════════ */
(function () {
  const sb = () => getSupabase()
  const TZ = 'America/Sao_Paulo'
  const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
  const pad = (n) => String(n).padStart(2, '0')
  const fmtBR = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  const fmtHoraBR = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
  const diaBR = (iso) => iso ? fmtBR.format(new Date(iso)) : null
  const horaBR = (iso) => iso ? fmtHoraBR.format(new Date(iso)) : '—'
  const hojeBR = () => fmtBR.format(new Date())
  const firstDow = (y, m) => new Date(Date.UTC(y, m, 1)).getUTCDay()
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  // limites do mês como datas YYYY-MM-DD (filtro pela coluna `data` do trecho)
  function boundsMes(y, m) {
    const ny = m === 11 ? y + 1 : y, nm = m === 11 ? 0 : m + 1
    return { startD: `${y}-${pad(m + 1)}-01`, endD: `${ny}-${pad(nm + 1)}-01` }
  }
  const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, c => c.toUpperCase())
  const fmtLugar = (v) => { const m = String(v || '').match(/^(.+)\/([A-Za-z]{2})$/); return m ? `${tcase(m[1].trim())}/${m[2].toUpperCase()}` : (v || '') }
  const diaTrecho = (t) => { const d = t && t.data; if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10); return diaBR(t && t.saida_em) }

  let ym = null
  let tecNomes = {}, veicLblMap = {}, cliNomes = {}, viagens = [], vistas = [], clientesMes = []
  const filtros = { busca: '', cliente: '', revisao: '' }
  const COR = { em_curso: '#1E8AE0', falta_revisar: '#179A47', revisado: '#9CA3AF' }
  const veicLbl = (id) => veicLblMap[id] || ''

  // destino "humano" do trecho: cliente · local/cidade · texto
  function destinoLbl(t) {
    const cli = t.destino_cliente_id ? (cliNomes[t.destino_cliente_id] || '') : ''
    const txt = fmtLugar(t.destino) || ''
    if (cli) return `${cli}${txt ? ' · ' + txt : ''}`
    return txt || '—'
  }
  const trechosDe = (d) => (d.deslocamento_trechos || []).filter(t => !t.espelho_legado).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0))

  async function init() {
    const [us, vc, cl] = await Promise.all([
      sb().rpc('sr_usuarios'),
      sb().from('veiculos').select('id,modelo,placa'),
      sb().from('clientes').select('id,nome'),
    ])
    tecNomes = {}; for (const u of (us.data || [])) tecNomes[u.id] = u.nome
    veicLblMap = {}; for (const v of (vc.data || [])) veicLblMap[v.id] = `${v.modelo || ''} (${v.placa || ''})`
    cliNomes = {}; for (const c of (cl.data || [])) cliNomes[c.id] = c.nome
    const y = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()))
    const m = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' }).format(new Date())) - 1
    ym = { y, m }
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
    const CAMPOS = { 'dcf-busca': 'busca', 'dcf-cliente': 'cliente', 'dcf-revisao': 'revisao' }
    const aplicar = () => { for (const [id, k] of Object.entries(CAMPOS)) { const el = document.getElementById(id); if (el) filtros[k] = el.value.trim() } render() }
    document.getElementById('dcf-buscar').onclick = aplicar
    document.getElementById('dcf-revisao').onchange = aplicar
    document.querySelectorAll('#dcf-busca, #dcf-cliente').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aplicar() } }))
    document.getElementById('dcf-limpar').onclick = () => {
      for (const id of Object.keys(CAMPOS)) { const el = document.getElementById(id); if (el) el.value = '' }
      Object.keys(filtros).forEach(k => filtros[k] = '')
      render()
    }
    document.getElementById('rc-mback').onclick = (e) => { if (e.target.id === 'rc-mback' || e.target.id === 'rc-modal-x') document.getElementById('rc-mback').classList.remove('open') }
    document.getElementById('det-x').onclick = fecharDet
    document.getElementById('det-fechar').onclick = fecharDet
    // combobox de Cliente
    const cin = document.getElementById('dcf-cliente'), clist = document.getElementById('dcf-cliente-list')
    const abrirCombo = () => {
      const termo = cin.value.trim().toLowerCase()
      const opts = clientesMes.filter(c => !termo || c.toLowerCase().includes(termo)).slice(0, 60)
      clist.innerHTML = opts.length ? opts.map(c => `<div class="rc-combo-opt" data-c="${esc(c)}">${esc(c)}</div>`).join('') : '<div class="rc-combo-empty">Nenhum cliente neste mês</div>'
      clist.hidden = false
    }
    cin.addEventListener('focus', abrirCombo)
    cin.addEventListener('input', abrirCombo)
    clist.addEventListener('mousedown', (e) => { const o = e.target.closest('.rc-combo-opt'); if (!o) return; e.preventDefault(); cin.value = o.dataset.c; clist.hidden = true })
    cin.addEventListener('blur', () => setTimeout(() => { clist.hidden = true }, 130))
    cin.addEventListener('keydown', (e) => { if (e.key === 'Escape') clist.hidden = true })
  }

  async function carregarMes() {
    const { startD, endD } = boundsMes(ym.y, ym.m)
    document.getElementById('rc-title').textContent = `${MONTHS[ym.m]} de ${ym.y}`
    document.getElementById('rc-grid').innerHTML = '<div class="rc-empty" style="grid-column:1/-1">Carregando…</div>'
    // ids das viagens com algum trecho no mês
    const { data: tr, error: te } = await sb().from('deslocamento_trechos').select('deslocamento_id').gte('data', startD).lt('data', endD)
    if (te) { document.getElementById('rc-grid').innerHTML = `<div class="rc-empty" style="grid-column:1/-1;color:var(--re)">Erro ao carregar: ${esc(te.message)}</div>`; return }
    const ids = [...new Set((tr || []).map(x => x.deslocamento_id).filter(Boolean))]
    if (!ids.length) { viagens = []; vistas = []; render(); return }
    const { data, error } = await sb().from('deslocamentos')
      .select('id,cliente_id,revisado,revisado_em,deslocamento_trechos(id,ordem,origem,destino,destino_local_id,destino_cliente_id,tarefa_id,data,saida_em,chegada_em,veiculo_id,nota_transporte,espelho_legado,trecho_tecnicos(tecnico_id)),deslocamento_tarefas(tarefa_id,tarefas(numero))')
      .in('id', ids)
    if (error) { document.getElementById('rc-grid').innerHTML = `<div class="rc-empty" style="grid-column:1/-1;color:var(--re)">Erro ao carregar: ${esc(error.message)}</div>`; return }
    viagens = data || []
    vistas = viagens.map(view).filter(v => v.dia && v.dia >= startD && v.dia < endD)   // 1 chip no dia de INÍCIO, só se cair no mês
    render()
  }

  function view(d) {
    const ts = trechosDe(d)
    const prim = ts[0] || {}, ult = ts[ts.length - 1] || {}
    const dia = ts.map(diaTrecho).filter(Boolean).sort()[0] || null   // dia de início
    const tecIds = [...new Set(ts.flatMap(t => (t.trecho_tecnicos || []).map(x => x.tecnico_id)))]
    const tecnicos = tecIds.map(id => tecNomes[id]).filter(Boolean)
    const veics = [...new Set(ts.map(t => t.veiculo_id).filter(Boolean))].map(veicLbl).filter(Boolean)
    const rota = `${fmtLugar(prim.origem) || '—'} → ${destinoLbl(ult)}`
    const emViagem = ts.some(t => t.saida_em) && !ts.every(t => t.chegada_em)
    const fechada = ts.length && ts.every(t => t.chegada_em)
    const estado = d.revisado ? 'revisado' : (fechada ? 'falta_revisar' : 'em_curso')
    const cliIds = [...new Set([...ts.map(t => t.destino_cliente_id).filter(Boolean), ...(d.cliente_id ? [d.cliente_id] : [])])]
    const clientes = cliIds.map(id => cliNomes[id]).filter(Boolean)
    const tarefas = (d.deslocamento_tarefas || []).map(x => x.tarefas).filter(Boolean)
    const hay = [rota, tecnicos.join(' '), veics.join(' '), clientes.join(' '),
      tarefas.map(t => 'tarefa ' + String(t.numero || '').padStart(5, '0')).join(' ')].join(' ').toLowerCase()
    return { id: d.id, dia, rota, tecnico: tecnicos.join(', ') || '—', veiculo: veics.join(', ') || '—',
      estado, revisado: !!d.revisado, cliente: clientes.join(' · ') || '—', clientes, tarefas, ts, hay }
  }

  function passaFiltro(v) {
    const f = filtros
    if (f.busca && !v.hay.includes(f.busca.toLowerCase())) return false
    if (f.cliente && !v.clientes.some(c => c.toLowerCase().includes(f.cliente.toLowerCase()))) return false
    if (f.revisao === 'revisado' && !v.revisado) return false
    if (f.revisao === 'a_revisar' && v.revisado) return false
    return true
  }

  function popularClientes(views) { clientesMes = [...new Set(views.flatMap(v => v.clientes))].filter(Boolean).sort((a, b) => a.localeCompare(b)) }

  function chipHTML(v) {
    const cor = COR[v.estado] || '#48506A'
    const titulo = `${v.rota}\n${v.tecnico}${v.veiculo !== '—' ? ' · ' + v.veiculo : ''}`
    return `<button class="rc-chip" data-id="${esc(v.id)}" title="${esc(titulo)}" style="background:${cor}1A;border-left:3px solid ${cor}">
      <span class="task" style="color:${corTextoLegivel(cor)}">${esc(v.rota)}</span>
      <span class="cli">${esc(v.tecnico)}</span>
      <span class="tec">${esc(v.veiculo)}</span>
    </button>`
  }

  function render() {
    popularClientes(vistas)
    const filtered = vistas.filter(passaFiltro)
    const aRevisar = filtered.filter(v => v.estado === 'falta_revisar').length
    document.getElementById('rc-count').textContent = `${filtered.length} viagem${filtered.length === 1 ? '' : 's'} em ${MONTHS[ym.m]}${aRevisar ? ` · ${aRevisar} a revisar` : ''}`
    const byDay = {}
    filtered.forEach(v => { if (v.dia) (byDay[v.dia] = byDay[v.dia] || []).push(v) })
    const fdow = firstDow(ym.y, ym.m), dim = daysInMonth(ym.y, ym.m), hoje = hojeBR()
    const cells = []
    for (let i = 0; i < fdow; i++) cells.push('<div class="rc-cell rc-out"></div>')
    for (let d = 1; d <= dim; d++) {
      const dia = `${ym.y}-${pad(ym.m + 1)}-${pad(d)}`
      const list = byDay[dia] || []
      const shown = list.slice(0, 4), extra = list.length - shown.length
      cells.push(`<div class="rc-cell">
        <div class="rc-dhead"><span class="rc-dnum${dia === hoje ? ' today' : ''}">${d}</span>${list.length ? `<span class="rc-dcount">${list.length}</span>` : ''}</div>
        ${shown.map(chipHTML).join('')}
        ${extra > 0 ? `<button class="rc-more" data-dia="${dia}">+${extra} mais</button>` : ''}
      </div>`)
    }
    while (cells.length % 7 !== 0) cells.push('<div class="rc-cell rc-out"></div>')
    const grid = document.getElementById('rc-grid')
    grid.innerHTML = cells.join('')
    grid.querySelectorAll('.rc-chip').forEach(b => b.onclick = () => abrirDet(b.dataset.id))
    grid.querySelectorAll('.rc-more').forEach(b => b.onclick = () => abrirModalDia(b.dataset.dia, byDay[b.dataset.dia] || []))
  }

  function abrirModalDia(dia, list) {
    const [y, m, d] = dia.split('-')
    document.getElementById('rc-modal-t').textContent = `${Number(d)} de ${MONTHS[Number(m) - 1]} · ${list.length} viagem${list.length === 1 ? '' : 's'}`
    const body = document.getElementById('rc-modal-body')
    body.innerHTML = list.map(chipHTML).join('')
    body.querySelectorAll('.rc-chip').forEach(b => b.onclick = () => { document.getElementById('rc-mback').classList.remove('open'); abrirDet(b.dataset.id) })
    document.getElementById('rc-mback').classList.add('open')
  }

  // ───────── Detalhe (SÓ LEITURA) ─────────
  let detId = null
  function fecharDet() { document.getElementById('det-back').classList.remove('open'); detId = null }
  function abrirDet(id) {
    const v = vistas.find(x => x.id === id) || viagens.map(view).find(x => x.id === id)
    if (!v) return
    detId = id
    const kv = (k, vv) => `<div class="det-kv"><span class="k">${esc(k)}</span><span class="v">${vv}</span></div>`
    const refs = v.tarefas.map(t => 'Tarefa Nº ' + String(t.numero || '').padStart(5, '0')).join(' · ')
    let sec = `<div class="det-sec"><h4>Viagem · ${v.ts.length} trecho${v.ts.length > 1 ? 's' : ''}</h4>
      ${kv('Revisão', `<span class="rev-pill${v.revisado ? ' on' : ''}">${v.revisado ? '✓ Revisado' : 'A revisar'}</span>`)}
      ${kv('Cliente/obra', esc(v.cliente))}
      ${v.veiculo !== '—' ? kv('Veículo(s)', esc(v.veiculo)) : ''}
      ${refs ? kv('Ref. Tarefa', esc(refs)) : ''}</div>`
    sec += `<div class="det-sec"><h4>Técnicos a bordo</h4><div class="v">${esc(v.tecnico)}</div></div>`
    sec += `<div class="det-sec"><h4>Trechos</h4>` + v.ts.map(t => {
      const tecs = (t.trecho_tecnicos || []).map(x => esc(tecNomes[x.tecnico_id] || '—')).join(' · ')
      const veicT = t.veiculo_id ? esc(veicLbl(t.veiculo_id)) : (t.nota_transporte ? `<span class="dim">sem veículo (${esc(t.nota_transporte)})</span>` : '—')
      return `<div class="det-leg"><div class="lh">${t.ordem}. ${esc(fmtLugar(t.origem) || '—')} → ${esc(destinoLbl(t))}</div>
        ${kv('Data', esc(diaTrecho(t) ? diaTrecho(t).split('-').reverse().join('/') : '—'))}
        ${kv('Saída', esc(horaBR(t.saida_em)))}
        ${kv('Chegada', esc(horaBR(t.chegada_em)))}
        ${kv('Veículo', veicT)}
        ${tecs ? kv('A bordo', tecs) : ''}</div>`
    }).join('') + `</div>`
    document.getElementById('det-body').innerHTML = sec
    document.getElementById('det-editar').onclick = () => { location.href = `deslocamentos.html?editar=${encodeURIComponent(id)}` }
    const bRev = document.getElementById('det-revisar')
    bRev.textContent = v.revisado ? 'Desfazer revisão' : 'Marcar como revisado'
    bRev.onclick = () => marcarRevisado(id, !v.revisado)
    document.getElementById('det-back').classList.add('open')
  }

  async function marcarRevisado(id, novo) {
    const { data: { user } } = await sb().auth.getUser()
    const patch = novo
      ? { revisado: true, revisado_em: new Date().toISOString(), revisado_por: (user && user.id) || null }
      : { revisado: false, revisado_em: null, revisado_por: null }
    const up = await sb().from('deslocamentos').update(patch).eq('id', id)
    if (up.error) { toast('Erro ao salvar revisão: ' + up.error.message, 'err'); return }
    toast(novo ? 'Viagem marcada como revisada.' : 'Revisão desfeita.', 'ok')
    const d = viagens.find(x => x.id === id); if (d) { d.revisado = novo; d.revisado_em = patch.revisado_em }
    vistas = viagens.map(view).filter(v => v.dia)
    fecharDet()
    render()
  }

  window.DeslocCalApp = { init }
})()
