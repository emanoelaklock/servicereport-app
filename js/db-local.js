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
  const DB_VERSION = 1
  const ST_RATS = 'rats'
  const ST_FOTOS = 'fotos'
  const ST_EVENTOS = 'eventos'

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
    enviando:    ['confirmado', 'erro'],
    erro:        ['na_fila'],          // retry
    confirmado:  [],                   // terminal
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
  let _dbp = null
  function db() {
    if (_dbp) return _dbp
    _dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
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
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
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
  async function salvarRat(client_uuid, patch = {}) {
    return tx([ST_RATS], 'readwrite', (t) => {
      const s = t.objectStore(ST_RATS)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
        const next = { ...cur, ...patch, client_uuid, atualizado_em: agora() }
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
  async function definirStatus(client_uuid, novo, detalhe) {
    return tx([ST_RATS, ST_EVENTOS], 'readwrite', (t) => {
      const s = t.objectStore(ST_RATS)
      reqP(s.get(client_uuid)).then((cur) => {
        if (!cur) return
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
    return tx([ST_RATS, ST_FOTOS, ST_EVENTOS], 'readwrite', (t) => {
      t.objectStore(ST_RATS).delete(client_uuid)
      const fi = t.objectStore(ST_FOTOS).index('rat_uuid')
      reqP(fi.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_FOTOS).delete(k)))
      const ei = t.objectStore(ST_EVENTOS).index('client_uuid')
      reqP(ei.getAllKeys(client_uuid)).then(keys => keys.forEach(k => t.objectStore(ST_EVENTOS).delete(k)))
    })
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

  async function fotosPendentes(client_uuid) {
    return (await listarFotos(client_uuid)).filter(f => !f.enviada)
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

  window.DBLocal = {
    STATUS, TRANSICOES,
    deviceId, uuid,
    novoRat, salvarRat, obterRat, listarRats, definirStatus, removerRat,
    adicionarFoto, listarFotos, removerFoto, marcarFotoEnviada, fotosPendentes,
    listarEventos, marcarEventoEnviado,
  }
})()
