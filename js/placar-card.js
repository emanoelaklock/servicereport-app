/* ═══════════════════════════════════════════════
   Service Report — placar-card.js (F2)
   "Meu Placar" na home do app do técnico. Autocontido: injeta os próprios
   estilos (tokens oficiais --sr-*), busca via RPC injetável (testável no
   harness com o MESMO código) e cai pro cache local quando offline.
   Regras cravadas:
   · Gate no servidor: desempenho_status().inicio NULL = painel desligado →
     a seção simplesmente NÃO aparece (zero impacto).
   · Privacidade: meu_placar()/meu_placar_rats() devolvem SÓ o próprio técnico.
   · Textos coletivos "da tua equipe" (encerramento/devolução); reedição é
     individual. Rótulo "Preenchimento online" + legenda-contrato.
   · Selo de carência até inicio+28d; depois, faixa "Placar oficial".
   · Offline-first: nunca bloqueia a home; mostra o último placar sincronizado
     com "Atualizado em…".
═══════════════════════════════════════════════ */
window.PlacarCard = (() => {
  const CACHE_KEY = 'sr_placar_cache_v1'
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
  const CONTRATO = 'Online = encerrada no dia do trabalho. Sem sinal não perde ponto — o app funciona offline e o registro conta normalmente.'
  const IC = {
    grafico: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/></svg>',
    selo: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M21 11.5a9 9 0 1 1-5.3-8.2"/><path d="m9 11 3 3L22 4"/></svg>',
    lapis: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    volta: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    sobe: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    desce: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    seta: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    voltar: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    reloop: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  }
  const CHIP = {
    D0: { cls: 'pl-c-d0', txt: 'NO DIA' },
    D1: { cls: 'pl-c-d1', txt: 'D+1 · ½ PONTO' },
    atrasada: { cls: 'pl-c-atr', txt: 'ATRASADA' },
    pendente: { cls: 'pl-c-ab', txt: 'EM ABERTO' },
    fora_janela_bug: { cls: 'pl-c-ab', txt: 'NÃO CONTA · APP INSTÁVEL' },
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
.pl-contagem{font-size:14px;font-weight:700;color:var(--sr-ink);margin-bottom:6px}
.pl-contagem b{color:var(--sr-title)}
.pl-contagem .pl-prob{color:var(--sr-pend-fg)}
.pl-notal{display:flex;align-items:baseline;gap:10px;margin-bottom:3px;flex-wrap:wrap}
.pl-nlabel{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--sr-muted)}
.pl-nota{font-size:40px;font-weight:800;letter-spacing:-1.5px;color:var(--sr-title);line-height:1;font-variant-numeric:tabular-nums}
.pl-de{font-size:17px;font-weight:700;color:var(--sr-muted);letter-spacing:0}
.pl-tend{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:700;color:var(--sr-exec-fg)}
.pl-tend.pl-baixa{color:var(--sr-pend-fg)}
.pl-tend svg{width:12px;height:12px}
.pl-amostra{font-size:10px;font-weight:800;background:var(--sr-aguard-bg);color:var(--sr-aguard-fg);border-radius:999px;padding:3px 9px;letter-spacing:.02em}
.pl-ocor{font-size:12px;color:var(--sr-ink);font-weight:600;margin-bottom:12px}
.pl-ocor .pl-prob{color:var(--sr-pend-fg)}
.pl-entender{margin-top:11px;border:1px solid var(--sr-line);border-radius:10px;padding:11px 12px;background:var(--sr-bg)}
.pl-entender[hidden]{display:none}
.pl-e-t{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--sr-muted);margin:8px 0 3px}
.pl-e-t:first-child{margin-top:0}
.pl-e-x{font-size:11.5px;color:var(--sr-ink);line-height:1.55}
.pl-e-x .pl-mut{color:var(--sr-aguard-fg)}
.pl-comp{display:flex;flex-direction:column;gap:11px}
.pl-chead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
.pl-cl{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:var(--sr-ink)}
.pl-cl svg{width:14px;height:14px}
.pl-cv{font-size:12px;color:var(--sr-aguard-fg);font-variant-numeric:tabular-nums;text-align:right}
.pl-bar{height:6px;border-radius:4px;background:var(--sr-aguard-bg);overflow:hidden}
.pl-bar i{display:block;height:100%;border-radius:4px}
.pl-impacto{margin-top:6px;font-size:12px;color:var(--sr-pend-fg);background:var(--sr-pend-bg);border-radius:8px;padding:7px 10px;line-height:1.45}
.pl-sub{margin-top:5px;font-size:11.5px;color:var(--sr-aguard-fg);line-height:1.5}
.pl-rod{display:flex;align-items:center;gap:6px;margin-top:13px;padding-top:11px;border-top:1px solid var(--sr-line);font-size:11px;color:var(--sr-muted);flex-wrap:wrap}
.pl-rod svg{width:12px;height:12px}
.pl-ver{margin-left:auto;color:var(--sr-blue);font-weight:700;font-size:12px;display:inline-flex;align-items:center;gap:3px;background:none;border:0;font-family:inherit;cursor:pointer;padding:0}
.pl-ver svg{width:12px;height:12px}
.pl-vazio{font-size:12.5px;color:var(--sr-aguard-fg);padding:6px 0 2px;line-height:1.5}
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
.pl-rrow{background:var(--sr-card);border:1px solid var(--sr-line);border-radius:13px;padding:11px 13px;display:flex;align-items:center;gap:11px}
.pl-dia{width:44px;flex:none;text-align:center}
.pl-dia b{display:block;font-size:15px;color:var(--sr-title);font-variant-numeric:tabular-nums}
.pl-dia span{font-size:9.5px;color:var(--sr-muted);text-transform:uppercase;letter-spacing:.06em}
.pl-inf{min-width:0;flex:1}
.pl-inf b{display:block;font-size:12.5px;color:var(--sr-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-inf span{font-size:11px;color:var(--sr-muted)}
.pl-chip{flex:none;font-size:10px;font-weight:800;padding:4px 9px;border-radius:999px;letter-spacing:.02em}
.pl-c-d0{background:var(--sr-exec-bg);color:var(--sr-exec-fg)}
.pl-c-d1{background:var(--sr-warn-bg);color:var(--sr-warn-fg)}
.pl-c-atr{background:var(--sr-pend-bg);color:var(--sr-pend-fg)}
.pl-c-ab{background:var(--sr-aguard-bg);color:var(--sr-aguard-fg)}`
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
  // pontos perdidos num componente (peso × fração perdida)
  const perda = (peso, comp) => Math.round(peso * (1 - (Number(comp) || 0) / 100))

  const rpcPadrao = (fn, args) => getSupabase().rpc(fn, args)

  // ── card na home ──
  async function montarHome(el, deps) {
    if (!el) return
    css()
    const rpc = (deps && deps.rpc) || rpcPadrao
    const agora = (deps && deps.agora) || (() => new Date())
    const cache = lerCache()
    // 1) gate do go-live (com fallback de cache pro offline)
    let status = null
    try { const r = await rpc('desempenho_status'); if (!r.error) status = (r.data || [])[0] || null } catch (e) {}
    if (!status || !status.inicio) status = (cache && cache.status && cache.status.inicio) ? cache.status : null
    if (!status || !status.inicio) { el.innerHTML = ''; return }   // painel desligado → invisível
    // 2) placar do mês (+ anterior pra tendência) — offline cai pro cache
    const mes = mesISO(agora())
    let dados = null, anterior = null, atualizadoEm = null, doCache = false
    try {
      const r = await rpc('meu_placar', { p_mes: mes })
      if (r.error) throw r.error
      dados = (r.data || [])[0] || null
      try { const ra = await rpc('meu_placar', { p_mes: mesAnteriorISO(mes) }); if (!ra.error) anterior = (ra.data || [])[0] || null } catch (e) {}
      atualizadoEm = agora().toISOString()
      gravarCache({ status, mes, dados, anterior, atualizadoEm })
    } catch (e) {
      if (cache && cache.mes === mes) { dados = cache.dados; anterior = cache.anterior; atualizadoEm = cache.atualizadoEm; doCache = true }
      else { el.innerHTML = ''; return }   // offline sem cache do mês: seção não aparece (não bloqueia a home)
    }
    el.innerHTML = `<div class="sec">Meu placar — ${e_(mesNome(mes))}</div>` + cardHTML(dados, anterior, status, atualizadoEm, doCache, agora())
    const btn = el.querySelector('.pl-ver')
    if (btn) btn.onclick = () => abrirDetalhe(rpc, mes, doCache)
    const ent = el.querySelector('.pl-abre-entender'), box = el.querySelector('.pl-entender')
    if (ent && box) ent.onclick = () => { box.hidden = !box.hidden }
  }

  // Selo de amostra (três níveis; ninguém sai do placar) — reavaliar com 2-3 meses de série.
  const seloAmostra = (n) => n < 3 ? '<span class="pl-amostra">Amostra muito baixa</span>'
    : (n <= 4 ? '<span class="pl-amostra">Amostra limitada</span>' : '')

  function cardHTML(d, ant, status, atualizadoEm, doCache, hoje) {
    const emCarencia = status.carencia_ate && (hoje.toISOString().slice(0, 10) <= String(status.carencia_ate))
    const faixa = emCarencia
      ? `<div class="pl-selo">${IC.grafico}Período de adaptação — placar informativo</div>`
      : `<div class="pl-oficial">${IC.selo}Placar oficial · válido desde ${e_(String(status.inicio).slice(8, 10))}/${e_(String(status.inicio).slice(5, 7))}</div>`
    if (!d) return `<div class="pl-card">${faixa}<div class="pl-vazio">Ainda sem RATs contadas neste mês — o placar aparece com o primeiro atendimento.</div></div>`
    const nRats = Number(d.rats) || 0
    const atras = (Number(d.atrasadas) || 0)
    const limpas = Math.max(0, nRats - atras)   // leitura de contagem: limpa = encerrada na régua (D+0/D+1)
    const tend = (ant && ant.nota != null)
      ? `<span class="pl-tend${Number(d.nota) < Number(ant.nota) ? ' pl-baixa' : ''}">${Number(d.nota) < Number(ant.nota) ? IC.desce : IC.sobe}${Number(d.nota) >= Number(ant.nota) ? '+' : ''}${Number(d.nota) - Number(ant.nota)} vs. ${e_(mesNome(mesAnteriorISO(d.mes)))}</span>`
      : ''
    const pPont = perda(65, d.comp_pontualidade), pReed = perda(15, d.comp_reedicao), pDev = perda(20, d.comp_devolucao)
    // linha de ocorrências (só o que existe; formatos distintos: nota é XX/100, contagem é "Y de X")
    const ocor = [
      atras ? `<span class="pl-prob">${e_(atras)} com atraso</span>` : null,
      Number(d.reedicoes) ? `${e_(d.reedicoes)} ${plural(Number(d.reedicoes), 'reedição', 'reedições')}` : null,
      Number(d.devolucoes) ? `${e_(d.devolucoes)} ${plural(Number(d.devolucoes), 'devolução', 'devoluções')}` : null,
      Number(d.pendentes) ? `<span class="pl-mut" style="color:var(--sr-aguard-fg)">${e_(d.pendentes)} em aberto</span>` : null,
    ].filter(Boolean).join(' · ') || 'Sem ocorrências no mês.'
    return `<div class="pl-card">
      ${faixa}
      <div class="pl-contagem"><b>${e_(nRats)} ${plural(nRats, 'RAT avaliada', 'RATs avaliadas')}</b> · ${e_(limpas)} ${plural(limpas, 'limpa', 'limpas')} · <span class="${atras ? 'pl-prob' : ''}">${e_(atras)} com problema</span></div>
      <div class="pl-notal"><span class="pl-nlabel">Nota do mês</span><span class="pl-nota">${e_(d.nota)}<span class="pl-de">/100</span></span>${tend}${seloAmostra(nRats)}</div>
      <div class="pl-ocor">${ocor}</div>
      <div class="pl-comp">
        <div>
          <div class="pl-chead"><span class="pl-cl">${IC.check}Preenchimento online</span><span class="pl-cv">${e_(d.d0)} D+0 · ${e_(d.d1)} D+1 · ${e_(atras)} ${plural(atras, 'atrasada', 'atrasadas')}</span></div>
          <div class="pl-bar"><i style="width:${Number(d.comp_pontualidade) || 0}%;background:var(--sr-exec-m)"></i></div>
          <div class="pl-sub">${e_(CONTRATO)}</div>
        </div>
        <div>
          <div class="pl-chead"><span class="pl-cl">${IC.lapis}Reedições após encerrar</span><span class="pl-cv">${Number(d.reedicoes) ? e_(d.reedicoes) + ' em dia posterior' : 'nenhuma'}</span></div>
          <div class="pl-bar"><i style="width:${Number(d.comp_reedicao) || 0}%;background:var(--sr-warn-m)"></i></div>
        </div>
        <div>
          <div class="pl-chead"><span class="pl-cl">${IC.volta}Devoluções</span><span class="pl-cv">${Number(d.devolucoes) ? e_(d.devolucoes) + ' ' + plural(Number(d.devolucoes), 'tarefa', 'tarefas') : 'nenhuma'}</span></div>
          <div class="pl-bar"><i style="width:${Number(d.comp_devolucao) || 0}%;background:${Number(d.devolucoes) ? 'var(--sr-pend-m)' : 'var(--sr-exec-m)'}"></i></div>
          ${Number(d.devolucoes) ? '' : '<div class="pl-sub">Nenhuma RAT da tua equipe devolvida pela gestão neste mês.</div>'}
        </div>
      </div>
      <div class="pl-rod">${IC.reloop}Atualizado em ${e_(fmtDH(atualizadoEm))}${doCache ? ' · offline — último placar sincronizado' : ''}
        <button type="button" class="pl-ver pl-abre-entender" style="margin-left:auto">Entender minha nota</button>
        <button type="button" class="pl-ver" style="margin-left:10px">Ver minhas RATs${IC.seta}</button></div>
      <div class="pl-entender" hidden>
        <div class="pl-e-t">Como a nota é calculada</div>
        <div class="pl-e-x">Nota = 65% Preenchimento online + 15% Reedições após encerrar + 20% Devoluções. A nota é sempre <b>XX/100</b>; a contagem "${e_(limpas)} de ${e_(nRats)} RATs limpas" é outro indicador — não são a mesma coisa.</div>
        <div class="pl-e-t">Regra aplicada</div>
        <div class="pl-e-x">Encerrada no dia (vale até 04:00 da madrugada seguinte) = nota cheia · até 12:00 do próximo dia útil = meio ponto · depois = zero · em aberto no prazo = não conta ainda. ${e_(CONTRATO)}</div>
        <div class="pl-e-t">O que pesou neste mês</div>
        <div class="pl-e-x">${[
          atras ? `${e_(atras)} ${plural(atras, 'RAT da tua equipe encerrada com atraso', 'RATs da tua equipe encerradas com atraso')}: −${pPont} pts` : null,
          Number(d.reedicoes) ? `${e_(d.reedicoes)} ${plural(Number(d.reedicoes), 'reedição sua em dia posterior', 'reedições suas em dia posterior')}: −${pReed} pts (teto 6/mês)` : null,
          Number(d.devolucoes) ? `${e_(d.devolucoes)} ${plural(Number(d.devolucoes), 'tarefa da tua equipe devolvida', 'tarefas da tua equipe devolvidas')} pela gestão: −${pDev} pts` : null,
        ].filter(Boolean).join('<br>') || 'Nada pesou contra — nota cheia nos três componentes.'}</div>
        <div class="pl-e-t">Versão e período da regra</div>
        <div class="pl-e-x"><span class="pl-mut">Régua v2 · placar válido desde ${e_(String(status.inicio).slice(8, 10))}/${e_(String(status.inicio).slice(5, 7))} · atrasos em janelas de instabilidade do app não são avaliados.</span></div>
      </div>
    </div>`
  }

  // ── detalhe "Minhas RATs" (overlay; legenda dos chips ANTES da lista) ──
  async function abrirDetalhe(rpc, mes, offline) {
    css()
    let ov = document.getElementById('pl-ov')
    if (!ov) { ov = document.createElement('div'); ov.id = 'pl-ov'; ov.className = 'pl-ov'; document.body.appendChild(ov) }
    ov.innerHTML = `<div class="pl-dh"><button type="button" class="pl-back">${IC.voltar}</button>
        <div><div class="pl-dt">Minhas RATs — ${e_(mesNome(mes))}</div><div class="pl-ds">Só as suas: nota e nome de colegas não aparecem</div></div></div>
      <p class="pl-leg">NO DIA = nota cheia (vale até 04:00 da madrugada seguinte) · D+1 = meio ponto (até 12:00 do próximo dia útil) · depois disso = zero · EM ABERTO = ainda no prazo, não conta. ${e_(CONTRATO)}</p>
      <div class="pl-rlist"><div class="pl-vazio">Carregando…</div></div>`
    ov.classList.add('aberto')
    ov.querySelector('.pl-back').onclick = () => ov.classList.remove('aberto')
    const lista = ov.querySelector('.pl-rlist')
    const cache = lerCache()
    let rats = null
    try {
      const r = await rpc('meu_placar_rats', { p_mes: mes })
      if (r.error) throw r.error
      rats = r.data || []
      gravarCache(Object.assign({}, cache, { rats, ratsMes: mes }))
    } catch (e) {
      if (cache && cache.ratsMes === mes && cache.rats) rats = cache.rats
    }
    if (!rats) { lista.innerHTML = '<div class="pl-vazio">Sem conexão e sem dados guardados — abre de novo quando sincronizar.</div>'; return }
    if (!rats.length) { lista.innerHTML = '<div class="pl-vazio">Nenhuma RAT sua neste mês ainda.</div>'; return }
    const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
    lista.innerHTML = rats.map(r => {
      const d = new Date(String(r.dia) + 'T12:00:00')
      const ch = CHIP[r.faixa] || CHIP.pendente
      const sub = r.encerrada_dia && r.faixa !== 'pendente' ? '' : (r.faixa === 'pendente' ? 'em atendimento' : '')
      return `<div class="pl-rrow"><span class="pl-dia"><b>${String(d.getDate()).padStart(2, '0')}</b><span>${DIAS[d.getDay()]}</span></span>
        <span class="pl-inf"><b>${r.tarefa_numero != null ? 'Tarefa ' + e_(String(r.tarefa_numero).padStart(5, '0')) + ' · ' : ''}${e_(r.cliente_nome || '—')}</b>${sub ? `<span>${e_(sub)}</span>` : ''}</span>
        <span class="pl-chip ${ch.cls}">${ch.txt}</span></div>`
    }).join('')
  }

  return { montarHome, abrirDetalhe }
})()
