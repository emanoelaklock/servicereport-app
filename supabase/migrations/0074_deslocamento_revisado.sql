-- 0074: revisão de viagem (deslocamento) — o admin marca uma viagem como conferida.
-- Aditivo e seguro (default false; o front antigo não referencia estas colunas). O calendário
-- de deslocamentos usa `revisado` (cor cinza) + filtro "A revisar/Revisados"; editar uma viagem
-- DESFAZ a revisão (salvarViagem zera revisado/revisado_em/revisado_por).
alter table public.deslocamentos
  add column if not exists revisado     boolean not null default false,
  add column if not exists revisado_em  timestamptz,
  add column if not exists revisado_por uuid;

-- DOWN: alter table public.deslocamentos drop column revisado, drop column revisado_em, drop column revisado_por;
