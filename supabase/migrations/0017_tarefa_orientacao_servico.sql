-- A orientação ao técnico nasce com o serviço aprovado no orçamento.
-- (Daqui pra frente isso é feito pela Edge Function aprovar-orcamento; aqui só o backfill.)
update public.tarefas t
set orientacao = o.servico_descricao
from public.orcamentos o
where t.orcamento_id = o.id
  and coalesce(t.orientacao, '') = ''
  and coalesce(o.servico_descricao, '') <> '';
