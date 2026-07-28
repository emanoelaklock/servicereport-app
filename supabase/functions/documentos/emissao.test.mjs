// Testes da lógica pura da emissão do PDF — `node --test supabase/functions/documentos/`
// Divergência do caso real Nº 14 (Maicon): `data` (dia realizado = 22/07) vs `criado_em`
// (dia do sync = 24/07). O PDF tem que sair com a data de referência (22/07), não a de criação no servidor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emissaoPreorc, fmtData } from './emissao.mjs'

test('pré-orçamento: `data` presente vence `criado_em` (Nº 14: data 22/07 × criado_em 24/07 → 22/07)', () => {
  const po = { data: '2026-07-22T10:20:00+00:00', criado_em: '2026-07-24T12:00:21+00:00' }
  assert.equal(fmtData(emissaoPreorc(po)), '22/07/2026')
})

test('pré-orçamento: sem `data`, cai no `criado_em` (fallback legado)', () => {
  const po = { data: null, criado_em: '2026-07-24T12:00:21+00:00' }
  assert.equal(fmtData(emissaoPreorc(po)), '24/07/2026')
})

test('pré-orçamento: sem `data` e sem `criado_em`, usa a data atual', () => {
  const agora = new Date('2026-07-28T12:00:00+00:00')
  assert.equal(fmtData(emissaoPreorc({}, agora)), '28/07/2026')
})

test('fuso: 22/07 07:20 BRT (10:20Z) formata como 22/07 — não escorrega o dia', () => {
  assert.equal(fmtData(new Date('2026-07-22T10:20:00+00:00')), '22/07/2026')
})
