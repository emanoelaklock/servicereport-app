-- Observação livre da conciliação de material (seriais de equipamentos, lotes, notas).
alter table public.tarefas
  add column if not exists conciliacao_obs text;
