/* ═══════════════════════════════════════════════
   Service Report — desempenho.js (F3)
   Página "Desempenho" do portal (admin/gestor): ranking do Preenchimento
   online + drill-down por técnico com as três lentes de devolução.
   Regras cravadas:
   · Fonte por mês: mês com SNAPSHOT sai congelado (selo com o carimbo);
     sem snapshot, view viva via desempenho_time() com aviso "parcial".
   · KPIs do topo: AGREGADOS APENAS — nomes só no ranking/drill-down,
     onde há contexto e trilha do lado.
   · Janela de instabilidade é anotação, nunca nota; sem exclusão manual.
   · Card do go-live: mostra o desempenho_config e liga a data com
     confirmação dupla (desempenho_definir_inicio, admin-only no servidor).
═══════════════════════════════════════════════ */
const DesempenhoApp = (() => {
  const sb = () => getSupabase()
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
  let mes = mesISO(new Date())
  let usuarios = []          // sr_usuarios (foto/role) — avatar padrão do portal
  let status = null          // { inicio, carencia_ate }
  let linhas = []            // ranking do mês
  let anterior = {}          // tecnico_id -> nota do mês anterior (tendência)
  let fonte = null           // { tipo: 'snapshot'|'parcial', carimbo? }
  let aberto = null          // tecnico_id com drill-down aberto

  const mesNome = (iso) => `${MESES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
  function mesISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
  function somaMes(iso, n) { const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + n, 1); return mesISO(d) }
  const fmtDH = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const fmtD = (iso) => iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}` : '—'
  const av = (u) => { const f = (typeof avatarUrl === 'function') ? avatarUrl(u && u.foto_url) : ''; return f ? `<img src="${esc(f)}" alt="">` : esc(String((u && u.nome) || '—').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase()) }
  const uDe = (id) => usuarios.find(u => u.id === id)

  async function init() {
    try { const { data } = await sb().rpc('sr_usuarios'); usuarios = (data || []).filter(u => u.ativo) } catch (e) { usuarios = [] }
    try { const { data } = await sb().rpc('desempenho_status'); status = (data || [])[0] || null } catch (e) { status = null }
    document.getElementById('dp-prev').onclick = () => { mes = somaMes(mes, -1); carregar() }
    document.getElementById('dp-next').onclick = () => { mes = somaMes(mes, 1); carregar() }
    document.getElementById('dp-golive').onclick = definirGoLive
    await carregar()
  }

  // Fonte do mês: snapshot congelado quando existir; senão a view viva (parcial).
  async function dadosDoMes(m) {
    const snap = await sb().from('desempenho_snapshots').select('dados,nota,gerado_em').eq('mes', m).order('nota', { ascending: false })
    if (!snap.error && snap.data && snap.data.length) {
      return { linhas: snap.data.map(s => Object.assign({}, s.dados, { nota: Number(s.nota) })), fonte: { tipo: 'snapshot', carimbo: snap.data[0].gerado_em } }
    }
    const r = await sb().rpc('desempenho_time', { p_mes: m })
    return { linhas: (r.error ? [] : (r.data || [])), fonte: { tipo: 'parcial' } }
  }

  async function carregar() {
    aberto = null
    document.getElementById('dp-mes').textContent = mesNome(mes)
    const atual = await dadosDoMes(mes)
    linhas = atual.linhas; fonte = atual.fonte
    const ant = await dadosDoMes(somaMes(mes, -1))
    anterior = {}; for (const l of ant.linhas) anterior[l.tecnico_id] = Number(l.nota)
    render()
  }

  function bannerHTML() {
    if (!status || !status.inicio) return `<div class="dp-banner dp-b-off">Painel DESLIGADO — os técnicos ainda não veem o placar. Liga no go-live (card abaixo), após a v575 confirmada na frota.</div>`
    const hoje = new Date().toISOString().slice(0, 10)
    if (status.carencia_ate && hoje <= String(status.carencia_ate)) return `<div class="dp-banner dp-b-car">Painel em carência até ${fmtD(status.carencia_ate)} — placar informativo, não oficial.</div>`
    return ''
  }

  function render() {
    document.getElementById('dp-fonte').innerHTML = fonte.tipo === 'snapshot'
      ? `<span class="dp-cong">congelado em ${esc(fmtDH(fonte.carimbo))}</span>`
      : `<span class="dp-parcial">parcial — muda até o fechamento</span>`
    document.getElementById('dp-banner').innerHTML = bannerHTML()

    // KPIs — AGREGADOS APENAS (sem nomes: nome só com contexto, no ranking/drill-down)
    const n = linhas.length
    const kpi = (v, l, s) => `<div class="dp-kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`
    const media = n ? Math.round(linhas.reduce((a, x) => a + Number(x.nota), 0) / n) : '—'
    const ratsReg = linhas.reduce((a, x) => a + Number(x.rats || 0), 0)
    const d0 = linhas.reduce((a, x) => a + Number(x.d0 || 0), 0)
    const fora = linhas.reduce((a, x) => a + Number(x.em_janela_instab || 0), 0)
    const reed = linhas.reduce((a, x) => a + Number(x.reedicoes || 0), 0)
    const dev = linhas.reduce((a, x) => a + Number(x.devolucoes || 0), 0)
    document.getElementById('dp-kpis').innerHTML = n ? [
      kpi(media, 'Nota média do time', `${n} técnicos com RATs no mês`),
      kpi(ratsReg ? Math.round(100 * d0 / ratsReg) + '%' : '—', 'Preenchimento online (D+0)', `${ratsReg} RATs na régua · ${fora} fora (janela/improd.)`),
      kpi(reed, 'Reedições em dia posterior', 'eventos no mês (teto 6/técnico)'),
      kpi(dev, 'Devoluções', 'tarefas devolvidas no mês'),
    ].join('') : ''

    const box = document.getElementById('dp-rk')
    if (!n) { box.innerHTML = `<div class="dp-vazio">${(!status || !status.inicio) && fonte.tipo !== 'snapshot' ? 'Sem dados: painel desligado e nenhum snapshot deste mês.' : 'Nenhum técnico com RATs neste mês.'}</div>`; renderGoLive(); return }
    box.innerHTML = `<table><thead><tr><th>Técnico</th><th>Nota</th><th>Composição 65·15·20</th><th>D+0 · D+1 · atr · aberto</th><th>Fora da régua</th><th>Reed.</th><th>Devol.</th><th>Tend.</th></tr></thead><tbody>` +
      linhas.map(l => {
        const u = uDe(l.tecnico_id)
        const antN = anterior[l.tecnico_id]
        const tend = antN == null ? '<span class="dim">novo</span>'
          : `<span class="dp-tend${Number(l.nota) < antN ? ' dn' : ''}">${Number(l.nota) >= antN ? '▲' : '▼'} ${Number(l.nota) >= antN ? '+' : ''}${Number(l.nota) - antN}</span>`
        const w = (p, comp) => Math.round(p * (Number(comp) || 0) / 100)
        return `<tr class="dp-linha${aberto === l.tecnico_id ? ' on' : ''}" data-tec="${esc(l.tecnico_id)}">
          <td><span class="dp-tec"><span class="dp-av">${av(u || { nome: l.tecnico_nome })}</span>${esc(l.tecnico_nome)}</span></td>
          <td class="dp-nt">${esc(l.nota)}</td>
          <td><span class="dp-comp" title="Encerramento ${esc(l.comp_pontualidade)} · Reedição ${esc(l.comp_reedicao)} · Devolução ${esc(l.comp_devolucao)}"><i style="width:${w(65, l.comp_pontualidade)}%;background:var(--gr)"></i><i style="width:${w(15, l.comp_reedicao)}%;background:var(--am)"></i><i style="width:${w(20, l.comp_devolucao)}%;background:var(--ac)"></i></span></td>
          <td class="num">${esc(l.d0)} · ${esc(l.d1)} · ${esc(l.atrasadas)} · ${esc(l.pendentes)}</td>
          <td>${Number(l.em_janela_instab) ? `<span class="dp-fj">${esc(l.em_janela_instab)} na janela</span>` : '<span class="dim">—</span>'}</td>
          <td class="num">${esc(l.reedicoes)}</td>
          <td class="num">${esc(l.devolucoes)}</td>
          <td>${tend}</td>
        </tr>
        <tr class="dp-dd" data-dd="${esc(l.tecnico_id)}" hidden><td colspan="8"><div class="dp-ddbox">Carregando…</div></td></tr>`
      }).join('') + '</tbody></table>'
    box.querySelectorAll('.dp-linha').forEach(tr => tr.onclick = () => toggleDrill(tr.dataset.tec))
    renderGoLive()
  }

  function renderGoLive() {
    const el = document.getElementById('dp-cfg')
    const btn = document.getElementById('dp-golive')
    if (!status || !status.inicio) {
      el.innerHTML = `<b>Go-live:</b> painel <b>DESLIGADO</b> — pré-requisito: v575 confirmada no Android real da frota.`
      btn.textContent = 'Definir data de go-live…'; btn.style.display = ''
    } else {
      el.innerHTML = `<b>Go-live:</b> painel LIGADO desde <b>${fmtD(status.inicio)}</b> · carência até <b>${fmtD(status.carencia_ate)}</b>.`
      btn.style.display = 'none'   // ligar é decisão única; mudar depois = SQL consciente, não clique
    }
  }

  async function definirGoLive() {
    const v = prompt('Data de go-live do placar (AAAA-MM-DD).\n\nA partir dela: técnicos passam a VER o card; carência de 28 dias; nada anterior entra no placar.\n\nPré-requisito combinado: v575 confirmada no Android real da frota.')
    if (!v) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return toast('Data inválida — use AAAA-MM-DD.', 'err')
    if (!confirm(`Ligar o painel com go-live em ${fmtD(v.trim())}? Os técnicos passam a ver o próprio placar no app.`)) return
    const { error } = await sb().rpc('desempenho_definir_inicio', { p_inicio: v.trim() })
    if (error) return toast('Não foi possível ligar: ' + error.message, 'err')
    toast('Painel ligado. Carência de 28 dias em curso.', 'ok')
    try { const { data } = await sb().rpc('desempenho_status'); status = (data || [])[0] || null } catch (e) {}
    render()
  }

  // ── drill-down: RATs do mês + reedições (trilha) + as três lentes de devolução ──
  async function toggleDrill(tec) {
    const row = document.querySelector(`.dp-dd[data-dd="${CSS.escape(tec)}"]`)
    if (!row) return
    if (aberto === tec) { row.hidden = true; aberto = null; marcaAberta(); return }
    document.querySelectorAll('.dp-dd').forEach(r => { r.hidden = true })
    aberto = tec; row.hidden = false; marcaAberta()
    const boxEl = row.querySelector('.dp-ddbox')
    boxEl.textContent = 'Carregando…'
    const [rats, devs] = await Promise.all([
      sb().rpc('desempenho_rats', { p_mes: mes, p_tecnico: tec }),
      sb().rpc('desempenho_devolucoes', { p_mes: mes, p_tecnico: tec }),
    ])
    const rlist = rats.error ? [] : (rats.data || [])
    // trilha 0095/0098: reedições marcadas nas RATs deste técnico
    let marcas = []
    const ids = rlist.map(r => r.rat_id)
    if (ids.length) {
      const m = await sb().from('rat_edicoes').select('rat_id,campo,valor_antigo,valor_novo,motivo,em').in('rat_id', ids).in('motivo', ['sync_app', 'sync_app_recusado']).order('em', { ascending: false }).limit(20)
      if (!m.error) marcas = m.data || []
    }
    boxEl.innerHTML = drillHTML(rlist, devs.error ? [] : (devs.data || []), marcas)
  }
  function marcaAberta() { document.querySelectorAll('.dp-linha').forEach(tr => tr.classList.toggle('on', tr.dataset.tec === aberto)) }

  const CHIP = { D0: ['dp-c-d0', 'NO DIA'], D1: ['dp-c-d1', 'D+1 · ½ PONTO'], atrasada: ['dp-c-atr', 'ATRASADA'], pendente: ['dp-c-ab', 'EM ABERTO'], fora_janela_bug: ['dp-c-ab', 'NÃO CONTA · JANELA'] }
  function drillHTML(rats, devs, marcas) {
    const numeroDe = {}   // tarefa_id -> numero (pra linkar)
    const ratRows = rats.map(r => {
      const ch = CHIP[r.faixa] || CHIP.pendente
      return `<div class="dp-rrow"><b>${esc(fmtD(r.dia))}</b>
        <a href="tarefa.html?t=${encodeURIComponent(r.tarefa_id)}&aba=rats" target="_blank" rel="noopener">Tarefa ${r.tarefa_numero != null ? esc(String(r.tarefa_numero).padStart(5, '0')) : '—'} · ${esc(r.cliente_nome || '—')}</a>
        <span class="dp-chip ${ch[0]}">${ch[1]}</span></div>`
    }).join('') || '<div class="dim" style="padding:6px 0">Nenhuma RAT no mês.</div>'
    const marcaRows = marcas.length
      ? marcas.map(m => `<div class="dp-mini">${esc(fmtD(m.em))} · <b>${esc(m.campo)}</b> ${esc(String(m.valor_antigo ?? ''))} → ${esc(String(m.valor_novo ?? ''))} <span class="${m.motivo === 'sync_app_recusado' ? 'dp-rec' : 'dp-mut'}">${m.motivo === 'sync_app_recusado' ? 'recusada (campo da gestão)' : 'após ajuste da gestão'}</span></div>`).join('')
      : '<div class="dim" style="padding:4px 0">Sem reedições marcadas na trilha neste mês.</div>'
    // lentes de devolução
    const cats = {}
    for (const d of devs) for (const c of (d.cats || [])) cats[c] = (cats[c] || 0) + 1
    const maxCat = Math.max(1, ...Object.values(cats))
    const catRows = Object.keys(cats).length
      ? Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, qtd]) => `<div class="dp-catrow"><span class="dp-catl">${esc(c)}</span><span class="dp-catbar"><i style="width:${Math.round(100 * qtd / maxCat)}%"></i></span><b>${qtd}</b></div>`).join('')
      : '<div class="dim">Nenhuma devolução no mês.</div>'
    const reinc = devs.filter(d => Number(d.total_na_tarefa) >= 2)
    const abertas = devs.filter(d => !d.resolvida_em && d.origem === 'ao_vivo')
    const tempos = devs.filter(d => d.resolvida_em && d.origem === 'ao_vivo').map(d => (new Date(d.resolvida_em) - new Date(d.devolvida_em)) / 3600000)
    const tempoTxt = [
      tempos.length ? `mediana <b>${Math.round(tempos.sort((a, b) => a - b)[Math.floor(tempos.length / 2)])}h</b> (${tempos.length} corrigida${tempos.length > 1 ? 's' : ''})` : null,
      abertas.length ? `<span class="dp-rec">${abertas.length} aberta${abertas.length > 1 ? 's' : ''}</span> — devolvida parada trava faturamento` : null,
    ].filter(Boolean).join(' · ') || '<span class="dim">sem série ao vivo ainda</span>'
    return `<div class="dp-ddgrid">
      <div class="dp-bloco"><div class="dp-bt">RATs do mês (abre a aba RATs da tarefa)</div>${ratRows}
        <div class="dp-bt" style="margin-top:12px">Reedições na trilha (0095/0098)</div>${marcaRows}</div>
      <div class="dp-bloco dp-b-dev"><div class="dp-bt">Devoluções — as três lentes</div>
        <div class="dp-sub">Por categoria (mês)</div>${catRows}
        <div class="dp-sub">Reincidência</div><div class="dp-mini">${reinc.length ? reinc.map(d => `Tarefa ${esc(String(d.numero).padStart(5, '0'))}: <b>${esc(d.total_na_tarefa)} devoluções</b> no histórico`).join(' · ') : 'Nenhuma tarefa com 2+ devoluções.'}</div>
        <div class="dp-sub">Tempo de correção</div><div class="dp-mini">${tempoTxt}</div>
        <div class="dp-ress">Série de devoluções começa em 14/07 (migração 0099). O anterior é backfill parcial — conta na reincidência como piso e fica FORA da lente de tempo.</div>
      </div></div>`
  }

  return { init }
})()
