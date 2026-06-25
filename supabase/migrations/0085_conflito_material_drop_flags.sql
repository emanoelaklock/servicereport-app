-- 0085: limpeza — remove as flags NÃO usadas do conflito de material.
-- A detecção é 100% DERIVADA (vw_rat_material_conflito); estas colunas (criadas na 0083 p/ a
-- abordagem original com trigger, depois descartada) nunca foram escritas. Sem dado a perder.
-- Mantém o índice materiais(rat_id) (a view usa).
alter table public.materiais drop column if exists conflito;
alter table public.rats      drop column if exists material_conflito;
