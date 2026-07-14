/* ═══════════════════════════════════════════════
   Service Report — placar-card.js (F2 — redesenho final)
   "Meu Placar" na home do app do técnico: SÓ o percentual de RATs sem
   problema e os fatos que o explicam. A nota composta (65/15/20) NÃO
   aparece no app — ela vive no portal como "Índice interno de disciplina".
   Regras cravadas:
   · Gate no servidor: desempenho_status().inicio NULL = painel desligado →
     a seção NÃO aparece (zero impacto).
   · Fonte: meu_resultado_rats() (0103) — só as RATs do próprio técnico,
     com flags por RAT (auth.uid no servidor).
   · RAT com problema: encerrada depois de D+1 · aberta com prazo vencido ·
     reeditada em dia posterior pelo PRÓPRIO técnico · tarefa devolvida.
     D+0 e D+1 não sujam (D+1 = tardia, informativo).
   · Tendência em PONTOS PERCENTUAIS (nunca "+15%"); <3 avaliadas =
     "Amostra limitada", percentual aparece mas tendência não.
   · Zero elegíveis = "Ainda não há RATs avaliadas neste mês." (nunca 0%).
   · Offline-first: nunca bloqueia a home; cache do último resultado.
═══════════════════════════════════════════════ */
window.PlacarCard = (() => {
  const CACHE_KEY = 'sr_placar_cache_v2'
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
  const CONTRATO = 'Sem sinal não perde ponto — o app funciona offline e o registro conta normalmente.'
  const IC = {
    grafico: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/></svg>',
    selo: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>',
    sobe: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    desce: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    seta: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    voltar: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    reloop: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  }

  // ── estilos (uma vez; tokens oficiais --sr-*) ──
  function css() {
    if (document.getElementById('pl-css')) return
    const s = document.createElement('style'); s.id = 'pl-css'
    s.textContent = `
.pl-card{background:var(--sr-card);border:1px solid var(--sr-line);border-radius:16px;padding:15px;font-family:inherit}
.pl-card svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pl-selo{display:flex;align-items:center;gap:8px;background:var(--sr-warn-bg);color:var(--sr-warn-fg);border:1px solid var(--sr-warn-m);border-left:4px solid var(--sr-warn-m);border-radius:10px;padding:8px 11px;font-size:12px;font-weight:600;margin-bottom:12px}
.pl-oficial{display:flex;align-items:center;gap:8px;background:var(--sr-info-bg);color:var(--sr-info-fg);border-radius:10px;padding:8px 11px;font-size:12px;font-weight:600;margin-bottom:12px}
.pl-selo svg,.pl-oficial svg{width:15px;height:15px;flex:none}
.pl-pctl{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:2px}
.pl-pct{font-size:42px;font-weight:800;letter-spacing:-1.5px;color:var(--sr-title);line-height:1;font-variant-numeric:tabular-nums}
.pl-pct-cap{font-size:13px;font-weight:700;color:var(--sr-ink)}
.pl-amostra{font-size:10px;font-weight:800;background:var(--sr-aguard-bg);color:var(--sr-aguard-fg);border-radius:999px;padding:3px 9px;letter-spacing:.02em}
.pl-tend{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:var(--sr-exec-fg);margin-bottom:8px}
.pl-tend.pl-baixa{color:var(--sr-pend-fg)}
.pl-tend svg{width:12px;height:12px}
.pl-tend .pl-mut{color:var(--sr-aguard-fg);font-weight:600}
.pl-contagem{font-size:13px;font-weight:700;color:var(--sr-ink);margin:6px 0 8px}
.pl-contagem .pl-prob{color:var(--sr-pend-fg)}
.pl-ocor{font-size:12px;color:var(--sr-ink);font-weight:600;line-height:1.7}
.pl-ocor .pl-prob{color:var(--sr-pend-fg)}
.pl-ocor .pl-tardia{color:var(--sr-warn-fg);font-weight:600}
.pl-nota-multi{font-size:10.5px;color:var(--sr-aguard-fg);margin-top:3px}
.pl-vazio{font-size:12.5px;color:var(--sr-aguard-fg);padding:6px 0 2px;line-height:1.5}
.pl-rod{display:flex;align-items:center;gap:6px;margin-top:12px;padding-top:11px;border-top:1px solid var(--sr-line);font-size:11px;color:var(--sr-muted);flex-wrap:wrap}
.pl-rod svg{width:12px;height:12px}
.pl-ver{color:var(--sr-blue);font-weight:700;font-size:12px;display:inline-flex;align-items:center;gap:3px;background:none;border:0;font-family:inherit;cursor:pointer;padding:0}
.pl-ver svg{width:12px;height:12px}
.pl-btn-prob{display:inline-flex;align-items:center;gap:6px;margin-top:11px;background:var(--sr-blue);color:var(--sr-card);border:0;border-radius:10px;padding:9px 14px;font-size:12.5px;font-weight:700;font-family:inherit;cursor:pointer}
.pl-btn-prob svg{width:13px;height:13px}
.pl-entender{margin-top:11px;border:1px solid var(--sr-line);border-radius:10px;padding:11px 12px;background:var(--sr-bg)}
.pl-entender[hidden]{display:none}
.pl-e-t{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--sr-muted);margin:8px 0 3px}
.pl-e-t:first-child{margin-top:0}
.pl-e-x{font-size:11.5px;color:var(--sr-ink);line-height:1.55}
.pl-e-x .pl-mut{color:var(--sr-aguard-fg)}
.pl-e-x .pl-prob{color:var(--sr-pend-fg);font-weight:700}
/* detalhe (overlay) */
.pl-ov{position:fixed;inset:0;background:var(--sr-bg);z-index:300;overflow-y:auto;padding:14px;display:none}
.pl-ov.aberto{display:block}
.pl-ov svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pl-dh{display:flex;align-items:center;gap:9px;margin:2px 0 8px}
.pl-dh .pl-back{width:34px;height:34px;border-radius:9px;background:var(--sr-card);border:1px solid var(--sr-line-strong);display:grid;place-items:center;color:var(--sr-muted);cursor:pointer;flex:none}
.pl-dh .pl-back svg{width:15px;height:15px}
.pl-dt{font-size:15px;font-weight:800;color:var(--sr-title)}
.pl-ds{font-size:11px;color:var(--sr-muted)}
.pl-leg{font-size:11px;color:var(--sr-aguard-fg);padding:2px 4px 8px;line-height:1.6}
.pl-rlist{display:flex;flex-direction:column;gap:8px}
.pl-rrow{background:var(--sr-card);border:1px solid var(--sr-line);border-radius:13px;padding:11px 13px;display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.pl-dia{width:44px;flex:none;text-align:center}
.pl-dia b{display:block;font-size:15px;color:var(--sr-title);font-variant-numeric:tabular-nums}
.pl-dia span{font-size:9.5px;color:var(--sr-muted);text-transform:uppercase;letter-spacing:.06em}
.pl-inf{min-width:0;flex:1}
.pl-inf b{display:block;font-size:12.5px;color:var(--sr-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-chips{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.pl-chip{flex:none;font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px}
.pl-c-ok{background:var(--sr-exec-bg);color:var(--sr-exec-fg)}
.pl-c-tardia{background:var(--sr-warn-bg);color:var(--sr-warn-fg)}
.pl-c-prob{background:var(--sr-pend-bg);color:var(--sr-pend-fg)}
.pl-c-neutro{background:var(--sr-aguard-bg);color:var(--sr-aguard-fg)}`
    document.head.appendChild(s)
  }

  // ── util ──
  const e_ = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const mesISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const mesNome = (iso) => MESES[Number(iso.slice(5, 7)) - 1] || iso
  const mesAnteriorISO = (iso) => { const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 - 1, 1); return mesISO(d) }
  const fmtDH = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const lerCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) } catch (e) { return null } }
  const gravarCache = (c) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch (e) { /* sem espaço: segue sem cache */ } }
  const plural = (n, um, muitos) => n === 1 ? um : muitos
  const rpcPadrao = (fn, args) => getSupabase().rpc(fn, args)

  // Classificação binária de UMA RAT (mesmos critérios do 0103 — exibição)
  const AVALIAVEIS = { D0: 1, D1: 1, atrasada: 1 }
  const temProblema = (r) => r.faixa === 'atrasada' || !!r.reeditada_por_mim || !!r.devolvida
  function resumo(rows) {
    const aval = (rows || []).filter(r => AVALIAVEIS[r.faixa])
    const prob = aval.filter(temProblema)
    return {
      aval, prob,
      nAval: aval.length, nProb: prob.length, nSem: aval.length - prob.length,
      pct: aval.length ? Math.round(100 * (aval.length - prob.length) / aval.length) : null,
      atraso: aval.filter(r => r.faixa === 'atrasada').length,
      reed: aval.filter(r => r.reeditada_por_mim).length,
      dev: aval.filter(r => r.devolvida).length,
      tardias: aval.filter(r => r.faixa === 'D1').length,
    }
  }

  // ── card na home ──
  async function montarHome(el, deps) {
    if (!el) return
    css()
    const rpc = (deps && deps.rpc) || rpcPadrao
    const agora = (deps && deps.agora) || (() => new Date())
    const cache = lerCache()
    let status = null
    try { const r = await rpc('desempenho_status'); if (!r.error) status = (r.data || [])[0] || null } catch (e) {}
    if (!status || !status.inicio) status = (cache && cache.status && cache.status.inicio) ? cache.status : null
    if (!status || !status.inicio) { el.innerHTML = ''; return }   // painel desligado → invisível
    const mes = mesISO(agora())
    let rows = null, prevPct = null, atualizadoEm = null, doCache = false
    try {
      const r = await rpc('meu_resultado_rats', { p_mes: mes })
      if (r.error) throw r.error
      rows = r.data || []
      try { const ra = await rpc('meu_resultado_rats', { p_mes: mesAnteriorISO(mes) }); if (!ra.error) prevPct = resumo(ra.data || []).pct } catch (e) {}
      atualizadoEm = agora().toISOString()
      gravarCache({ status, mes, rows, prevPct, atualizadoEm })
    } catch (e) {
      if (cache && cache.mes === mes) { rows = cache.rows; prevPct = cache.prevPct; atualizadoEm = cache.atualizadoEm; doCache = true }
      else { el.innerHTML = ''; return }
    }
    el.innerHTML = `<div class="sec">Meu placar — ${e_(mesNome(mes))}</div>` + cardHTML(rows, prevPct, status, atualizadoEm, doCache, agora(), mes)
    const bDet = el.querySelector('.pl-btn-prob')
    if (bDet) bDet.onclick = () => abrirDetalhe(rows, mes, bDet.dataset.filtro === 'prob')
    const ent = el.querySelector('.pl-abre-entender'), box = el.querySelector('.pl-entender')
    if (ent && box) ent.onclick = () => { box.hidden = !box.hidden }
  }

  function cardHTML(rows, prevPct, status, atualizadoEm, doCache, hoje, mes) {
    const emCarencia = status.carencia_ate && (hoje.toISOString().slice(0, 10) <= String(status.carencia_ate))
    const faixa = emCarencia
      ? `<div class="pl-selo">${IC.grafico}Período de adaptação — placar informativo</div>`
      : `<div class="pl-oficial">${IC.selo}Placar oficial · válido desde ${e_(String(status.inicio).slice(8, 10))}/${e_(String(status.inicio).slice(5, 7))}</div>`
    const R = resumo(rows)
    const rodape = (extra) => `<div class="pl-rod">${IC.reloop}Atualizado em ${e_(fmtDH(atualizadoEm))}${doCache ? ' · offline — último placar sincronizado' : ''}${extra || ''}</div>`
    // Zero elegíveis: nunca mostrar 0%
    if (!R.nAval) return `<div class="pl-card">${faixa}<div class="pl-vazio">Ainda não há RATs avaliadas neste mês.</div>${rodape()}</div>`
    // Tendência: pontos percentuais, e só com amostra ≥3 (senão não é conclusão de desempenho)
    const amostra = R.nAval < 3 ? '<span class="pl-amostra">Amostra limitada</span>' : ''
    let tend = ''
    if (R.nAval >= 3 && prevPct != null) {
      const d = R.pct - prevPct
      tend = d === 0
        ? `<div class="pl-tend"><span class="pl-mut">estável · ${e_(prevPct)}% em ${e_(mesNome(mesAnteriorISO(mes)))}</span></div>`
        : `<div class="pl-tend${d < 0 ? ' pl-baixa' : ''}">${d < 0 ? IC.desce : IC.sobe}${Math.abs(d)} ${plural(Math.abs(d), 'ponto percentual', 'pontos percentuais')} <span class="pl-mut">· ${e_(prevPct)}% em ${e_(mesNome(mesAnteriorISO(mes)))}</span></div>`
    }
    // Ocorrências (contagem de RATs por motivo; só >0)
    const ocor = [
      R.atraso ? `<span class="pl-prob">${e_(R.atraso)} ${plural(R.atraso, 'encerrada com atraso', 'encerradas com atraso')}</span>` : null,
      R.reed ? `<span class="pl-prob">${e_(R.reed)} ${plural(R.reed, 'reedição em dia posterior', 'reedições em dia posterior')}</span>` : null,
      R.dev ? `<span class="pl-prob">${e_(R.dev)} ${plural(R.dev, 'devolução', 'devoluções')}</span>` : null,
      R.tardias ? `<span class="pl-tardia">${e_(R.tardias)} ${plural(R.tardias, 'encerrada em D+1 (tardia, não conta como problema)', 'encerradas em D+1 (tardias, não contam como problema)')}</span>` : null,
    ].filter(Boolean).join(' · ')
    const multi = R.nProb ? '<div class="pl-nota-multi">Uma mesma RAT pode apresentar mais de um motivo.</div>' : ''
    const btn = R.nProb
      ? `<button type="button" class="pl-btn-prob" data-filtro="prob">Ver RATs com problema${IC.seta}</button>`
      : `<button type="button" class="pl-btn-prob" data-filtro="todas">Ver RATs avaliadas${IC.seta}</button>`
    // "Entender meu resultado" — só o binário; nada de nota composta/pesos/índice interno
    const probList = R.prob.map(r => {
      const motivos = [r.faixa === 'atrasada' ? 'encerrada com atraso (conta pra equipe toda)' : null,
                       r.reeditada_por_mim ? 'reeditada por você em dia posterior' : null,
                       r.devolvida ? 'tarefa devolvida pela gestão (conta pra equipe toda)' : null].filter(Boolean).join(' + ')
      return `Tarefa ${r.tarefa_numero != null ? e_(String(r.tarefa_numero).padStart(5, '0')) : '—'} (${e_(String(r.dia).slice(8, 10))}/${e_(String(r.dia).slice(5, 7))}): <span class="pl-prob">${motivos}</span>`
    }).join('<br>')
    return `<div class="pl-card">
      ${faixa}
      <div class="pl-pctl"><span class="pl-pct">${e_(R.pct)}%</span><span class="pl-pct-cap">das RATs sem problema</span>${amostra}</div>
      ${tend}
      <div class="pl-contagem">${e_(R.nAval)} ${plural(R.nAval, 'RAT avaliada', 'RATs avaliadas')} · ${e_(R.nSem)} sem problema · <span class="${R.nProb ? 'pl-prob' : ''}">${e_(R.nProb)} com problema</span></div>
      ${ocor ? `<div class="pl-ocor">${ocor}</div>${multi}` : ''}
      ${btn}
      ${rodape(`<button type="button" class="pl-ver pl-abre-entender" style="margin-left:auto">Entender meu resultado</button>`)}
      <div class="pl-entender" hidden>
        <div class="pl-e-t">Como o percentual é calculado</div>
        <div class="pl-e-x">${e_(R.nSem)} sem problema ÷ ${e_(R.nAval)} avaliadas × 100 = <b>${e_(R.pct)}%</b>. Cada RAT pesa igual; uma RAT com dois ou três motivos conta uma vez só.</div>
        <div class="pl-e-t">O que faz uma RAT contar como problema</div>
        <div class="pl-e-x">Encerrada depois de D+1 · ainda aberta com o prazo vencido · reeditada em dia posterior por você · tarefa devolvida pela gestão. Encerrar no dia (vale até 04:00) ou até 12:00 do dia útil seguinte NÃO conta como problema — D+1 aparece só como "tardia". Atraso e devolução contam pra equipe toda da RAT; reedição conta só pra quem editou. ${e_(CONTRATO)}</div>
        <div class="pl-e-t">O que produziu o resultado deste mês</div>
        <div class="pl-e-x">${probList || 'Nenhuma RAT com problema — resultado 100%.'}</div>
        <div class="pl-e-t">Fora da conta</div>
        <div class="pl-e-x"><span class="pl-mut">RATs em janela de instabilidade do app e improdutivas não são avaliadas; RAT ainda no prazo entra quando encerrar.</span></div>
      </div>
    </div>`
  }

  // ── detalhe (overlay): lista com chips por motivo; filtroProblema = só as que afetaram ──
  function abrirDetalhe(rows, mes, filtroProblema) {
    css()
    let ov = document.getElementById('pl-ov')
    if (!ov) { ov = document.createElement('div'); ov.id = 'pl-ov'; ov.className = 'pl-ov'; document.body.appendChild(ov) }
    const R = resumo(rows)
    const lista = filtroProblema ? R.prob : (rows || [])
    const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
    const linhas = lista.length ? lista.map(r => {
      const d = new Date(String(r.dia) + 'T12:00:00')
      const chips = []
      if (r.faixa === 'D0') chips.push('<span class="pl-chip pl-c-ok">Encerrada no dia</span>')
      if (r.faixa === 'D1') chips.push('<span class="pl-chip pl-c-tardia">Encerrada em D+1 (tardia)</span>')
      if (r.faixa === 'atrasada') chips.push('<span class="pl-chip pl-c-prob">Encerrada com atraso</span>')
      if (r.faixa === 'pendente') chips.push('<span class="pl-chip pl-c-neutro">Ainda em aberto</span>')
      if (r.faixa === 'fora_janela_bug') chips.push('<span class="pl-chip pl-c-neutro">Não avaliada — app instável</span>')
      if (r.reeditada_por_mim) chips.push('<span class="pl-chip pl-c-prob">Reedição em dia posterior</span>')
      if (r.devolvida) chips.push('<span class="pl-chip pl-c-prob">Devolvida</span>')
      return `<div class="pl-rrow"><span class="pl-dia"><b>${String(d.getDate()).padStart(2, '0')}</b><span>${DIAS[d.getDay()]}</span></span>
        <span class="pl-inf"><b>${r.tarefa_numero != null ? 'Tarefa ' + e_(String(r.tarefa_numero).padStart(5, '0')) + ' · ' : ''}${e_(r.cliente_nome || '—')}</b></span>
        <span class="pl-chips">${chips.join('')}</span></div>`
    }).join('') : '<div class="pl-vazio">Nada aqui neste mês.</div>'
    ov.innerHTML = `<div class="pl-dh"><button type="button" class="pl-back">${IC.voltar}</button>
        <div><div class="pl-dt">${filtroProblema ? 'RATs com problema' : 'Minhas RATs'} — ${e_(mesNome(mes))}</div><div class="pl-ds">Só as suas: dados de colegas não aparecem</div></div></div>
      <p class="pl-leg">Problema = encerrada depois de D+1 · aberta com prazo vencido · reedição sua em dia posterior · tarefa devolvida. Encerrada no dia ou em D+1 não conta como problema. Uma mesma RAT pode ter mais de um motivo. ${e_(CONTRATO)}</p>
      <div class="pl-rlist">${linhas}</div>`
    ov.classList.add('aberto')
    ov.querySelector('.pl-back').onclick = () => ov.classList.remove('aberto')
  }

  return { montarHome, abrirDetalhe }
})()
