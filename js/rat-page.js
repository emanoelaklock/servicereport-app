/* ═══════════════════════════════════════════════
   Service Report — rat-page.js
   Página dedicada de UMA RAT (rat.html?id=<id>), com link próprio.
   Reutiliza window.RatView (render/edição/PDF). Office-only.
═══════════════════════════════════════════════ */
const RatPage = (() => {
  const sb = () => getSupabase()
  let user = { id: null }
  let det = null
  let editMode = false
  let tipos = []
  let ratId = null
  let usuarios = []          // técnicos do SR (p/ adicionar à RAT)
  let ratTecs = []           // participantes atuais (rat_tecnicos) — set de trabalho na edição
  let ratTecsOrig = []       // técnicos originais (do banco) — base do diff
  let prodDel = new Set()    // ids de materiais marcados p/ remover
  let prodAdd = []           // produtos adicionados no editor { uid, produto_id, codigo, descricao, quantidade, preco }
  let fotoDel = new Set()    // ids de fotos marcadas p/ remover
  let fotoAdd = []           // fotos adicionadas { uid, path, legenda } (já subidas no storage)
  let histLista = []         // rat_edicoes carregadas
  let pendentes = []         // alterações aguardando o motivo
  let buscaT = null
  let souAdmin = false       // só admin edita (gestor vê o histórico, não edita)
  const MOT_LABEL = { esquecimento_tecnico: 'Esquecimento do técnico', completacao: 'Completação', mudanca_processo: 'Mudança de processo', pedido_cliente: 'Pedido do cliente', outro: 'Outro' }

  // Carrega auxiliares da edição (usuários p/ técnicos + participantes atuais).
  async function carregarAux() {
    try { const { data } = await sb().rpc('sr_usuarios'); usuarios = (data || []).filter(u => u.ativo) } catch (e) { usuarios = [] }
    try { const { data } = await sb().from('rat_tecnicos').select('tecnico_id,inicio,fim').eq('rat_id', ratId); ratTecs = data || []; ratTecsOrig = (data || []).map(x => ({ ...x })) } catch (e) { ratTecs = []; ratTecsOrig = [] }
    souAdmin = ((usuarios.find(u => u.id === user.id) || {}).role) === 'admin'
  }
  const nomeTec = (id) => { const u = usuarios.find(x => x.id === id); return u ? u.nome : (id || '—') }
  // Avatar com foto do Portal (componente padrão); iniciais como fallback.
  const avTec = (u) => { const f = (typeof avatarUrl === 'function') ? avatarUrl(u && u.foto_url) : ''; return f ? `<img src="${esc(f)}" alt="">` : esc(String((u && u.nome) || '—').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase()) }

  async function init() {
    ratId = new URLSearchParams(location.search).get('id')
    const body = document.getElementById('rp-body')
    if (!ratId) { body.innerHTML = '<p class="rp-msg">RAT não informada.</p>'; barra(false); return }
    const { data: { user: u } } = await sb().auth.getUser()
    user.id = u ? u.id : null

    const { data, error } = await sb().from('rats').select(RatView.RAT_SELECT).eq('id', ratId).single()
    if (error || !data) { body.innerHTML = '<p class="rp-msg">RAT não encontrada (ou sem permissão).</p>'; barra(false); return }
    det = await RatView.loadDetalhe(data)

    const tarefaNo = det.r.tarefa && det.r.tarefa.numero != null ? String(det.r.tarefa.numero).padStart(5, '0') : null
    document.title = `RAT ${det.r.cliente_nome || ''}${tarefaNo ? ' · ' + tarefaNo : ''}`.trim()
    document.getElementById('rp-title').textContent = `${det.r.cliente_nome || 'RAT'}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}`

    await carregarAux()
    bind()
    renderHero()
    render()
    carregarHistorico()
  }

  // Re-carrega tudo após uma edição/restauração (mantém na tela).
  async function recarregar() {
    const { data } = await sb().from('rats').select(RatView.RAT_SELECT).eq('id', ratId).single()
    if (data) det = await RatView.loadDetalhe(data)
    await carregarAux()
    prodDel = new Set(); prodAdd = []; fotoDel = new Set(); fotoAdd = []
    renderHero(); render(); carregarHistorico()
  }

  // RAT "em andamento" de um dia anterior = o técnico não encerrou (não é travamento).
  function diasNaoEncerrada(r) {
    if (r.status !== 'em_andamento') return 0
    const s = (r.respostas && r.respostas.data) || r.data_tarefa || r.criado_em
    if (!s) return 0
    const d = new Date(String(s).length <= 10 ? s + 'T00:00:00' : s); if (isNaN(d)) return 0
    const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const ho = new Date(); const h0 = new Date(ho.getFullYear(), ho.getMonth(), ho.getDate())
    return dia < h0 ? Math.round((h0 - dia) / 86400000) : 0
  }

  function renderHero() {
    const r = det.r
    const tarefaNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null
    const st = RatView.statusInfo(r.status)
    const diasNE = diasNaoEncerrada(r)
    const stBadge = diasNE
      ? `<span class="rp-pill" style="background:#FEF3DA;color:#92670A" title="O técnico iniciou o atendimento e não encerrou">Não encerrada · há ${diasNE} ${diasNE === 1 ? 'dia' : 'dias'}</span>`
      : `<span class="rp-pill ${st.cls}">${esc(st.label)}</span>`
    document.getElementById('rp-hero').innerHTML = `
      <div class="rp-cli">${esc(r.cliente_nome || '—')}</div>
      <div class="rp-sub">${esc(RatView.tipoNomeRat(r))}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}</div>
      <div class="rp-chips">
        <span class="rp-chip"><i>Técnico</i>${esc(r.tecnico_nome || '—')}</span>
        <span class="rp-chip"><i>Data</i>${fdt(r.data_tarefa, { numeric: true })}</span>
        <span class="rp-chip"><i>Tempo trabalhado</i>${RatView.fmtMin(RatView.tempoRat(r))}</span>
        ${stBadge}
        ${r.ajustada_gestao ? '<span class="rp-pill" style="background:#FBE3EE;color:#A82A66" title="Esta RAT foi ajustada pela gestão (ver histórico)">Ajustada pela gestão</span>' : ''}
      </div>`
  }

  function barra(show) { document.getElementById('rp-actions').style.display = show ? '' : 'none' }

  function bind() {
    document.getElementById('rp-editar').onclick = () => { editMode = true; prodDel = new Set(); prodAdd = []; fotoDel = new Set(); fotoAdd = []; render() }
    document.getElementById('rp-cancelar').onclick = async () => { editMode = false; await carregarAux(); prodDel = new Set(); prodAdd = []; fotoDel = new Set(); fotoAdd = []; render() }
    document.getElementById('rp-salvar').onclick = salvar
    document.getElementById('mot-x').onclick = fecharMotivo
    document.getElementById('mot-cancelar').onclick = fecharMotivo
    document.getElementById('rp-pdf').onclick = () => {
      const t = det.r.tarefa && det.r.tarefa.numero != null ? String(det.r.tarefa.numero).padStart(5, '0') : ''
      RatView.gerarPdf([det], `RAT ${det.r.cliente_nome || ''} ${t}`.trim())
    }
    document.getElementById('rp-excluir').onclick = excluir
    document.getElementById('rp-encerrar').onclick = encerrar
    document.getElementById('rp-nova').onclick = abrirPend
    document.getElementById('pend-x').onclick = fecharPend
    document.getElementById('pend-cancelar').onclick = fecharPend
    document.getElementById('pend-criar').onclick = criarPend
    document.getElementById('btn-voltar').onclick = () => { if (history.length > 1) history.back(); else window.close() }
  }

  function render() {
    const corpo = RatView.buildReportBody(det, editMode, { noHeader: true, adminEdit: editMode })
    document.getElementById('rp-body').innerHTML = (editMode ? tecnicosEditorHTML() : '') + corpo
    if (editMode) { bindTecEditor(); bindProdEditor(); bindFotoEditor(); bindEditExtras() }
    const show = (id, v) => { document.getElementById(id).style.display = v ? '' : 'none' }
    show('rp-editar', !editMode && souAdmin)
    show('rp-salvar', editMode)
    show('rp-cancelar', editMode)
    show('rp-nova', !editMode)
    show('rp-pdf', !editMode)
    show('rp-excluir', !editMode)
    // RAT presa "em andamento" (técnico não encerrou): o admin pode concluir e destravar a tarefa
    show('rp-encerrar', !editMode && det.r.status === 'em_andamento')
  }

  // Encerra (conclui) uma RAT que ficou "em andamento" — o técnico esqueceu de fechar o
  // atendimento, então a tarefa não progride. RLS: tarefas_admin_all permite o update.
  async function encerrar() {
    const r = det.r
    if (!confirm('Encerrar esta RAT em andamento e marcá-la como Atendimento Realizado (fecha o dia)?\n\nSe precisar acertar os horários/tempo, use "Editar" antes. Encerrar a RAT não conclui o serviço — isso é feito na Tarefa.')) return
    const upd = { status: 'registrado' }
    const tm = RatView.tempoRat(r)            // recalcula o tempo se já houver início e término
    if (tm != null) upd.tempo_trabalhado = tm
    const { error } = await sb().from('rats').update(upd).eq('id', r.id)
    if (error) return toast('Erro ao encerrar: ' + error.message, 'err')
    det.r.status = 'registrado'; if (tm != null) det.r.tempo_trabalhado = tm
    renderHero(); render()
    toast('Atendimento realizado (dia encerrado).', 'ok')
  }

  // ── Editor de TÉCNICOS (participantes) — só re-renderiza sua própria seção ──
  function tecEditorInner() {
    const atuais = ratTecs.map(t => usuarios.find(u => u.id === t.tecnico_id) || { id: t.tecnico_id, nome: nomeTec(t.tecnico_id) })
    const disp = usuarios.filter(u => u.role === 'tecnico_campo' && !ratTecs.some(t => t.tecnico_id === u.id)).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
    return `<div class="rd-sec-t">Técnicos responsáveis</div>
      <div class="rp-tecs">${atuais.length
        ? atuais.map(u => `<span class="rp-tec"><span class="rp-av">${avTec(u)}</span><span class="rp-tnm">${esc(u.nome)}</span><button type="button" class="rp-tecx" data-tecdel="${esc(u.id)}" title="Remover">×</button></span>`).join('')
        : '<span class="dim">Nenhum técnico — adicione abaixo.</span>'}</div>
      ${disp.length ? `<div class="rp-pick-l">Adicionar técnico:</div><div class="rp-tecpick">${disp.map(u => `<button type="button" class="rp-tecopt" data-tecadd="${esc(u.id)}"><span class="rp-av">${avTec(u)}</span><span class="rp-tnm">${esc(u.nome)}</span></button>`).join('')}</div>` : ''}`
  }
  function tecnicosEditorHTML() { return `<div class="rd-sec" id="rp-tecedit">${tecEditorInner()}</div>` }
  function bindTecEditor() {
    const wrap = document.getElementById('rp-tecedit'); if (!wrap) return
    const redo = () => { wrap.innerHTML = tecEditorInner(); bindTecEditor() }
    wrap.querySelectorAll('[data-tecdel]').forEach(b => b.onclick = () => { ratTecs = ratTecs.filter(t => t.tecnico_id !== b.dataset.tecdel); redo() })
    wrap.querySelectorAll('[data-tecadd]').forEach(b => b.onclick = () => { const id = b.dataset.tecadd; if (id && !ratTecs.some(t => t.tecnico_id === id)) { ratTecs.push({ tecnico_id: id, inicio: null, fim: null }); redo() } })
  }

  // ── Auto-ajuste das textareas + condicionais ao vivo (almoço/pausa/deslocamento → Sim) ──
  function bindEditExtras() {
    const body = document.getElementById('rp-body')
    const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px' }
    body.querySelectorAll('textarea.rd-edit').forEach(ta => { grow(ta); ta.addEventListener('input', () => grow(ta)) })
    const reapply = (clear) => {
      RatView.aplicarCondicionais(body, det.campos)
      if (clear) body.querySelectorAll('[data-cwrap]').forEach(w => { if (w.style.display === 'none') { const inp = w.querySelector('[data-campo]'); if (inp && inp.value) inp.value = '' } })
    }
    body.querySelectorAll('select[data-campo]').forEach(s => s.addEventListener('change', () => reapply(true)))
    reapply(false)
  }

  // ── Editor de PRODUTOS (qty/remover/adicionar) ──
  function bindProdEditor() {
    const body = document.getElementById('rp-body')
    body.querySelectorAll('[data-matdel]').forEach(b => b.onclick = () => {
      const id = b.dataset.matdel, tr = body.querySelector(`[data-matrow="${id}"]`)
      if (prodDel.has(id)) { prodDel.delete(id); if (tr) tr.style.opacity = '' }
      else { prodDel.add(id); if (tr) tr.style.opacity = '.4' }
    })
    body.querySelectorAll('[data-newdel]').forEach(b => b.onclick = () => { prodAdd = prodAdd.filter(p => p.uid !== b.dataset.newdel); const tr = body.querySelector(`[data-newrow="${b.dataset.newdel}"]`); if (tr) tr.remove() })
    const busca = document.getElementById('rd-prodbusca'), res = document.getElementById('rd-prodres')
    if (busca && res) busca.oninput = () => {
      clearTimeout(buscaT); const q = busca.value.trim()
      if (q.length < 2) { res.hidden = true; return }
      buscaT = setTimeout(async () => {
        const { data } = await sb().from('produtos').select('id,codigo,descricao,preco_venda').or(`codigo.ilike.%${q}%,descricao.ilike.%${q}%`).limit(20)
        const list = data || []
        res.innerHTML = list.length ? list.map(p => `<div class="rd-prodopt" data-pid="${esc(p.id)}">${esc(p.codigo || '')} · ${esc(p.descricao || '')}</div>`).join('') : '<div class="rd-prodopt dim">Nada encontrado</div>'
        res.hidden = false
        res.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => { const p = list.find(x => x.id === el.dataset.pid); if (p) addProduto(p); res.hidden = true; busca.value = '' })
      }, 250)
    }
  }
  function addProduto(p) {
    const uid = 'n' + Date.now() + '_' + prodAdd.length
    prodAdd.push({ uid, produto_id: p.id, codigo: p.codigo, descricao: p.descricao, preco: Number(p.preco_venda) || 0, quantidade: 1 })
    const tb = document.getElementById('rd-prodbody')
    if (tb) { tb.insertAdjacentHTML('beforeend', `<tr data-newrow="${esc(uid)}"><td>${esc(p.codigo || '')} · ${esc(p.descricao || '')}</td><td class="num"><input class="rd-qtd" data-newqtd="${esc(uid)}" type="number" step="any" min="0" value="1"></td><td class="num">${(Number(p.preco_venda) || 0).toFixed(2)}</td><td class="num">—</td><td class="num"><button type="button" class="rd-matdel" data-newdel="${esc(uid)}" title="Remover">×</button></td></tr>`); bindProdEditor() }
  }

  // ── Editor de FOTOS (adicionar via upload / remover / legenda) ──
  function bindFotoEditor() {
    const body = document.getElementById('rp-body')
    body.querySelectorAll('[data-fotodel]').forEach(b => b.onclick = () => {
      const id = b.dataset.fotodel, fig = body.querySelector(`[data-fotorow="${id}"]`)
      if (fotoDel.has(id)) { fotoDel.delete(id); if (fig) fig.style.opacity = '' } else { fotoDel.add(id); if (fig) fig.style.opacity = '.4' }
    })
    body.querySelectorAll('[data-newfotodel]').forEach(b => b.onclick = () => { fotoAdd = fotoAdd.filter(p => p.uid !== b.dataset.newfotodel); const fig = body.querySelector(`[data-fotonew="${b.dataset.newfotodel}"]`); if (fig) fig.remove() })
    const inp = document.getElementById('rd-fotoinput')
    if (inp) inp.onchange = async () => { for (const f of Array.from(inp.files)) await subirFoto(f); inp.value = '' }
  }
  async function subirFoto(file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `rats/${ratId}/adm-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`
    const { error } = await sb().storage.from('rat-anexos').upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' })
    if (error) return toast('Erro ao subir foto: ' + error.message, 'err')
    const uid = 'f' + Date.now() + '_' + fotoAdd.length
    fotoAdd.push({ uid, path, legenda: '' })
    const cont = document.getElementById('rd-fotos'); const prev = URL.createObjectURL(file)
    if (cont) cont.insertAdjacentHTML('beforeend', `<figure class="det-foto" data-fotonew="${esc(uid)}"><img src="${prev}" alt=""><button type="button" class="rd-fotodel" data-newfotodel="${esc(uid)}" title="Remover">×</button><input class="rd-fotonewleg" data-fotonewleg="${esc(uid)}" placeholder="legenda"></figure>`)
    bindFotoEditor()
  }

  // ── Salvar: monta o diff, pede o MOTIVO e envia pela Edge Function rat-editar ──
  function salvar() {
    const alt = coletarAlteracoes()
    if (!alt.length) { toast('Nada foi alterado.', 'info'); return }
    abrirMotivo(alt)
  }
  function coletarAlteracoes() {
    const cont = document.getElementById('rp-body'), alt = []
    const { respostas } = RatView.coletarEdicao(cont, det), orig = det.r.respostas || {}
    for (const k of Object.keys(respostas)) {
      if (String(respostas[k] ?? '') !== String(orig[k] ?? '')) alt.push({ alvo: 'campo', operacao: 'update', campo: k, valor_novo: respostas[k] })
    }
    for (const m of (det.mats || [])) {
      if (prodDel.has(m.id)) { alt.push({ alvo: 'produto', operacao: 'delete', chave: m.id }); continue }
      const qEl = cont.querySelector(`[data-matqtd="${m.id}"]`), pEl = cont.querySelector(`[data-mat="${m.id}"]`)
      const v = {}
      if (qEl && Number(qEl.value) !== Number(m.quantidade)) v.quantidade = Number(qEl.value)
      if (pEl && pEl.value !== '' && Number(pEl.value) !== Number(m.preco)) v.preco_unitario = Number(pEl.value)
      if (Object.keys(v).length) alt.push({ alvo: 'produto', operacao: 'update', chave: m.id, valor_novo: v })
    }
    for (const p of prodAdd) {
      const qEl = document.querySelector(`[data-newqtd="${p.uid}"]`)
      alt.push({ alvo: 'produto', operacao: 'insert', valor_novo: { produto_id: p.produto_id || null, codigo_produto: p.codigo || null, descricao: p.descricao, quantidade: qEl ? Number(qEl.value) : (Number(p.quantidade) || 0), preco_unitario: p.preco ?? null } })
    }
    const orT = new Set(ratTecsOrig.map(x => x.tecnico_id)), atT = new Set(ratTecs.map(x => x.tecnico_id))
    for (const id of atT) if (!orT.has(id)) alt.push({ alvo: 'tecnico', operacao: 'insert', chave: id })
    for (const id of orT) if (!atT.has(id)) alt.push({ alvo: 'tecnico', operacao: 'delete', chave: id })
    // fotos existentes: remover ou mudar legenda
    for (const f of (det.fotos || [])) {
      if (!f.id) continue
      if (fotoDel.has(f.id)) { alt.push({ alvo: 'foto', operacao: 'delete', chave: f.id }); continue }
      const lEl = cont.querySelector(`[data-fotoleg="${f.id}"]`)
      if (lEl && (lEl.value || '') !== (f.legenda || '')) alt.push({ alvo: 'foto', operacao: 'update', chave: f.id, valor_novo: { legenda: lEl.value } })
    }
    // fotos adicionadas (já subidas no storage; manda o path + legenda)
    for (const p of fotoAdd) {
      const lEl = cont.querySelector(`[data-fotonewleg="${p.uid}"]`)
      alt.push({ alvo: 'foto', operacao: 'insert', valor_novo: { url: p.path, legenda: lEl ? lEl.value : '' } })
    }
    return alt
  }
  function abrirMotivo(alt) {
    pendentes = alt
    document.getElementById('mot-resumo').textContent = `${alt.length} alteração(ões) nesta RAT.`
    document.getElementById('mot-sel').value = ''
    document.getElementById('modal-motivo').classList.add('open')
    document.getElementById('mot-confirmar').onclick = async () => {
      const motivo = document.getElementById('mot-sel').value
      if (!motivo) return toast('Escolha o motivo do ajuste.', 'err')
      fecharMotivo()
      await chamarEditar({ rat_id: ratId, motivo, alteracoes: pendentes })
    }
  }
  function fecharMotivo() { document.getElementById('modal-motivo').classList.remove('open') }
  async function chamarEditar(payload) {
    const { data, error } = await sb().functions.invoke('rat-editar', { body: payload })
    let msg = null
    if (error) { msg = error.message; try { if (error.context) { const j = await error.context.json(); if (j?.error) msg = j.error } } catch (e) {} }
    else if (data && data.error) msg = data.error
    if (msg) return toast('Não foi possível salvar: ' + msg, 'err')
    toast('RAT atualizada.', 'ok')
    editMode = false
    await recarregar()
  }

  // ── Histórico de edições + Restaurar ──
  async function carregarHistorico() {
    const box = document.getElementById('rp-hist'); if (!box) return
    const { data } = await sb().from('rat_edicoes').select('*').eq('rat_id', ratId).order('em', { ascending: false }).limit(100)
    histLista = data || []
    if (!histLista.length) { box.innerHTML = ''; return }
    const alvoTxt = (e) => { const op = ({ insert: 'adicionou', delete: 'removeu', update: 'alterou', restore: 'restaurou' })[e.operacao] || e.operacao; const al = ({ campo: 'campo ' + (e.campo || ''), tecnico: 'técnico', produto: 'produto', foto: 'foto' })[e.alvo] || e.alvo; return op + ' ' + al }
    const detVal = (e) => e.alvo === 'campo' ? ` · "${esc(String(e.valor_antigo ?? ''))}" → "${esc(String(e.valor_novo ?? ''))}"` : ''
    box.innerHTML = `<div class="rd-sec"><div class="rd-sec-t">Histórico de edições (gestão)</div>` +
      histLista.map(e => `<div class="rp-hrow">
        <div class="rp-hmain"><b>${esc(alvoTxt(e))}</b> · ${esc(MOT_LABEL[e.motivo] || e.motivo)}<div class="rp-hsub">${esc(e.ator_nome || '—')} · ${fdt(e.em, { withTime: true })}${detVal(e)}</div></div>
        ${e.operacao !== 'restore' ? `<button class="btn" data-restaurar="${esc(e.id)}">Restaurar</button>` : '<span class="dim">restaurado</span>'}
      </div>`).join('') + `</div>`
    box.querySelectorAll('[data-restaurar]').forEach(b => b.onclick = async () => {
      if (!confirm('Restaurar esta alteração (volta ao valor anterior)?')) return
      const { data: d2, error } = await sb().functions.invoke('rat-editar', { body: { restaurar_id: b.dataset.restaurar } })
      if (error || (d2 && d2.error)) return toast('Erro ao restaurar.', 'err')
      toast('Restaurado.', 'ok'); await recarregar()
    })
  }

  async function excluir() {
    if (!confirm('Excluir esta RAT? Remove os produtos e fotos dela. Esta ação não pode ser desfeita.')) return
    const { error } = await sb().rpc('admin_excluir_rat', { p_rat: det.r.id })
    if (error) return toast('Erro ao excluir: ' + error.message, 'err')
    toast('RAT excluída.', 'ok')
    document.getElementById('rp-body').innerHTML = '<p class="rp-msg">RAT excluída.</p>'
    barra(false)
    setTimeout(() => { window.close() }, 800)
  }

  // ── Nova tarefa da pendência ──
  async function abrirPend() {
    if (!tipos.length) {
      const { data } = await sb().from('tipos_servico').select('id,nome,ativo').eq('ativo', true).order('nome')
      tipos = data || []
    }
    const r = det.r
    const resp = r.respostas || {}
    const pend = (r.pendencias && r.pendencias.trim()) || (resp.observacoes && String(resp.observacoes).trim()) || ''
    const tipoOrig = (r.tarefa && r.tarefa.tipo_servico_id) || ''
    const tarefaNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null
    document.getElementById('pend-cli').textContent = r.cliente_nome || '—'
    document.getElementById('pend-tipo').innerHTML = tipos.map(t => `<option value="${esc(t.id)}"${t.id === tipoOrig ? ' selected' : ''}>${esc(t.nome)}</option>`).join('')
    document.getElementById('pend-orient').value = pend
    document.getElementById('pend-origem').textContent = tarefaNo ? `Origem: Tarefa Nº ${tarefaNo}` : ''
    document.getElementById('modal-pend').classList.add('open')
  }
  function fecharPend() { document.getElementById('modal-pend').classList.remove('open') }
  async function criarPend() {
    const r = det.r
    const cliId = r.cliente_id || (r.tarefa && r.tarefa.cliente_id)
    const tipoId = document.getElementById('pend-tipo').value
    const orient = document.getElementById('pend-orient').value.trim()
    if (!cliId) return toast('RAT sem cliente vinculado.', 'err')
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')
    const tarefaNo = r.tarefa && r.tarefa.numero != null ? String(r.tarefa.numero).padStart(5, '0') : null
    const ins = await sb().from('tarefas').insert({
      cliente_id: cliId, tipo_servico_id: tipoId, status: 'aguardando_execucao',
      orientacao: orient || null,
      observacoes: tarefaNo ? `Gerada da pendência da Tarefa Nº ${tarefaNo}.` : 'Gerada de pendência de RAT.',
      criado_por: user.id,
    }).select('numero').single()
    if (ins.error) return toast('Erro ao criar tarefa: ' + ins.error.message, 'err')
    fecharPend()
    toast(`Tarefa Nº ${String(ins.data.numero).padStart(5, '0')} criada. Atribua o técnico em Tarefas.`, 'ok')
  }

  return { init }
})()
