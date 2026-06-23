-- 0075: conflito de finalização colaborativa da viagem.
-- A partir de agora QUALQUER técnico a bordo pode finalizar a viagem (não só quem criou) —
-- a escrita passa pela Edge Function `viagem-merge`, que mescla por união. Quando dois
-- aparelhos lançam valores DIFERENTES pro mesmo campo de hora (saída/chegada/refeição) de um
-- trecho, o valor existente é mantido e a divergência é REGISTRADA aqui pro admin resolver —
-- nunca sobrescrita em silêncio (mesmo princípio da RAT colaborativa).
--
-- `conflito` = array JSON de entradas:
--   [{ "trecho_ordem": 2, "campo": "chegada_em", "servidor": "...", "recebido": "...",
--      "por": "<uuid do técnico>", "em": "<timestamptz>" }]
-- null/[]  = sem conflito. O portal mostra um selo "⚠ conflito — revisar" quando há entradas.
-- Aditivo e seguro: default null; o front antigo não referencia esta coluna.
alter table public.deslocamentos
  add column if not exists conflito jsonb;

-- DOWN: alter table public.deslocamentos drop column conflito;
