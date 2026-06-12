-- Ref. Tarefa por TRECHO: a tarefa em aberto pertence ao cliente do destino
-- daquele trecho. deslocamento_tarefas segue existindo como agregado derivado
-- (união das tarefas dos trechos) para listas/relatórios.
alter table public.deslocamento_trechos
  add column if not exists tarefa_id uuid references public.tarefas(id);
create index if not exists idx_trechos_tarefa on public.deslocamento_trechos (tarefa_id);
