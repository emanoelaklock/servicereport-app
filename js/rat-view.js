/* ═══════════════════════════════════════════════
   Service Report — rat-view.js
   Renderização compartilhada do detalhe da RAT (back-office):
   layout de relatório, edição de campos, PDF (1 RAT ou várias unificadas).
   Usado dentro da tela de Tarefas (Conciliação). Depende de: utils.js (esc, fdt),
   supabase-client.js (getSupabase). Exposto como window.RatView.
═══════════════════════════════════════════════ */
window.RatView = (function () {
  let forms = {}   // id do formulário -> array de campos

  // Dados do emitente (cabeçalho do documento) — mesmos do orçamento/TSRV.
  const EMPRESA = {
    nome: 'Traders Service Soluções em Tecnologia',
    cnpj: '10.923.494/0001-30',
    tel: '(47) 3025-2660',
    email: 'suporte@tsrv.com.br',
    endereco: 'R. Dona Francisca, 8300 — Via Trieste, Prédio 02 · Perini Business Park · Joinville-SC · 89.219-600',
  }

  // Colunas necessárias para montar o detalhe de uma RAT (inclui dados fiscais do cliente e da OS).
  const RAT_SELECT = 'id,cliente_id,cliente_nome,tecnico_nome,data_tarefa,status,sync_status,pendencias,assinatura_url,respostas,tempo_trabalhado,formulario_id,rat_seq,checkin_lat,checkin_lng,checkin_precisao,checkin_em,atendimento_executado,motivo_improdutiva,motivo_texto,tipos_servico(nome),cliente:clientes(nome,documento,endereco),tarefa:tarefas(id,numero,cliente_id,tipo_servico_id,orientacao,tipo:tipos_servico(nome))'

  async function ensureForms() {
    if (Object.keys(forms).length) return
    const { data } = await getSupabase().from('formulario_modelos').select('id,campos')
    forms = {}; (data || []).forEach(f => { forms[f.id] = f.campos || [] })
  }

  const fmtMin = (t) => (t == null) ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  const escMulti = (s) => esc(String(s == null ? '' : s)).replace(/\n/g, '<br>')
  const tipoNomeRat = (r) => (r.tarefa && r.tarefa.tipo && r.tarefa.tipo.nome) || (r.tipos_servico && r.tipos_servico.nome) || '—'

  const STATUS = {
    em_andamento:        { label: 'Em andamento',           cls: 'st-run' },
    registrado:          { label: 'Registrada',             cls: 'st-ok' },
    concluida:           { label: 'Concluída',              cls: 'st-ok' },
    concluida_pendencia: { label: 'Concluída c/ pendência', cls: 'st-pend' },
    improdutiva:         { label: 'Visita improdutiva',     cls: 'st-pend' },
  }
  const statusInfo = (s) => STATUS[s] || { label: s || '—', cls: '' }
  // Motivos da visita improdutiva (mesmas chaves do app do técnico)
  const MOTIVO_IMPRODUTIVA = {
    cliente_nao_liberou: 'Cliente não liberou acesso',
    local_nao_pronto: 'Local não estava pronto',
    falta_material: 'Falta de peça / material',
    clima: 'Condições climáticas',
    equip_cliente_indisponivel: 'Equipamento do cliente indisponível',
    outro: 'Outro motivo',
  }
  const motivoImprodutivaLabel = (r) => {
    const base = MOTIVO_IMPRODUTIVA[r.motivo_improdutiva] || r.motivo_improdutiva || '—'
    return (r.motivo_improdutiva === 'outro' && r.motivo_texto) ? `${base}: ${r.motivo_texto}` : base
  }

  // ── Tempo trabalhado (mesma regra do app do técnico) ──
  // NOVO: execução + ida + retorno (que existiram) − almoço − pausa.
  // LEGADO: RAT antiga (só a chave `deslocamento`) → janela única ida→retorno; senão execução.
  const minutosDe = (hhmm) => { if (!hhmm) return null; const [h, m] = String(hhmm).split(':').map(Number); return (isNaN(h) || isNaN(m)) ? null : h * 60 + m }
  function calcTempoDe(resp) {
    resp = resp || {}
    // horários são só HH:MM (sem data): término < início = virou a meia-noite → +24h
    const dur = (ini, fim) => { const a = minutosDe(ini), b = minutosDe(fim); if (a == null || b == null) return 0; let d = b - a; if (d < 0) d += 1440; return d }
    const alm = dur(resp.almoco_inicio, resp.almoco_termino), pau = dur(resp.pausa_inicio, resp.pausa_termino)
    const temNovo = (resp.desloc_ida != null && resp.desloc_ida !== '') || (resp.desloc_retorno != null && resp.desloc_retorno !== '')
    if (temNovo) {
      const exec = (resp.hora_inicio && resp.hora_termino) ? dur(resp.hora_inicio, resp.hora_termino) : 0
      const ida = resp.desloc_ida === 'Sim' ? dur(resp.desloc_inicial_ida, resp.desloc_final_ida) : 0
      const ret = resp.desloc_retorno === 'Sim' ? dur(resp.desloc_inicial_retorno, resp.desloc_final_retorno) : 0
      if (!resp.hora_inicio && !ida && !ret) return null
      const t = exec + ida + ret - alm - pau
      return t < 0 ? 0 : t
    }
    let ini, fim
    if (resp.deslocamento === 'Sim') { ini = resp.desloc_inicial_ida; fim = resp.desloc_final_retorno }
    else { ini = resp.hora_inicio; fim = resp.hora_termino }
    const a = minutosDe(ini), b = minutosDe(fim)
    if (a == null || b == null) return null
    let bruto = b - a; if (bruto < 0) bruto += 1440
    const t = bruto - alm - pau
    return t < 0 ? 0 : t
  }
  const tempoRat = (r) => { const t = calcTempoDe(r.respostas); return t == null ? r.tempo_trabalhado : t }

  // Visibilidade de campo condicional.
  function regraOk(rg, resp) {
    const v = String(resp[rg.campo] == null ? '' : resp[rg.campo]).trim()
    switch (rg.op) {
      case 'igual':      return v === (rg.valor == null ? '' : rg.valor)
      case 'diferente':  return v !== (rg.valor == null ? '' : rg.valor)
      case 'contem':     return v.toLowerCase().includes(String(rg.valor || '').toLowerCase())
      case 'preenchido': return v !== ''
      case 'vazio':      return v === ''
      default:           return true
    }
  }
  function campoVisivel(c, resp) {
    if (!c.cond || !Array.isArray(c.cond.regras) || !c.cond.regras.length) return true
    const oks = c.cond.regras.map(rg => regraOk(rg, resp))
    return c.cond.logica === 'OU' ? oks.some(Boolean) : oks.every(Boolean)
  }

  // Campo editável conforme o tipo (modo edição do admin).
  function editInput(c, val) {
    const v = val == null ? '' : String(val)
    const a = `data-campo="${esc(c.id)}"`
    if (c.tipo === 'selecao') {
      const ops = Array.isArray(c.opcoes) ? c.opcoes : []
      return `<select ${a}><option value=""></option>` + ops.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('') + `</select>`
    }
    if (c.tipo === 'hora')   return `<input type="time" ${a} value="${esc(v)}">`
    if (c.tipo === 'data')   return `<input type="date" ${a} value="${esc(v)}">`
    if (c.tipo === 'numero') return `<input type="number" ${a} value="${esc(v)}">`
    return `<input type="text" ${a} value="${esc(v)}">`
  }

  // Monta o corpo de UMA RAT (modal e PDF compartilham). edit=true torna campos editáveis.
  // opts.noHeader: omite o cabeçalho interno (a página desenha o seu próprio).
  function buildReportBody(d, edit, opts) {
    opts = opts || {}
    const { r, campos, mats, fotos, sigUrl } = d
    const resp = r.respostas || {}
    const SKIP = new Set(['foto', 'produtos', 'assinatura'])
    const baseNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null
    const tarefaNo = baseNo ? (baseNo + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : '')) : null

    let h = `<div class="rd">`
    if (!opts.noHeader) h += `
      <div class="rd-head">
        <div class="rd-cli">${esc(r.cliente_nome || '—')}</div>
        <div class="rd-sub">${esc(tipoNomeRat(r))}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}</div>
        <div class="rd-meta">
          <span><b>Técnico:</b> ${esc(r.tecnico_nome || '—')}</span>
          <span><b>Data:</b> ${fdt(r.data_tarefa, { withTime: true })}</span>
          <span><b>Status:</b> ${esc(statusInfo(r.status).label)}</span>
          <span><b>Tempo:</b> ${fmtMin(tempoRat(r))}</span>
        </div>
      </div>`

    if (edit) h += `<div class="rd-edit-hint">✎ Modo edição — você pode ajustar qualquer campo e o valor unitário dos produtos. O tempo é recalculado ao salvar.</div>`

    // Dados da OS
    const tf = r.tarefa || {}
    h += `<div class="rd-sec"><div class="rd-sec-t">Dados da OS</div><div class="rd-grid">
      <div class="rd-f"><label>Nº da OS</label><div class="v">${tarefaNo ? '#' + tarefaNo : '—'}</div></div>
      <div class="rd-f"><label>Data / Hora</label><div class="v">${fdt(r.data_tarefa, { withTime: true })}</div></div>
      <div class="rd-f"><label>Tipo de tarefa</label><div class="v">${esc(tipoNomeRat(r))}</div></div>
      <div class="rd-f"><label>Duração</label><div class="v">${fmtMin(tempoRat(r))}</div></div>
      ${(r.checkin_lat != null && r.checkin_lng != null) ? `<div class="rd-f"><label>Local (GPS)</label><div class="v"><a href="https://www.google.com/maps?q=${r.checkin_lat},${r.checkin_lng}" target="_blank" rel="noopener">📍 ver no mapa</a>${r.checkin_precisao ? ` <span class="dim">(±${Math.round(r.checkin_precisao)} m)</span>` : ''}</div></div>` : ''}
      ${tf.orientacao ? `<div class="rd-f" style="grid-column:1/-1"><label>Orientação</label><div class="v">${escMulti(tf.orientacao)}</div></div>` : ''}
    </div></div>`

    // Visita improdutiva: destaque do motivo + permanência (execução não aconteceu; tarefa segue aguardando).
    if (r.status === 'improdutiva' || r.atendimento_executado === false) {
      const hi = resp.hora_inicio, hf = resp.hora_termino
      const mi = minutosDe(hi), mf = minutosDe(hf)
      const pDur = (mi != null && mf != null && mf >= mi) ? (mf - mi) : null
      h += `<div class="rd-sec"><div class="rd-sec-t">Visita improdutiva</div><div class="rd-grid">
        <div class="rd-f" style="grid-column:1/-1"><label>Motivo de não ter executado</label><div class="v">${esc(motivoImprodutivaLabel(r))}</div></div>
        ${(hi && hf) ? `<div class="rd-f" style="grid-column:1/-1"><label>Tempo no local (início–término)</label><div class="v">${esc(hi)} – ${esc(hf)}${pDur != null ? ' · ' + fmtMin(pDur) : ''}</div></div>` : ''}
        <div class="rd-f" style="grid-column:1/-1"><div class="v dim">Deslocamento e tempo no local ficam registrados (faturáveis); a execução foi zerada e a tarefa continua aguardando reagendamento.</div></div>
      </div></div>`
    }

    // Passagem (handoff): técnico encerrou o dia e vai voltar depois pra terminar — o que falta / levar.
    if (resp.volta_amanha === 'Não' && resp.passagem_motivo === 'volto_depois') {
      h += `<div class="rd-sec"><div class="rd-sec-t">Passagem — volta depois pra terminar</div><div class="rd-grid">
        ${resp.passagem_falta ? `<div class="rd-f" style="grid-column:1/-1"><label>O que falta</label><div class="v">${escMulti(resp.passagem_falta)}</div></div>` : ''}
        ${resp.passagem_levar ? `<div class="rd-f" style="grid-column:1/-1"><label>O que levar</label><div class="v">${escMulti(resp.passagem_levar)}</div></div>` : ''}
      </div></div>`
    }

    // Intervalos (almoço/pausa) saem da grade no modo leitura — viram a tabela "Pausas".
    const EXC_GRID = new Set(['almoco', 'almoco_inicio', 'almoco_termino', 'pausa', 'pausa_inicio', 'pausa_termino', 'pausa_motivo'])
    const grid = []
    const longSecs = []
    for (const c of campos) {
      if (SKIP.has(c.tipo)) continue
      if (!edit && EXC_GRID.has(c.id)) continue
      const isLong = c.tipo === 'texto_longo'
      const val = resp[c.id]
      const vazio = val == null || String(val).trim() === ''
      if (!campoVisivel(c, resp)) continue
      if (!edit && vazio) continue
      if (isLong) {
        longSecs.push(`<div class="rd-sec"><div class="rd-sec-t">${esc(c.label)}</div>` +
          (edit
            ? `<textarea class="rd-edit" data-campo="${esc(c.id)}" rows="5">${esc(String(val || ''))}</textarea>${typeof IA_BTN_HTML !== 'undefined' ? IA_BTN_HTML : ''}`
            : `<div class="rd-long">${escMulti(val) || '—'}</div>`) + `</div>`)
      } else {
        grid.push(`<div class="rd-f"><label>${esc(c.label)}</label>` +
          (edit ? editInput(c, val) : `<div class="v">${escMulti(val) || '—'}</div>`) + `</div>`)
      }
    }
    if (grid.length) h += `<div class="rd-sec"><div class="rd-sec-t">RAT — dados do atendimento</div><div class="rd-grid">${grid.join('')}</div></div>`
    h += longSecs.join('')

    // Produtos com preço (editável no modo edição) + Resumo de Valores
    if (mats && mats.length) {
      const total = mats.reduce((s, m) => s + (Number(m.subtotal) || 0), 0)
      h += `<div class="rd-sec"><div class="rd-sec-t">Produtos</div>
        <table class="rd-prodtbl"><thead><tr><th>Produto</th><th class="num">Qtd</th><th class="num">Valor unit.</th><th class="num">Subtotal</th></tr></thead><tbody>` +
        mats.map(m => `<tr>
          <td>${esc(m.descricao || m.codigo || '—')}</td>
          <td class="num">${esc(String(m.quantidade))}</td>
          <td class="num">${edit ? `<input class="rd-preco" data-mat="${esc(m.id)}" type="number" step="0.01" min="0" value="${m.preco}">` : money(m.preco)}</td>
          <td class="num">${money(m.subtotal)}</td>
        </tr>`).join('') +
        `</tbody></table><div class="rd-total">Total <b>${money(total)}</b></div></div>`
    }

    // Pausas (almoço + pausa) — tabela no modo leitura.
    if (!edit) {
      const pausas = []
      if (resp.almoco === 'Sim' && (resp.almoco_inicio || resp.almoco_termino)) pausas.push({ ini: resp.almoco_inicio, fim: resp.almoco_termino, motivo: 'Almoço' })
      if (resp.pausa === 'Sim' && (resp.pausa_inicio || resp.pausa_termino || resp.pausa_motivo)) pausas.push({ ini: resp.pausa_inicio, fim: resp.pausa_termino, motivo: resp.pausa_motivo || 'Pausa' })
      if (pausas.length) {
        const durStr = (a, b) => { const x = minutosDe(a), y = minutosDe(b); if (x == null || y == null) return '—'; let d = y - x; if (d < 0) d += 1440; return fmtMin(d) }
        h += `<div class="rd-sec"><div class="rd-sec-t">Pausas na tarefa</div>
          <table class="rd-pausas"><thead><tr><th>Início</th><th>Fim</th><th>Tempo</th><th>Justificativa/Motivo</th></tr></thead><tbody>` +
          pausas.map(p => `<tr><td>${esc(p.ini || '—')}</td><td>${esc(p.fim || '—')}</td><td>${durStr(p.ini, p.fim)}</td><td>${esc(p.motivo)}</td></tr>`).join('') +
          `</tbody></table></div>`
      }
    }

    if (fotos && fotos.length) {
      h += `<div class="rd-sec"><div class="rd-sec-t">Fotos</div><div class="det-fotos">` +
        fotos.map(f => `<figure class="det-foto"><a href="${f.url}" target="_blank"><img src="${f.url}" alt=""></a>${f.legenda ? `<figcaption>${esc(f.legenda)}</figcaption>` : ''}</figure>`).join('') + `</div></div>`
    }
    if (sigUrl) h += `<div class="rd-sec"><div class="rd-sec-t">Assinatura</div><img class="det-sig" src="${sigUrl}" alt=""></div>`
    h += `</div>`
    return h
  }

  // Carrega tudo de uma RAT (form, materiais usados c/ preço, fotos e assinatura assinadas).
  async function loadDetalhe(r) {
    await ensureForms()
    const sb = getSupabase()
    const campos = forms[r.formulario_id] || []
    const { data: matsRaw } = await sb.from('materiais')
      .select('id,produto_id,codigo_produto,descricao,quantidade,preco_unitario').eq('rat_id', r.id).eq('origem', 'usado')
    const pids = [...new Set((matsRaw || []).map(m => m.produto_id).filter(Boolean))]
    const precoCat = {}
    if (pids.length) {
      const { data: ps } = await sb.from('produtos').select('id,preco_venda').in('id', pids)
      ; (ps || []).forEach(p => { precoCat[p.id] = Number(p.preco_venda) || 0 })
    }
    const mats = (matsRaw || []).map(m => {
      const preco = m.preco_unitario != null ? Number(m.preco_unitario) : (m.produto_id ? (precoCat[m.produto_id] || 0) : 0)
      const qtd = Number(m.quantidade) || 0
      return { id: m.id, descricao: m.descricao, codigo: m.codigo_produto, quantidade: qtd, preco, subtotal: qtd * preco }
    })
    const { data: fotosRaw } = await sb.from('relatorio_fotos').select('url,legenda').eq('rat_id', r.id)
    const comUrl = (fotosRaw || []).filter(f => f.url)
    let fotos = []
    if (comUrl.length) {
      const legPorPath = {}; comUrl.forEach(f => { legPorPath[f.url] = f.legenda })
      const { data: signed } = await sb.storage.from('rat-anexos').createSignedUrls(comUrl.map(f => f.url), 3600)
      fotos = (signed || []).filter(s => s.signedUrl).map(s => ({ url: s.signedUrl, legenda: legPorPath[s.path] || '' }))
    }
    let sigUrl = null
    if (r.assinatura_url) {
      const { data: sg } = await sb.storage.from('rat-anexos').createSignedUrl(r.assinatura_url, 3600)
      sigUrl = (sg && sg.signedUrl) || null
    }
    return { r, campos, mats: mats || [], fotos, sigUrl }
  }

  // Coleta as respostas e os preços editados do container e devolve {respostas, tempo, precos}.
  function coletarEdicao(container, det) {
    const resp = Object.assign({}, det.r.respostas || {})
    container.querySelectorAll('[data-campo]').forEach(el => { resp[el.getAttribute('data-campo')] = el.value })
    const precos = []
    container.querySelectorAll('[data-mat]').forEach(el => { precos.push({ id: el.getAttribute('data-mat'), preco: el.value === '' ? null : Number(el.value) }) })
    return { respostas: resp, tempo: calcTempoDe(resp), precos }
  }

  // Persiste os preços editados dos produtos (materiais.preco_unitario).
  async function salvarPrecos(precos) {
    if (!precos || !precos.length) return
    const sb = getSupabase()
    for (const p of precos) await sb.from('materiais').update({ preco_unitario: p.preco }).eq('id', p.id)
  }

  // Reduz/comprime uma imagem (foto/assinatura) para o PDF não ficar pesado.
  // Redimensiona p/ no máx maxPx no maior lado e recomprime em JPEG.
  function shrinkImg(url, maxPx, q) {
    return new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
          const scale = Math.min(1, maxPx / Math.max(w, h))
          w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale))
          const c = document.createElement('canvas'); c.width = w; c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(c.toDataURL('image/jpeg', q))
        } catch (e) { resolve(url) }   // CORS/canvas "tainted" → mantém original
      }
      img.onerror = () => resolve(url)
      img.src = url
    })
  }

  // PDF: 1 ou várias RATs no mesmo documento (para envio manual ao cliente).
  // Abre a janela já (gesto do usuário), comprime as imagens e então escreve o doc.
  // modo: 'print' (padrão — abre o diálogo de impressão) | 'download' (baixa o .pdf;
  //        usa html2pdf por folha A4 já paginada, com fallback pro diálogo de impressão).
  async function gerarPdf(dets, titulo, capaHTML, modo) {
    const win = window.open('', '_blank')
    if (!win) { try { toast('Permita pop-ups para gerar o PDF.', 'err') } catch (e) {} return }
    try { win.document.write('<!doctype html><meta charset="utf-8"><body style="font-family:Inter,Arial,sans-serif;color:#1B2A4A;padding:28px">Gerando PDF…</body>') } catch (e) {}

    // Versão dos dets com imagens reduzidas (fotos ~1100px / assinatura ~700px).
    const pdets = []
    for (const d of dets) {
      const fotos = []
      for (const f of (d.fotos || [])) fotos.push(Object.assign({}, f, { url: await shrinkImg(f.url, 1100, 0.72) }))
      const sigUrl = d.sigUrl ? await shrinkImg(d.sigUrl, 700, 0.85) : null
      pdets.push(Object.assign({}, d, { fotos, sigUrl }))
    }

    const capa = capaHTML ? `<div class="rd">${capaHTML}</div>` : ''
    const bodies = capa + pdets.map(d => buildReportBody(d, false)).join('')
    const HEADER = `<div class="pdf-top"><div class="pdf-brand">TRADERS SERVICE</div><div class="pdf-doc">Relatório de Atendimento Técnico</div></div>`
    const HEADERC = `<div class="pdf-topc"><span>TRADERS SERVICE</span><span>Relatório de Atendimento Técnico</span></div>`
    const FOOTER = `<div class="pdf-foot"><span>Documento gerado pela plataforma Service Report.</span><span class="pg"></span></div>`
    const doc = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo || 'RAT')}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>${PDF_CSS}${SHEET_CSS}</style></head><body>
  <div id="raw">${bodies}</div>
  <div id="sheets"></div>
  <script>
    var HEADER=${JSON.stringify(HEADER)},HEADERC=${JSON.stringify(HEADERC)},FOOTER=${JSON.stringify(FOOTER)};
    var MODO=${JSON.stringify(modo === 'download' ? 'download' : 'print')};
    var FN=${JSON.stringify(String(titulo || 'documento').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf')};
    // download de verdade: html2pdf renderiza cada folha A4 já paginada; se o CDN
    // falhar, cai no diálogo de impressão (dá pra salvar como PDF por lá)
    function baixarPdf(){
      document.title='Gerando o arquivo PDF…';
      var st=document.createElement('style');st.textContent='.sheet{page-break-after:always;break-after:page}';document.head.appendChild(st);
      var sc=document.createElement('script');
      sc.src='https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      sc.onload=function(){
        html2pdf().set({filename:FN,margin:0,image:{type:'jpeg',quality:0.92},
          html2canvas:{scale:2,useCORS:true,letterRendering:true},
          jsPDF:{unit:'mm',format:'a4',orientation:'portrait'},
          pagebreak:{mode:['css','legacy']}})
          .from(document.getElementById('sheets')).save()
          .then(function(){document.title='PDF baixado — pode fechar esta aba';})
          .catch(function(){window.focus();window.print();});
      };
      sc.onerror=function(){window.focus();window.print();};
      document.head.appendChild(sc);
    }
    function el(t,c){var e=document.createElement(t);if(c)e.className=c;return e}
    var raw=document.getElementById('raw'),sheets=document.getElementById('sheets'),cur=null,ftrs=[],blocks=[];
    var rds=raw.querySelectorAll('.rd');for(var ri=0;ri<rds.length;ri++){var ch=rds[ri].children;for(var i=0;i<ch.length;i++){blocks.push({h:ch[i].outerHTML,brk:(ri>0&&i===0)});}}
    function newSheet(){var first=ftrs.length===0;var s=el('div','sheet');var hd=el('div','hd');hd.innerHTML=first?HEADER:HEADERC;var bd=el('div','bd');var ft=el('div','ft');ft.innerHTML=FOOTER;s.appendChild(hd);s.appendChild(bd);s.appendChild(ft);sheets.appendChild(s);ftrs.push(ft);cur={bd:bd};}
    function over(){return cur.bd.scrollHeight>cur.bd.clientHeight+1;}
    function addHTML(h){var d=el('div');d.innerHTML=h;var n=d.firstElementChild;if(!n)return;cur.bd.appendChild(n);if(over()&&cur.bd.children.length>1){cur.bd.removeChild(n);newSheet();cur.bd.appendChild(n);}}
    function build(){newSheet();for(var i=0;i<blocks.length;i++){if(blocks[i].brk)newSheet();addHTML(blocks[i].h);}if(raw.parentNode)raw.parentNode.removeChild(raw);var N=ftrs.length;for(var k=0;k<N;k++){var pg=ftrs[k].querySelector('.pg');if(pg)pg.textContent='Página '+(k+1)+' de '+N;}var imgs=Array.prototype.slice.call(document.images);var left=imgs.filter(function(im){return !im.complete});function go(){if(MODO==='download'){baixarPdf();}else{window.focus();window.print();}}if(!left.length){setTimeout(go,200);return;}var done=0,fired=false;function one(){done++;if(done>=left.length&&!fired){fired=true;setTimeout(go,150);}}left.forEach(function(im){im.addEventListener('load',one);im.addEventListener('error',one);});setTimeout(function(){if(!fired){fired=true;go();}},7000);}
    if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){setTimeout(build,80);});}else{setTimeout(build,400);}
  <\/script>
