-- Remove o CHECK fixo de status: agora os valores são dirigidos pela tabela
-- status_tarefa (permite status personalizados criados em Configurações).
alter table public.tarefas drop constraint if exists tarefas_status_check;
