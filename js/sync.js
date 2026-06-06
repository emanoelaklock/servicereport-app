/* ═══════════════════════════════════════════════
   Service Report — sync.js
   Sobe RATs local-first para o Supabase (idempotente por client_uuid):
     salvo_local → na_fila → enviando → [upload fotos+assinatura no Storage,
     upsert em tarefas, relatorio_fotos] → confirmado (quando o servidor
     carimba recebido_em) | erro. Espelha a trilha local em sync_eventos.
   Retry automático ao voltar a conexão (evento 'online').

   Dependências: supabase-client.js (getSupabase), auth.js (SESSION),
   db-local.js (window.DBLocal). Exposto como window.SyncEngine.
═══════════════════════════════════════════════ */
(function () {
  const D = () => window.DBLocal
  const BUCKET = 'rat-anexos'
  let syncing = false

  // Colunas REAIS de public.tarefas (whitelist).
  // Exclui: relatorio_completo (gerada), recebido_em (servidor), criado_em/
  // atualizado_em (defaults) e campos só-locais (tipo_servico_nome, assinatura_local).
  const TAREFA_COLS = [
    'client_uuid', 'origem_registro', 'cliente_id', 'tecnico_id', 'tarefa_id',
    'equipamento_id', 'contrato_id', 'tipo_servico_id', 'formulario_id',
    'cliente_nome', 'tecnico_nome', 'data_tarefa', 'status', 'valor',
    'checkin_lat', 'checkin_lng', 'checkin_precisao', 'checkin_em', 'assinatura_url', 'respostas',
    'tem_foto', 'tem_assinatura', 'questionario_ok', 'pendencias',
    'sync_status', 'device_id', 'os_omie', 'observacoes', 'tempo_trabalhado',
  ]

  function dataURLparaBlob(dataURL) {
    const [meta, b64] = dataURL.split(',')
    const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/png'
    const bin = atob(b64), arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return new Blob([arr], { type: mime })
  }
  const extDoMime = (m) => (m && m.includes('png')) ? 'png' : (m && m.includes('webp')) ? 'webp' : 'jpg'

  // Envia UMA RAT. Lança em caso de falha (o chamador marca 'erro').
  async function enviarRat(rat) {
    const sb = getSupabase()
    const uid = rat.tecnico_id
    if (!uid) throw new Error('RAT sem tecnico_id')

    await D().definirStatus(rat.client_uuid, D().STATUS.ENVIANDO, 'iniciando envio')

    // 1) Fotos pendentes → Storage (path sob a pasta do técnico p/ casar com a RLS)
    for (const f of await D().listarFotos(rat.client_uuid)) {
      if (f.enviada) continue
      const path = `${uid}/${rat.client_uuid}/foto-${f.id}.${extDoMime(f.blob.type)}`
      const up = await sb.storage.from(BUCKET).upload(path, f.blob, { upsert: true, contentType: f.blob.type || 'image/jpeg' })
      if (up.error) throw up.error
      await D().marcarFotoEnviada(f.id, path)
    }

    // 2) Assinatura (dataURL local) → Storage
    let assinatura_url = rat.assinatura_url || null
    if (rat.assinatura_local && !assinatura_url) {
      const path = `${uid}/${rat.client_uuid}/assinatura.png`
      const up = await sb.storage.from(BUCKET).upload(path, dataURLparaBlob(rat.assinatura_local), { upsert: true, contentType: 'image/png' })
      if (up.error) throw up.error
      assinatura_url = path
    }

    // 3) Upsert da tarefa (idempotente por client_uuid)
    const payload = {}
    TAREFA_COLS.forEach(c => { if (rat[c] !== undefined && rat[c] !== null) payload[c] = rat[c] })
    payload.client_uuid = rat.client_uuid
    payload.origem_registro = 'nativo'
    payload.tecnico_id = uid
    payload.sync_status = 'confirmado'
    if (assinatura_url) payload.assinatura_url = assinatura_url
    const ups = await sb.from('rats').upsert(payload, { onConflict: 'client_uuid' }).select('id,recebido_em').single()
    if (ups.error) throw ups.error
    const tarefaId = ups.data.id

    // 4) relatorio_fotos (idempotente: id = id local da foto)
    const rows = (await D().listarFotos(rat.client_uuid)).filter(f => f.url)
      .map(f => ({ id: f.id, rat_id: tarefaId, url: f.url, legenda: f.legenda || null }))
    if (rows.length) {
      const rf = await sb.from('relatorio_fotos').upsert(rows, { onConflict: 'id' })
      if (rf.error) throw rf.error
    }

    // 4b) materiais utilizados (idempotente: id = id local do material)
    const mats = await D().listarMateriais(rat.client_uuid)
    if (mats.length) {
      const mrows = mats.map(m => ({
        id: m.id, origem: 'usado', rat_id: tarefaId,
        produto_id: m.produto_id || null, codigo_produto: m.codigo_produto || null,
        descricao: m.descricao || null, quantidade: m.quantidade || 0,
      }))
      const mr = await sb.from('materiais').upsert(mrows, { onConflict: 'id' })
      if (mr.error) throw mr.error
    }

    // 4c) Reflete a situação do atendimento no status da Tarefa-pai (#7.2).
    //     Guardas: não mexe em tarefas já em faturamento; "em execução" só inicia
    //     (não rebaixa uma tarefa concluída por causa de uma RAT antiga).
    if (rat.tarefa_id && rat.status) {
      const MAP = { em_andamento: 'em_execucao', concluida: 'concluida', concluida_pendencia: 'concluida_pendencia' }
      const novo = MAP[rat.status]
      if (novo) {
        const { data: tt } = await sb.from('tarefas').select('status').eq('id', rat.tarefa_id).maybeSingle()
        const atual = tt && tt.status
        const terminal = ['aprovada_faturamento', 'faturada']
        const aplicar = atual && !terminal.includes(atual) &&
          (novo === 'em_execucao' ? atual === 'aguardando_execucao' : true)
        if (aplicar) await sb.from('tarefas').update({ status: novo }).eq('id', rat.tarefa_id)
      }
    }

    // 5) ACK do servidor: recebido_em carimbado → confirmado
    if (ups.data.recebido_em) {
      await D().salvarRat(rat.client_uuid, { recebido_em: ups.data.recebido_em, assinatura_url })
      await D().definirStatus(rat.client_uuid, D().STATUS.CONFIRMADO, 'recebido pelo servidor')
    }

    // 6) sync_eventos pendentes → servidor (idempotente: id = id local do evento)
    //    Feito por último para incluir os eventos na_fila/enviando/confirmado desta rodada.
    const evs = await D().listarEventos({ client_uuid: rat.client_uuid, pendentes: true })
    if (evs.length) {
      const erows = evs.map(e => ({
        id: e.id, client_uuid: e.client_uuid, rat_id: tarefaId,
        device_id: e.device_id, evento: e.evento, detalhe: e.detalhe, em: e.em,
      }))
      const se = await sb.from('sync_eventos').upsert(erows, { onConflict: 'id' })
      if (!se.error) { for (const e of evs) await D().marcarEventoEnviado(e.id) }
    }
    return true
  }

  // Colunas REAIS de public.pre_orcamentos (whitelist).
  // Exclui: numero (IDENTITY no servidor), recebido_em (servidor), criado_em/
  // atualizado_em (defaults) e campos só-locais.
  const PREORC_COLS = [
    'client_uuid', 'cliente_id', 'tecnico_id', 'cliente_nome', 'tecnico_nome',
    'descricao', 'respostas', 'tempo_trabalhado', 'data', 'status',
    'sync_status', 'device_id',
  ]

  // Envia UM pré-orçamento. Lança em caso de falha (o chamador marca 'erro').
  async function enviarPreorc(po) {
    const sb = getSupabase()
    const uid = po.tecnico_id
    if (!uid) throw new Error('Pré-orçamento sem tecnico_id')

    await D().definirStatusPreorc(po.client_uuid, D().STATUS.ENVIANDO)

    // 1) Fotos pendentes → Storage (pasta do técnico p/ casar com a RLS do bucket)
    for (const f of await D().listarFotos(po.client_uuid)) {
      if (f.enviada) continue
      const path = `${uid}/${po.client_uuid}/foto-${f.id}.${extDoMime(f.blob.type)}`
      const up = await sb.storage.from(BUCKET).upload(path, f.blob, { upsert: true, contentType: f.blob.type || 'image/jpeg' })
      if (up.error) throw up.error
      await D().marcarFotoEnviada(f.id, path)
    }

    // 2) Upsert do pré-orçamento (idempotente por client_uuid)
    const payload = {}
    PREORC_COLS.forEach(c => { if (po[c] !== undefined && po[c] !== null) payload[c] = po[c] })
    payload.client_uuid = po.client_uuid
    payload.tecnico_id = uid
    payload.sync_status = 'confirmado'
    const ups = await sb.from('pre_orcamentos').upsert(payload, { onConflict: 'client_uuid' }).select('id,numero,recebido_em').single()
    if (ups.error) throw ups.error
    const preorcId = ups.data.id

    // 3) relatorio_fotos (idempotente: id = id local da foto) — via pre_orcamento_id
    const rows = (await D().listarFotos(po.client_uuid)).filter(f => f.url)
      .map(f => ({ id: f.id, pre_orcamento_id: preorcId, url: f.url, legenda: f.legenda || null }))
    if (rows.length) {
      const rf = await sb.from('relatorio_fotos').upsert(rows, { onConflict: 'id' })
      if (rf.error) throw rf.error
    }

    // 4) Itens (materiais necessários — sem preço; idempotente: id = id local)
    const itens = await D().listarItensPreorc(po.client_uuid)
    if (itens.length) {
      const irows = itens.map(m => ({
        id: m.id, pre_orcamento_id: preorcId,
        produto_id: m.produto_id || null, codigo_produto: m.codigo_produto || null,
        descricao: m.descricao || null, unidade: m.unidade || null, quantidade: m.quantidade || 0,
      }))
      const ir = await sb.from('pre_orcamento_itens').upsert(irows, { onConflict: 'id' })
      if (ir.error) throw ir.error
    }

    // 5) ACK do servidor: recebido_em carimbado → confirmado
    if (ups.data.recebido_em) {
      await D().salvarPreorc(po.client_uuid, { recebido_em: ups.data.recebido_em, numero: ups.data.numero })
      await D().definirStatusPreorc(po.client_uuid, D().STATUS.CONFIRMADO)
    }

    // 6) Pré-orçamento CONCLUÍDO → PDF (servidor) + e-mail ao comercial.
    //    Best-effort: não derruba o sync; idempotente no servidor (email_comercial_em).
    if (po.status === 'concluido') {
      try { await sb.functions.invoke('documentos', { body: { action: 'pre_orcamento_concluido', id: preorcId } }) }
      catch (e) { console.warn('[sync] pós-conclusão pré-orçamento (pdf/email):', e) }
    }
    return true
  }

  // Sobe todas as RATs e pré-orçamentos pendentes (salvo_local / na_fila / erro).
  // Jornada (dia contínuo): segmento é linha simples → upsert idempotente por id.
  async function enviarSegmento(seg) {
    const sb = getSupabase()
    const { data: { user } } = await sb.auth.getUser()
    const payload = {
      id: seg.id, tecnico_id: (user && user.id) || seg.tecnico_id, data: seg.data,
      tipo: seg.tipo, titulo: seg.titulo || null, tipo_servico_id: seg.tipo_servico_id || null,
      cliente_id: seg.cliente_id || null, tarefa_id: seg.tarefa_id || null,
      inicio: seg.inicio, fim: seg.fim || null, device_id: seg.device_id || null,
    }
    const up = await sb.from('jornada_segmentos').upsert(payload, { onConflict: 'id' })
    if (up.error) throw up.error
    await D().marcarSegmentoStatus(seg.id, D().STATUS.CONFIRMADO)
  }

  // Deslocamento (pernoite): upsert do trajeto + técnicos a bordo (idempotente por id).
  async function enviarDeslocamento(d) {
    const sb = getSupabase()
    const { data: { user } } = await sb.auth.getUser()
    const up = await sb.from('deslocamentos').upsert({
      id: d.id, sentido: d.sentido || 'ida', veiculo_id: d.veiculo_id || null, cliente_id: d.cliente_id || null,
      origem: d.origem || null, destino: d.destino || null,
      origem_cidade: d.origem_cidade || null, origem_uf: d.origem_uf || null, destino_cidade: d.destino_cidade || null, destino_uf: d.destino_uf || null,
      saida_em: d.saida_em, chegada_em: d.chegada_em || null,
      motivo: d.motivo || null, criado_por: (user && user.id) || d.criado_por,
      saida_lat: d.saida_lat ?? null, saida_lng: d.saida_lng ?? null, saida_precisao: d.saida_precisao ?? null,
      chegada_lat: d.chegada_lat ?? null, chegada_lng: d.chegada_lng ?? null, chegada_precisao: d.chegada_precisao ?? null,
    }, { onConflict: 'id' })
    if (up.error) throw up.error
    const tecs = d.tecnicos || []
    if (tecs.length) {
      const it = await sb.from('deslocamento_tecnicos').upsert(tecs.map(tid => ({ deslocamento_id: d.id, tecnico_id: tid })), { onConflict: 'deslocamento_id,tecnico_id' })
      if (it.error) throw it.error
    }
    await D().marcarDeslocamentoStatus(d.id, D().STATUS.CONFIRMADO)
  }

  async function syncAll() {
    if (syncing || !navigator.onLine) return { ok: 0, fail: 0, skipped: true }
    syncing = true
    let ok = 0, fail = 0
    const PEND = [D().STATUS.SALVO_LOCAL, D().STATUS.NA_FILA, D().STATUS.ERRO]
    try {
      const todas = await D().listarRats()
      const pend = todas.filter(r => PEND.includes(r.sync_status))
      for (const r of pend) {
        try {
          await D().definirStatus(r.client_uuid, D().STATUS.NA_FILA, 'enfileirado')
          await enviarRat(await D().obterRat(r.client_uuid))
          ok++
        } catch (e) {
          console.warn('[sync] falha rat', r.client_uuid, e)
          await D().definirStatus(r.client_uuid, D().STATUS.ERRO, (e && e.message) || 'erro de envio')
          fail++
        }
      }
      const preorcs = (await D().listarPreorc()).filter(p => PEND.includes(p.sync_status))
      for (const p of preorcs) {
        try {
          await D().definirStatusPreorc(p.client_uuid, D().STATUS.NA_FILA)
          await enviarPreorc(await D().obterPreorc(p.client_uuid))
          ok++
        } catch (e) {
          console.warn('[sync] falha pré-orçamento', p.client_uuid, e)
          await D().definirStatusPreorc(p.client_uuid, D().STATUS.ERRO)
          fail++
        }
      }
      const segs = await D().segmentosPendentes()
      for (const s of segs) {
        try { await enviarSegmento(s); ok++ }
        catch (e) { console.warn('[sync] falha segmento', s.id, e); fail++ }
      }
      const desls = await D().deslocamentosPendentes()
      for (const d of desls) {
        try { await enviarDeslocamento(d); ok++ }
        catch (e) { console.warn('[sync] falha deslocamento', d.id, e); fail++ }
      }
    } finally { syncing = false }
    await pullChanges()   // depois de empurrar o local, puxa o que mudou no servidor
    if (typeof window.onSyncDone === 'function') window.onSyncDone({ ok, fail })
    return { ok, fail }
  }

  // ───────────────────── Delta-pull (servidor → aparelho) ─────────────────────
  // Puxa só o que mudou desde o último cursor: linhas alteradas (atualizado_em)
  // e exclusões (sync_tombstones). Aplica no IndexedDB sem clobberar o que ainda
  // está pendente de envio. Cursores ficam no localStorage.
  const cur = (k) => localStorage.getItem('sr_pull_' + k) || '1970-01-01T00:00:00+00:00'
  const setCur = (k, v) => { if (v) localStorage.setItem('sr_pull_' + k, v) }
  let pulling = false

  async function pullChanges() {
    if (pulling || !navigator.onLine) return { applied: 0, removed: 0 }
    const sb = getSupabase(); if (!sb) return { applied: 0, removed: 0 }
    pulling = true
    let applied = 0, removed = 0, changed = false
    try {
      for (const [tabela, m] of Object.entries(D().SYNC_MAP)) {
        const c = cur('upd_' + tabela)
        const { data, error } = await sb.from(tabela).select('*').gt('atualizado_em', c)
          .order('atualizado_em', { ascending: true }).limit(500)
        if (error) { console.warn('[pull]', tabela, error.message); continue }
        let max = c
        for (const row of (data || [])) {
          if (await D().aplicarDoServidor(m.store, row)) { applied++; changed = true }
          if (row.atualizado_em && row.atualizado_em > max) max = row.atualizado_em
        }
        setCur('upd_' + tabela, max)
      }
      const tc = cur('tomb')
      const { data: tombs, error: te } = await sb.from('sync_tombstones')
        .select('tabela,registro_id,deletado_em').gt('deletado_em', tc)
        .order('deletado_em', { ascending: true }).limit(1000)
      if (!te) {
        let tmax = tc
        for (const t of (tombs || [])) {
          const m = D().SYNC_MAP[t.tabela]
          if (m && await D().removerDoServidor(m.store, t.registro_id)) { removed++; changed = true }
          if (t.deletado_em > tmax) tmax = t.deletado_em
        }
        setCur('tomb', tmax)
      }
    } catch (e) { console.warn('[pull]', e) }
    finally { pulling = false }
    if (changed && typeof window.onSyncChanged === 'function') window.onSyncChanged({ applied, removed })
    return { applied, removed }
  }

  // ───────────────────── Realtime (sinal → reconcilia) ─────────────────────
  let rtChannel = null, pullTimer = null
  const agendarPull = () => { clearTimeout(pullTimer); pullTimer = setTimeout(() => pullChanges(), 400) }
  function startRealtime() {
    const sb = getSupabase(); if (!sb || rtChannel) return
    try {
      rtChannel = sb.channel('sr-sync')
      for (const tabela of Object.keys(D().SYNC_MAP)) {
        rtChannel.on('postgres_changes', { event: '*', schema: 'public', table: tabela }, agendarPull)
      }
      rtChannel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sync_tombstones' }, agendarPull)
      rtChannel.subscribe()
    } catch (e) { console.warn('[realtime]', e) }
  }

  // Dispara ao iniciar (se online) e sempre que a conexão voltar.
  function start() {
    window.addEventListener('online', () => syncAll())
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pullChanges() })
    setInterval(() => pullChanges(), 2 * 60 * 1000)   // rede de segurança
    if (navigator.onLine) { syncAll(); startRealtime() }
  }

  window.SyncEngine = { syncAll, pullChanges, enviarRat, enviarPreorc, enviarSegmento, enviarDeslocamento, start }
})()
