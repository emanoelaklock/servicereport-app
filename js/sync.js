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
  let refazer = false   // syncAll pedido (ou save detectado pela guarda do ACK) durante rodada em voo → nova rodada ao terminar

  // Colunas REAIS de public.tarefas (whitelist).
  // Exclui: relatorio_completo (gerada), recebido_em (servidor), criado_em/
  // atualizado_em (defaults) e campos só-locais (tipo_servico_nome, assinatura_local).
  const TAREFA_COLS = [
    'client_uuid', 'origem_registro', 'cliente_id', 'tecnico_id', 'tarefa_id',
    'equipamento_id', 'contrato_id', 'tipo_servico_id', 'formulario_id',
    'cliente_nome', 'tecnico_nome', 'data_tarefa', 'status', 'valor',
    'checkin_lat', 'checkin_lng', 'checkin_precisao', 'checkin_em', 'assinatura_url', 'respostas',
    'respostas_ts',   // carimbo local por campo (quando o técnico preencheu — métrica tempo-real v2)
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
  // Recebe o client_uuid, não o objeto: o retrato é tirado DEPOIS de marcar 'enviando' —
  // um save entre o retrato e a marca subiria dado velho e ainda seria confirmado (caso 04895).
  async function enviarRat(client_uuid) {
    const sb = getSupabase()
    await D().definirStatus(client_uuid, D().STATUS.ENVIANDO, 'iniciando envio')
    const rat = await D().obterRat(client_uuid)
    const uid = rat && rat.tecnico_id
    if (!uid) throw new Error('RAT sem tecnico_id')

    // 1) Fotos pendentes → Storage (path sob a pasta do técnico p/ casar com a RLS)
    for (const f of await D().listarFotos(rat.client_uuid)) {
      if (f.enviada) continue
      // Materializa os bytes antes de subir: no iOS, Blob file-backed do IndexedDB vira corpo
      // VAZIO no fetch (StorageApiError "No content provided"). comprimirFoto pode devolver o File
      // ORIGINAL quando o canvas não reduz o tamanho (JPEG já pequeno, PNG, imagem ≤1600px), então
      // a RAT sofre o mesmo furo do pré-orçamento — a defesa real é aqui. (idem enviarPreorc)
      const buf = await f.blob.arrayBuffer()
      const body = new Blob([buf], { type: (f.blob && f.blob.type) || 'image/jpeg' })
      const path = `${uid}/${rat.client_uuid}/foto-${f.id}.${extDoMime(body.type)}`
      const up = await sb.storage.from(BUCKET).upload(path, body, { upsert: true, contentType: body.type })
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
    const upsertRat = () => sb.from('rats').upsert(payload, { onConflict: 'client_uuid' }).select('id,recebido_em').single()
    let ups = await upsertRat()
    if (ups.error) {
      // FK rats_tarefa_id_fkey: a Tarefa-pai não existe no servidor (excluída no portal, ou tarefa
      // local que não subiu) → a RAT ficaria presa em erro pra sempre. Para NÃO perder o trabalho
      // do técnico, recria uma Tarefa mínima a partir dos dados da própria RAT (criar_tarefa_app é
      // idempotente e SECURITY DEFINER) e reenvia a RAT uma vez. O admin vê a Tarefa e trata.
      const fk = ups.error.code === '23503' || /tarefa_id_fkey|foreign key/i.test(ups.error.message || '')
      if (fk && payload.tarefa_id && payload.cliente_id) {
        const cr = await sb.rpc('criar_tarefa_app', {
          p_id: payload.tarefa_id, p_cliente_id: payload.cliente_id,
          p_status: null, p_tipo_servico_id: payload.tipo_servico_id || null, p_orientacao: null,
          p_data_agendada: (rat.respostas && rat.respostas.data) || (payload.data_tarefa ? String(payload.data_tarefa).slice(0, 10) : null),
          p_tecnicos: uid ? [uid] : [],
        })
        if (!cr.error) ups = await upsertRat()
      }
      if (ups.error) {
        // 42501 AQUI (e somente aqui): recusa de RLS no UPSERT DE RATS. Marca o erro na
        // origem para o syncAll tratar como bloqueio de propriedade — um 42501 vindo de
        // outra tabela (fotos/materiais) NÃO entra nesse tratamento (comportamento padrão).
        if (ups.error.code === '42501' || /row-level security/i.test(ups.error.message || '')) ups.error.rlsRatsUpsert = true
        throw ups.error
      }
    }
    const tarefaId = ups.data.id
    if (rat.envio_bloqueado_rls) await D().salvarRat(client_uuid, { envio_bloqueado_rls: null })   // dono logou e o envio passou

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
        created_by: m.created_by || null, device_id: m.device_id || null,   // autor real (conflito colaborativo) — NÃO sobrescreve com o uploader
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
        const { data: tt } = await sb.from('tarefas').select('status,devolvida_em').eq('id', rat.tarefa_id).maybeSingle()
        const atual = tt && tt.status
        const terminal = ['aprovada_faturamento', 'faturada']
        const aplicar = atual && !terminal.includes(atual) && !ehPausa &&
          (atual === 'aguardando_execucao' || atual === 'em_pausa')
        if (aplicar) await sb.from('tarefas').update({ status: novo }).eq('id', rat.tarefa_id)
        // Tarefa DEVOLVIDA + técnico salvou a RAT ('registrado' = correção enviada) →
        // volta pra 'concluida' (o serviço já era concluído; a devolução é de preenchimento).
        // O trigger 0099 carimba resolvida_em sozinho ao sair de 'devolvida'; a gestão
        // confere e pode re-devolver (2ª devolução conta reincidência). "Vou voltar
        // depois" não dispara (é pausa, não correção).
        // REGRA DE DESTRAVAMENTO (decisão 15/07): só a RAT devolvida — criada ANTES de
        // devolvida_em — destrava. RAT NOVA (criada depois da devolução, ex.: "Nova RAT
        // de hoje" numa tarefa devolvida) NÃO tira a tarefa de 'devolvida' — senão vira
        // atalho pra limpar devolução sem corrigir e a métrica do painel perde o sentido.
        // devolvida_em null (devoluções pré-0088, legadas): comportamento antigo (destrava).
        const corrigeDevolucao = !tt || !tt.devolvida_em ||
          (rat.criado_em && new Date(rat.criado_em) <= new Date(tt.devolvida_em))
        if (atual === 'devolvida' && rat.status === 'registrado' && !ehPausa && corrigeDevolucao) {
          await sb.from('tarefas').update({ status: 'concluida' }).eq('id', rat.tarefa_id)
        }
      }
    }

    // 5) ACK do servidor: recebido_em carimbado → confirmado.
    //    Guarda contra corrida (caso 04895): se o técnico salvou DURANTE o envio (ex.: encerrou
    //    a RAT enquanto as fotos subiam), o sync_status local já não é 'enviando' e o retrato que
    //    subiu está velho — NÃO confirma; volta pra fila e a rodada extra (refazer) reenvia.
    const local = await D().obterRat(rat.client_uuid)
    if (!local || local.sync_status !== D().STATUS.ENVIANDO) {
      await D().definirStatus(rat.client_uuid, D().STATUS.NA_FILA, 'alterada durante o envio — reenviar')
      refazer = true
    } else if (ups.data.recebido_em) {
      await D().salvarRat(rat.client_uuid, { recebido_em: ups.data.recebido_em, assinatura_url })
      // CAS (apenasSe): fecha a janela restante — se um save escorregar entre a leitura da guarda
      // e esta gravação, o confirmado NÃO aplica (a RAT fica pendente e sobe na próxima rodada).
      await D().definirStatus(rat.client_uuid, D().STATUS.CONFIRMADO, 'recebido pelo servidor', D().STATUS.ENVIANDO)
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
  // Mesma ordem da RAT: 'enviando' primeiro, retrato depois (guarda de corrida do ACK).
  async function enviarPreorc(client_uuid) {
    const sb = getSupabase()
    await D().definirStatusPreorc(client_uuid, D().STATUS.ENVIANDO)
    const po = await D().obterPreorc(client_uuid)
    const uid = po && po.tecnico_id
    if (!uid) throw new Error('Pré-orçamento sem tecnico_id')

    // 1) Fotos pendentes → Storage (pasta do técnico p/ casar com a RLS do bucket).
    //    RESILIENTE: uma foto ilegível NÃO derruba o pré-orçamento inteiro. A leitura que falha
    //    por File file-backed invalidado no iOS (NotReadableError) é marcada como falha permanente
    //    (pulada daqui pra frente, mas NÃO apagada — o técnico re-anexa); erro de rede/servidor é
    //    transitório e será re-tentado. O texto+itens+fotos boas sobem mesmo assim (§12).
    const fotosFalhas = []
    for (const f of await D().listarFotos(po.client_uuid)) {
      if (f.enviada || f.falha_permanente || f.url) continue   // já no Storage ou já sinalizada → não reprocessa
      try {
        const blob = f.blob
        if (!blob || typeof blob.arrayBuffer !== 'function') {
          throw Object.assign(new Error('foto ausente no aparelho'), { name: 'NotReadableError' })
        }
        // CAUSA RAIZ (caso Maicon, StorageApiError "No content provided"): o iOS Safari manda
        // corpo VAZIO quando o body do fetch é um Blob file-backed vindo do IndexedDB — mesmo o
        // blob tendo conteúdo (a miniatura renderiza). Materializa os bytes em memória e sobe um
        // Blob FRESCO: corpo correto E recupera a foto existente sem precisar re-anexar. Só é
        // "ilegível" de verdade se arrayBuffer() falhar ou vier 0 bytes.
        const buf = await blob.arrayBuffer()
        if (!buf || !buf.byteLength) {
          throw Object.assign(new Error('foto vazia no aparelho (0 bytes)'), { name: 'NotReadableError' })
        }
        const body = new Blob([buf], { type: blob.type || 'image/jpeg' })
        const path = `${uid}/${po.client_uuid}/foto-${f.id}.${extDoMime(body.type)}`
        const up = await sb.storage.from(BUCKET).upload(path, body, { upsert: true, contentType: body.type })
        if (up.error) throw up.error
        await D().marcarFotoEnviada(f.id, path)
      } catch (e) {
        // Rede/upserver = transitório → re-tenta. Blob genuinamente ilegível/vazio (arrayBuffer
        // falhou/0 bytes) ou "No content provided" residual = PERMANENTE → sinaliza re-anexar.
        const txt = String((e && (e.message || e.name)) || '')
        const leitura = !!(e && e.name === 'NotReadableError') || /notreadable|could not be read|not be read|no content provided|content provided|0 bytes/i.test(txt)
        const motivo = txt || 'falha ao enviar foto'
        if (leitura) await D().marcarFotoFalha(f.id, motivo)
        fotosFalhas.push({ id: f.id, motivo, permanente: leitura })
        console.warn('[sync] foto pré-orçamento não enviada', f.id, e)
      }
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

    // 4.5) Envio PARCIAL: dados no servidor, mas há foto(s) pendente(s) — ilegíveis no aparelho
    //      (falha_permanente, re-anexar) ou que ainda não subiram (transitório). NÃO confirma
    //      "verde limpo" e SEGURA o e-mail/PDF ao comercial (a etapa 6 fica fora de alcance).
    //      Padrão do bloqueio da RAT: marca 'erro' com mensagem, mas o chamador NÃO conta no toast.
    const fotosPendentes = (await D().listarFotos(po.client_uuid)).filter(f => f.falha_permanente && !f.enviada)
    const transit = fotosFalhas.filter(x => !x.permanente)
    if (fotosPendentes.length || transit.length) {
      await D().salvarPreorc(po.client_uuid, {
        recebido_em: ups.data.recebido_em || null, numero: ups.data.numero || po.numero || null,
        fotos_falhas: fotosFalhas,
      })
      const nPerm = fotosPendentes.length
      const msg = nPerm
        ? `Enviado, mas ${nPerm} foto(s) não puderam ser lidas no aparelho — re-anexe a(s) foto(s).`
        : `Enviado, mas ${transit.length} foto(s) não subiram — nova tentativa no próximo sync.`
      throw Object.assign(new Error(msg), { preorcFotoPendente: true, soTransitorio: nPerm === 0 })
    }
    if (po.fotos_falhas) await D().salvarPreorc(po.client_uuid, { fotos_falhas: null })   // completo → limpa sinalização

    // 5) ACK do servidor: recebido_em carimbado → confirmado (mesma guarda de corrida da RAT:
    //    save durante o envio → não confirma o retrato velho; volta pra fila e reenvia)
    const localPo = await D().obterPreorc(po.client_uuid)
    if (!localPo || localPo.sync_status !== D().STATUS.ENVIANDO) {
      await D().definirStatusPreorc(po.client_uuid, D().STATUS.NA_FILA)
      refazer = true
    } else if (ups.data.recebido_em) {
      await D().salvarPreorc(po.client_uuid, { recebido_em: ups.data.recebido_em, numero: ups.data.numero })
      await D().definirStatusPreorc(po.client_uuid, D().STATUS.CONFIRMADO, D().STATUS.ENVIANDO)   // CAS: não confirma por cima de save que escorregou
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
    // Modelo novo (viagem com trechos): a escrita passa pela Edge Function `viagem-merge`.
    // O RLS de `deslocamentos` só deixa o criador gravar; a função (service role) deixa QUALQUER
    // um a bordo finalizar e mescla por união (preenche vazio, marca conflito quando as horas
    // divergem, preserva criado_por). Só marca confirmado quando a função confirma de verdade —
    // nada de "✓ sincronizado" sobre algo que não subiu.
    if (Array.isArray(d.trechos)) {
      const { data, error } = await sb.functions.invoke('viagem-merge', { body: { trip: d } })
      if (error) {
        // 403 = não está a bordo desta viagem: para de reenviar (a versão canônica chega pelo
        // pull) e evita o loop de permissão. Demais erros sobem e ficam pendentes p/ nova tentativa.
        if (error.context && error.context.status === 403) { await D().marcarDeslocamentoStatus(d.id, D().STATUS.CONFIRMADO); return }
        throw error
      }
      if (data && data.error) throw new Error(data.error)
      await D().marcarDeslocamentoStatus(d.id, D().STATUS.CONFIRMADO)
      return
    }
    // Modelo legado (1 registro = 1 trajeto): só o criador grava (RLS). Mantido p/ dados antigos.
    const { data: { user } } = await sb.auth.getUser()
    if (d.criado_por && user && d.criado_por !== user.id) { await D().marcarDeslocamentoStatus(d.id, D().STATUS.CONFIRMADO); return }
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

  async function syncAll(opts) {
    const manual = !!(opts && opts.manual)   // ação humana explícita (botão): re-tenta itens bloqueados por RLS
    if (!navigator.onLine) return { ok: 0, fail: 0, skipped: true }
    // Rodada em voo: NÃO descarta o pedido (o encerramento da RAT chama syncAll na hora —
    // caso 04895); marca pra rodar de novo assim que a rodada atual terminar.
    if (syncing) { refazer = true; return { ok: 0, fail: 0, skipped: true } }
    syncing = true
    if (typeof window.onSyncStart === 'function') window.onSyncStart()
    let ok = 0, fail = 0
    const PEND = [D().STATUS.SALVO_LOCAL, D().STATUS.NA_FILA, D().STATUS.ERRO]
    window.srCriticalBegin?.()   // guard: SIGNED_OUT durante o push do sync não navega (colado no try → finally garante o End)
    try {
      // Tarefas criadas offline primeiro (RAT depende da tarefa via FK).
      const tlocais = await D().tarefasLocaisPendentes()
      for (const t of tlocais) {
        try { await enviarTarefaLocal(t); ok++ }
        catch (e) { console.warn('[sync] falha tarefa local', t.id, e); fail++ }
      }
      const todas = await D().listarRats()
      // RAT bloqueada por RLS no upsert de rats (42501 — tipicamente aparelho que trocou de
      // login com RAT de outra conta na fila): o retry automático é INTERROMPIDO na sessão
      // (sem spam de erro), e uma nova tentativa acontece quando (a) o dono loga, (b) o login
      // muda em relação ao que estava ativo no bloqueio, ou (c) o técnico aciona o sync
      // manualmente. NÃO apaga nada (§12): a RAT segue no aparelho, rotulada na lista.
      let meId = null
      try { const { data: { user: me } } = await getSupabase().auth.getUser(); meId = me && me.id } catch (e) { /* offline/expirado */ }
      const pend = todas.filter(r => {
        if (!PEND.includes(r.sync_status)) return false
        const bloq = r.envio_bloqueado_rls
        if (!bloq) return true
        if (manual) return true                                          // ação manual explícita
        if (meId && r.tecnico_id && r.tecnico_id === meId) return true   // dono logou → tenta
        const bloqUsuario = (typeof bloq === 'object' && bloq) ? bloq.usuario : null
        if (bloqUsuario && meId && bloqUsuario !== meId) return true     // trocou de login → 1 nova tentativa
        return false                                                     // mesmo login do bloqueio: suprimido
      })
      for (const r of pend) {
        try {
          await D().definirStatus(r.client_uuid, D().STATUS.NA_FILA, 'enfileirado')
          await enviarRat(r.client_uuid)
          ok++
        } catch (e) {
          console.warn('[sync] falha rat', r.client_uuid, e)
          // Somente a recusa de RLS marcada NO UPSERT DE RATS (enviarRat) entra no bloqueio;
          // qualquer outro erro (inclusive 42501 de outra tabela) mantém o retry padrão.
          const rls = !!(e && e.rlsRatsUpsert)
          if (rls) {
            // registro local do bloqueio: quando, sob qual login, e se a propriedade
            // divergente está comprovada pelos dados locais (tecnico_id do registro ≠ logado)
            const provado = !!(meId && r.tecnico_id && r.tecnico_id !== meId)
            await D().salvarRat(r.client_uuid, { envio_bloqueado_rls: { em: new Date().toISOString(), usuario: meId || null, provado } })
            await D().definirStatus(r.client_uuid, D().STATUS.ERRO, provado
              ? 'Esta RAT foi criada por outro usuário neste aparelho. Entre com a conta original para sincronizá-la.'
              : 'Esta RAT não pôde ser sincronizada por restrição de acesso. O conteúdo permanece salvo neste aparelho.')
            // bloqueada NÃO conta no toast (nenhum alerta repetido; o rótulo na lista explica)
          } else {
            await D().definirStatus(r.client_uuid, D().STATUS.ERRO, (e && e.message) || 'erro de envio')
            fail++
          }
        }
      }
      const preorcs = (await D().listarPreorc()).filter(p => PEND.includes(p.sync_status))
      for (const p of preorcs) {
        try {
          await D().definirStatusPreorc(p.client_uuid, D().STATUS.NA_FILA)
          await enviarPreorc(p.client_uuid)
          if (p.sync_erro) await D().salvarPreorc(p.client_uuid, { sync_erro: null, sync_erro_em: null })   // subiu → limpa erro anterior
          ok++
        } catch (e) {
          console.warn('[sync] falha pré-orçamento', p.client_uuid, e)
          // Persiste o erro EXATO no item — antes só havia console.warn (diagnóstico cego).
          // name + message capturam o NotReadableError do iOS (File file-backed invalidado no
          // IndexedDB após o PWA ser morto), além de HTTP/RLS/timeout de qualquer origem.
          const parcial = !!(e && e.preorcFotoPendente)   // envio parcial: dados subiram, falta re-anexar foto — mensagem já amigável
          const msg = (e && (e.message || e.error_description)) || String(e || 'erro de envio')
          const nome = (!parcial && e && e.name && e.name !== 'Error') ? e.name + ': ' : ''
          await D().salvarPreorc(p.client_uuid, { sync_erro: (nome + msg).slice(0, 300), sync_erro_em: new Date().toISOString() })
          await D().definirStatusPreorc(p.client_uuid, D().STATUS.ERRO)
          if (!parcial) fail++   // parcial segue vermelho no badge/lista, mas sem "N item com erro" repetido a cada sync
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
    } finally { syncing = false; window.srCriticalEnd?.() }
    await pullChanges()   // depois de empurrar o local, puxa o que mudou no servidor
    if (typeof window.onSyncDone === 'function') window.onSyncDone({ ok, fail })
    if (refazer) { refazer = false; setTimeout(syncAll, 0) }   // rodada pedida no meio, ou reenvio da guarda do ACK
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
  // Hidrata os FILHOS de cada pré-orçamento baixado (o pai vem no pull, mas itens e
  // fotos não). Roda ANTES do apply do pai, lendo o estado local atual: se houver
  // trabalho local pendente, NÃO mexe (local vence — mesma regra do aplicarDoServidor).
  // Fotos reusam o store de fotos (rat_uuid = client_uuid do pré-orçamento).
  async function hidratarPreorcPull(sb, rows) {
    const list = (rows || []).filter(r => r.id && r.client_uuid)
    if (!list.length) return
    for (const r of list) {
      const loc = await D().obterPreorc(r.client_uuid)
      if (loc && loc.sync_status && loc.sync_status !== D().STATUS.CONFIRMADO) continue   // pendente: preserva local
      try {
        const [ires, fres] = await Promise.all([
          sb.from('pre_orcamento_itens').select('id,produto_id,codigo_produto,descricao,unidade,quantidade,criado_em').eq('pre_orcamento_id', r.id),
          sb.from('relatorio_fotos').select('id,url,legenda,criado_em').eq('pre_orcamento_id', r.id),
        ])
        await D().hidratarItensPreorc(r.client_uuid, ires.data || [])
        let fotos = fres.data || []
        if (fotos.length) {
          const paths = fotos.map(f => f.url).filter(Boolean)
          const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600)
          const sig = {}; (signed || []).forEach(s => { if (s && s.signedUrl) sig[s.path] = s.signedUrl })
          fotos = fotos.map(f => ({ ...f, signedUrl: sig[f.url] || null }))
        }
        await D().hidratarFotosDaRat(r.client_uuid, fotos)
      } catch (e) { console.warn('[pull] preorc filhos', r.numero, e && e.message) }
    }
  }

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
        if (tabela === 'pre_orcamentos') await hidratarPreorcPull(sb, data || [])   // hidrata itens+fotos do pré-orçamento
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

  window.SyncEngine = { syncAll, pullChanges, repararDeslocViagens, hidratarPreorcPull, enviarRat, enviarPreorc, enviarSegmento, enviarDeslocamento, enviarTarefaLocal, start }
})()
