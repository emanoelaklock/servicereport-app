-- Faturamento passa a ser por Tarefa (não por RAT).
alter table public.tarefas
  add column if not exists faturado boolean not null default false,
  add column if not exists data_faturamento timestamptz,
  add column if not exists numero_nota text;
