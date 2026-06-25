-- 0086: motivo da devolução da tarefa.
-- Quando o admin devolve a tarefa ao técnico (status 'devolvida'), grava aqui o motivo
-- (o que precisa corrigir). O técnico vê esse texto no detalhe da Tarefa e no contexto da RAT.
-- Aditivo e seguro: coluna nova, nullable.
alter table public.tarefas add column if not exists motivo_devolucao text;
