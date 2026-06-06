/* ═══════════════════════════════════════════════
   Service Report — jornada.js  (§10.1 dia contínuo · visão do admin)
   Mostra a jornada de um técnico num dia: linha do tempo de segmentos,
   totais por tipo, horas de trabalho por cliente (faturável por hora,
   arredondado p/ cima 30 min) e detecção de buraco entre atividades.
   Exposto como window.JornadaApp.
═══════════════════════════════════════════════ */
const JornadaApp = (() => {
  const sb = () => getSupabase()
  let cliNomes = {}

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
      sb().from('usuarios').select('id,nome').eq('role', 'tecnico_campo').eq('ativo', true).order('nome'),
      sb().from('clientes').select('id,nome'),
    ])
    document.getElementById('j-tec').innerHTML = (tec.data || []).map(t => `<option value="${esc(t.id)}">${esc(t.nome || '(sem nome)')}</option>`).join('')
    ;(cli.data || []).forEach(c => { cliNomes[c.id] = c.nome })
    document.getElementById('j-data').value = hoje()
    document.getElementById('j-tec').onchange = carregar
    document.getElementById('j-data').onchange = carregar
    if ((tec.data || []).length) carregar()
    else document.getElementById('j-timeline').innerHTML = '<div class="j-empty">Nenhum técnico ativo.</div>'
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
      <div class="j-kpi"><div class="k">Jornada</div><div class="v">${fmtMin(jornadaMin)}</div></div>
      <div class="j-kpi"><div class="k">Trabalho</div><div class="v">${fmtMin(porTipo.trabalho)}</div></div>
      <div class="j-kpi"><div class="k">Pausa</div><div class="v">${fmtMin(porTipo.pausa)}</div></div>
      <div class="j-kpi"><div class="k">Almoço</div><div class="v">${fmtMin(porTipo.almoco)}</div></div>
      <div class="j-kpi"><div class="k">Deslocamento</div><div class="v">${fmtMin(porTipo.deslocamento)}</div></div>`

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

  return { init }
})()
