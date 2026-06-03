-- Remove o campo Impostos do orçamento (não será usado).
alter table public.orcamentos drop column if exists impostos;
