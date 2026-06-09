/* ═══════════════════════════════════════════════
   Service Report — jornada.js  (§10.1 dia contínuo · visão do admin)
   Mostra a jornada de um técnico num dia: linha do tempo de segmentos,
   totais por tipo, horas de trabalho por cliente (faturável por hora,
   arredondado p/ cima 30 min) e detecção de buraco entre atividades.
   Exposto como window.JornadaApp.
═══════════════════════════════════════════════ */
const JornadaApp = (() => {
  const sb = () => getSupabase()
  let cliNomes = {}, tecNomes = {}

  const SEG_META = {
    trabalho: { ic: '🔧', lb: 'Trabalho' }, pausa: { ic: '⏸️', lb: 'Pausa' },
    almoco: { ic: '🍽️', lb: 'Almoço' }, deslocamento: { ic: '🚗', lb: 'Deslocamento' },
  }
  const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const hhmm = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const minBetween = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000))
  const fmtMin = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}min`
  const ceil30 = (m) => Math.ceil(m / 30) * 30

  async function init() {
    const [tec, cli] = await Promise.all([
      sb().rpc('sr_usuarios'),   // usuários do SR (papel vindo do Portal); filtra técnicos abaixo
      sb().from('clientes').select('id,nome'),
    ])
    if (tec.data) tec.data = tec.data.filter(u => u.role === 'tecnico_campo' && u.ativo)
    document.getElementById('j-tec').innerHTML = (tec.data || []).map(t => `<option value="${esc(t.id)}">${esc(t.nome || '(sem nome)')}</option>`).join('')
    ;(cli.data || []).forEach(c => { cliNomes[c.id] = c.nome })
    ;(tec.data || []).forEach(t => { tecNomes[t.id] = t.nome })
    document.getElementById('j-data').value = hoje()
    document.getElementById('j-tec').onchange = carregar
    document.getElementById('j-data').onchange = carregar
    // Pernoites: select de técnico (com "todos") + período = mês corrente
    document.getElementById('p-tec').innerHTML = '<option value="">Todos os técnicos</option>' +
      (tec.data || []).map(t => `<option value="${esc(t.id)}">${esc(t.nome || '(sem nome)')}</option>`).join('')
    const d = new Date(), p = n => String(n).padStart(2, '0')
    document.getElementById('p-de').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`
    document.getElementById('p-ate').value = hoje()
    document.getElementById('p-gerar').onclick = carregarPernoites
    if ((tec.data || []).length) { carregar(); carregarPernoites() }
    else document.getElementById('j-timeline').innerHTML = '<div class="j-empty">Nenhum técnico ativo.</div>'
  }

  // ───────────────────── Pernoites (período) ─────────────────────
  const diaLocal = (iso) => { const x = new Date(iso); return new Date(x.getFullYear(), x.getMonth(), x.getDate()) }
  const calNoites = (aIso, bIso) => Math.max(0, Math.round((diaLocal(bIso) - diaLocal(aIso)) / 86400000))
  const dDMA = (iso) => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'

  async function carregarPernoites() {
    const de = document.getElementById('p-de').value, ate = document.getElementById('p-ate').value
    const tecFiltro = document.getElementById('p-tec').value
    if (!de || !ate) return toast('Informe o período.', 'err')
    // pega trajetos cuja saída cai no período (inclui o dia "até" inteiro)
    let q = sb().from('deslocamentos')
      .select('id,sentido,saida_em,chegada_em,origem_cidade,origem_uf,destino_cidade,destino_uf,origem,destino,deslocamento_tecnicos(tecnico_id)')
      .gte('saida_em', de + 'T00:00:00').lte('saida_em', ate + 'T23:59:59')
      .order('saida_em', { ascending: true })
    const { data, error } = await q
    if (error) { toast('Erro: ' + error.message, 'err'); return }
    // agrupa por técnico a bordo
    const porTec = {}
    for (const d of (data || [])) {
      for (const x of (d.deslocamento_tecnicos || [])) {
        if (tecFiltro && x.tecnico_id !== tecFiltro) continue
        ;(porTec[x.tecnico_id] = porTec[x.tecnico_id] || []).push(d)
      }
    }
    // monta viagens: começa ao sair, fecha numa "volta" (precisa ter retorno)
    const linhas = []
    for (const [tid, trajs] of Object.entries(porTec)) {
      trajs.sort((a, b) => (a.saida_em || '').localeCompare(b.saida_em || ''))
      const viagens = []; let inicio = null
      for (const t of trajs) {
        if (!inicio) inicio = t.saida_em
        if (t.sentido === 'volta') {
          const fim = t.chegada_em || t.saida_em
          viagens.push({ inicio, fim, noites: calNoites(inicio, fim), aberta: false })
          inicio = null
        }
      }
      if (inicio) viagens.push({ inicio, fim: null, noites: 0, aberta: true })   // saiu e não voltou ainda
      const fechadas = viagens.filter(v => !v.aberta)
      const noites = fechadas.reduce((s, v) => s + v.noites, 0)
      linhas.push({ tid, viagens, fechadas: fechadas.length, abertas: viagens.length - fechadas.length, noites })
    }
    linhas.sort((a, b) => b.noites - a.noites || (tecNomes[a.tid] || '').localeCompare(tecNomes[b.tid] || ''))
    renderPernoites(linhas)
  }

  function renderPernoites(linhas) {
    const tb = document.getElementById('p-tbody')
    const totN = linhas.reduce((s, l) => s + l.noites, 0)
    const totV = linhas.reduce((s, l) => s + l.fechadas, 0)
    document.getElementById('p-resumo').textContent = linhas.length ? `${totN} pernoite(s) · ${totV} viagem(ns) com retorno` : ''
    if (!linhas.length) { tb.innerHTML = '<tr><td colspan="4" class="j-empty">Nenhum deslocamento no período.</td></tr>'; return }
    tb.innerHTML = linhas.map(l => {
      const det = l.viagens.map(v => v.aberta
        ? `<div class="p-trip p-open">⚠ Em aberto — saiu ${dDMA(v.inicio)} (sem retorno, não contado)</div>`
        : `<div class="p-trip">${dDMA(v.inicio)} → ${dDMA(v.fim)} · ${v.noites} noite${v.noites === 1 ? '' : 's'}</div>`).join('')
      return `<tr>
        <td>${esc(tecNomes[l.tid] || '—')}</td>
        <td>${l.fechadas}${l.abertas ? ` <span class="p-open">(+${l.abertas} em aberto)</span>` : ''}</td>
        <td class="p-noites">${l.noites}</td>
        <td>${det || '—'}</td>
      </tr>`
    }).join('') + `<tr class="tot"><td>Total</td><td>${totV}</td><td class="p-noites">${totN}</td><td></td></tr>`
  }

  async function carregar() {
    const tid = document.getElementById('j-tec').value
    const data = document.getElementById('j-data').value
    if (!tid || !data) return
    const { data: segs, error } = await sb().from('jornada_segmentos')
      .select('id,tipo,titulo,cliente_id,inicio,fim').eq('tecnico_id', tid).eq('data', data).order('inicio')
    if (error) { toast('Erro: ' + error.message, 'err'); return }
    render(segs || [])
  }

  function render(segs) {
    const fechados = segs.filter(s => s.fim)
    // totais por tipo
    const porTipo = { trabalho: 0, pausa: 0, almoco: 0, deslocamento: 0 }
    for (const s of segs) porTipo[s.tipo] = (porTipo[s.tipo] || 0) + minBetween(s.inicio, s.fim || new Date().toISOString())
    const entrada = segs.length ? segs[0].inicio : null
    const saidaSeg = segs.length ? segs[segs.length - 1] : null
    const saida = saidaSeg ? (saidaSeg.fim || null) : null
    const jornadaMin = entrada ? minBetween(entrada, saida || new Date().toISOString()) : 0

    document.getElementById('j-resumo').textContent = segs.length
      ? `${segs.length} atividade(s) · ${hhmm(entrada)} → ${saida ? hhmm(saida) : 'em aberto'}`
      : ''

    document.getElementById('j-kpis').innerHTML = `
      <div class="j-kpi jk-blue"><div class="k">Jornada</div><div class="v">${fmtMin(jornadaMin)}</div></div>
      <div class="j-kpi jk-green"><div class="k">Trabalho</div><div class="v">${fmtMin(porTipo.trabalho)}</div></div>
      <div class="j-kpi jk-amber"><div class="k">Pausa</div><div class="v">${fmtMin(porTipo.pausa)}</div></div>
      <div class="j-kpi jk-purple"><div class="k">Almoço</div><div class="v">${fmtMin(porTipo.almoco)}</div></div>
      <div class="j-kpi jk-orange"><div class="k">Deslocamento</div><div class="v">${fmtMin(porTipo.deslocamento)}</div></div>`

    // horas de trabalho por cliente (faturável por hora)
    const porCli = {}
    for (const s of segs) {
      if (s.tipo !== 'trabalho') continue
      const k = s.cliente_id || '—'
      porCli[k] = (porCli[k] || 0) + minBetween(s.inicio, s.fim || new Date().toISOString())
    }
    const clis = Object.entries(porCli)
    document.getElementById('j-clientes').innerHTML = clis.length
      ? clis.map(([id, m]) => `<div class="j-cli"><span>${esc(cliNomes[id] || (id === '—' ? 'Sem cliente' : '—'))}</span><span class="h">${fmtMin(ceil30(m))}<span class="raw">real ${fmtMin(m)}</span></span></div>`).join('')
      : '<div class="j-empty" style="padding:14px 0">Sem atividades de trabalho.</div>'

    // linha do tempo + buracos
    const tl = document.getElementById('j-timeline')
    if (!segs.length) { tl.innerHTML = '<div class="j-empty">Nenhuma atividade neste dia.</div>'; return }
    let html = ''
    segs.forEach((s, i) => {
      if (i > 0) {
        const prev = segs[i - 1]
        if (prev.fim) { const g = minBetween(prev.fim, s.inicio); if (g >= 1) html += `<div class="j-gap">⚠ Buraco de ${fmtMin(g)} entre ${hhmm(prev.fim)} e ${hhmm(s.inicio)} — classificar antes de faturar.</div>` }
      }
      const m = SEG_META[s.tipo] || {}
      const tt = s.tipo === 'trabalho' ? (s.titulo || 'Trabalho') : (m.lb || s.tipo)
      const sub = s.tipo === 'trabalho' ? (cliNomes[s.cliente_id] || '') : ''
      html += `<div class="j-seg"><span class="s-ic">${m.ic || ''}</span>
        <div class="s-main"><div class="s-tt">${esc(tt)}</div><div class="s-sub">${hhmm(s.inicio)}–${s.fim ? hhmm(s.fim) : 'em aberto'}${sub ? ` · ${esc(sub)}` : ''}</div></div>
        <div class="s-dur">${fmtMin(minBetween(s.inicio, s.fim || new Date().toISOString()))}</div></div>`
    })
    tl.innerHTML = html
  }

  return { init, carregarPernoites }
})()
