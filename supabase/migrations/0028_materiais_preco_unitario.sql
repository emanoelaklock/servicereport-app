-- Preço por produto utilizado na RAT (editável pelo admin no back-office).
-- Técnico nunca define/vê (sync não envia esta coluna).
alter table public.materiais add column if not exists preco_unitario numeric;
