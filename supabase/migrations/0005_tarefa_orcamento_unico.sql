-- #4.4 — Status do orçamento: "aprovado gera Tarefa".
-- No máximo UMA Tarefa (OS interna) por orçamento → idempotência do aprovar.
-- orcamento_id nulo (Tarefa avulsa) não é restrito pelo índice parcial.
-- A criação da Tarefa é feita server-side (Edge Function aprovar-orcamento),
-- porque o papel `comercial` não tem RLS de escrita em public.tarefas.
create unique index if not exists uq_tarefas_orcamento
  on public.tarefas (orcamento_id) where orcamento_id is not null;
