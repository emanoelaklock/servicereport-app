-- Pendência no nível da Tarefa (quando concluída com pendência pelo técnico).
alter table public.tarefas
  add column if not exists pendencias text;
