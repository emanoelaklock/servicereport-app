-- Ajuste do Orçamento (módulo Comercial):
-- Serviço passa a ser DESCRIÇÃO LIVRE + VALOR ÚNICO no próprio orçamento
-- (não é mais item de tabela). orcamento_itens guarda só MATERIAIS (material/avulso).
-- Campos novos para o PDF: prazo_execucao, impostos.
alter table public.orcamentos
  add column if not exists servico_descricao text,
  add column if not exists servico_valor numeric default 0,
  add column if not exists prazo_execucao text,
  add column if not exists impostos text;

-- Migra serviços já existentes (1 por orçamento) para as novas colunas.
update public.orcamentos o set
  servico_descricao = s.descricao,
  servico_valor = coalesce(s.subtotal, s.quantidade * s.preco_unitario, 0)
from (
  select distinct on (orcamento_id) orcamento_id, descricao, subtotal, quantidade, preco_unitario
  from public.orcamento_itens where tipo = 'servico'
  order by orcamento_id, criado_em
) s
where s.orcamento_id = o.id;

delete from public.orcamento_itens where tipo = 'servico';
