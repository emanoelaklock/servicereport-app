-- GPS no início (saída) e fim (chegada) do trajeto de deslocamento.
alter table public.deslocamentos
  add column if not exists saida_lat double precision,
  add column if not exists saida_lng double precision,
  add column if not exists saida_precisao numeric,
  add column if not exists chegada_lat double precision,
  add column if not exists chegada_lng double precision,
  add column if not exists chegada_precisao numeric;
