// _shared/tangerino-logic.mjs — funções PURAS de matching/consulta de colaboradores do
// Tangerino, compartilhadas entre as Edge Functions ponto-sync (SR) e portal-usuarios (Hub).
// Extraídas de ponto-sync/logic.mjs SEM mudança de comportamento (ponto-sync re-exporta daqui;
// prova de não-regressão: logic.test.mjs continua 57/57). NADA aqui faz rede, Deno ou I/O.

// ── só dígitos (normalização de CPF) ─────────────────────────────────────────
export const soDigitos = (s) => String(s ?? '').replace(/\D+/g, '')

// ── sugestão de vínculo (roda SÓ NO SERVIDOR; CPF jamais sai daqui) ───────────
// Prioridade: externalId (chave forte, se preenchido no Tangerino com o uuid do SR) >
// CPF normalizado (só dígitos, 11 posições). Nome NUNCA é chave. A sugestão é auxílio:
// quem confirma é humano; nada aqui cria vínculo.
export function sugerirVinculo(colab, usuariosAtivos) {
  const ext = String(colab?.externalId ?? '').trim().toLowerCase()
  if (ext) {
    const u = (usuariosAtivos || []).find((x) => String(x.id).toLowerCase() === ext)
    if (u) return { tecnicoId: u.id, origem: 'externalId' }
  }
  const cpf = soDigitos(colab?.cpf)
  if (cpf.length === 11) {
    const u = (usuariosAtivos || []).find((x) => soDigitos(x.cpf) === cpf)
    if (u) return { tecnicoId: u.id, origem: 'cpf' }
  }
  return null
}

// ── query string do Employer find-all (diagnóstico 22/07 comprovou) ──────────
// `showFired=true` retorna SOMENTE os demitidos ("mostrar OS demitidos", não incluir);
// sem o parâmetro vêm os ATIVOS. Logo: duas consultas independentes, unidas por id.
export function qsEmployerFindAll(page, size, somenteDemitidos) {
  const q = new URLSearchParams({ page: String(page), size: String(size) })
  if (somenteDemitidos) q.set('showFired', 'true')
  return q.toString()
}

// ── união por id com NORMALIZAÇÃO ESTRITA da situação (nunca truthy/falsy) ────
//   fired === true → inativo · fired === false → ativo · qualquer outra coisa → ERRO.
// Inconsistências BLOQUEIAM com erro sanitizado (sem classificar em silêncio):
//   · mesmo id presente como ativo E inativo · registro do conjunto de demitidos com
//   fired !== true · fired ausente/string/número. resignationDate NUNCA classifica.
export function unirColaboradores(ativos, demitidos) {
  const vistos = new Map()
  const problemas = new Set()
  const processa = (lista, conjuntoDemitidos) => {
    for (const p of lista || []) {
      const id = p?.id
      if (id == null) { problemas.add('registro sem id'); continue }
      if (typeof p.fired !== 'boolean') { problemas.add('fired ausente ou não-boolean'); continue }
      if (conjuntoDemitidos && p.fired !== true) { problemas.add('conjunto de demitidos contém registro com fired !== true'); continue }
      if (vistos.has(id)) {
        if (vistos.get(id).fired !== p.fired) problemas.add('mesmo id presente como ativo e inativo')
        continue   // duplicata idêntica: mantém a primeira (união por id)
      }
      vistos.set(id, p)
    }
  }
  processa(ativos, false)
  processa(demitidos, true)
  if (problemas.size) {
    return { erro: `inconsistência na lista de colaboradores: ${[...problemas].join('; ')}`.slice(0, 300) }
  }
  return { colaboradores: [...vistos.values()] }
}
