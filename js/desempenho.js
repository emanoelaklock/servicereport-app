/* ═══════════════════════════════════════════════
   Service Report — desempenho.js (F3)
   Página "Desempenho da equipe" (admin/gestor): ranking do Preenchimento
   Online + drill-down por técnico com as três lentes de devolução.
   Regras cravadas (a camada visual muda; NADA aqui altera cálculo):
   · Fonte por mês: mês com SNAPSHOT sai congelado (selo com o carimbo);
     sem snapshot, view viva via desempenho_time() com aviso "parcial".
   · KPIs do topo: AGREGADOS APENAS — nomes só no ranking/drill-down.
   · Janela de instabilidade é anotação ("não avaliada — app instável"),
     nunca nota; sem exclusão manual.
   · Go-live: banner único (família info) quando desligado, com o botão
     "Definir data de go-live" (dupla confirmação, admin-only no servidor).
   · Impactos exibidos no drill-down são DERIVADOS da própria nota
     (65/15/20 e contadores) — exibição, não cálculo novo.
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
  let binario = {}           // tecnico_id -> {elegiveis, sem_problema, com_problema, r_*} (RPC desempenho_binario — vivo)
  let binarioAnt = {}        // mês anterior (tendência: percentual vs percentual)
  let ordem = 'atencao'      // ordenação escolhida no seletor (sem índice invisível)

  const mesNome = (iso) => `${MESES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
  function mesISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
  function somaMes(iso, n) { const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + n, 1); return mesISO(d) }
  const fmtDH = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const fmtD = (iso) => iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}` : '—'
  const pts1 = (v) => (Math.round(v * 10) / 10).toLocaleString('pt-BR')   // pontos com 1 casa
  const av = (u) => { const f = (typeof avatarUrl === 'function') ? avatarUrl(u && u.foto_url) : ''; return f ? `<img src="${esc(f)}" alt="">` : esc(String((u && u.nome) || '—').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase()) }
  const uDe = (id) => usuarios.find(u => u.id === id)
  const IC_CHEV = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>'

  async function init() {
    try { const { data } = await sb().rpc('sr_usuarios'); usuarios = (data || []).filter(u => u.ativo) } catch (e) { usuarios = [] }
    try { const { data } = await sb().rpc('desempenho_status'); status = (data || [])[0] || null } catch (e) { status = null }
    document.getElementById('dp-prev').onclick = () => { mes = somaMes(mes, -1); carregar() }
    document.getElementById('dp-next').onclick = () => { mes = somaMes(mes, 1); carregar() }
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
    // Percentual de RATs sem problema (o indicador principal da página) — vivo, e também
    // do mês anterior (tendência percentual vs. percentual).
    binario = {}; binarioAnt = {}
    try { const b = await sb().rpc('desempenho_binario', { p_mes: mes }); for (const x of (b.data || [])) binario[x.tecnico_id] = x } catch (e) {}
    try { const b = await sb().rpc('desempenho_binario', { p_mes: somaMes(mes, -1) }); for (const x of (b.data || [])) binarioAnt[x.tecnico_id] = x } catch (e) {}
    render()
  }
  // Leitura invertida (decisão 14/07): a página mostra % de RATs COM problema
  const pctDe = (b) => (b && Number(b.elegiveis)) ? Math.round(100 * Number(b.com_problema) / Number(b.elegiveis)) : null

  // Banner único de estado (família info quando desligado; warn na carência).
  function bannerHTML() {
    if (!status || !status.inicio) return `<div class="dp-banner dp-b-info">
      <div class="dp-b-tx"><b>Painel ainda não liberado aos técnicos</b>
      <span>Os técnicos ainda não visualizam o próprio placar. A ativação depende do teste da versão atual do app na frota e da definição da data de go-live.</span></div>
      <button class="btn btn-p" id="dp-golive">Definir data de go-live</button></div>`
    const hoje = new Date().toISOString().slice(0, 10)
    if (status.carencia_ate && hoje <= String(status.carencia_ate)) return `<div class="dp-banner dp-b-car">
      <div class="dp-b-tx"><b>Período de adaptação até ${fmtD(status.carencia_ate)}</b>
      <span>Placar visível aos técnicos, ainda não oficial. Vale desde ${fmtD(status.inicio)}.</span></div></div>`
    return ''
  }

  function headerStatusHTML() {
    if (!status || !status.inicio) return ''
    return `<span class="dp-ligado">Ligado desde ${fmtD(status.inicio)}</span>`
  }

  function render() {
    document.getElementById('dp-fonte').innerHTML = (fonte.tipo === 'snapshot'
      ? `<span class="dp-cong">dados congelados em ${esc(fmtDH(fonte.carimbo))}</span>`
      : `<span class="dp-parcial">parcial — muda até o fechamento</span>`) + headerStatusHTML()
    document.getElementById('dp-banner').innerHTML = bannerHTML()
    const bGo = document.getElementById('dp-golive'); if (bGo) bGo.onclick = definirGoLive

    // KPIs — AGREGADOS APENAS (sem nomes; o índice composto NÃO aparece nesta página)
    const n = linhas.length
    const elegT = Object.values(binario).reduce((a, b) => a + Number(b.elegiveis || 0), 0)
    const probT = Object.values(binario).reduce((a, b) => a + Number(b.com_problema || 0), 0)
    const ratsReg = linhas.reduce((a, x) => a + Number(x.rats || 0), 0)
    const d0 = linhas.reduce((a, x) => a + Number(x.d0 || 0), 0)
    const fora = linhas.reduce((a, x) => a + Number(x.em_janela_instab || 0), 0)
    const reed = linhas.reduce((a, x) => a + Number(x.reedicoes || 0), 0)
    const dev = linhas.reduce((a, x) => a + Number(x.devolucoes || 0), 0)
    const kpi = (fam, ic, titulo, sub, valor, det) => `<div class="dp-kpi dp-k-${fam}">
      <div class="dp-k-h"><span class="dp-k-ic">${ic}</span><div><div class="dp-k-t">${titulo}</div><div class="dp-k-s">${sub}</div></div></div>
      <div class="dp-k-v">${valor}</div><div class="dp-k-d">${det}</div></div>`
    document.getElementById('dp-kpis').innerHTML = n ? [
      kpi('title', '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/></svg>',
        'Resultado da equipe', 'RATs com problema no mês', elegT ? Math.round(100 * probT / elegT) + '%' : '—',
        `${probT} de ${elegT} RATs · ${n} técnico${n > 1 ? 's' : ''} avaliado${n > 1 ? 's' : ''}`),
      kpi('info', '<svg viewBox="0 0 24 24"><path d="M21 11.5a9 9 0 1 1-5.3-8.2"/><path d="m9 11 3 3L22 4"/></svg>',
        'Preenchimento Online', 'RATs encerradas no dia do trabalho', ratsReg ? Math.round(100 * d0 / ratsReg) + '%' : '—',
        `${d0} em D+0 de ${ratsReg} avaliadas · ${fora} fora da régua (app/improdutiva)`),
      kpi('warn', '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
        'Reedições após encerrar', 'em dia posterior ao trabalho', reed, `evento${reed === 1 ? '' : 's'} no mês · teto 6 por técnico`),
      kpi('pend', '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
        'Devoluções', 'tarefas devolvidas pela gestão', dev, `tarefa${dev === 1 ? '' : 's'} no mês`),
    ].join('') : ''

    // Seletor de ordenação — nada de índice invisível: ordena pelo que está na tela
    document.getElementById('dp-leg').innerHTML = n ? `<label class="dp-ord">Ordenar por
      <select id="dp-ord-sel">
        <option value="atencao"${ordem === 'atencao' ? ' selected' : ''}>Mais atenção</option>
        <option value="pct"${ordem === 'pct' ? ' selected' : ''}>Menor percentual com problema</option>
        <option value="reed"${ordem === 'reed' ? ' selected' : ''}>Mais reedições</option>
        <option value="dev"${ordem === 'dev' ? ' selected' : ''}>Mais devoluções</option>
        <option value="nome"${ordem === 'nome' ? ' selected' : ''}>Nome</option>
      </select></label>` : ''
    const sel = document.getElementById('dp-ord-sel')
    if (sel) sel.onchange = () => { ordem = sel.value; render() }

    const box = document.getElementById('dp-rk')
    if (!n) { box.innerHTML = `<div class="dp-vazio">${(!status || !status.inicio) && fonte.tipo !== 'snapshot' ? 'Sem dados: painel desligado e nenhum snapshot deste mês.' : 'Nenhum técnico com RATs neste mês.'}</div>`; return }
    const pctL = (l) => pctDe(binario[l.tecnico_id])
    const ordenadas = linhas.slice().sort((a, b) => {
      if (ordem === 'nome') return String(a.tecnico_nome).localeCompare(String(b.tecnico_nome))
      if (ordem === 'reed') return Number(b.reedicoes) - Number(a.reedicoes)
      if (ordem === 'dev') return Number(b.devolucoes) - Number(a.devolucoes)
      const pa = pctL(a), pb = pctL(b)   // pct = % COM problema
      if (ordem === 'pct') return (pa ?? 999) - (pb ?? 999)   // menor % com problema primeiro
      // 'atencao': MAIOR % com problema primeiro (nulos por último), desempate por mais problemas
      if ((pa ?? -1) !== (pb ?? -1)) return (pb ?? -1) - (pa ?? -1)
      return Number((binario[b.tecnico_id] || {}).com_problema || 0) - Number((binario[a.tecnico_id] || {}).com_problema || 0)
    })
    box.innerHTML = `<table><thead><tr><th>Técnico</th><th>Resultado do mês</th><th>Encerramentos e ocorrências</th><th>Tendência</th><th></th></tr></thead><tbody>` +
      ordenadas.map(l => {
        const u = uDe(l.tecnico_id)
        const b = binario[l.tecnico_id]
        const pct = pctDe(b)   // % COM problema
        // Resultado do mês: % de RATs COM problema como elemento principal + contagem
        const resultado = pct == null ? '<span class="dim">—</span>'
          : `<div class="dp-res"><b class="${pct ? 'dp-res-ruim' : ''}">${pct}%</b> com problema</div><div class="dp-res-s">${Number(b.com_problema)} de ${Number(b.elegiveis)} RATs</div>`
        // Coluna única (sem redundância): encerramentos neutros em texto + problemas em chips.
        // O atraso aparece SÓ como chip — não duplica na lista neutra.
        const neutros = [
          Number(l.d0) ? `<b title="Encerrada no dia">${esc(l.d0)}</b> <span title="Encerrada no dia">no dia</span>` : null,
          Number(l.d1) ? `<b title="Encerrada em D+1">${esc(l.d1)}</b> <span title="Encerrada em D+1">em D+1</span>` : null,
          Number(l.pendentes) ? `<span title="Ainda em aberto">${esc(l.pendentes)} aberta${Number(l.pendentes) > 1 ? 's' : ''}</span>` : null,
        ].filter(Boolean).join(' · ')
          + (Number(l.em_janela_instab) ? ` <span class="dp-na">· ${esc(l.em_janela_instab)} não avaliada${Number(l.em_janela_instab) > 1 ? 's' : ''} (app)</span>` : '')
        const probs = [
          Number(l.atrasadas) ? `<span class="dp-oc dp-oc-warn" title="Encerrada com atraso — conta pra equipe toda da RAT"><b>${esc(l.atrasadas)}</b> atraso${Number(l.atrasadas) > 1 ? 's' : ''} coletivo${Number(l.atrasadas) > 1 ? 's' : ''}</span>` : null,
          Number(l.reedicoes) ? `<span class="dp-oc dp-oc-warn" title="Reedição em dia posterior — conta só pra quem editou"><b>${esc(l.reedicoes)}</b> ${Number(l.reedicoes) > 1 ? 'reedições próprias' : 'reedição própria'}</span>` : null,
          Number(l.devolucoes) ? `<span class="dp-oc dp-oc-pend" title="Tarefa devolvida pela gestão — conta pra equipe toda"><b>${esc(l.devolucoes)}</b> devoluç${Number(l.devolucoes) > 1 ? 'ões' : 'ão'}</span>` : null,
        ].filter(Boolean).join(' ') || '<span class="dp-oc dp-oc-ok">sem ocorrências</span>'
        const encOc = `<div class="dp-enc-n">${neutros || '<span class="dim">—</span>'}</div><div class="dp-enc-c">${probs}</div>`
        // Tendência: % com problema vs mês anterior — SUBIR é ruim (vermelho), CAIR é bom (verde)
        const pAnt = pctDe(binarioAnt[l.tecnico_id])
        const tend = (pct == null || pAnt == null) ? '<span class="dim">Sem histórico</span>'
          : (() => { const d = pct - pAnt
              return `<div class="dp-res-s">${pct}% neste mês</div><div class="dp-res-s">${pAnt}% no mês anterior</div>
                <span class="dp-tend${d > 0 ? ' dn' : ''}">${d === 0 ? 'estável' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} ${Math.abs(d) === 1 ? 'ponto percentual' : 'pontos percentuais'}`}</span>` })()
        const amostra = Number(l.rats) < 3 ? '<span class="dp-amostra">Amostra muito baixa</span>'
          : (Number(l.rats) <= 4 ? '<span class="dp-amostra">Amostra limitada</span>' : '')
        return `<tr class="dp-linha${aberto === l.tecnico_id ? ' on' : ''}" data-tec="${esc(l.tecnico_id)}">
          <td><span class="dp-tec"><span class="dp-av">${av(u || { nome: l.tecnico_nome })}</span>${esc(l.tecnico_nome)}${amostra}</span></td>
          <td>${resultado}</td>
          <td class="dp-po">${encOc}</td>
          <td>${tend}</td>
          <td class="dp-chev">${IC_CHEV}</td>
        </tr>
        <tr class="dp-dd" data-dd="${esc(l.tecnico_id)}" hidden><td colspan="5"><div class="dp-ddbox">Carregando…</div></td></tr>`
      }).join('') + '</tbody></table>'
    box.querySelectorAll('.dp-linha').forEach(tr => tr.onclick = () => toggleDrill(tr.dataset.tec))
  }

  async function definirGoLive() {
    const v = prompt('Data de go-live do placar (AAAA-MM-DD).\n\nA partir dela: técnicos passam a VER o card; carência de 28 dias; nada anterior entra no placar.\n\nConfirme antes: teste da versão atual do app aprovado na frota.')
    if (!v) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return toast('Data inválida — use AAAA-MM-DD.', 'err')
    if (!confirm(`Ligar o painel com go-live em ${fmtD(v.trim())}? Os técnicos passam a ver o próprio placar no app.`)) return
    const { error } = await sb().rpc('desempenho_definir_inicio', { p_inicio: v.trim() })
    if (error) return toast('Não foi possível ligar: ' + error.message, 'err')
    toast('Painel ligado. Carência de 28 dias em curso.', 'ok')
    try { const { data } = await sb().rpc('desempenho_status'); status = (data || [])[0] || null } catch (e) {}
    render()
  }

  // ── drill-down: RATs avaliadas + reedições (trilha) + devoluções (3 lentes) ──
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
    const linhaTec = linhas.find(l => l.tecnico_id === tec) || {}
    boxEl.innerHTML = drillHTML(rlist, devs.error ? [] : (devs.data || []), marcas, linhaTec)
  }
  function marcaAberta() { document.querySelectorAll('.dp-linha').forEach(tr => tr.classList.toggle('on', tr.dataset.tec === aberto)) }

  // Chips (textos oficiais por extenso)
  const CHIP = {
    D0: ['dp-c-d0', 'Encerrada no dia'],
    D1: ['dp-c-d1', 'Encerrada em D+1 (meio ponto)'],
    atrasada: ['dp-c-atr', 'Encerrada com atraso'],
    pendente: ['dp-c-ab', 'Ainda em aberto'],
    fora_janela_bug: ['dp-c-ab', 'Não avaliada — app instável'],
  }
  function drillHTML(rats, devs, marcas, lt) {
    // Impactos DERIVADOS da nota (exibição): cada RAT avaliada vale 65/n do componente;
    // cada evento de reedição (até o teto 6) custa 15/6; cada devolução custa a fração do 20.
    const nAval = Number(lt.rats) || 0
    const impRat = (faixa) => {
      if (!nAval) return ''
      if (faixa === 'atrasada') return `<span class="dp-imp">−${pts1(65 / nAval)} pts</span>`
      if (faixa === 'D1') return `<span class="dp-imp">−${pts1(32.5 / nAval)} pts</span>`
      if (faixa === 'D0') return '<span class="dp-imp ok">sem perda</span>'
      return '<span class="dp-imp na">não conta</span>'
    }
    const ratRows = rats.length ? rats.map(r => {
      const ch = CHIP[r.faixa] || CHIP.pendente
      return `<div class="dp-rrow"><b>${esc(fmtD(r.dia))}</b>
        <a href="tarefa.html?t=${encodeURIComponent(r.tarefa_id)}&aba=rats" target="_blank" rel="noopener">Tarefa ${r.tarefa_numero != null ? esc(String(r.tarefa_numero).padStart(5, '0')) : '—'} · ${esc(r.cliente_nome || '—')}</a>
        ${impRat(r.faixa)}<span class="dp-chip ${ch[0]}">${ch[1]}</span></div>`
    }).join('') : '<div class="dp-empty">Nenhuma RAT no mês.</div>'

    const nReed = Number(lt.reedicoes) || 0
    const perdaReedTotal = 15 * (1 - (Number(lt.comp_reedicao) || 0) / 100)
    const marcaRows = marcas.length
      ? marcas.map(m => `<div class="dp-rrow"><b>${esc(fmtD(m.em))}</b><span class="dp-mtx"><b>${esc(m.campo)}</b> ${esc(String(m.valor_antigo ?? ''))} → ${esc(String(m.valor_novo ?? ''))}</span>
          <span class="${m.motivo === 'sync_app_recusado' ? 'dp-rec' : 'dp-mut'}">${m.motivo === 'sync_app_recusado' ? 'recusada (campo da gestão)' : 'após ajuste da gestão'}</span></div>`).join('')
      : ''
    const reedResumo = nReed
      ? `<div class="dp-mini">${nReed} evento${nReed > 1 ? 's' : ''} em dia posterior · impacto <b class="dp-vr">−${pts1(perdaReedTotal)} pts</b> (${pts1(15 / 6)} por evento, teto 6)${marcas.length ? '' : ' · detalhe campo a campo na trilha a partir de 14/07'}</div>`
      : '<div class="dp-empty">Nenhuma reedição em dia posterior.</div>'

    const nDev = devs.length
    const perdaDevTotal = 20 * (1 - (Number(lt.comp_devolucao) || 0) / 100)
    const devRows = nDev ? devs.map(d => {
      const reinc = Number(d.total_na_tarefa) >= 2
      return `<div class="dp-rrow"><b>${esc(fmtD(d.devolvida_em))}</b>
        <span class="dp-mtx"><b>Tarefa ${esc(String(d.numero).padStart(5, '0'))}</b> · ${(d.cats || []).map(esc).join(', ') || 'sem categoria'}${d.origem === 'backfill' ? ' <span class="dp-mut">(backfill)</span>' : ''}</span>
        ${reinc ? `<span class="dp-rec">${esc(d.total_na_tarefa)}ª devolução</span>` : ''}
        <span class="dp-imp">−${pts1(nDev ? perdaDevTotal / nDev : 0)} pts</span></div>`
    }).join('') + `<div class="dp-ress">Série de devoluções começa em 14/07 (migração 0099). O anterior é backfill parcial — conta na reincidência como piso e fica fora da lente de tempo.</div>`
      : '<div class="dp-empty">Nenhuma devolução no mês.</div>'

    // "Dados técnicos da régua" — o índice composto sai da interface principal e vive
    // aqui, como seção secundária de auditoria (cálculo/armazenamento intactos no backend).
    const tecnicos = `<div class="dp-bloco"><div class="dp-bt">Dados técnicos da régua (auditoria)</div>
      <div class="dp-mini">Índice interno de disciplina: <b>${esc(lt.nota)}</b>/100 · composição 65·15·20 —
      Preenchimento ${esc(lt.comp_pontualidade)} · Reedições ${esc(lt.comp_reedicao)} · Devoluções ${esc(lt.comp_devolucao)}.
      <span class="dp-mut">Uso interno do portal (histórico/auditoria); o indicador desta página e do app é o % de RATs sem problema.</span></div></div>`
    return `<div class="dp-ddgrid">
      <div class="dp-bloco dp-b-po"><div class="dp-bt">RATs avaliadas</div>${ratRows}</div>
      <div class="dp-colb">
        <div class="dp-bloco dp-b-reed"><div class="dp-bt">Reedições após encerramento</div>${reedResumo}${marcaRows}</div>
        <div class="dp-bloco dp-b-dev"><div class="dp-bt">Devoluções</div>${devRows}</div>
        ${tecnicos}
      </div></div>`
  }

  return { init }
})()
