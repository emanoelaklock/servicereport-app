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
    'client_uuid', 'origem_registro', 'cliente_id', 'tecnico_id',
    'equipamento_id', 'contrato_id', 'tipo_servico_id', 'formulario_id',
    'cliente_nome', 'tecnico_nome', 'data_tarefa', 'status', 'valor',
    'checkin_lat', 'checkin_lng', 'assinatura_url', 'respostas',
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

  // Sobe todas as RATs pendentes (salvo_local / na_fila / erro).
  async function syncAll() {
    if (syncing || !navigator.onLine) return { ok: 0, fail: 0, skipped: true }
    syncing = true
    let ok = 0, fail = 0
    try {
      const todas = await D().listarRats()
      const pend = todas.filter(r => [D().STATUS.SALVO_LOCAL, D().STATUS.NA_FILA, D().STATUS.ERRO].includes(r.sync_status))
      for (const r of pend) {
        try {
          await D().definirStatus(r.client_uuid, D().STATUS.NA_FILA, 'enfileirado')
          await enviarRat(await D().obterRat(r.client_uuid))
          ok++
        } catch (e) {
          console.warn('[sync] falha', r.client_uuid, e)
          await D().definirStatus(r.client_uuid, D().STATUS.ERRO, (e && e.message) || 'erro de envio')
          fail++
        }
      }
    } finally { syncing = false }
    if (typeof window.onSyncDone === 'function') window.onSyncDone({ ok, fail })
    return { ok, fail }
  }

  // Dispara ao iniciar (se online) e sempre que a conexão voltar.
  function start() {
    window.addEventListener('online', () => syncAll())
    if (navigator.onLine) syncAll()
  }

  window.SyncEngine = { syncAll, enviarRat, start }
})()
