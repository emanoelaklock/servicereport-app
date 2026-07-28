// Lógica pura da EMISSÃO do PDF — testável em Node (`node --test supabase/functions/documentos/`).
// Sem rede, sem segredo. Reusada pela Edge Function `documentos` (index.ts) e pelo teste.

// Data de EMISSÃO do PRÉ-ORÇAMENTO = data de REFERÊNCIA do pré-orçamento (fixada na criação):
//   1) po.data      — data de referência (dia em que o técnico abriu o levantamento em campo);
//   2) po.criado_em — fallback legado (registros antigos, sem `data`);
//   3) `now`        — só quando ambos estiverem ausentes.
// NÃO altera a regra do orçamento comum (data_envio → criado_em → now), que segue inline no index.ts.
// Motivação (caso Nº 14 / Maicon): o PDF usava `criado_em` (dia do sync = 24/07) em vez de `data`
// (dia realizado = 22/07); corrigir `pre_orcamentos.data` sozinho não bastava — o PDF ignorava a coluna.
export function emissaoPreorc(po, now = new Date()) {
  if (po && po.data) return new Date(po.data)
  if (po && po.criado_em) return new Date(po.criado_em)
  return now
}

// Formata dd/mm/aaaa SEMPRE no fuso America/Sao_Paulo (regra da casa: o documento é do Brasil).
export function fmtData(d) {
  const f = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" })
  const p = {}
  for (const part of f.formatToParts(d)) p[part.type] = part.value
  return `${p.day}/${p.month}/${p.year}`
}
