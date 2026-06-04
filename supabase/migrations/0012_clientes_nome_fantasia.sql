-- Preserva razão social e nome fantasia separadamente; `nome` passa a ser o nome de exibição
-- (fantasia preferida, com fallback para razão social).
alter table public.clientes
  add column if not exists razao_social text,
  add column if not exists nome_fantasia text;
