/* ═══════════════════════════════════════════════
   Service Report — jornada.js  (§10.1 dia contínuo · visão do admin)
   Mostra a jornada de um técnico num dia: linha do tempo de segmentos,
   totais por tipo, horas de trabalho por cliente (faturável por hora,
   arredondado p/ cima 30 min) e detecção de buraco entre atividades.
   Exposto como window.JornadaApp.
═══════════════════════════════════════════════ */
const JornadaApp = (() => {
  const sb = () => getSupabase()
  let cliNomes = {}, tecNomes = {}, tecFotos = {}
  // Avatar com FOTO do Portal (mesmo componente das RATs/Tarefas/Deslocamentos); iniciais como fallback.
  const avHtml = (tid) => {
    const foto = (typeof avatarUrl === 'function') ? avatarUrl(tecFotos[tid]) : ''
    if (foto) return `<img src="${esc(foto)}" alt="">`
    return esc((tecNomes[tid] || '—').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase())
  }

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
    const todosUsuarios = tec.data || []
    // Nomes: TODOS os usuários do SR — RATs/deslocamentos podem ter participantes que não são
    // "tecnico_campo" no papel do Portal (ex.: um admin que também vai a campo, como o Arian),
    // e o nome deles precisa resolver na tabela do dia (senão aparece "—").
    todosUsuarios.forEach(t => { tecNomes[t.id] = t.nome; tecFotos[t.id] = t.foto_url })
    ;(cli.data || []).forEach(c => { cliNomes[c.id] = c.nome })
    // Dropdown de filtro: técnicos de campo ativos.
    const tecsCampo = todosUsuarios.filter(u => u.role === 'tecnico_campo' && u.ativo)
    document.getElementById('j-tec').innerHTML = tecsCampo.map(t => `<option value="${esc(t.id)}">${esc(t.nome || '(sem nome)')}</option>`).join('')
    document.getElementById('j-data').value = hoje()
    document.getElementById('j-tec').onchange = carregar
    document.getElementById('j-data').onchange = () => { carregar(); carregarHorasDia() }
    carregarHorasDia()
    carregarSemVolta()   // conferência (leitura): dias com deslocamento de ida sem volta registrada
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

  // ───────────────────── Conferência: deslocamento de ida sem volta (leitura) ─────────────────────
  // Lê a vw_alerta_desloc_sem_volta (regra fiscal mora na view; fuso BR lá). Só mostra; não trava.
  const dmyDia = (s) => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—'   // 'YYYY-MM-DD' → DD/MM/YYYY (sem new Date: zero off-by-one)
  async function carregarSemVolta() {
    const box = document.getElementById('sv-box'); if (!box) return
    const { data, error } = await sb().from('vw_alerta_desloc_sem_volta').select('*').order('dia', { ascending: false })
    if (error) { box.innerHTML = '<div class="j-empty">Não foi possível carregar a conferência.</div>'; return }
    const rows = data || []
    if (!rows.length) { box.innerHTML = '<div class="j-empty">Nenhum dia com deslocamento de ida sem volta a verificar.</div>'; return }
    box.innerHTML = rows.map(r => {
      const links = (r.rats || []).map(x => {
        const seq = x.rat_seq != null ? '/' + String(x.rat_seq).padStart(2, '0') : ''
        return `<a href="rat.html?id=${encodeURIComponent(x.rat_id)}" target="_blank" rel="noopener">RAT${seq}${x.cliente ? ' · ' + esc(x.cliente) : ''} ↗</a>`
      }).join(' · ')
      return `<div class="hd-alert"><div>
        <div class="t">${esc(r.tecnico_nome || '—')} · ${dmyDia(r.dia)}</div>
        <div class="d">${esc(r.clientes || '—')} — ida registrada, <b>sem volta</b> no dia (e sem pernoite). Verificar: ${links}</div>
      </div></div>`
    }).join('')
  }

  // ───────────────────── Horas do dia por técnico (§8: tempo é da pessoa) ─────────────────────
  // Σ da UNIÃO dos intervalos de participação (RATs + trechos a bordo) − almoço único da pessoa.
  const tMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0) }
  function uniaoMin(spans) {   // [[ini,fim]] em minutos → união (sobreposição não conta duas vezes)
    const v = spans.filter(s => s[0] != null && s[1] != null && s[1] > s[0]).sort((a, b) => a[0] - b[0])
    const out = []
    for (const s of v) {
      const u = out[out.length - 1]
      if (u && s[0] <= u[1]) u[1] = Math.max(u[1], s[1])
      else out.push([s[0], s[1]])
    }
    return out
  }
  async function carregarHorasDia() {
    const dia = document.getElementById('j-data').value
    if (!dia) return
    const [parts, alms, confs] = await Promise.all([
      sb().from('vw_participacoes_dia').select('*').eq('dia', dia),
      sb().from('almocos').select('tecnico_id,inicio,fim,origem,artefato_tipo').eq('dia', dia),
      sb().from('almoco_conflitos').select('tecnico_id,inicio,fim,artefato_tipo,motivo').eq('dia', dia),
    ])
    renderHorasDia(parts.data || [], alms.data || [], confs.data || [])
  }
  function renderHorasDia(parts, alms, confs) {
    const ab = document.getElementById('hd-alertas')
    ab.innerHTML = confs.length ? `<div class="hd-alert"><div><div class="t">${confs.length} conflito(s) de almoço resolvido(s) automaticamente</div>
      <div class="d">${confs.map(c => `<b>${esc(tecNomes[c.tecnico_id] || '—')}</b>: ${esc(c.motivo || 'almoço duplicado descartado')} — nenhuma ação necessária.`).join('<br>')}</div></div></div>` : ''
    const tb = document.getElementById('hd-tbody')
    const porTec = {}
    for (const p of parts) (porTec[p.tecnico_id] = porTec[p.tecnico_id] || []).push(p)
    const tids = Object.keys(porTec).sort((a, b) => (tecNomes[a] || '').localeCompare(tecNomes[b] || ''))
    if (!tids.length) { tb.innerHTML = '<tr><td colspan="4" class="j-empty">Nenhuma participação neste dia.</td></tr>'; return }
    const corRat = {}; let nc = 0   // uma cor por artefato (RATs ciclam; deslocamento é laranja)
    tb.innerHTML = tids.map(tid => {
      const ps = porTec[tid].slice().sort((a, b) => String(a.inicio || '') < String(b.inicio || '') ? -1 : 1)
      const chips = ps.map(p => {
        const faixa = `${String(p.inicio || '—').slice(0, 5)}–${String(p.fim || '…').slice(0, 5)}`
        if (p.artefato_tipo === 'deslocamento') return `<a href="deslocamentos.html?editar=${encodeURIComponent(p.artefato_id)}" target="_blank" rel="noopener" class="hd-seg hd-desl" title="Abrir deslocamento"><i></i>Deslocamento · ${faixa}</a>`
        if (!(p.artefato_id in corRat)) corRat[p.artefato_id] = 'hd-rat' + (nc++ % 3)
        const ref = p.referencia ? `RAT ${esc(p.referencia)}${p.rat_seq != null ? '/' + String(p.rat_seq).padStart(2, '0') : ''}` : 'RAT'
        return `<a href="rat.html?id=${encodeURIComponent(p.artefato_id)}" target="_blank" rel="noopener" class="hd-seg ${corRat[p.artefato_id]}" title="Abrir RAT"><i></i>${ref} · ${faixa}${p.ajustado ? ' <span class="hd-aj">AJUSTADO</span>' : ''}</a>`
      }).join('')
      const alm = alms.find(a => a.tecnico_id === tid)
      const origemLbl = alm && (alm.origem === 'ponto' ? 'ponto' : (alm.artefato_tipo === 'deslocamento' ? 'Deslocamento' : alm.artefato_tipo === 'rat' ? 'RAT' : 'manual'))
      const lunch = alm
        ? `<span class="hd-lunch${origemLbl === 'manual' ? ' man' : ''}">${String(alm.inicio).slice(0, 5)}–${String(alm.fim).slice(0, 5)} · ${origemLbl}</span>`
        : '<span class="hd-lunch none">sem registro</span>'
      const uni = uniaoMin(ps.map(p => [tMin(p.inicio), tMin(p.fim)]))
      let tot = uni.reduce((s, u) => s + (u[1] - u[0]), 0)
      if (alm) {
        const ai = tMin(alm.inicio), af = tMin(alm.fim)
        for (const u of uni) tot -= Math.max(0, Math.min(u[1], af) - Math.max(u[0], ai))
      }
      return `<tr>
        <td><span class="hd-tec"><span class="av">${avHtml(tid)}</span><span class="nm">${esc(tecNomes[tid] || '—')}</span></span></td>
        <td>${chips}</td>
        <td>${lunch}</td>
        <td style="text-align:right"><span class="hd-hrs">${String(Math.floor(tot / 60)).padStart(2, '0')}h${String(tot % 60).padStart(2, '0')}</span></td>
      </tr>`
    }).join('')
  }

  // ───────────────────── Pernoites (período) ─────────────────────
  const diaLocal = (iso) => { const x = new Date(iso); return new Date(x.getFullYear(), x.getMonth(), x.getDate()) }
  const calNoites = (aIso, bIso) => Math.max(0, Math.round((diaLocal(bIso) - diaLocal(aIso)) / 86400000))
  const dDMA = (iso) => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—'

  async function carregarPernoites() {
    const de = document.getElementById('p-de').value, ate = document.getElementById('p-ate').value
    const tecFiltro = document.getElementById('p-tec').value
    if (!de || !ate) return toast('Informe o período.', 'err')
    // legado (1 registro = 1 perna) + modelo novo (viagem com trechos), no mesmo período
    const [leg, novo] = await Promise.all([
      sb().from('deslocamentos')
        .select('id,sentido,saida_em,chegada_em,deslocamento_tecnicos(tecnico_id)')
        .gte('saida_em', de + 'T00:00:00').lte('saida_em', ate + 'T23:59:59')
        .order('saida_em', { ascending: true }),
      sb().from('deslocamento_trechos')
        .select('deslocamento_id,ordem,data,saida_em,chegada_em,espelho_legado,trecho_tecnicos(tecnico_id)')
        .eq('espelho_legado', false)
        .gte('data', de).lte('data', ate).order('ordem', { ascending: true }),
    ])
    if (leg.error) { toast('Erro: ' + leg.error.message, 'err'); return }
    const porTec = {}   // tid → { viagens: [] }
    const linhaDe = (tid) => (porTec[tid] = porTec[tid] || { viagens: [] })
    // ── legado: começa ao sair, fecha numa "volta" (precisa ter retorno)
    const porTecLeg = {}
    for (const d of (leg.data || [])) {
      for (const x of (d.deslocamento_tecnicos || [])) {
        if (tecFiltro && x.tecnico_id !== tecFiltro) continue
        ;(porTecLeg[x.tecnico_id] = porTecLeg[x.tecnico_id] || []).push(d)
      }
    }
    for (const [tid, trajs] of Object.entries(porTecLeg)) {
      trajs.sort((a, b) => (a.saida_em || '').localeCompare(b.saida_em || ''))
      let inicio = null
      for (const t of trajs) {
        if (!inicio) inicio = t.saida_em
        if (t.sentido === 'volta') {
          const fim = t.chegada_em || t.saida_em
          linhaDe(tid).viagens.push({ inicio, fim, noites: calNoites(inicio, fim), aberta: false })
          inicio = null
        }
      }
      if (inicio) linhaDe(tid).viagens.push({ inicio, fim: null, noites: 0, aberta: true })
    }
    // ── modelo novo: noites POR PESSOA derivadas dos gaps entre trechos de dias diferentes
    //    (está "fora" quem segue a bordo de algum trecho anterior E de algum posterior)
    const porViagem = {}
    for (const t of (novo.data || [])) (porViagem[t.deslocamento_id] = porViagem[t.deslocamento_id] || []).push(t)
    for (const ts of Object.values(porViagem)) {
      ts.sort((a, b) => a.ordem - b.ordem)
      const aberta = !ts.every(t => t.chegada_em)
      const ini = ts[0].saida_em || (ts[0].data ? ts[0].data + 'T12:00:00' : null)
      const fim = aberta ? null : (ts[ts.length - 1].chegada_em || null)
      const noitesTec = {}
      for (let i = 0; i + 1 < ts.length; i++) {
        const a = ts[i], b = ts[i + 1]
        if (!a.data || !b.data || b.data <= a.data) continue
        const n = Math.round((new Date(b.data) - new Date(a.data)) / 86400000)
        const antes = new Set(); ts.slice(0, i + 1).forEach(t => (t.trecho_tecnicos || []).forEach(x => antes.add(x.tecnico_id)))
        const depois = new Set(); ts.slice(i + 1).forEach(t => (t.trecho_tecnicos || []).forEach(x => depois.add(x.tecnico_id)))
        for (const tid of antes) if (depois.has(tid)) noitesTec[tid] = (noitesTec[tid] || 0) + n
      }
      const todos = new Set(); ts.forEach(t => (t.trecho_tecnicos || []).forEach(x => todos.add(x.tecnico_id)))
      for (const tid of todos) {
        if (tecFiltro && tid !== tecFiltro) continue
        linhaDe(tid).viagens.push({ inicio: ini, fim, noites: aberta ? 0 : (noitesTec[tid] || 0), aberta })
      }
    }
    const linhas = Object.entries(porTec).map(([tid, l]) => {
      const fechadas = l.viagens.filter(v => !v.aberta)
      return { tid, viagens: l.viagens, fechadas: fechadas.length, abertas: l.viagens.length - fechadas.length, noites: fechadas.reduce((s, v) => s + v.noites, 0) }
    })
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
