// Gates da correção "conexão do IndexedDB morta pelo iOS" (F21, caso Arian) — roda o
// js/db-local.js REAL em Node sobre um IndexedDB falso com interruptor de morte.
// Cobre os DOIS modos de morte do WebKit:
//   1. conexão morta em repouso → transaction() lança InvalidStateError (síncrono);
//   2. morte EM VOO → transação aborta com t.error NULO (o db-local materializa AbortError).
// E prova as duas obrigações do retry: recupera (reabre e completa) e grava UMA vez
// (idempotência — transação abortada não commita nada; re-rodar o fn não duplica).
// Uso: node test/db-local-conexao-morta.test.mjs   (sai com código 1 se algum gate falhar)
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── ambiente browser mínimo ──
global.window = globalThis
global.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) }, removeItem(k) { delete this._m[k] } }

// ── IndexedDB falso (só o que o db-local usa) com interruptor de morte ──
// Semântica fiel no que importa pro teste: escrita fica num buffer e SÓ vai pro disco no
// commit (transação atômica — abort descarta tudo); add duplicado → ConstraintError;
// close() explícito NÃO dispara onclose (spec); morte anormal dispara (como o WebKit).
const discos = new Map()          // nome do banco → { stores: Map<nome, {keyPath, indexes, dados}> }
const conexoes = []               // toda conexão aberta, na ordem (a última é a viva)
const cont = { opens: 0, transacoes: 0 }   // transacoes conta TENTATIVAS (inclui a que lança)
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))

class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; this.onupgradeneeded = null; this.onblocked = null; this.result = undefined; this.error = null } }

class FakeStore {
  constructor(tx, backing) { this._tx = tx; this._b = backing }
  index(nome) {
    const campo = this._b.indexes.get(nome), b = this._b, tx = this._tx
    return {
      getAll: (k) => tx._req(() => [...b.dados.values()].filter(v => v[campo] === k).map(clone)),
      getAllKeys: (k) => tx._req(() => [...b.dados.entries()].filter(([, v]) => v[campo] === k).map(([kk]) => kk)),
    }
  }
  add(v) {
    return this._tx._req(() => {
      if (this._tx._quota) throw new DOMException('Quota exceeded.', 'QuotaExceededError')
      const k = v[this._b.keyPath]
      if (this._b.dados.has(k) || this._tx._buffer.some(op => op.b === this._b && op.tipo === 'put' && op.chave === k))
        throw new DOMException('Key already exists in the object store.', 'ConstraintError')
      this._tx._buffer.push({ b: this._b, tipo: 'put', chave: k, valor: clone(v) })
    })
  }
  put(v) { return this._tx._req(() => { this._tx._buffer.push({ b: this._b, tipo: 'put', chave: v[this._b.keyPath], valor: clone(v) }) }) }
  get(k) { return this._tx._req(() => clone(this._b.dados.get(k))) }
  getAll() { return this._tx._req(() => [...this._b.dados.values()].map(clone)) }
  delete(k) { return this._tx._req(() => { this._tx._buffer.push({ b: this._b, tipo: 'delete', chave: k }) }) }
}

class FakeTransaction {
  constructor(conn) {
    this._conn = conn; this._buffer = []; this._pend = 0; this._fim = false
    this.oncomplete = null; this.onerror = null; this.onabort = null; this.error = null
    // interruptores armados na conexão, consumidos pela PRÓXIMA transação
    this._abortarEmVoo = conn._abortarProximaTx; conn._abortarProximaTx = false
    this._quota = conn._quotaProximaTx; conn._quotaProximaTx = false
    this._agendarCommit()
  }
  objectStore(nome) { return new FakeStore(this, this._conn._disco.stores.get(nome)) }
  _req(work) {
    const r = new FakeRequest()
    this._pend++
    queueMicrotask(() => {
      if (this._fim) return
      try { r.result = work(); this._pend-- } catch (e) {
        this._pend--; r.error = e
        if (r.onerror) r.onerror()
        this._abortar(e)          // erro de request aborta a transação com esse erro
        return
      }
      if (r.onsuccess) r.onsuccess()
      this._agendarCommit()
    })
    return r
  }
  _abortar(e) {
    if (this._fim) return
    this._fim = true; this._buffer = []       // abort: NADA commita
    this.error = e || null                    // morte em voo do WebKit: t.error vem NULO
    if (this.onabort) this.onabort()
  }
  _agendarCommit() {
    // macrotask: deixa as cadeias get().then(put) (microtasks) emitirem os follow-ups antes
    setTimeout(() => {
      if (this._fim || this._pend > 0) return
      if (this._abortarEmVoo) return this._abortar(null)
      this._fim = true
      for (const op of this._buffer) op.tipo === 'delete' ? op.b.dados.delete(op.chave) : op.b.dados.set(op.chave, op.valor)
      if (this.oncomplete) this.oncomplete()
    }, 0)
  }
}