</body></html>`
    win.document.open(); win.document.write(doc); win.document.close()
  }

  const PDF_CSS = `
    *{box-sizing:border-box}
    body{font-family:Inter,Arial,sans-serif;color:#1B2A4A;margin:12px 14px;font-size:12.5px}
    /* tabela-envelope: cabeçalho/rodapé repetem em todas as páginas (print) */
    .pdf-sheet{width:100%;border-collapse:collapse}
    .pdf-sheet>thead{display:table-header-group}
    .pdf-sheet>tfoot{display:table-footer-group}
    .pdf-sheet>thead>tr>td,.pdf-sheet>tfoot>tr>td,.pdf-sheet>tbody>tr>td{padding:0;border:0;vertical-align:top}
    .pdf-top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #243456;padding-bottom:10px;margin-bottom:16px}
    .pdf-brand{font-size:20px;font-weight:800;letter-spacing:.04em;color:#243456}
    .pdf-doc{font-size:12px;color:#7C8290;font-weight:600;text-transform:none;letter-spacing:normal}
    .rat-sep{font-size:11px;font-weight:700;text-transform:none;letter-spacing:normal;color:#9aa7bd;margin:0 0 8px}
    .rd-head{margin-bottom:6px}
    .rd-cli{font-size:18px;font-weight:700;color:#243456}
    .rd-sub{font-size:13px;color:#1E8AE0;font-weight:600;margin-top:2px}
    .rd-meta{display:flex;flex-wrap:wrap;gap:3px 18px;margin-top:7px;font-size:12px}
    .rd-meta b{color:#5b6b86;font-weight:500}
    .rd-edit-hint{display:none}
    .rd-sec{margin-top:16px;page-break-inside:avoid}
    .rd-sec-t{font-size:12px;font-weight:700;text-transform:none;letter-spacing:normal;color:#243456;border-bottom:1px solid #EAEDF2;padding-bottom:5px;margin-bottom:9px}
    .rd-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .rd-f{background:#f7f9fc;border:1px solid #EAEDF2;border-radius:7px;padding:7px 10px}
    .rd-f label{display:block;font-size:10.5px;text-transform:none;letter-spacing:normal;color:#7C8290;margin-bottom:2px}
    .rd-f .v{font-size:12.5px}
    .rd-long{white-space:pre-wrap;line-height:1.5}
    .rd-emit{font-size:12px;line-height:1.5}
    .rd-prodtbl{width:100%;border-collapse:collapse;font-size:12px}
    .rd-prodtbl th{text-align:left;font-size:10.5px;text-transform:none;letter-spacing:normal;color:#7C8290;padding:0 8px 6px;border-bottom:1px solid #EAEDF2}
    .rd-prodtbl th.num,.rd-prodtbl td.num{text-align:right;white-space:nowrap}
    .rd-prodtbl td{padding:6px 8px;border-bottom:1px solid #eef2f8}
    .rd-total{display:flex;justify-content:flex-end;gap:12px;margin-top:9px;font-size:13px}
    .rd-pausas{width:100%;border-collapse:collapse;font-size:12px}
    .rd-pausas th{text-align:left;font-size:10.5px;text-transform:none;letter-spacing:normal;color:#7C8290;padding:0 8px 6px;border-bottom:1px solid #EAEDF2}
    .rd-pausas td{padding:6px 8px;border-bottom:1px solid #eef2f8}
    .det-fotos{display:flex;flex-wrap:wrap;gap:12px}
    .det-foto{display:flex;flex-direction:column;gap:4px;width:150px;margin:0}
    .det-fotos img{width:150px;height:150px;object-fit:cover;border-radius:8px;border:1px solid #d6deea}
    .det-foto figcaption{font-size:10px;color:#5b6b86;line-height:1.2}
    .det-sig{max-width:280px;border:1px solid #d6deea;border-radius:8px;background:#fff}
    .pdf-foot{margin-top:14px;border-top:1px solid #d6deea;padding-top:8px;font-size:10px;color:#9aa7bd;text-align:center}
    @media print{ a{color:inherit;text-decoration:none} }`

  // Layout paginado em folhas A4 (cabeçalho/rodapé por página, via JS).
  const SHEET_CSS = `
    body{margin:0;background:#eceff3}
    #raw{position:absolute;left:-99999px;top:0;width:726px}
    .sheet{width:794px;height:1123px;margin:16px auto;background:#fff;padding:32px 34px;display:flex;flex-direction:column;box-shadow:0 10px 30px rgba(20,30,55,.12);overflow:hidden}
    .sheet .hd{flex:none}
    .sheet .bd{flex:1 1 auto;min-height:0;overflow:hidden}
    .sheet .ft{flex:none}
    .pdf-top{margin-bottom:14px}
    .pdf-topc{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #243456;padding-bottom:8px;margin-bottom:14px;font-size:11px;font-weight:700;color:#243456;text-transform:none;letter-spacing:normal}
    .pdf-foot{display:flex;justify-content:space-between;align-items:center;text-align:left}
    @media print{ @page{size:A4;margin:0} body{margin:0;background:#fff} .sheet{box-shadow:none;margin:0;width:210mm;height:297mm;page-break-after:always} .sheet:last-child{page-break-after:auto} #raw{display:none} }`

  return {
    RAT_SELECT, ensureForms, loadDetalhe, buildReportBody, coletarEdicao, salvarPrecos,
    gerarPdf, calcTempoDe, tempoRat, fmtMin, tipoNomeRat, statusInfo,
  }
})()
