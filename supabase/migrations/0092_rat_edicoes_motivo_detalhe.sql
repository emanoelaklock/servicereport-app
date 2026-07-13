-- 0092: detalhe do motivo "Outro" na edição de RAT (auditoria).
-- O modal do editor só gravava o CÓDIGO do motivo; ao escolher "Outro" não havia campo de texto,
-- então a edição ficava sem explicação (inútil pro histórico/índice de assertividade). Agora o
-- texto livre do "Outro" é gravado aqui. Aditivo/nullable, nada reescrito.

alter table public.rat_edicoes
  add column if not exists motivo_detalhe text;

-- DOWN:
-- alter table public.rat_edicoes drop column if exists motivo_detalhe;