class FakeConn {
  constructor(disco) {
    this._disco = disco; this._morta = false
    this._abortarProximaTx = false; this._quotaProximaTx = false
    this.onversionchange = null; this.onclose = null
    this.objectStoreNames = { contains: (n) => disco.stores.has(n) }
  }
  createObjectStore(nome, { keyPath }) {
    const st = { keyPath, indexes: new Map(), dados: new Map(), createIndex(n, campo) { st.indexes.set(n, campo) } }
    this._disco.stores.set(nome, st)
    return st
  }
  transaction(stores, mode) {
    cont.transacoes++
    if (this._morta) throw new DOMException('The database connection is closing.', 'InvalidStateError')
    return new FakeTransaction(this)
  }
  close() { this._morta = true }   // close explícito: sem evento onclose (spec)
}

global.indexedDB = {
  open(nome) {
    const req = new FakeRequest()
    queueMicrotask(() => {
      let disco = discos.get(nome)
      const novo = !disco
      if (novo) { disco = { stores: new Map() }; discos.set(nome, disco) }
      const conn = new FakeConn(disco)
      cont.opens++; conexoes.push(conn)
      req.result = conn
      if (novo && req.onupgradeneeded) req.onupgradeneeded({ target: { result: conn } })
      if (req.onsuccess) req.onsuccess()
    })
    return req
  },
}

// mata a conexão como o iOS: viva → defunta. comOnclose=true reproduz o evento que o
// WebKit dispara na morte anormal; false reproduz o zumbi silencioso (só se descobre no uso).
function matar(conn, { comOnclose } = { comOnclose: false }) {
  conn._morta = true
  if (comOnclose && conn.onclose) conn.onclose()
}
const atual = () => conexoes[conexoes.length - 1]

// ── carrega o db-local.js REAL ──
new Function(readFileSync(join(raiz, 'js', 'db-local.js'), 'utf8'))()
const D = window.DBLocal
D.setUser('u-teste')

let falhas = 0
const gate = (nome, cond, extra) => { const ok = !!cond; if (!ok) falhas++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + nome + (extra ? '  [' + extra + ']' : '')) }

// ── G0: baseline — grava e lê com a conexão sã ──
await D.novoRat({ client_uuid: 'rat-1', tarefa_id: 't1' })
await D.adicionarFoto('rat-1', { fake: 'blob-1' }, null)
gate('G0a baseline: RAT criada + foto gravada', (await D.listarFotos('rat-1')).length === 1)
gate('G0b baseline: tem_foto refletido na RAT', (await D.obterRat('rat-1')).tem_foto === true)
gate('G0c baseline: 1 conexão aberta', cont.opens === 1, 'opens=' + cont.opens)

// ── G1: caso Arian — câmera mata a conexão em silêncio (zumbi); gravar foto DEVE recuperar ──
let t0 = cont.transacoes
matar(atual())                                        // sem onclose: só se descobre ao usar
await D.adicionarFoto('rat-1', { fake: 'blob-2' }, null)
let fotos = await D.listarFotos('rat-1')
gate('G1a conexão zumbi (InvalidStateError): foto gravada mesmo assim', fotos.length === 2)
gate('G1b gravou UMA vez (sem duplicata no retry)', new Set(fotos.map(f => f.id)).size === 2)
gate('G1c reabriu exatamente 1 conexão nova', cont.opens === 2, 'opens=' + cont.opens)

