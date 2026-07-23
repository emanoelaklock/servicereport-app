// node --test — funções puras do módulo compartilhado. Cobre o contrato que ponto-sync e
// portal-usuarios dependem: normalização de CPF, sugestão (externalId > CPF), query string
// do find-all e união estrita ativos+demitidos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { soDigitos, sugerirVinculo, qsEmployerFindAll, unirColaboradores } from './tangerino-logic.mjs'

test('soDigitos remove tudo que não é dígito', () => {
  assert.equal(soDigitos('123.456.789-09'), '12345678909')
  assert.equal(soDigitos(null), '')
  assert.equal(soDigitos(undefined), '')
  assert.equal(soDigitos('abc'), '')
})

test('sugerirVinculo: externalId tem prioridade sobre CPF', () => {
  const us = [{ id: 'AABB-uuid', cpf: '111' }, { id: 'other', cpf: '12345678909' }]
  const r = sugerirVinculo({ externalId: 'aabb-uuid', cpf: '12345678909' }, us)
  assert.deepEqual(r, { tecnicoId: 'AABB-uuid', origem: 'externalId' })
})

test('sugerirVinculo: cai no CPF quando não há externalId', () => {
  const us = [{ id: 'u1', cpf: '123.456.789-09' }]
  const r = sugerirVinculo({ externalId: '', cpf: '12345678909' }, us)
  assert.deepEqual(r, { tecnicoId: 'u1', origem: 'cpf' })
})

test('sugerirVinculo: CPF com != 11 dígitos não casa', () => {
  assert.equal(sugerirVinculo({ cpf: '123' }, [{ id: 'u1', cpf: '123' }]), null)
})

test('sugerirVinculo: sem correspondência → null', () => {
  assert.equal(sugerirVinculo({ cpf: '99999999999' }, [{ id: 'u1', cpf: '12345678909' }]), null)
})

test('qsEmployerFindAll: sem showFired por padrão; com quando demitidos', () => {
  assert.equal(qsEmployerFindAll(0, 200, false), 'page=0&size=200')
  assert.equal(qsEmployerFindAll(1, 50, true), 'page=1&size=50&showFired=true')
})

test('unirColaboradores: une ativos e demitidos por id, sem duplicar', () => {
  const r = unirColaboradores(
    [{ id: 1, fired: false }, { id: 2, fired: false }],
    [{ id: 3, fired: true }],
  )
  assert.ok(!('erro' in r))
  assert.equal(r.colaboradores.length, 3)
  assert.deepEqual(r.colaboradores.map((c) => c.id).sort(), [1, 2, 3])
})

test('unirColaboradores: fired não-boolean → erro sanitizado', () => {
  const r = unirColaboradores([{ id: 1, fired: 'x' }], [])
  assert.ok('erro' in r)
  assert.match(r.erro, /fired ausente ou não-boolean/)
})

test('unirColaboradores: registro sem id → erro', () => {
  const r = unirColaboradores([{ fired: false }], [])
  assert.ok('erro' in r)
  assert.match(r.erro, /registro sem id/)
})

test('unirColaboradores: conjunto de demitidos com fired!==true → erro', () => {
  const r = unirColaboradores([], [{ id: 5, fired: false }])
  assert.ok('erro' in r)
  assert.match(r.erro, /conjunto de demitidos/)
})

test('unirColaboradores: mesmo id ativo e inativo → erro', () => {
  const r = unirColaboradores([{ id: 7, fired: false }], [{ id: 7, fired: true }])
  assert.ok('erro' in r)
  assert.match(r.erro, /ativo e inativo/)
})

test('unirColaboradores: duplicata idêntica mantém a primeira (sem erro)', () => {
  const r = unirColaboradores([{ id: 9, fired: false }, { id: 9, fired: false }], [])
  assert.ok(!('erro' in r))
  assert.equal(r.colaboradores.length, 1)
})
