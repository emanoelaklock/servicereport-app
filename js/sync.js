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
    'atendimento_executado', 'motivo_improdutiva', 'motivo_texto',   // visita improdutiva
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
      // A RAT só leva a Tarefa a "em execução" (atendimento continua). Concluir o serviço
      // ('concluida'/'concluida_pendencia') é deliberado na Tarefa — nunca a partir da RAT.
      // Reabre tarefa PARADA (aguardando OU em_pausa) → em_execucao. Mas "volto depois"
      // (não volto amanhã) NÃO reabre: deixa o trigger 0069 pôr em_pausa (espelho coerente).
      const MAP = { em_andamento: 'em_execucao', registrado: 'em_execucao' }
      const novo = MAP[rat.status]
      if (novo) {
        const rs = rat.respostas || {}
        const ehPausa = rs.volta_amanha === 'Não' && rs.passagem_motivo === 'volto_depois'
        const { data: tt } = await sb.from('tarefas').select('status').eq('id', rat.tarefa_id).maybeSingle()
        const atual = tt && tt.status
        const terminal = ['aprovada_faturamento', 'faturada']
        const aplicar = atual && !terminal.includes(atual) && !ehPausa &&
          (atual === 'aguardando_execucao' || atual === 'em_pausa')
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
  // Tarefa criada pelo técnico offline → função SECURITY DEFINER (criado_por = auth.uid()),
  // que evita as armadilhas de RLS do upsert/insert. Remove a cópia local ao confirmar.
  async function enviarTarefaLocal(t) {
    const sb = getSupabase()
    const { error } = await sb.rpc('criar_tarefa_app', {
      p_id: t.id, p_cliente_id: t.cliente_id, p_status: t.status || 'aguardando_execucao',
      p_tipo_servico_id: t.tipo_servico_id || null, p_orientacao: t.orientacao || null,
      p_data_agendada: t.data_agendada || null, p_tecnicos: t.tecnicos || [],
      p_local: t.local_servico || null,
    })
    if (error) throw error
    await D().removerTarefaLocal(t.id)
  }

  async function enviarDeslocamento(d) {
    const sb = getSupabase()
    const { data: { user } } = await sb.auth.getUser()
    if (Array.isArray(d.trechos)) return enviarViagem(sb, d, (user && user.id) || d.criado_por)
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

  // Modelo novo: viagem (pai) + trechos + a-bordo/direção por trecho + almoço na estrada.
  // saida_em do PAI fica nula de propósito — o trigger-espelho de compatibilidade
  // (app antigo, 1 registro = 1 perna) só age sobre pais com saida_em preenchida.
  async function enviarViagem(sb, d, criadoPor) {
    const up = await sb.from('deslocamentos').upsert({
      id: d.id, sentido: 'outro', cliente_id: d.cliente_id || null,
      motivo: d.motivo || null, observacoes: d.observacoes || null, criado_por: criadoPor,
    }, { onConflict: 'id' })
    if (up.error) throw up.error
    // trechos: substituição completa (cascade limpa a-bordo/direção)
    const del = await sb.from('deslocamento_trechos').delete().eq('deslocamento_id', d.id)
    if (del.error) throw del.error
    const trechos = (d.trechos || []).map((t, i) => ({
      id: t.id, deslocamento_id: d.id, ordem: i + 1,
      origem: t.origem || null, destino: t.destino || null, destino_local_id: t.destino_local_id || null,
      destino_cliente_id: t.destino_cliente_id || null, tarefa_id: t.tarefa_id || null,
      almoco_inicio: t.almoco_inicio || null, almoco_fim: t.almoco_fim || null,
      data: t.data || null, saida_em: t.saida_em || null, chegada_em: t.chegada_em || null,
      saida_lat: t.saida_lat ?? null, saida_lng: t.saida_lng ?? null, saida_precisao: t.saida_precisao ?? null,
      chegada_lat: t.chegada_lat ?? null, chegada_lng: t.chegada_lng ?? null, chegada_precisao: t.chegada_precisao ?? null,
      veiculo_id: t.veiculo_id || null, nota_transporte: t.nota_transporte || null,
    }))
    if (trechos.length) {
      const it = await sb.from('deslocamento_trechos').insert(trechos)
      if (it.error) throw it.error
      const aboard = [], dirs = []
      for (const t of (d.trechos || [])) {
        for (const tid of (t.tecnicos || [])) aboard.push({ trecho_id: t.id, tecnico_id: tid })
        for (const m of (t.motoristas || [])) dirs.push({ trecho_id: t.id, tecnico_id: m.tecnico_id, hora_de: m.hora_de || null, hora_ate: m.hora_ate || null })
      }
      if (aboard.length) { const r = await sb.from('trecho_tecnicos').insert(aboard); if (r.error) throw r.error }
      if (dirs.length) { const r = await sb.from('trecho_direcao').insert(dirs); if (r.error) throw r.error }
    }
    // união a bordo no pai: dá leitura da viagem a quem participa (RLS) e serve o admin
    const delT = await sb.from('deslocamento_tecnicos').delete().eq('deslocamento_id', d.id)
    if (delT.error) throw delT.error
    const uni = [...new Set((d.trechos || []).flatMap(t => t.tecnicos || []))]
    if (uni.length) {
      const r = await sb.from('deslocamento_tecnicos').upsert(uni.map(tid => ({ deslocamento_id: d.id, tecnico_id: tid })), { onConflict: 'deslocamento_id,tecnico_id' })
      if (r.error) throw r.error
    }
    // tarefas referenciadas (em aberto, dos clientes do destino)
    const delTar = await sb.from('deslocamento_tarefas').delete().eq('deslocamento_id', d.id)
    if (delTar.error) throw delTar.error
    if ((d.tarefas || []).length) {
      const r = await sb.from('deslocamento_tarefas').insert(d.tarefas.map(tid => ({ deslocamento_id: d.id, tarefa_id: tid })))
      if (r.error) throw r.error
    }
    // almoço na estrada por pessoa/dia → o servidor materializa em `almocos` (com dedup)
    const delA = await sb.from('deslocamento_almocos').delete().eq('deslocamento_id', d.id)
    if (delA.error) throw delA.error
    if ((d.almocos || []).length) {
      const r = await sb.from('deslocamento_almocos').insert(d.almocos.map(a => ({
        deslocamento_id: d.id, tecnico_id: a.tecnico_id, dia: a.dia, inicio: a.inicio, fim: a.fim,
      })))
      if (r.error) throw r.error
    }
    await D().marcarDeslocamentoStatus(d.id, D().STATUS.CONFIRMADO)
  }

  async function syncAll() {
    if (syncing || !navigator.onLine) return { ok: 0, fail: 0, skipped: true }
    syncing = true
    if (typeof window.onSyncStart === 'function') window.onSyncStart()
    let ok = 0, fail = 0
    const PEND = [D().STATUS.SALVO_LOCAL, D().STATUS.NA_FILA, D().STATUS.ERRO]
    try {
      // Tarefas criadas offline primeiro (RAT depende da tarefa via FK).
      const tlocais = await D().tarefasLocaisPendentes()
      for (const t of tlocais) {
        try { await enviarTarefaLocal(t); ok++ }
        catch (e) { console.warn('[sync] falha tarefa local', t.id, e); fail++ }
      }
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

  // Hidrata os TRECHOS dos deslocamentos vindos no pull: o pai (servidor) não traz `trechos`
  // (moram em deslocamento_trechos), então sem isto o app desenharia a viagem como trajeto
  // legado vazio. Busca em 1 query batched (só os ids do delta) e monta o formato local — o
  // MESMO que o app usa ao abrir uma viagem (tecnicos/motoristas/GPS/almoço). Espelho_legado fora.
  async function hidratarTrechosPull(sb, rows) {
    const ids = rows.map(r => r.id).filter(Boolean)
    if (!ids.length) return
    const hh = (s) => s ? String(s).slice(0, 5) : null
    const { data: ts, error } = await sb.from('deslocamento_trechos')
      .select('id,deslocamento_id,ordem,origem,destino,destino_local_id,destino_cliente_id,tarefa_id,data,saida_em,chegada_em,saida_lat,saida_lng,saida_precisao,chegada_lat,chegada_lng,chegada_precisao,veiculo_id,nota_transporte,almoco_inicio,almoco_fim,espelho_legado,trecho_tecnicos(tecnico_id),trecho_direcao(tecnico_id,hora_de,hora_ate)')
      .in('deslocamento_id', ids)
    if (error) { console.warn('[pull] trechos', error.message); return }
    const byD = {}
    for (const t of (ts || [])) { if (t.espelho_legado) continue; (byD[t.deslocamento_id] = byD[t.deslocamento_id] || []).push(t) }
    for (const r of rows) {
      const lst = (byD[r.id] || []).sort((a, b) => a.ordem - b.ordem)
      if (!lst.length) continue   // sem trechos = trajeto legado de verdade (deixa como está)
      r.trechos = lst.map(t => ({
        id: t.id, origem: t.origem || '', destino: t.destino || '',
        destino_local_id: t.destino_local_id || null, destino_cliente_id: t.destino_cliente_id || null,
        tarefa_id: t.tarefa_id || null, data: t.data || null,
        saida_em: t.saida_em || null, chegada_em: t.chegada_em || null,
        saida_lat: t.saida_lat ?? null, saida_lng: t.saida_lng ?? null, saida_precisao: t.saida_precisao ?? null,
        chegada_lat: t.chegada_lat ?? null, chegada_lng: t.chegada_lng ?? null, chegada_precisao: t.chegada_precisao ?? null,
        veiculo_id: t.veiculo_id || null, sem_veiculo: !t.veiculo_id && !!t.nota_transporte, nota_transporte: t.nota_transporte || null,
        almoco_inicio: hh(t.almoco_inicio), almoco_fim: hh(t.almoco_fim),
        tecnicos: (t.trecho_tecnicos || []).map(x => x.tecnico_id),
        motoristas: (t.trecho_direcao || []).map(m => ({ tecnico_id: m.tecnico_id, hora_de: hh(m.hora_de), hora_ate: hh(m.hora_ate) })),
      }))
      r.tarefas = [...new Set(lst.map(t => t.tarefa_id).filter(Boolean))]
    }
  }

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
        if (tabela === 'deslocamentos') await hidratarTrechosPull(sb, data || [])   // hidrata os trechos da viagem
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

  // Auto-reparo: deslocamentos que ficaram como "esqueleto" (puxados antes da hidratação:
  // confirmados, sentido 'outro', sem origem/destino e sem trechos) são re-hidratados a partir
  // do servidor. Conserta as viagens antigas sem depender de novo atualizado_em.
  async function repararDeslocViagens() {
    if (!navigator.onLine) return 0
    const sb = getSupabase(); if (!sb) return 0
    const all = await D().listarDeslocamentos()
    const esqueletos = all.filter(d => !Array.isArray(d.trechos) && d.sentido === 'outro'
      && !d.origem && !d.destino && d.sync_status === D().STATUS.CONFIRMADO && !d.tombstoned)
    if (!esqueletos.length) return 0
    await hidratarTrechosPull(sb, esqueletos)
    let n = 0
    for (const d of esqueletos) { if (Array.isArray(d.trechos) && await D().aplicarDoServidor('deslocamentos', d)) n++ }
    return n
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

  window.SyncEngine = { syncAll, pullChanges, repararDeslocViagens, enviarRat, enviarPreorc, enviarSegmento, enviarDeslocamento, enviarTarefaLocal, start }
})()
