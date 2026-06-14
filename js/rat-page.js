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

    bind()
    renderHero()
    render()
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
      ? `<span class="badge" style="background:#FEF3DA;color:#92670A;font-weight:700" title="O técnico iniciou o atendimento e não encerrou">⚠ Não encerrada · há ${diasNE} ${diasNE === 1 ? 'dia' : 'dias'}</span>`
      : `<span class="badge ${st.cls}">${esc(st.label)}</span>`
    document.getElementById('rp-hero').innerHTML = `
      <div class="doc-band"><div class="db-brand">TRADERS SERVICE</div><div class="db-doc">Relatório de Atendimento Técnico</div></div>
      <div class="doc-hero">
        <div class="dh-cli">${esc(r.cliente_nome || '—')}</div>
        <div class="dh-sub">${esc(RatView.tipoNomeRat(r))}${tarefaNo ? ' · Tarefa Nº ' + tarefaNo : ''}</div>
        <div class="dh-chips">
          <span class="chip"><i>Técnico</i>${esc(r.tecnico_nome || '—')}</span>
          <span class="chip"><i>Data</i>${fdt(r.data_tarefa, { withTime: true })}</span>
          <span class="chip"><i>Tempo trabalhado</i>${RatView.fmtMin(RatView.tempoRat(r))}</span>
          ${stBadge}
        </div>
      </div>`
  }

  function barra(show) { document.getElementById('rp-actions').style.display = show ? '' : 'none' }

  function bind() {
    document.getElementById('rp-editar').onclick = () => { editMode = true; render() }
    document.getElementById('rp-cancelar').onclick = () => { editMode = false; render() }
    document.getElementById('rp-salvar').onclick = salvar
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
    document.getElementById('rp-body').innerHTML = RatView.buildReportBody(det, editMode, { noHeader: true })
    const show = (id, v) => { document.getElementById(id).style.display = v ? '' : 'none' }
    show('rp-editar', !editMode)
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
    if (!confirm('Encerrar esta RAT em andamento e marcá-la como Registrada (fecha o dia)?\n\nSe precisar acertar os horários/tempo, use "Editar" antes. Encerrar a RAT não conclui o serviço — isso é feito na Tarefa.')) return
    const upd = { status: 'registrado' }
    const tm = RatView.tempoRat(r)            // recalcula o tempo se já houver início e término
    if (tm != null) upd.tempo_trabalhado = tm
    const { error } = await sb().from('rats').update(upd).eq('id', r.id)
    if (error) return toast('Erro ao encerrar: ' + error.message, 'err')
    det.r.status = 'registrado'; if (tm != null) det.r.tempo_trabalhado = tm
    renderHero(); render()
    toast('RAT registrada (dia encerrado).', 'ok')
  }

  async function salvar() {
    const { respostas, tempo, precos } = RatView.coletarEdicao(document.getElementById('rp-body'), det)
    const upd = { respostas }; if (tempo != null) upd.tempo_trabalhado = tempo
    const { error } = await sb().from('rats').update(upd).eq('id', det.r.id)
    if (error) return toast('Erro ao salvar: ' + error.message, 'err')
    await RatView.salvarPrecos(precos)
    det.r.respostas = respostas; if (tempo != null) det.r.tempo_trabalhado = tempo
    det = await RatView.loadDetalhe(det.r)   // recarrega produtos c/ novos preços/subtotais
    editMode = false; renderHero(); render()
    toast('RAT atualizada.', 'ok')
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
