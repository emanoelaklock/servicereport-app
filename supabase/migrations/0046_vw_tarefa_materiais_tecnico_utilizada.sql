-- View do técnico: Orçado + Levado (tarefa_materiais) + Utilizado (soma de TODAS as RATs).
-- Sem preços. Visível ao técnico atribuído (ou admin/gestor/comercial).
drop view if exists public.vw_tarefa_materiais_tecnico;
create view public.vw_tarefa_materiais_tecnico as
with plano as (
  select tm.tarefa_id, tm.match_key,
    max(tm.descricao) as descricao,
    max(tm.codigo_produto) as codigo_produto,
    (array_agg(tm.produto_id) filter (where tm.produto_id is not null))[1] as produto_id,
    max(tm.unidade) as unidade,
    sum(tm.qtd_orcada) as qtd_orcada,
    sum(tm.qtd_levada) as qtd_levada
  from public.tarefa_materiais tm
  group by tm.tarefa_id, tm.match_key
), usado as (
  select r.tarefa_id,
    coalesce(m.produto_id::text, nullif(btrim(lower(m.codigo_produto)), ''), btrim(lower(m.descricao))) as match_key,
    max(m.descricao) as descricao,
    (array_agg(m.produto_id) filter (where m.produto_id is not null))[1] as produto_id,
    max(m.codigo_produto) as codigo_produto,
    sum(m.quantidade) as qtd_utilizada
  from public.materiais m
  join public.rats r on r.id = m.rat_id
  where m.origem = 'usado' and r.tarefa_id is not null
  group by r.tarefa_id, coalesce(m.produto_id::text, nullif(btrim(lower(m.codigo_produto)), ''), btrim(lower(m.descricao)))
)
select
  coalesce(p.tarefa_id, u.tarefa_id) as tarefa_id,
  coalesce(p.produto_id, u.produto_id) as produto_id,
  coalesce(p.codigo_produto, u.codigo_produto) as codigo_produto,
  coalesce(p.descricao, u.descricao) as descricao,
  p.unidade as unidade,
  coalesce(p.qtd_orcada, 0) as qtd_orcada,
  coalesce(p.qtd_levada, 0) as qtd_levada,
  coalesce(u.qtd_utilizada, 0) as qtd_utilizada
from plano p
full join usado u on p.tarefa_id = u.tarefa_id and p.match_key = u.match_key
where exists (
  select 1 from public.tarefas t
  where t.id = coalesce(p.tarefa_id, u.tarefa_id)
    and (app_role() = any (array['admin','gestor_axis','comercial'])
         or exists (select 1 from public.tarefa_tecnicos tt where tt.tarefa_id = t.id and tt.tecnico_id = auth.uid())));
