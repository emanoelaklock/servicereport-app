-- GPS do atendimento na RAT (reusa checkin_lat/lng; + precisão e timestamp).
alter table public.rats
  add column if not exists checkin_precisao numeric,
  add column if not exists checkin_em timestamptz;
