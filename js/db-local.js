/* ═══════════════════════════════════════════════
   Service Report — db-local.js
   Camada local-first (IndexedDB). SEM dependência de rede/Supabase.
   Responsável por: client_uuid + device_id no aparelho, RATs e fotos
   guardadas offline, máquina de sync_status e trilha local de sync_eventos.
   A subida para o Supabase é responsabilidade do sync.js (passo 5).

   Exposto como window.DBLocal (API toda baseada em Promise).
═══════════════════════════════════════════════ */
(function () {
  const DB_NAME = 'service_report'
  const DB_VERSION = 6
  const ST_RATS = 'rats'
  const ST_FOTOS = 'fotos'
  const ST_EVENTOS = 'eventos'
  const ST_MATERIAIS = 'materiais'
  const ST_PREORC = 'preorcamentos'      // pré-orçamentos (artefato de campo, #4.2)
  const ST_PREORC_ITENS = 'preorc_itens' // materiais NECESSÁRIOS do pré-orçamento
  const ST_SEGMENTOS = 'segmentos'       // jornada "dia contínuo" (§10.1)
  const ST_DESLOC = 'deslocamentos'      // deslocamento (pernoite) — trajetos offline
  const ST_TAREFAS = 'tarefas_local'     // tarefas criadas pelo técnico offline (fila)

  // ── Estados de sincronização (brief) ──
  const STATUS = {
    RASCUNHO: 'rascunho',
    SALVO_LOCAL: 'salvo_local',
    NA_FILA: 'na_fila',
    ENVIANDO: 'enviando',
    CONFIRMADO: 'confirmado',
    ERRO: 'erro',
  }
  // Transições permitidas: rascunho → salvo_local → na_fila → enviando → confirmado | erro
  const TRANSICOES = {
    rascunho:    ['rascunho', 'salvo_local'],
    salvo_local: ['salvo_local', 'na_fila', 'rascunho'],
    na_fila:     ['enviando', 'erro', 'na_fila'],
    enviando:    ['confirmado', 'erro', 'salvo_local'],   // salvo_local = técnico salvou DURANTE o envio; a guarda do ACK (sync.js) não confirma o retrato velho e reenvia
    erro:        ['na_fila'],          // retry
    confirmado:  ['salvo_local'],      // reabrir RAT confirmada p/ correção (devolução)
  }

  // ── device_id persistente (uma vez por aparelho) ──
  function deviceId() {
    let id = localStorage.getItem('sr_device_id')
    if (!id) { id = uuid(); localStorage.setItem('sr_device_id', id) }
    return id
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID()
    // fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0]) % 16
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  function agora() { return new Date().toISOString() }

  // ── Abertura/migração do banco ──
  // ── Instrumentação de diagnóstico (branch diag/encerramento-hang-db) ──
  // Loga passos do DB/salvar no console e, com SR_DB_DEBUG on, na TELA via toast — localiza o
  // congelamento do encerramento no aparelho SEM CPU profile. Global pro tecnico.js reusar.
  // OFF em produção (só liga na investigação): evita toasts/overlay "TRAVOU" na tela do técnico.
  // Os breadcrumbs srStep/srDbg continuam gravando em console/localStorage — inofensivos.
  window.SR_DB_DEBUG = false
  window.srDbg = function (msg, nivel) {
    ;(nivel === 'warn' ? console.warn : console.info)('[diag] ' + msg)
    if (window.SR_DB_DEBUG && typeof toast === 'function') { try { toast(msg, nivel === 'warn' ? 'err' : '') } catch (e) { /* nada */ } }
  }
  // Breadcrumb SÍNCRONO (localStorage) — sobrevive a main-thread travado (toast NÃO pinta num
  // bloqueio síncrono). Escreve o passo ANTES de cada operação; após força-fechar+reabrir, o
  // último valor = passo onde o thread morreu. Surfaceado no load (init do tecnico.js).
  window.srStep = function (label) {
    var now = Date.now()
    try {
      // Trilha (reset a cada 'click:'): guarda os últimos passos COM timestamp → o delta entre
      // passos consecutivos diz se o congelamento foi imediato no passo X ou se algo antes
      // degradou N ms. localStorage é síncrono → sobrevive ao main-thread travado.
      var arr = /^⟳/.test(label) ? [] : (JSON.parse(localStorage.getItem('sr_diag_trail') || '[]') || [])
      if (!Array.isArray(arr)) arr = []
      arr.push(label + ' @' + now)
      if (arr.length > 12) arr = arr.slice(-12)
      localStorage.setItem('sr_diag_trail', JSON.stringify(arr))
      localStorage.setItem('sr_diag_step', label + ' @' + now)   // último (compat/fallback)
    } catch (e) { /* nada */ }
    console.info('[step] ' + label + ' @' + now)
  }

  let _dbp = null, _dbConn = null, _uid = null
  // Escopo POR USUÁRIO: cada login tem seu próprio IndexedDB (service_report_u_<uid>). Sem isso,
  // dois logins no mesmo aparelho misturavam RATs/tarefas (risco de faturamento). O banco legado
  // ('service_report') é preservado (não apaga trabalho não-sincronizado de quem usou antes).
  function setUser(uid) {
    uid = uid || null
    if (uid === _uid) return
    _uid = uid
    if (_dbConn) { try { _dbConn.close() } catch (e) { /* nada */ } _dbConn = null }
    _dbp = null   // próxima db() reabre no banco do usuário atual
  }
  function dbName() {
    let u = _uid
    if (!u) { try { u = localStorage.getItem('sr_last_uid') } catch (e) { u = null } }
    // Recusa abrir o banco legado/compartilhado: sem usuário, falha alto em vez de mostrar
    // (ou gravar em) um banco vazio/errado — o "sumiço" silencioso de RATs vinha daqui.
    if (!u) throw new Error('DBLocal: sem usuário — recusando abrir banco (evita banco legado vazio)')
    return 'service_report_u_' + u
  }
  function db() {
    if (_dbp) return _dbp
    // dbName() pode lançar (sem usuário) — chamada ANTES de cachear _dbp, pra não prender uma
    // promise rejeitada: a próxima chamada (já com usuário definido) reabre normalmente.
    const _name = dbName()
    _dbp = new Promise((resolve, reject) => {
      window.srDbg && window.srDbg('db: abrindo ' + _name)
      const req = indexedDB.open(_name, DB_VERSION)
      // Watchdog anti-hang (só em debug): se o open não resolver em 8s (blocked/travado), falha
      // ALTO em vez de pendurar pra sempre; limpa _dbp pra a próxima chamada reabrir.
      const _wd = window.SR_DB_DEBUG ? setTimeout(function () {
        window.srDbg && window.srDbg('db: OPEN TIMEOUT (8s) — provável BLOQUEADO', 'warn')
        _dbp = null; reject(new Error('DBLocal: open timeout (possível blocked)'))
      }, 8000) : null
      req.onupgradeneeded = (e) => {
        const d = e.target.result
        if (!d.objectStoreNames.contains(ST_RATS)) {
          const s = d.createObjectStore(ST_RATS, { keyPath: 'client_uuid' })
          s.createIndex('sync_status', 'sync_status', { unique: false })
          s.createIndex('criado_em', 'criado_em', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_FOTOS)) {
          const s = d.createObjectStore(ST_FOTOS, { keyPath: 'id' })
          s.createIndex('rat_uuid', 'rat_uuid', { unique: false })
          s.createIndex('enviada', 'enviada', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_EVENTOS)) {
          const s = d.createObjectStore(ST_EVENTOS, { keyPath: 'id' })
          s.createIndex('client_uuid', 'client_uuid', { unique: false })
          s.createIndex('enviado', 'enviado', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_MATERIAIS)) {
          const s = d.createObjectStore(ST_MATERIAIS, { keyPath: 'id' })
          s.createIndex('rat_uuid', 'rat_uuid', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_PREORC)) {
          const s = d.createObjectStore(ST_PREORC, { keyPath: 'client_uuid' })
          s.createIndex('sync_status', 'sync_status', { unique: false })
          s.createIndex('criado_em', 'criado_em', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_PREORC_ITENS)) {
          const s = d.createObjectStore(ST_PREORC_ITENS, { keyPath: 'id' })
          s.createIndex('preorc_uuid', 'preorc_uuid', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_SEGMENTOS)) {
          const s = d.createObjectStore(ST_SEGMENTOS, { keyPath: 'id' })
          s.createIndex('data', 'data', { unique: false })
          s.createIndex('sync_status', 'sync_status', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_DESLOC)) {
          const s = d.createObjectStore(ST_DESLOC, { keyPath: 'id' })
          s.createIndex('sync_status', 'sync_status', { unique: false })
        }
        if (!d.objectStoreNames.contains(ST_TAREFAS)) {
          const s = d.createObjectStore(ST_TAREFAS, { keyPath: 'id' })
          s.createIndex('sync_status', 'sync_status', { unique: false })
        }
      }
      req.onblocked = () => { window.srDbg && window.srDbg('db: BLOQUEADO (open travado por outra conexão aberta)', 'warn') }
      req.onsuccess = () => {
        if (_wd) clearTimeout(_wd)
        _dbConn = req.result
        // onversionchange: se outra aba/instância quiser subir de versão, ESTA conexão cede (fecha)
        // em vez de bloquear o upgrade — metade preventiva do fix (um DB que não pendura em bloqueio).
        _dbConn.onversionchange = () => { window.srDbg && window.srDbg('db: onversionchange → fechando esta conexão', 'warn'); try { _dbConn.close() } catch (e) { /* nada */ } _dbConn = null; _dbp = null }
        window.srDbg && window.srDbg('db: ok ' + _name)
        resolve(req.result)
      }
      req.onerror = () => { if (_wd) clearTimeout(_wd); window.srDbg && window.srDbg('db: ERRO no open: ' + (req.error && req.error.message), 'warn'); reject(req.error) }
    })
    return _dbp
  }

  // helper: roda uma transação e resolve quando ela completa
  async function tx(stores, mode, fn) {
    const d = await db()
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode)
      let out
      t.oncomplete = () => resolve(out)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
      out = fn(t)
    })
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

  // ── Eventos (trilha local imutável; sync.js sobe para sync_eventos) ──
  async function _registrarEvento(t, client_uuid, evento, detalhe) {
    const reg = {
      id: uuid(),
      client_uuid,
      device_id: deviceId(),
      evento,
      detalhe: detalhe || null,
      em: agora(),
      enviado: 0,           // 0 = pendente de subir; 1 = já registrado no servidor
    }
    t.objectStore(ST_EVENTOS).add(reg)
    return reg
  }

  // ── RATs ──
  // Cria uma nova RAT local com client_uuid e device_id. Nasce 'rascunho'.
  async function novoRat(dados = {}) {
    const client_uuid = dados.client_uuid || uuid()
    const rat = {
      client_uuid,
      device_id: deviceId(),
      origem_registro: 'nativo',
      sync_status: STATUS.RASCUNHO,
      tem_foto: false,
      tem_assinatura: false,
      questionario_ok: false,
      respostas: null,
      recebido_em: null,
      criado_em: agora(),
      atualizado_em: agora(),
      ...dados,
    }
    await tx([ST_RATS, ST_EVENTOS], 'readwrite', (t) => {
      t.objectStore(ST_RATS).add(rat)
      _registrarEvento(t, client_uuid, 'criado', null)
    })
    return rat
  }

  // Merge parcial de campos numa RAT existente. Atualiza atualizado_em.
  // Carimbo local por campo (respostas_ts): quando `respostas` muda, cada chave
  // alterada ganha o horário do aparelho NAQUELE momento — matéria-prima da
  // métrica "Preenchimento online" (v2.1) e da proteção de campos (registra
  // QUANDO o técnico realmente preencheu cada coisa, independente do sync).
  async function salvarRat(client_uuid, patch = {}) {
    return tx([ST_RATS], 'readwrite', (t) => {
      const s = t.objectStore(ST_RATS)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
        const next = { ...cur, ...patch, client_uuid, atualizado_em: agora() }
        if (patch.respostas !== undefined) {
          const antes = cur.respostas || {}
          const depois = patch.respostas || {}
          const ts = { ...(cur.respostas_ts || {}) }
          const chaves = new Set([...Object.keys(antes), ...Object.keys(depois)])
          for (const k of chaves) {
            if (String(depois[k] ?? '') !== String(antes[k] ?? '')) ts[k] = agora()
          }
          next.respostas_ts = ts
        }
        // recomputa relatorio_completo localmente (espelho do server)
        next.relatorio_completo = !!(next.tem_foto && next.tem_assinatura && next.questionario_ok)
        s.put(next)
      })
    }).then(() => obterRat(client_uuid))
  }

  async function obterRat(client_uuid) {
    const d = await db()
    return reqP(d.transaction(ST_RATS).objectStore(ST_RATS).get(client_uuid))
  }

  // Lista RATs (opcionalmente filtra por status). Ordena por criado_em desc.
  async function listarRats({ status } = {}) {
    const d = await db()
    const s = d.transaction(ST_RATS).objectStore(ST_RATS)
    const all = await reqP(s.getAll())
    const arr = status ? all.filter(r => r.sync_status === status) : all
    return arr.sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''))
  }

  // Muda o sync_status validando a transição e registrando o evento.
  // `apenasSe`: compare-and-set atômico (dentro da tx) — só aplica se o status atual for esse.
  // Usado pelo ACK do sync pra não confirmar por cima de um save que chegou durante o envio.
  async function definirStatus(client_uuid, novo, detalhe, apenasSe) {
    return tx([ST_RATS, ST_EVENTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_RATS)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
        if (apenasSe && cur.sync_status !== apenasSe) return
        const atual = cur.sync_status
        const ok = (TRANSICOES[atual] || []).includes(novo)
        if (!ok && atual !== novo) {
          console.warn(`[DBLocal] transição inesperada ${atual} → ${novo} (${client_uuid})`)
        }
        const patch = { ...cur, sync_status: novo, atualizado_em: agora() }
        if (novo === STATUS.CONFIRMADO && !patch.recebido_em) patch.recebido_em = agora()
        s.put(patch)
        _registrarEvento(t, client_uuid, novo, detalhe)
      })
    }).then(() => obterRat(client_uuid))
  }

  async function removerRat(client_uuid) {
    return tx([ST_RATS, ST_FOTOS, ST_EVENTOS, ST_MATERIAIS], 'readwrite', (t) => {
      t.objectStore(ST_RATS).delete(client_uuid)
      const fi = t.objectStore(ST_FOTOS).index('rat_uuid')
      reqP(fi.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_FOTOS).delete(k)))
      const ei = t.objectStore(ST_EVENTOS).index('client_uuid')
      reqP(ei.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_EVENTOS).delete(k)))
      const mi = t.objectStore(ST_MATERIAIS).index('rat_uuid')
      reqP(mi.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_MATERIAIS).delete(k)))
    })
  }

  // ── Materiais utilizados (catálogo de produtos) ──
  async function adicionarMaterial(client_uuid, m) {
    const reg = {
      id: uuid(), rat_uuid: client_uuid,
      produto_id: m.produto_id || null, codigo_produto: m.codigo_produto || null,
      descricao: m.descricao || null, unidade: m.unidade || null,
      quantidade: Number(m.quantidade) || 0, qtd_levada: (m.qtd_levada != null ? Number(m.qtd_levada) : null),
      qtd_orcada: (m.qtd_orcada != null ? Number(m.qtd_orcada) : null),
      qtd_usada_tarefa: (m.qtd_usada_tarefa != null ? Number(m.qtd_usada_tarefa) : null),
      created_by: _uid || null, device_id: deviceId(),   // autor real da linha (conflito de material colaborativo)
      criado_em: agora(),
    }
    await tx([ST_MATERIAIS], 'readwrite', (t) => { t.objectStore(ST_MATERIAIS).add(reg) })
    return reg.id
  }
  async function atualizarMaterial(id, patch) {
    return tx([ST_MATERIAIS], 'readwrite', (t) => {
      const s = t.objectStore(ST_MATERIAIS)
      reqP(s.get(id)).then(m => { if (m) { Object.assign(m, patch); if (patch.quantidade != null) m.quantidade = Number(patch.quantidade) || 0; s.put(m) } })
    })
  }
  async function listarMateriais(client_uuid) {
    const d = await db()
    const idx = d.transaction(ST_MATERIAIS).objectStore(ST_MATERIAIS).index('rat_uuid')
    const arr = await reqP(idx.getAll(client_uuid))
    return arr.sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''))
  }
  async function removerMaterial(id) {
    return tx([ST_MATERIAIS], 'readwrite', (t) => t.objectStore(ST_MATERIAIS).delete(id))
  }

  // ── Hidratação dos filhos na DEVOLUÇÃO (descida) ──
  // O pull traz a linha `rats`, mas material/foto moram em tabelas-filhas que NÃO entram no
  // SYNC_MAP (sem atualizado_em). Quando o admin devolve a tarefa (ou completa a RAT), o técnico
  // reabre e precisa ver tudo. Estas funções trazem os filhos do servidor pro store local.
  // Merge por `id` (não apaga nada local) — usado só quando a RAT está sincronizada (sem trabalho
  // local pendente), então o conjunto do servidor é a verdade.
  async function hidratarMateriaisDaRat(client_uuid, serverMats) {
    if (!Array.isArray(serverMats) || !serverMats.length) return
    await tx([ST_MATERIAIS], 'readwrite', (t) => {
      const s = t.objectStore(ST_MATERIAIS)
      for (const m of serverMats) {
        reqP(s.get(m.id)).then((cur) => {
          s.put({
            id: m.id, rat_uuid: client_uuid,
            produto_id: m.produto_id || (cur && cur.produto_id) || null,
            codigo_produto: m.codigo_produto || (cur && cur.codigo_produto) || null,
            descricao: m.descricao || (cur && cur.descricao) || null,
            unidade: m.unidade || (cur && cur.unidade) || null,
            quantidade: Number(m.quantidade) || 0,
            // o servidor NÃO carrega o plano da tarefa (orçada/levada) — preserva o que já está local
            // (senão a RAT reaberta perde "Orçado/Disponibilizado"). precarregarLevados re-preenche se faltar.
            qtd_levada: (cur && cur.qtd_levada != null) ? cur.qtd_levada : null,
            qtd_orcada: (cur && cur.qtd_orcada != null) ? cur.qtd_orcada : null,
            qtd_usada_tarefa: (cur && cur.qtd_usada_tarefa != null) ? cur.qtd_usada_tarefa : null,
            created_by: m.created_by || (cur && cur.created_by) || null,
            device_id: m.device_id || (cur && cur.device_id) || null,
            criado_em: m.criado_em || (cur && cur.criado_em) || agora(),
          })
        })
      }
    })
  }
  async function hidratarFotosDaRat(client_uuid, serverFotos) {
    if (!Array.isArray(serverFotos) || !serverFotos.length) return
    await tx([ST_FOTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_FOTOS)
      for (const f of serverFotos) {
        reqP(s.get(f.id)).then((cur) => {
          s.put({
            id: f.id, rat_uuid: client_uuid,
            // PRESERVA o blob local (cópia offline da foto): re-hidratar NÃO pode destruí-lo, senão
            // a galeria fica refém da URL assinada (expira em 1h / pode falhar) e a foto some.
            blob: (cur && cur.blob) || null,
            legenda: f.legenda || (cur && cur.legenda) || null,
            // url = PATH (fonte da verdade p/ re-upload e re-assinar). NUNCA gravar a URL assinada aqui:
            // ela expira em 1h e o re-envio a persistiria em relatorio_fotos.url → fotos somem. preview = só exibir.
            url: f.url || (cur && cur.url) || null,
            preview: f.signedUrl || (cur && cur.preview) || null,
            enviada: 1, criado_em: f.criado_em || (cur && cur.criado_em) || agora(),
          })
        })
      }
    })
  }

  // Hidrata os ITENS de um pré-orçamento vindos do servidor (pull em outro aparelho).
  // Espelha hidratarMateriaisDaRat: merge por `id`, sem preço (técnico nunca vê preço).
  // Só é chamado quando o pré-orçamento NÃO tem trabalho local pendente.
  async function hidratarItensPreorc(client_uuid, serverItens) {
    if (!Array.isArray(serverItens) || !serverItens.length) return
    await tx([ST_PREORC_ITENS], 'readwrite', (t) => {
      const s = t.objectStore(ST_PREORC_ITENS)
      for (const m of serverItens) {
        reqP(s.get(m.id)).then((cur) => {
          s.put({
            id: m.id, preorc_uuid: client_uuid,
            produto_id: m.produto_id || (cur && cur.produto_id) || null,
            codigo_produto: m.codigo_produto || (cur && cur.codigo_produto) || null,
            descricao: m.descricao || (cur && cur.descricao) || null,
            unidade: m.unidade || (cur && cur.unidade) || null,
            quantidade: Number(m.quantidade) || 0,
            criado_em: m.criado_em || (cur && cur.criado_em) || agora(),
          })
        })
      }
    })
  }

  // ── Pré-orçamentos (artefato de campo, #4.2) ──
  // Mesma máquina de sync_status das RATs. Fotos reutilizam o store ST_FOTOS
  // (rat_uuid = client_uuid do pré-orçamento). Sem trilha de eventos (sync_eventos
  // exige rat_id) — pré-orçamento é um artefato mais leve.
  async function novoPreorc(dados = {}) {
    const client_uuid = dados.client_uuid || uuid()
    const reg = {
      client_uuid,
      device_id: deviceId(),
      sync_status: STATUS.RASCUNHO,
      tem_foto: false,
      respostas: null,
      recebido_em: null,
      criado_em: agora(),
      atualizado_em: agora(),
      ...dados,
    }
    await tx([ST_PREORC], 'readwrite', (t) => { t.objectStore(ST_PREORC).add(reg) })
    return reg
  }

  async function salvarPreorc(client_uuid, patch = {}) {
    return tx([ST_PREORC], 'readwrite', (t) => {
      const s = t.objectStore(ST_PREORC)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
        s.put({ ...cur, ...patch, client_uuid, atualizado_em: agora() })
      })
    }).then(() => obterPreorc(client_uuid))
  }

  async function obterPreorc(client_uuid) {
    const d = await db()
    return reqP(d.transaction(ST_PREORC).objectStore(ST_PREORC).get(client_uuid))
  }

  async function listarPreorc({ status } = {}) {
    const d = await db()
    const s = d.transaction(ST_PREORC).objectStore(ST_PREORC)
    const all = await reqP(s.getAll())
    const arr = status ? all.filter(r => r.sync_status === status) : all
    return arr.sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''))
  }

  async function definirStatusPreorc(client_uuid, novo, apenasSe) {
    return tx([ST_PREORC], 'readwrite', (t) => {
      const s = t.objectStore(ST_PREORC)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
        if (apenasSe && cur.sync_status !== apenasSe) return
        const patch = { ...cur, sync_status: novo, atualizado_em: agora() }
        if (novo === STATUS.CONFIRMADO && !patch.recebido_em) patch.recebido_em = agora()
        s.put(patch)
      })
    }).then(() => obterPreorc(client_uuid))
  }

  async function removerPreorc(client_uuid) {
    return tx([ST_PREORC, ST_PREORC_ITENS, ST_FOTOS], 'readwrite', (t) => {
      t.objectStore(ST_PREORC).delete(client_uuid)
      const ii = t.objectStore(ST_PREORC_ITENS).index('preorc_uuid')
      reqP(ii.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_PREORC_ITENS).delete(k)))
      const fi = t.objectStore(ST_FOTOS).index('rat_uuid')
      reqP(fi.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_FOTOS).delete(k)))
    })
  }

  // Materiais NECESSÁRIOS (sem preço — técnico nunca vê preço).
  async function adicionarItemPreorc(client_uuid, m) {
    const reg = {
      id: uuid(), preorc_uuid: client_uuid,
      produto_id: m.produto_id || null, codigo_produto: m.codigo_produto || null,
      descricao: m.descricao || null, unidade: m.unidade || null,
      quantidade: Number(m.quantidade) || 0, criado_em: agora(),
    }
    await tx([ST_PREORC_ITENS], 'readwrite', (t) => { t.objectStore(ST_PREORC_ITENS).add(reg) })
    return reg.id
  }
  async function listarItensPreorc(client_uuid) {
    const d = await db()
    const idx = d.transaction(ST_PREORC_ITENS).objectStore(ST_PREORC_ITENS).index('preorc_uuid')
    const arr = await reqP(idx.getAll(client_uuid))
    return arr.sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''))
  }
  async function removerItemPreorc(id) {
    return tx([ST_PREORC_ITENS], 'readwrite', (t) => t.objectStore(ST_PREORC_ITENS).delete(id))
  }

  // ── Fotos (blobs guardados offline) ──
  async function adicionarFoto(client_uuid, blob, legenda) {
    const foto = { id: uuid(), rat_uuid: client_uuid, blob, legenda: legenda || null, url: null, enviada: 0, criado_em: agora() }
    await tx([ST_FOTOS, ST_RATS], 'readwrite', (t) => {
      t.objectStore(ST_FOTOS).add(foto)
      const s = t.objectStore(ST_RATS)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
        const next = { ...cur, tem_foto: true, atualizado_em: agora() }
        next.relatorio_completo = !!(next.tem_foto && next.tem_assinatura && next.questionario_ok)
        s.put(next)
      })
    })
    return foto.id
  }

  async function listarFotos(client_uuid) {
    const d = await db()
    const idx = d.transaction(ST_FOTOS).objectStore(ST_FOTOS).index('rat_uuid')
    const arr = await reqP(idx.getAll(client_uuid))
    return arr.sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''))
  }

  async function removerFoto(id) {
    return tx([ST_FOTOS], 'readwrite', (t) => t.objectStore(ST_FOTOS).delete(id))
  }

  // Marca foto como enviada (guarda a url do Storage). Usado pelo sync.js.
  async function marcarFotoEnviada(id, url) {
    return tx([ST_FOTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_FOTOS)
      reqP(s.get(id)).then((cur) => { if (cur) s.put({ ...cur, enviada: 1, url }) })
    })
  }

  // Marca foto como ILEGÍVEL no aparelho (blob file-backed invalidado no iOS): o envio a pula
  // daqui pra frente, mas ela NÃO é apagada — fica sinalizada p/ o técnico re-anexar (§12).
  async function marcarFotoFalha(id, motivo) {
    return tx([ST_FOTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_FOTOS)
      reqP(s.get(id)).then((cur) => { if (cur) s.put({ ...cur, falha_permanente: 1, falha_motivo: motivo || null }) })
    })
  }

  async function fotosPendentes(client_uuid) {
    return (await listarFotos(client_uuid)).filter(f => !f.enviada)
  }

  // Atualiza a legenda de uma foto (editável no app de campo).
  async function atualizarLegendaFoto(id, legenda) {
    return tx([ST_FOTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_FOTOS)
      reqP(s.get(id)).then((cur) => { if (cur) s.put({ ...cur, legenda: legenda || null }) })
    })
  }

  // ── Eventos: leitura/baixa pelo sync.js ──
  async function listarEventos({ client_uuid, pendentes } = {}) {
    const d = await db()
    const s = d.transaction(ST_EVENTOS).objectStore(ST_EVENTOS)
    let arr = await reqP(s.getAll())
    if (client_uuid) arr = arr.filter(e => e.client_uuid === client_uuid)
    if (pendentes) arr = arr.filter(e => !e.enviado)
    return arr.sort((a, b) => (a.em || '').localeCompare(b.em || ''))
  }

  async function marcarEventoEnviado(id) {
    return tx([ST_EVENTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_EVENTOS)
      reqP(s.get(id)).then((cur) => { if (cur) s.put({ ...cur, enviado: 1 }) })
    })
  }

  // ── Jornada "dia contínuo" (§10.1): segmentos contíguos ──
  async function salvarSegmento(seg) {
    if (!seg.id) seg.id = uuid()
    if (!seg.device_id) seg.device_id = deviceId()
    if (!seg.criado_em) seg.criado_em = agora()
    seg.sync_status = STATUS.NA_FILA
    seg.atualizado_em = agora()
    await tx([ST_SEGMENTOS], 'readwrite', (t) => { t.objectStore(ST_SEGMENTOS).put(seg) })
    return seg
  }
  async function obterSegmento(id) {
    const d = await db()
    return reqP(d.transaction(ST_SEGMENTOS).objectStore(ST_SEGMENTOS).get(id))
  }
  async function listarSegmentos(data) {
    const d = await db()
    const all = await reqP(d.transaction(ST_SEGMENTOS).objectStore(ST_SEGMENTOS).getAll())
    const arr = data ? all.filter(s => s.data === data) : all
    return arr.sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''))
  }
  async function segmentoAberto(data) {
    const arr = await listarSegmentos(data)
    return arr.find(s => !s.fim) || null
  }
  async function segmentosPendentes() {
    const d = await db()
    const all = await reqP(d.transaction(ST_SEGMENTOS).objectStore(ST_SEGMENTOS).getAll())
    return all.filter(s => s.sync_status !== STATUS.CONFIRMADO)
  }
  async function marcarSegmentoStatus(id, novo) {
    return tx([ST_SEGMENTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_SEGMENTOS)
      reqP(s.get(id)).then(cur => { if (cur) { cur.sync_status = novo; if (novo === STATUS.CONFIRMADO) cur.recebido_em = agora(); s.put(cur) } })
    })
  }
  async function removerSegmento(id) {
    return tx([ST_SEGMENTOS], 'readwrite', (t) => { t.objectStore(ST_SEGMENTOS).delete(id) })
  }

  // ── Deslocamento (pernoite): trajeto offline (técnicos a bordo no array .tecnicos) ──
  async function salvarDeslocamento(d) {
    if (!d.id) d.id = uuid()
    if (!d.device_id) d.device_id = deviceId()
    if (!d.criado_em) d.criado_em = agora()
    d.sync_status = STATUS.NA_FILA
    d.atualizado_em = agora()
    await tx([ST_DESLOC], 'readwrite', (t) => { t.objectStore(ST_DESLOC).put(d) })
    return d
  }
  async function listarDeslocamentos() {
    const dd = await db()
    const all = await reqP(dd.transaction(ST_DESLOC).objectStore(ST_DESLOC).getAll())
    return all.sort((a, b) => (b.saida_em || '').localeCompare(a.saida_em || ''))
  }
  async function deslocamentosPendentes() {
    const dd = await db()
    const all = await reqP(dd.transaction(ST_DESLOC).objectStore(ST_DESLOC).getAll())
    return all.filter(x => x.sync_status !== STATUS.CONFIRMADO && !x.tombstoned)   // tombstoned: não reenviar
  }
  async function marcarDeslocamentoStatus(id, novo) {
    return tx([ST_DESLOC], 'readwrite', (t) => {
      const s = t.objectStore(ST_DESLOC)
      reqP(s.get(id)).then(c => { if (c) { c.sync_status = novo; if (novo === STATUS.CONFIRMADO) c.recebido_em = agora(); s.put(c) } })
    })
  }
  async function removerDeslocamento(id) { return tx([ST_DESLOC], 'readwrite', (t) => { t.objectStore(ST_DESLOC).delete(id) }) }

  // ── Tarefas criadas pelo técnico offline (fila de envio) ──
  async function salvarTarefaLocal(t) {
    if (!t.id) t.id = uuid()
    if (!t.criado_em) t.criado_em = agora()
    t.sync_status = STATUS.NA_FILA
    await tx([ST_TAREFAS], 'readwrite', (tt) => { tt.objectStore(ST_TAREFAS).put(t) })
    return t
  }
  async function listarTarefasLocais() {
    const dd = await db()
    return reqP(dd.transaction(ST_TAREFAS).objectStore(ST_TAREFAS).getAll())
  }
  async function tarefasLocaisPendentes() {
    return (await listarTarefasLocais()).filter(x => x.sync_status !== STATUS.CONFIRMADO)
  }
  async function removerTarefaLocal(id) { return tx([ST_TAREFAS], 'readwrite', (t) => { t.objectStore(ST_TAREFAS).delete(id) }) }

  // ───────── Sync genérico (delta-pull + realtime) ─────────
  // Mapa nome-da-tabela → store local. Usado pelo SyncEngine para reconciliar.
  // table → { store, keyPath }
  const SYNC_MAP = {
    deslocamentos:     { store: ST_DESLOC, key: 'id' },
    jornada_segmentos: { store: ST_SEGMENTOS, key: 'id' },
    rats:              { store: ST_RATS, key: 'client_uuid' },
    // pré-orçamentos passam a ser BAIXADOS (antes só subiam): o técnico reabre em
    // qualquer aparelho. Filhos (itens/fotos) hidratados no sync (hidratarPreorcPull).
    pre_orcamentos:    { store: ST_PREORC, key: 'client_uuid' },
  }
  const storeKeyPath = (store) => (Object.values(SYNC_MAP).find(m => m.store === store) || { key: 'id' }).key
  async function obterPorChave(store, chave) {
    const dd = await db()
    return reqP(dd.transaction(store).objectStore(store).get(chave))
  }
  async function listarStore(store) {
    const dd = await db()
    return reqP(dd.transaction(store).objectStore(store).getAll())
  }
  // Grava uma linha vinda do SERVIDOR (já confirmada). Não mexe se a cópia local
  // estiver pendente de envio (preserva edição offline não sincronizada).
  async function aplicarDoServidor(store, row) {
    const chave = row[storeKeyPath(store)]
    if (chave == null) return false
    const atual = await obterPorChave(store, chave)
    if (atual && atual.sync_status && atual.sync_status !== STATUS.CONFIRMADO) return false // pendente: local vence
    const novo = Object.assign({}, atual || {}, row)
    novo.sync_status = STATUS.CONFIRMADO
    if (!novo.recebido_em) novo.recebido_em = agora()
    await tx([store], 'readwrite', (t) => { t.objectStore(store).put(novo) })
    return true
  }
  // Remove uma linha local porque foi excluída no servidor (só se confirmada).
  // Pendente NÃO é apagada sozinha (§12) — ganha a marca `tombstoned`: a UI avisa
  // ("removido pelo escritório") e o sync para de reenviar, senão o registro
  // ressuscita no servidor a cada sync e o admin nunca consegue excluir.
  async function removerDoServidor(store, chave) {
    const atual = await obterPorChave(store, chave)
    if (atual && atual.sync_status && atual.sync_status !== STATUS.CONFIRMADO) {
      if (!atual.tombstoned) {
        atual.tombstoned = true
        await tx([store], 'readwrite', (t) => { t.objectStore(store).put(atual) })
      }
      return false
    }
    await tx([store], 'readwrite', (t) => { t.objectStore(store).delete(chave) })
    return !!atual
  }

  window.DBLocal = {
    STATUS, TRANSICOES,
    deviceId, uuid, setUser,
    salvarSegmento, obterSegmento, listarSegmentos, segmentoAberto, segmentosPendentes, marcarSegmentoStatus, removerSegmento,
    salvarDeslocamento, listarDeslocamentos, deslocamentosPendentes, marcarDeslocamentoStatus, removerDeslocamento,
    salvarTarefaLocal, listarTarefasLocais, tarefasLocaisPendentes, removerTarefaLocal,
    SYNC_MAP, obterPorChave, listarStore, aplicarDoServidor, removerDoServidor,
    novoRat, salvarRat, obterRat, listarRats, definirStatus, removerRat,
    adicionarFoto, listarFotos, removerFoto, marcarFotoEnviada, marcarFotoFalha, fotosPendentes, atualizarLegendaFoto,
    adicionarMaterial, atualizarMaterial, listarMateriais, removerMaterial,
    hidratarMateriaisDaRat, hidratarFotosDaRat, hidratarItensPreorc,
    novoPreorc, salvarPreorc, obterPreorc, listarPreorc, definirStatusPreorc, removerPreorc,
    adicionarItemPreorc, listarItensPreorc, removerItemPreorc,
    listarEventos, marcarEventoEnviado,
  }
})()
