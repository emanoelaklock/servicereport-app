/* ═══════════════════════════════════════════════
   Service Report — deslocamento-calendario.js  (portal admin)
   Calendário MENSAL de viagens (deslocamento) — esqueleto do rat-calendario.
   · Carrega só as viagens do MÊS visível (filtro pela DATA dos trechos); troca de mês refaz.
   · Fuso America/Sao_Paulo (Intl, sem off-by-one).
   · UM chip por TRECHO, no dia do trecho — rota (origem→destino) · técnico · veículo.
     A base (org_config) aparece como "Traders". Cor por estado da VIAGEM: azul (em curso) ·
     verde (finalizada, falta revisar) · cinza (revisado).
   · Clicar num trecho → detalhe da VIAGEM (só leitura) + Editar (deep-link) + Marcar revisado.
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
  function boundsMes(y, m) {
    const ny = m === 11 ? y + 1 : y, nm = m === 11 ? 0 : m + 1
    return { startD: `${y}-${pad(m + 1)}-01`, endD: `${ny}-${pad(nm + 1)}-01` }
  }
  const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, c => c.toUpperCase())
  const fmtLugar = (v) => { const m = String(v || '').match(/^(.+)\/([A-Za-z]{2})$/); return m ? `${tcase(m[1].trim())}/${m[2].toUpperCase()}` : (v || '') }
  const diaTrecho = (t) => { const d = t && t.data; if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10); return diaBR(t && t.saida_em) }

  let ym = null
  let tecNomes = {}, veicLblMap = {}, cliNomes = {}, baseCidade = '', viagens = [], chips = [], clientesMes = []
  const filtros = { busca: '', cliente: '', revisao: '' }
  const COR = { em_curso: '#1E8AE0', falta_revisar: '#179A47', revisado: '#9CA3AF' }
  const veicLbl = (id) => veicLblMap[id] || ''
  // destino "Joinville" (base) = Traders
  const ehBase = (txt) => { const c = baseCidade.trim().toLowerCase(); return !!c && String(txt || '').toLowerCase().includes(c) }
  const origemLbl = (t) => ehBase(t.origem) ? 'Traders' : (fmtLugar(t.origem) || '—')
  function destinoLbl(t) {
    if (ehBase(t.destino)) return 'Traders'
    const cli = t.destino_cliente_id ? (cliNomes[t.destino_cliente_id] || '') : ''
    const txt = fmtLugar(t.destino) || ''
    return cli ? `${cli}${txt ? ' · ' + txt : ''}` : (txt || '—')
  }
  const trechosDe = (d) => (d.deslocamento_trechos || []).filter(t => !t.espelho_legado).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0))

  async function init() {
    const [us, vc, cl, og] = await Promise.all([
      sb().rpc('sr_usuarios'),
      sb().from('veiculos').select('id,modelo,placa'),
      sb().from('clientes').select('id,nome'),
      sb().from('org_config').select('base_cidade').eq('id', 1).maybeSingle(),
    ])
    tecNomes = {}; for (const u of (us.data || [])) tecNomes[u.id] = u.nome
    veicLblMap = {}; for (const v of (vc.data || [])) veicLblMap[v.id] = `${v.modelo || ''} (${v.placa || ''})`
    cliNomes = {}; for (const c of (cl.data || [])) cliNomes[c.id] = c.nome
    baseCidade = (og.data && og.data.base_cidade) || ''
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

  // metadados da VIAGEM (estado, clientes, busca) — compartilhados por todos os trechos dela
  function metaViagem(d) {
    const ts = trechosDe(d)
    const fechada = ts.length && ts.every(t => t.chegada_em)
    const estado = d.revisado ? 'revisado' : (fechada ? 'falta_revisar' : 'em_curso')
    const cliIds = [...new Set([...ts.map(t => t.destino_cliente_id).filter(Boolean), ...(d.cliente_id ? [d.cliente_id] : [])])]
    const clientes = cliIds.map(id => cliNomes[id]).filter(Boolean)
    const tecnicosViagem = [...new Set(ts.flatMap(t => (t.trecho_tecnicos || []).map(x => x.tecnico_id)))].map(id => tecNomes[id]).filter(Boolean)
    const tarefas = (d.deslocamento_tarefas || []).map(x => x.tarefas).filter(Boolean)
    const hay = [clientes.join(' '), tecnicosViagem.join(' '),
      [...new Set(ts.map(t => t.veiculo_id).filter(Boolean))].map(veicLbl).join(' '),
      tarefas.map(t => 'tarefa ' + String(t.numero || '').padStart(5, '0')).join(' ')].join(' ').toLowerCase()
    return { estado, clientes, hay }
  }

  async function carregarMes() {
    const { startD, endD } = boundsMes(ym.y, ym.m)
    document.getElementById('rc-title').textContent = `${MONTHS[ym.m]} de ${ym.y}`
    document.getElementById('rc-grid').innerHTML = '<div class="rc-empty" style="grid-column:1/-1">Carregando…</div>'
    const { data: tr, error: te } = await sb().from('deslocamento_trechos').select('deslocamento_id').gte('data', startD).lt('data', endD)
    if (te) { document.getElementById('rc-grid').innerHTML = `<div class="rc-empty" style="grid-column:1/-1;color:var(--re)">Erro ao carregar: ${esc(te.message)}</div>`; return }
    const ids = [...new Set((tr || []).map(x => x.deslocamento_id).filter(Boolean))]
    if (!ids.length) { viagens = []; chips = []; render(); return }
    const { data, error } = await sb().from('deslocamentos')
      .select('id,cliente_id,revisado,revisado_em,deslocamento_trechos(id,ordem,origem,destino,destino_local_id,destino_cliente_id,tarefa_id,data,saida_em,chegada_em,veiculo_id,nota_transporte,espelho_legado,trecho_tecnicos(tecnico_id)),deslocamento_tarefas(tarefa_id,tarefas(numero))')
      .in('id', ids)
    if (error) { document.getElementById('rc-grid').innerHTML = `<div class="rc-empty" style="grid-column:1/-1;color:var(--re)">Erro ao carregar: ${esc(error.message)}</div>`; return }
    viagens = data || []
    // UM chip por TRECHO, no dia do trecho (dentro do mês)
    chips = []
    for (const d of viagens) {
      const meta = metaViagem(d)
      let lastVeic = ''   // veículo herda do trecho anterior quando o trecho não tem (e sem nota de transporte)
      for (const t of trechosDe(d)) {
        if (t.veiculo_id) lastVeic = veicLbl(t.veiculo_id)
        const dia = diaTrecho(t)
        if (!dia || dia < startD || dia >= endD) continue
        const tecsT = (t.trecho_tecnicos || []).map(x => tecNomes[x.tecnico_id]).filter(Boolean)
        const veicT = t.veiculo_id ? veicLbl(t.veiculo_id) : (t.nota_transporte || lastVeic || '')
        const rota = `${origemLbl(t)} → ${destinoLbl(t)}`
        chips.push({
          viagemId: d.id, dia, rota, tecnico: tecsT.join(', ') || '—',
          veiculo: veicT || '—', estado: meta.estado, revisado: !!d.revisado, clientes: meta.clientes,
          hay: (rota + ' ' + meta.hay).toLowerCase(),
        })
      }
    }
    render()
  }

  function passaFiltro(c) {
    const f = filtros
    if (f.busca && !c.hay.includes(f.busca.toLowerCase())) return false
    if (f.cliente && !c.clientes.some(x => x.toLowerCase().includes(f.cliente.toLowerCase()))) return false
    if (f.revisao === 'revisado' && !c.revisado) return false
    if (f.revisao === 'a_revisar' && c.revisado) return false
    return true
  }

  function chipHTML(c) {
    const cor = COR[c.estado] || '#48506A'
    const titulo = `${c.rota}\n${c.tecnico}${c.veiculo !== '—' ? ' · ' + c.veiculo : ''}`
    // link real p/ o editor: clique normal abre o detalhe (modal); ctrl/⌘/meio/direito abrem o editor em nova aba
    return `<a class="rc-chip" href="deslocamentos.html?editar=${encodeURIComponent(c.viagemId)}" data-id="${esc(c.viagemId)}" title="${esc(titulo)}" style="background:${cor}1A;border-left:3px solid ${cor}">
      <span class="task" style="color:${corTextoLegivel(cor)}">${esc(c.rota)}</span>
      <span class="cli">${esc(c.tecnico)}</span>
      <span class="tec">${esc(c.veiculo)}</span>
    </a>`
  }

  function render() {
    clientesMes = [...new Set(chips.flatMap(c => c.clientes))].filter(Boolean).sort((a, b) => a.localeCompare(b))
    const filtered = chips.filter(passaFiltro)
    const viagensFiltradas = new Set(filtered.map(c => c.viagemId))
    const aRevisar = new Set(filtered.filter(c => c.estado === 'falta_revisar').map(c => c.viagemId)).size
    const nv = viagensFiltradas.size
    document.getElementById('rc-count').textContent = `${nv} viagem${nv === 1 ? '' : 's'} em ${MONTHS[ym.m]}${aRevisar ? ` · ${aRevisar} a revisar` : ''}`
    const byDay = {}
    filtered.forEach(c => { if (c.dia) (byDay[c.dia] = byDay[c.dia] || []).push(c) })
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
    grid.querySelectorAll('.rc-chip').forEach(b => b.onclick = (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); abrirDet(b.dataset.id) })
    grid.querySelectorAll('.rc-more').forEach(b => b.onclick = () => abrirModalDia(b.dataset.dia, byDay[b.dataset.dia] || []))
  }

  function abrirModalDia(dia, list) {
    const [y, m, d] = dia.split('-')
    document.getElementById('rc-modal-t').textContent = `${Number(d)} de ${MONTHS[Number(m) - 1]} · ${list.length} trecho${list.length === 1 ? '' : 's'}`
    const body = document.getElementById('rc-modal-body')
    body.innerHTML = list.map(chipHTML).join('')
    body.querySelectorAll('.rc-chip').forEach(b => b.onclick = (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); document.getElementById('rc-mback').classList.remove('open'); abrirDet(b.dataset.id) })
    document.getElementById('rc-mback').classList.add('open')
  }

  // ───────── Detalhe da VIAGEM (SÓ LEITURA) ─────────
  function fecharDet() { document.getElementById('det-back').classList.remove('open') }
  const dmy = (iso) => iso ? iso.split('-').reverse().join('/') : '—'
  const inic = (n) => { const p = String(n).trim().split(/\s+/).map(x => x[0]).filter(Boolean); return ((p[0] || '') + (p.length > 1 ? p[p.length - 1] : '')).toUpperCase() }
  function fmtDur(a, b) {
    if (!a || !b) return ''
    const min = Math.round((new Date(b) - new Date(a)) / 60000)
    if (!isFinite(min) || min <= 0) return ''
    const h = Math.floor(min / 60), m = min % 60
    return h ? `${h}h${m ? pad(m) + 'min' : ''}` : `${m}min`
  }
  const DET_ICO = {
    cal: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="M3 17h2m14 0h2M5 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/><path d="M5 17V8a1 1 0 0 1 1-1h8l4 4v6"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
    rota: '<svg viewBox="0 0 24 24"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h7"/></svg>',
  }
  function abrirDet(viagemId) {
    const d = viagens.find(x => x.id === viagemId); if (!d) return
    const ts = trechosDe(d)
    const meta = metaViagem(d)
    // cabeçalho: cliente/obra como título + resumo da viagem como subtítulo + badge de revisão
    const refsN = (d.deslocamento_tarefas || []).map(x => x.tarefas ? String(x.tarefas.numero || '').padStart(5, '0') : null).filter(Boolean)
    document.getElementById('det-title').textContent = meta.clientes.join(' · ') || 'Viagem'
    document.getElementById('det-sub').textContent = ['Viagem', `${ts.length} trecho${ts.length > 1 ? 's' : ''}`, ...refsN.map(n => 'Tarefa ' + n)].join(' · ')
    const pill = document.getElementById('det-rev-pill')
    pill.className = 'rev-pill' + (d.revisado ? ' on' : '')
    pill.innerHTML = `<i></i>${d.revisado ? 'Revisado' : 'A revisar'}`
    // resumo em grid
    const dias = [...new Set(ts.map(diaTrecho).filter(Boolean))].sort()
    const dataV = !dias.length ? '—' : dias.length === 1 ? dmy(dias[0]) : `${dmy(dias[0]).slice(0, 5)} – ${dmy(dias[dias.length - 1])}`
    const veics = [...new Set(ts.map(t => t.veiculo_id).filter(Boolean))].map(veicLbl).filter(Boolean)
    const sumHTML = [
      ['Data', dataV, DET_ICO.cal],
      ['Veículo', veics.join(' · ') || '—', DET_ICO.car],
      ['Ref. tarefa', refsN.length ? refsN.map(n => 'Nº ' + n).join(' · ') : '—', DET_ICO.doc],
      ['Trechos', String(ts.length), DET_ICO.rota],
    ].map(([k, v, ico]) => `<div class="det-sum-i">${ico}<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div></div>`).join('')
    // técnicos a bordo (viagem) em chips
    const tecnicos = [...new Set(ts.flatMap(t => (t.trecho_tecnicos || []).map(x => x.tecnico_id)))].map(id => tecNomes[id]).filter(Boolean)
    const tecKey = tecnicos.slice().sort().join('|')
    const tecsHTML = tecnicos.length
      ? tecnicos.map(n => `<span class="det-tec"><i>${esc(inic(n))}</i>${esc(n)}</span>`).join('')
      : '<span class="det-tec">—</span>'
    // trechos como linha do tempo
    const multiDia = dias.length > 1
    let lastV = ''   // veículo herda do trecho anterior quando o trecho não tem (e sem nota)
    const legsHTML = ts.map((t, i) => {
      if (t.veiculo_id) lastV = veicLbl(t.veiculo_id)
      const volta = ehBase(t.destino)
      const destino = volta ? 'Traders' : ((t.destino_cliente_id && cliNomes[t.destino_cliente_id]) || fmtLugar(t.destino) || '—')
      const cid = volta ? '' : fmtLugar(t.destino)
      const dur = fmtDur(t.saida_em, t.chegada_em)
      // veículo do trecho só quando difere do resumo (ou sem veículo / herdado)
      let veicT = ''
      if (!t.veiculo_id && t.nota_transporte) veicT = `sem veículo (${esc(t.nota_transporte)})`
      else {
        const lbl = t.veiculo_id ? veicLbl(t.veiculo_id) : lastV
        if (lbl && (veics.length !== 1 || lbl !== veics[0])) veicT = esc(lbl) + (t.veiculo_id ? '' : ' <span class="dim">(herdado)</span>')
      }
      const tecsT = (t.trecho_tecnicos || []).map(x => tecNomes[x.tecnico_id]).filter(Boolean)
      const difTec = tecsT.length && tecsT.slice().sort().join('|') !== tecKey
      const metaParts = [
        dur ? `Duração: <b>${esc(dur)}</b>` : '',
        cid ? esc(cid) : '',
        veicT,
        difTec ? `A bordo: ${tecsT.map(esc).join(' · ')}` : '',
      ].filter(Boolean)
      const head = [
        ts.length > 1 ? `<span class="det-leg-n">Trecho ${t.ordem || i + 1}</span>` : '',
        volta ? `<span class="det-leg-tag">Volta</span>` : '',
        multiDia ? `<span class="det-leg-d">${esc(dmy(diaTrecho(t)))}</span>` : '',
      ].filter(Boolean).join('')
      return `<div class="det-leg">
        ${head ? `<div class="det-leg-h">${head}</div>` : ''}
        <div class="det-tl">
          <div class="det-tl-e"><span class="h">${esc(horaBR(t.saida_em))}</span><span class="p">${esc(origemLbl(t))}</span><span class="l">Saída</span></div>
          <div class="det-tl-line"></div>
          <div class="det-tl-e b"><span class="h">${esc(horaBR(t.chegada_em))}</span><span class="p">${esc(destino)}</span><span class="l">Chegada</span></div>
        </div>
        ${metaParts.length ? `<div class="det-leg-meta">${metaParts.join(' · ')}</div>` : ''}</div>`
    }).join('')
    document.getElementById('det-body').innerHTML =
      `<div><div class="det-st">Resumo</div><div class="det-sum">${sumHTML}</div></div>` +
      `<div><div class="det-st">Técnicos a bordo</div><div class="det-tecs">${tecsHTML}</div></div>` +
      `<div><div class="det-st">Trechos</div><div class="det-legs">${legsHTML}</div></div>`
    // rodapé: hierarquia por estado — a revisar: verde primário; revisado: Editar primário
    const bEd = document.getElementById('det-editar')
    bEd.className = d.revisado ? 'btn btn-primary' : 'btn det-btn-blue-o'
    bEd.style.order = d.revisado ? '1' : ''   // revisado: Editar vira a ação principal, na ponta direita
    bEd.onclick = () => { location.href = `deslocamentos.html?editar=${encodeURIComponent(viagemId)}` }
    const bRev = document.getElementById('det-revisar')
    bRev.className = d.revisado ? 'btn btn-ghost' : 'btn det-btn-green'
    bRev.textContent = d.revisado ? 'Desfazer revisão' : 'Marcar como revisado'
    bRev.onclick = () => marcarRevisado(viagemId, !d.revisado)
    document.getElementById('det-back').classList.add('open')
  }

  async function marcarRevisado(id, novo) {
    const { data: { user } } = await sb().auth.getUser()
    const patch = novo ? { revisado: true, revisado_em: new Date().toISOString(), revisado_por: (user && user.id) || null } : { revisado: false, revisado_em: null, revisado_por: null }
    const up = await sb().from('deslocamentos').update(patch).eq('id', id)
    if (up.error) { toast('Erro ao salvar revisão: ' + up.error.message, 'err'); return }
    toast(novo ? 'Viagem marcada como revisada.' : 'Revisão desfeita.', 'ok')
    const d = viagens.find(x => x.id === id); if (d) d.revisado = novo
    fecharDet()
    carregarMes()
  }

  window.DeslocCalApp = { init }
})()
