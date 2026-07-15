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
  // "hoje" e horas SEMPRE no calendário/relógio de Brasília (regra da casa — fuso do navegador nunca é fonte)
  const hoje = () => diaSP()
  const hhmm = (iso) => iso ? hhSP(iso) : '—'
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
    const mes01 = hoje().slice(0, 7) + '-01'   // 1º do mês corrente NO CALENDÁRIO DE BRASÍLIA
    document.getElementById('p-de').value = mes01
    document.getElementById('p-ate').value = hoje()
    document.getElementById('p-gerar').onclick = carregarPernoites
    // Deslocamento por técnico (período): mesmo padrão dos pernoites (todos + mês corrente)
    document.getElementById('dt-tec').innerHTML = '<option value="">Todos os técnicos</option>' +
      (tec.data || []).map(t => `<option value="${esc(t.id)}">${esc(t.nome || '(sem nome)')}</option>`).join('')
    document.getElementById('dt-de').value = mes01
    document.getElementById('dt-ate').value = hoje()
    document.getElementById('dt-gerar').onclick = carregarDeslocPeriodo
    document.getElementById('dt-csv').onclick = exportarDeslocCsv
    if ((tec.data || []).length) { carregar(); carregarPernoites(); carregarDeslocPeriodo() }
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
        const num = x.numero != null ? ' ' + x.numero : ''
        const seq = x.rat_seq != null ? '/' + String(x.rat_seq).padStart(2, '0') : ''
        return `<a href="rat.html?id=${encodeURIComponent(x.rat_id)}" target="_blank" rel="noopener">RAT${num}${seq}${x.cliente ? ' · ' + esc(x.cliente) : ''} ↗</a>`
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
    const [parts, alms, confs, preo] = await Promise.all([
      sb().from('vw_participacoes_dia').select('*').eq('dia', dia),
      sb().from('almocos').select('tecnico_id,inicio,fim,origem,artefato_tipo,artefato_id').eq('dia', dia),
      sb().from('almoco_conflitos').select('tecnico_id,inicio,fim,artefato_tipo,motivo').eq('dia', dia),
      // Pré-orçamentos do dia (janela do dia em BR). Entram como participações sintéticas no mesmo
      // motor de união/almoço — o levantamento é tempo de trabalho da pessoa, igual a uma RAT.
      sb().from('pre_orcamentos').select('id,numero,cliente_id,tecnico_id,respostas,tempo_trabalhado,data')
        .gte('data', dia + 'T00:00:00-03:00').lte('data', dia + 'T23:59:59.999-03:00'),
    ])
    // Cada pré-orçamento vira até 2 participações: a VISITA (rosa) e o DESLOCAMENTO ida→retorno
    // (laranja, cor = deslocamento). A união de intervalos deduplica sobreposição no total.
    const preParts = []
    for (const p of (preo.data || [])) {
      const r = p.respostas || {}, ref = p.numero != null ? String(p.numero) : ''
      const base = { tecnico_id: p.tecnico_id, artefato_id: p.id, referencia: ref, cliente_id: p.cliente_id }
      if (r.visita_inicio && r.visita_termino) preParts.push({ ...base, artefato_tipo: 'preorc', inicio: r.visita_inicio, fim: r.visita_termino })
      if (r.ida && r.retorno) preParts.push({ ...base, artefato_tipo: 'preorc_desloc', inicio: r.ida, fim: r.retorno })
    }
    renderHorasDia([...(parts.data || []), ...preParts], alms.data || [], confs.data || [])
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
        if (p.artefato_tipo === 'deslocamento' || p.artefato_tipo === 'desloc_dia') {
          // viagem/pernoite → abre o Deslocamento; deslocamento do dia (ida/retorno da RAT) → abre a RAT.
          const ehDia = p.artefato_tipo === 'desloc_dia'
          const href = ehDia ? `rat.html?id=${encodeURIComponent(p.artefato_id)}` : `deslocamentos.html?editar=${encodeURIComponent(p.artefato_id)}`
          const lbl = ehDia ? `RAT ${esc(p.referencia || '')}${p.rat_seq != null ? '/' + String(p.rat_seq).padStart(2, '0') : ''}` : 'Deslocamento'
          return `<a href="${href}" target="_blank" rel="noopener" class="hd-seg hd-desl" title="Abrir"><i></i>${lbl} · ${faixa}</a>`
        }
        if (p.artefato_tipo === 'preorc_desloc') {
          // Deslocamento do levantamento — laranja (cor = deslocamento), sem link.
          const refP = p.referencia ? `Pré-orç Nº ${esc(p.referencia)}` : 'Pré-orç'
          return `<span class="hd-seg hd-desl" title="Deslocamento do pré-orçamento"><i></i>${refP} · desloc · ${faixa}</span>`
        }
        if (p.artefato_tipo === 'preorc') {
          // Levantamento comercial — chip rosa, sem link (não há visualizador de pré-orçamento no portal).
          const refP = p.referencia ? `Pré-orç Nº ${esc(p.referencia)}` : 'Pré-orç'
          return `<span class="hd-seg hd-preorc" title="Pré-orçamento (levantamento)"><i></i>${refP} · ${faixa}</span>`
        }
        if (!(p.artefato_id in corRat)) corRat[p.artefato_id] = 'hd-rat' + (nc++ % 3)
        const ref = p.referencia ? `RAT ${esc(p.referencia)}${p.rat_seq != null ? '/' + String(p.rat_seq).padStart(2, '0') : ''}` : 'RAT'
        return `<a href="rat.html?id=${encodeURIComponent(p.artefato_id)}" target="_blank" rel="noopener" class="hd-seg ${corRat[p.artefato_id]}" title="Abrir RAT"><i></i>${ref} · ${faixa}${p.ajustado ? ' <span class="hd-aj">AJUSTADO</span>' : ''}</a>`
      }).join('')
      const alm = alms.find(a => a.tecnico_id === tid)
      let lunch
      if (!alm) {
        lunch = '<span class="hd-lunch none">sem registro</span>'
      } else {
        const faixaA = `${String(alm.inicio).slice(0, 5)}–${String(alm.fim).slice(0, 5)}`
        if (alm.artefato_tipo === 'rat' && alm.artefato_id) {
          // Almoço lançado numa RAT → mostra nº e cor da RAT (mesma cor da participação).
          const rp = ps.find(p => p.artefato_id === alm.artefato_id && p.artefato_tipo === 'rat') || ps.find(p => p.artefato_id === alm.artefato_id)
          const cor = corRat[alm.artefato_id] || 'hd-rat0'
          const ref = rp && rp.referencia ? `RAT ${esc(rp.referencia)}${rp.rat_seq != null ? '/' + String(rp.rat_seq).padStart(2, '0') : ''}` : 'RAT'
          lunch = `<a href="rat.html?id=${encodeURIComponent(alm.artefato_id)}" target="_blank" rel="noopener" class="hd-seg ${cor}" title="Almoço lançado nesta RAT"><i></i>${faixaA} · ${ref}</a>`
        } else {
          const origemLbl = alm.origem === 'ponto' ? 'ponto' : (alm.artefato_tipo === 'deslocamento' ? 'Deslocamento' : 'manual')
          lunch = `<span class="hd-lunch${origemLbl === 'manual' ? ' man' : ''}">${faixaA} · ${origemLbl}</span>`
        }
      }
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
  const diaLocal = (iso) => { const [y, m, dd] = diaSP(iso).split('-').map(Number); return new Date(y, m - 1, dd) }   // dia de Brasília
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

  // ───────────────────── Deslocamento por técnico (período) ─────────────────────
  // Mapa aprovado (15/07): fonte A = desloc do dia (RAT, tipo `desloc_dia`) · B = viagem
  // (trechos POR PESSOA, tipo `deslocamento`) · C = pré-orçamento (ida→retorno, fora da view).
  // Total = UNIÃO das fontes − janela de almoço do dia (sobreposição conta uma vez — teto).
  // Sobreposição com RAT vira SINALIZAÇÃO na linha (dado fisicamente inconsistente: expõe,
  // nunca subtrai em silêncio). Madrugada (fim < início na view, que rebaixa pra ::time)
  // divide nos DOIS dias — recorte por período exato. Registro sem duração (trecho aberto,
  // horário incompleto) NÃO conta no total e é declarado na linha e no rodapé.
  let dtLinhas = []   // linhas calculadas (CSV + drill-down)
  const fmtHm2 = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}h${String(Math.round(m % 60)).padStart(2, '0')}`
  const diaMaisN = (dia, n) => { const [y, mo, d] = String(dia).split('-').map(Number); const x = new Date(y, mo - 1, d + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
  // intervalo de um artefato → [{dia, ini, fim}] em minutos; divide a madrugada; null = sem duração
  function dtSpans(dia, iniT, fimT) {
    const i = tMin(iniT), f = tMin(fimT)
    if (i == null || f == null) return null
    if (f >= i) return [{ dia, ini: i, fim: f }]
    return [{ dia, ini: i, fim: 1440 }, { dia: diaMaisN(dia, 1), ini: 0, fim: f }]   // virou a meia-noite
  }
  const dtOverlapMin = (unis, ini, fim) => unis.reduce((s, u) => s + Math.max(0, Math.min(u[1], fim) - Math.max(u[0], ini)), 0)

  async function carregarDeslocPeriodo() {
    const de = document.getElementById('dt-de').value, ate = document.getElementById('dt-ate').value
    const tecFiltro = document.getElementById('dt-tec').value
    if (!de || !ate) return toast('Informe o período.', 'err')
    const deQ = diaMaisN(de, -1)   // véspera: captura a parte pós-meia-noite que cai no 1º dia do período
    const [parts, alms, preo] = await Promise.all([
      sb().from('vw_participacoes_dia').select('*').gte('dia', deQ).lte('dia', ate),
      sb().from('almocos').select('tecnico_id,dia,inicio,fim').gte('dia', de).lte('dia', ate),
      sb().from('pre_orcamentos').select('id,numero,tecnico_id,respostas,data')
        .gte('data', deQ + 'T00:00:00-03:00').lte('data', ate + 'T23:59:59.999-03:00'),
    ])
    if (parts.error) return toast('Erro: ' + parts.error.message, 'err')
    // nº oficial das viagens (V-0003) pro drill-down rastreável
    const viagemIds = [...new Set((parts.data || []).filter(p => p.artefato_tipo === 'deslocamento').map(p => p.artefato_id))]
    let vNum = {}
    if (viagemIds.length) {
      const { data } = await sb().from('deslocamentos').select('id,numero').in('id', viagemIds)
      for (const d of (data || [])) vNum[d.id] = d.numero
    }
    // normaliza tudo em itens {tid, cat, dia, iniT, fimT, ref, href}
    const itens = []
    for (const p of (parts.data || [])) {
      if (tecFiltro && p.tecnico_id !== tecFiltro) continue
      if (p.artefato_tipo === 'rat') { itens.push({ tid: p.tecnico_id, cat: 'rat', dia: p.dia, iniT: p.inicio, fimT: p.fim, ref: `RAT ${p.referencia || ''}${p.rat_seq != null ? '/' + String(p.rat_seq).padStart(2, '0') : ''}` }); continue }
      if (p.artefato_tipo === 'deslocamento') {
        const nv = vNum[p.artefato_id]
        itens.push({ tid: p.tecnico_id, cat: 'viagem', dia: p.dia, iniT: p.inicio, fimT: p.fim, ref: nv ? `V-${String(nv).padStart(4, '0')}` : 'Viagem', href: `deslocamentos.html?editar=${encodeURIComponent(p.artefato_id)}` })
      } else if (p.artefato_tipo === 'desloc_dia') {
        itens.push({ tid: p.tecnico_id, cat: 'dia', dia: p.dia, iniT: p.inicio, fimT: p.fim, ref: `RAT ${p.referencia || ''}${p.rat_seq != null ? '/' + String(p.rat_seq).padStart(2, '0') : ''}`, href: `rat.html?id=${encodeURIComponent(p.artefato_id)}` })
      }
    }
    for (const p of (preo.data || [])) {
      if (tecFiltro && p.tecnico_id !== tecFiltro) continue
      const r = p.respostas || {}
      if (!r.ida && !r.retorno) continue   // pré-orç sem deslocamento não entra no recorte
      const dia = diaSP(p.data)   // bucket do dia no calendário de Brasília
      itens.push({ tid: p.tecnico_id, cat: 'pre', dia, iniT: r.ida || null, fimT: r.retorno || null, ref: p.numero != null ? `Pré-orç Nº ${p.numero}` : 'Pré-orç' })
    }
    // almoço por técnico/dia (janela descontada de tudo que sobrepõe)
    const almDe = {}
    for (const a of (alms.data || [])) almDe[`${a.tecnico_id}|${a.dia}`] = [tMin(a.inicio), tMin(a.fim)]
    // agrupa: tid → dia → {viagem:[], dia:[], pre:[], rat:[]}; conta sem-duração; guarda drill
    const T = {}
    const tDe = (tid) => (T[tid] = T[tid] || { porDia: {}, semDur: 0, drill: {}, sobre: new Set() })
    for (const it of itens) {
      const t = tDe(it.tid)
      const spans = dtSpans(it.dia, it.iniT, it.fimT)
      const dentro = (d) => d >= de && d <= ate
      if (spans === null) {
        if (it.cat !== 'rat' && dentro(it.dia)) {
          t.semDur++
          ;(t.drill[it.dia] = t.drill[it.dia] || []).push({ ...it, semDur: true })
        }
        continue
      }
      const virou = spans.length > 1
      for (const s of spans) {
        if (!dentro(s.dia)) continue
        const d = (t.porDia[s.dia] = t.porDia[s.dia] || { viagem: [], dia: [], pre: [], rat: [] })
        d[it.cat].push([s.ini, s.fim, it.ref])   // ref junto do intervalo (sinal de sobreposição)
        if (it.cat !== 'rat') (t.drill[s.dia] = t.drill[s.dia] || []).push({ ...it, faixa: `${String(it.iniT).slice(0, 5)}–${String(it.fimT).slice(0, 5)}${virou ? ' (vira o dia)' : ''}` })
      }
    }
    // totais por técnico: união por fonte e união geral − almoço; sobreposição com RAT = sinal
    dtLinhas = Object.entries(T).map(([tid, t]) => {
      const tot = { viagem: 0, dia: 0, pre: 0, uniao: 0 }
      const dias = new Set()
      for (const [dia, d] of Object.entries(t.porDia)) {
        const alm = almDe[`${tid}|${dia}`]
        const desconta = (unis) => unis.reduce((s, u) => s + (u[1] - u[0]), 0) - (alm ? dtOverlapMin(unis, alm[0], alm[1]) : 0)
        const uV = uniaoMin(d.viagem), uD = uniaoMin(d.dia), uP = uniaoMin(d.pre)
        const uTodos = uniaoMin([...d.viagem, ...d.dia, ...d.pre])
        if (uTodos.length) dias.add(dia)
        tot.viagem += desconta(uV); tot.dia += desconta(uD); tot.pre += desconta(uP)
        tot.uniao += desconta(uTodos)
        // sobreposição física com RAT: expõe (nunca subtrai em silêncio)
        for (const r of d.rat) for (const u of uTodos) {
          if (Math.min(u[1], r[1]) - Math.max(u[0], r[0]) > 0) { t.sobre.add(r[2] || 'RAT'); break }
        }
      }
      return { tid, nome: tecNomes[tid] || '—', dias: dias.size, ...tot, semDur: t.semDur, sobre: [...t.sobre], drill: t.drill }
    }).filter(l => l.dias || l.semDur)
    dtLinhas.sort((a, b) => b.uniao - a.uniao || a.nome.localeCompare(b.nome))
    renderDeslocPeriodo()
  }

  function renderDeslocPeriodo() {
    const tb = document.getElementById('dt-tbody')
    const totalGeral = dtLinhas.reduce((s, l) => s + l.uniao, 0)
    const semDurGeral = dtLinhas.reduce((s, l) => s + l.semDur, 0)
    document.getElementById('dt-resumo').textContent = dtLinhas.length ? `${dtLinhas.length} técnico(s) · ${fmtHm2(totalGeral)} em trânsito (união)` : ''
    document.getElementById('dt-csv').style.display = dtLinhas.length ? '' : 'none'
    document.getElementById('dt-rodape').textContent = semDurGeral
      ? `⚠ ${semDurGeral} registro(s) sem duração no período (trecho aberto ou horário incompleto) — NÃO contam no total; veja o detalhe de cada técnico.`
      : (dtLinhas.length ? 'Todos os registros do período têm duração — total íntegro.' : '')
    if (!dtLinhas.length) { tb.innerHTML = '<tr><td colspan="8" class="j-empty">Nenhum deslocamento no período.</td></tr>'; return }
    tb.innerHTML = dtLinhas.map((l, i) => {
      const sinais = [
        ...l.sobre.map(r => `<span class="dt-sinal warn">⚠ sobrepõe ${esc(r)}</span>`),
        l.semDur ? `<span class="dt-sinal">⏱ ${l.semDur} sem duração (horas parciais)</span>` : '',
      ].filter(Boolean).join(' ')
      const drill = Object.entries(l.drill).sort(([a], [b]) => a.localeCompare(b)).map(([dia, its]) => {
        const [y, m, d] = dia.split('-')
        const linha = its.map(it => {
          const lbl = `${esc(it.ref)}${it.semDur ? ' · <b>sem duração</b>' : ` · ${esc(it.faixa || '')}`}`
          return it.href ? `<a href="${it.href}" target="_blank" rel="noopener">${lbl}</a>` : lbl
        }).join(' · ')
        return `<div class="p-trip">${d}/${m}: ${linha}</div>`
      }).join('')
      return `<tr>
        <td><span class="hd-tec"><span class="av">${avHtml(l.tid)}</span><span class="nm">${esc(l.nome)}</span></span></td>
        <td>${l.dias}</td>
        <td>${l.viagem ? fmtHm2(l.viagem) : '—'}</td>
        <td>${l.dia ? fmtHm2(l.dia) : '—'}</td>
        <td>${l.pre ? fmtHm2(l.pre) : '—'}</td>
        <td><b>${fmtHm2(l.uniao)}</b></td>
        <td>${sinais || '—'}</td>
        <td><button type="button" class="btn btn-sm" data-dtdet="${i}">Detalhe</button></td>
      </tr>
      <tr class="dt-drill" id="dt-drill-${i}" style="display:none"><td colspan="8">${drill || '—'}</td></tr>`
    }).join('') + `<tr class="tot"><td>Total</td><td></td>
      <td>${fmtHm2(dtLinhas.reduce((s, l) => s + l.viagem, 0))}</td>
      <td>${fmtHm2(dtLinhas.reduce((s, l) => s + l.dia, 0))}</td>
      <td>${fmtHm2(dtLinhas.reduce((s, l) => s + l.pre, 0))}</td>
      <td><b>${fmtHm2(totalGeral)}</b></td><td colspan="2"></td></tr>`
    tb.querySelectorAll('[data-dtdet]').forEach(b => {
      b.onclick = () => { const el = document.getElementById('dt-drill-' + b.dataset.dtdet); el.style.display = el.style.display === 'none' ? '' : 'none' }
    })
  }

  function exportarDeslocCsv() {
    if (!dtLinhas.length) return
    const de = document.getElementById('dt-de').value, ate = document.getElementById('dt-ate').value
    const linhas = [['tecnico', 'dias', 'horas_viagem', 'horas_desloc_dia', 'horas_preorc', 'total_uniao', 'sem_duracao', 'sobrepoe_rat'].join(';')]
    for (const l of dtLinhas) linhas.push([`"${l.nome.replaceAll('"', '""')}"`, l.dias, fmtHm2(l.viagem), fmtHm2(l.dia), fmtHm2(l.pre), fmtHm2(l.uniao), l.semDur, `"${l.sobre.join(' | ')}"`].join(';'))
    const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `deslocamento-por-tecnico_${de}_a_${ate}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
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