// ── G2: morte EM VOO (abort com t.error nulo) na escrita que gera uuid DENTRO do fn ──
// novoRat grava a RAT + evento 'criado' (uuid novo a cada rodada do fn) na MESMA transação:
// é o pior caso de idempotência — a prova de que a 1ª tentativa abortada não deixou rastro.
matar(atual())                                        // caso composto: derruba o cache de novo…
atual(); await D.listarRats()                         // …reabre pela leitura (caminho ro)
atual()._abortarProximaTx = true                      // …e arma o abort em voo na conexão viva
await D.novoRat({ client_uuid: 'rat-2', tarefa_id: 't2' })
const rats2 = (await D.listarRats()).filter(r => r.client_uuid === 'rat-2')
const evts2 = await D.listarEventos({ client_uuid: 'rat-2' })
gate('G2a abort em voo: RAT gravada na retentativa', rats2.length === 1)
gate('G2b idempotência: exatamente 1 evento "criado" (fn re-rodado do zero, sem eco da 1ª)',
  evts2.filter(e => e.evento === 'criado').length === 1, 'eventos=' + evts2.length)

// ── G3: onclose (morte anunciada, como o WebKit faz): próxima operação nem tropeça ──
t0 = cont.transacoes
matar(atual(), { comOnclose: true })                  // o handler onclose derruba o cache na hora
await D.adicionarFoto('rat-1', { fake: 'blob-3' }, null)
gate('G3a pós-onclose: operação completa normal', (await D.listarFotos('rat-1')).length === 3)
gate('G3b sem tentativa na conexão defunta (cache já limpo; 2 tx = escrita + leitura)',
  cont.transacoes - t0 === 2, 'delta=' + (cont.transacoes - t0))

// ── G4: erro de DADO não é retentado — ConstraintError sobe e nada duplica ──
t0 = cont.transacoes
let erroG4 = null
await D.novoRat({ client_uuid: 'rat-1' }).catch(e => { erroG4 = e })
gate('G4a add duplicado: ConstraintError sobe pro chamador', erroG4 && erroG4.name === 'ConstraintError', erroG4 && erroG4.name)
gate('G4b sem retry (1 única tentativa de transação)', cont.transacoes - t0 === 1, 'delta=' + (cont.transacoes - t0))
gate('G4c disco intacto (rat-1 única)', (await D.listarRats()).filter(r => r.client_uuid === 'rat-1').length === 1)

// ── G5: quota cheia não é retentada (retry não salvaria; erro precisa aparecer) ──
t0 = cont.transacoes
atual()._quotaProximaTx = true
let erroG5 = null
await D.adicionarFoto('rat-1', { fake: 'blob-4' }, null).catch(e => { erroG5 = e })
gate('G5a QuotaExceededError sobe pro chamador', erroG5 && erroG5.name === 'QuotaExceededError', erroG5 && erroG5.name)
gate('G5b sem retry de quota', cont.transacoes - t0 === 1, 'delta=' + (cont.transacoes - t0))
gate('G5c nada gravado', (await D.listarFotos('rat-1')).length === 3)

// ── G6: leitura avulsa (ro) também recupera de conexão zumbi ──
t0 = cont.transacoes; const opens0 = cont.opens
matar(atual())
fotos = await D.listarFotos('rat-1')
gate('G6a leitura recupera (retry do ro)', fotos.length === 3)
gate('G6b 1 tentativa falha + 1 boa, 1 reabertura', cont.transacoes - t0 === 2 && cont.opens - opens0 === 1,
  'tx=' + (cont.transacoes - t0) + ' opens=' + (cont.opens - opens0))

console.log(falhas ? `\n${falhas} gate(s) FALHARAM` : '\nTodos os gates passaram')
process.exit(falhas ? 1 : 0)
