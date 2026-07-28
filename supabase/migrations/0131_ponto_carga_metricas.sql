-- 0131 — C3: métricas adicionais da carga histórica na trilha ponto_sync_execucoes.
--
-- A carga (tipo 'carga_historica', já permitido no CHECK desde a 0126) precisa registrar,
-- além de novas/atualizadas/pendentes/ignoradas/inválidas, três contadores conservadores
-- para observabilidade e para o acompanhamento do R2/R3 durante o uso:
--   · inalteradas          — reimportação idempotente (mesmo lastModifiedDate; nada mudou);
--   · abertas              — marcações com dateOut nulo (saida null), preservadas;
--   · excluidas_sinalizadas — marcações com excluded=true (preservadas no espelho, NUNCA
--                             apagadas fisicamente — a reconciliação definitiva segue pendente).
-- Não altera dados nem RLS de leitura; a escrita continua só por service_role (a Edge).

alter table public.ponto_sync_execucoes
  add column if not exists inalteradas int not null default 0,
  add column if not exists abertas int not null default 0,
  add column if not exists excluidas_sinalizadas int not null default 0;

-- Reafirma a vedação a anon (padrão 0127) — idempotente; leitura só admin/gestor (RLS já posta).
revoke all on table public.ponto_sync_execucoes from anon;
revoke all on table public.ponto_marcacoes from anon;
