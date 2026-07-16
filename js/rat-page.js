/* ═══════════════════════════════════════════════
   Service Report — rat-page.js
   Página dedicada de UMA RAT (rat.html?id=<id>), com link próprio.
   Reutiliza window.RatView (render/PDF) e window.RatEditor (edição auditada
   compartilhada com a aba RATs da Tarefa). Office-only.
═══════════════════════════════════════════════ */
const RatPage = (() => {
  const sb = () => getSupabase()
  let user = { id: null }
  let det = null
  let editMode = false
  let tipos = []
  let pendOpId = null   // chave de idempotência da operação (1 por abertura do modal)
  let ratId = null
  let usuarios = []          // técnicos do SR (p/ adicionar à RAT)
  let histLista = []         // rat_edicoes carregadas
  let souAdmin = false       // só admin edita (gestor vê o histórico, não edita)
  const MOT_LABEL = { esquecimento_tecnico: 'Esquecimento do técnico', completacao: 'Completação', mudanca_processo: 'Mudança de processo', pedido_cliente: 'Pedido do cliente', correcao_texto: 'Correção de texto (fora do desempenho)', outro: 'Outro', sync_app: 'Reeditada pelo técnico no app (sync)' }

  // Editor auditado compartilhado (estado da edição + motivo + Edge rat-editar).
  const ed = RatEditor.criar({
    sb,
    getUsuarios: () => usuarios,
    container: () => document.getElementById('rp-body'),
    onSaved: async () => { editMode = false; await recarregar() },
  })

  // Carrega auxiliares da edição (usuários p/ técnicos).
  async function carregarAux() {
    try { const { data } = await sb().rpc('sr_usuarios'); usuarios = (data || []).filter(u => u.ativo) } catch (e) { usuarios = [] }
    souAdmin = ((usuarios.find(u => u.id === user.id) || {}).role) === 'admin'
  }

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
    document.getElementById('rp-editar').onclick = async () => { await ed.iniciar(det); editMode = true; render() }
    document.getElementById('rp-cancelar').onclick = () => { editMode = false; render() }
    document.getElementById('rp-salvar').onclick = () => ed.salvar()
    // PDF vetorial (pdfmake local) — mesmo motor do documento da Tarefa, sem capa.
    document.getElementById('rp-pdf').onclick = async () => {
      const btn = document.getElementById('rp-pdf')
      const antes = btn.textContent
      btn.disabled = true; btn.textContent = 'Gerando PDF…'
      try {
        const t = det.r.tarefa && det.r.tarefa.numero != null ? String(det.r.tarefa.numero).padStart(5, '0') : ''
        const seq = det.r.rat_seq != null ? String(det.r.rat_seq).padStart(2, '0') : null
        const ratNo = (t || '—') + (seq ? '/' + seq : '')
        await PdfTarefa.gerar({
          numeroFmt: t || '—', headerRight: `RAT Nº ${ratNo}`,
          arquivo: `RAT_${t || 'SR'}${seq ? '_' + seq : ''}.pdf`, selo: null,
          flags: { cliente: false, valores: true, conciliacao: false, zerados: true },
          motivoImprodutiva: RatView.motivoImprodutivaLabel,
          capa: null, dets: [det],
        })
      } catch (e) { console.error('[PDF RAT]', e); toast('Não foi possível gerar o PDF. Tente novamente.', 'err') }
      finally { btn.disabled = false; btn.textContent = antes }
    }
    document.getElementById('rp-excluir').onclick = excluir
    document.getElementById('rp-improd').onclick = () =>
      RatEditor.reclassificarImprodutiva({ sb, rat: det.r, onDone: recarregar })
    document.getElementById('rp-encerrar').onclick = encerrar
    document.getElementById('rp-nova').onclick = abrirPend
    document.getElementById('pend-x').onclick = fecharPend
    document.getElementById('pend-cancelar').onclick = fecharPend
    document.getElementById('pend-criar').onclick = criarPend
    document.getElementById('btn-voltar').onclick = () => { if (history.length > 1) history.back(); else window.close() }
  }

  function render() {
    const corpo = RatView.buildReportBody(det, editMode, { noHeader: true, adminEdit: editMode })
    document.getElementById('rp-body').innerHTML = (editMode ? ed.tecnicosHTML() : '') + corpo
    if (editMode) ed.bind()
    const show = (id, v) => { document.getElementById(id).style.display = v ? '' : 'none' }
    show('rp-editar', !editMode && souAdmin)
    show('rp-salvar', editMode)
    show('rp-cancelar', editMode)
    show('rp-nova', !editMode)
    show('rp-pdf', !editMode)
    show('rp-excluir', !editMode && souAdmin)   // excluir é admin-only (RPC admin_excluir_rat); UI acompanha
    show('rp-improd', !editMode && souAdmin && det.r.status !== 'improdutiva')   // reclassificação auditada (Edge valida)
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
        <div class="rp-hmain"><b>${esc(alvoTxt(e))}</b> · ${esc(MOT_LABEL[e.motivo] || e.motivo)}${e.motivo === 'outro' && e.motivo_detalhe ? ': ' + esc(e.motivo_detalhe) : ''}<div class="rp-hsub">${esc(e.ator_nome || '—')} · ${fdt(e.em, { withTime: true })}${detVal(e)}</div></div>
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
    pendOpId = crypto.randomUUID()   // chave de idempotência: 1 por abertura do modal
    document.getElementById('modal-pend').classList.add('open')
  }
  function fecharPend() { document.getElementById('modal-pend').classList.remove('open') }
  async function criarPend() {
    const r = det.r
    const tipoId = document.getElementById('pend-tipo').value
    const orient = document.getElementById('pend-orient').value.trim()
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')
    const tarefaOrigem = (r.tarefa && r.tarefa.id) || null
    if (tarefaOrigem) {
      // RPC atômica (0111): nova tarefa vinculada (continuação planejada, FK pra tarefa e
      // RAT da pendência), origem fecha PRESERVANDO a pendência, evento auditado.
      // Retry/duplo-clique reenviam o mesmo pendOpId → recebem a tarefa já criada.
      const btn = document.getElementById('pend-criar')
      if (btn) btn.disabled = true   // evita toast duplicado no duplo-clique
      let data, error
      try { ({ data, error } = await sb().rpc('gerar_tarefa_de_pendencia', {
        p_id: pendOpId, p_tarefa_origem: tarefaOrigem, p_rat_origem: r.id || null,
        p_tipo_servico: tipoId, p_orientacao: orient || null,
      })) } finally { if (btn) btn.disabled = false }
      if (error) return toast('Erro ao criar tarefa: ' + error.message, 'err')
      const r0 = Array.isArray(data) ? data[0] : data
      fecharPend()
      toast(r0 && r0.o_ja_existia
        ? `Tarefa Nº ${String(r0.o_numero).padStart(5, '0')} já havia sido criada desta pendência.`
        : `Tarefa Nº ${String(r0.o_numero).padStart(5, '0')} criada. Atribua o técnico em Tarefas.`, 'ok')
      return
    }
    // RAT legada sem tarefa-pai: não há origem pra vincular — cria solta, como antes.
    const cliId = r.cliente_id || null
    if (!cliId) return toast('RAT sem cliente vinculado.', 'err')
    const ins = await sb().from('tarefas').insert({
      cliente_id: cliId, tipo_servico_id: tipoId, status: 'aguardando_execucao',
      orientacao: orient || null, observacoes: 'Gerada de pendência de RAT.',
      criado_por: user.id,
    }).select('numero').single()
    if (ins.error) return toast('Erro ao criar tarefa: ' + ins.error.message, 'err')
    fecharPend()
    toast(`Tarefa Nº ${String(ins.data.numero).padStart(5, '0')} criada. Atribua o técnico em Tarefas.`, 'ok')
  }

  return { init }
})()
