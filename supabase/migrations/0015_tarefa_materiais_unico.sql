-- Uma linha por (tarefa, produto/material) → Levada editável 1:1; Utilizada casa por match_key.
create unique index if not exists uq_tm_tarefa_matchkey on public.tarefa_materiais (tarefa_id, match_key);

-- Recria a view de conciliação expondo tm_id (id da linha editável de Orçada/Levada).
drop view if exists public.vw_conciliacao_tarefa;
create view public.vw_conciliacao_tarefa as
with plano as (
  select tarefa_id, match_key,
         (array_agg(id order by id))[1] as tm_id,
         max(descricao) as descricao,
         max(codigo_produto) as codigo_produto,
         (array_agg(produto_id) filter (where produto_id is not null))[1] as produto_id,
         max(unidade) as unidade,
         max(preco_unitario) as preco_unitario,
         sum(qtd_orcada) as qtd_orcada,
         sum(qtd_levada) as qtd_levada
  from public.tarefa_materiais
  group by tarefa_id, match_key
),
usado as (
  select r.tarefa_id,
         coalesce(m.produto_id::text, nullif(btrim(lower(m.codigo_produto)), ''), btrim(lower(m.descricao))) as match_key,
         max(m.descricao) as descricao,
         sum(m.quantidade) as qtd_utilizada
  from public.materiais m
  join public.rats r on r.id = m.rat_id
  where m.origem = 'usado' and r.tarefa_id is not null
  group by r.tarefa_id, 2
)
select
  coalesce(p.tarefa_id, u.tarefa_id) as tarefa_id,
  p.tm_id,
  coalesce(p.match_key, u.match_key) as match_key,
  coalesce(p.descricao, u.descricao) as descricao,
  p.codigo_produto,
  p.produto_id,
  p.unidade,
  coalesce(p.preco_unitario, 0) as preco_unitario,
  coalesce(p.qtd_orcada, 0)   as qtd_orcada,
  coalesce(p.qtd_levada, 0)   as qtd_levada,
  coalesce(u.qtd_utilizada, 0) as qtd_utilizada,
  coalesce(p.qtd_levada, 0) - coalesce(u.qtd_utilizada, 0) as qtd_devolvida,
  case
    when coalesce(p.qtd_orcada,0) = 0 and coalesce(u.qtd_utilizada,0) > 0 then 'sem_orcada'
    when coalesce(u.qtd_utilizada,0) > coalesce(p.qtd_levada,0) then 'falta_estoque'
    when coalesce(p.qtd_orcada,0) > 0 and coalesce(u.qtd_utilizada,0) > coalesce(p.qtd_orcada,0) then 'acima_orcado'
    when coalesce(p.qtd_levada,0) > coalesce(u.qtd_utilizada,0) then 'devolver'
    else 'ok'
  end as situacao
from plano p
full join usado u on p.tarefa_id = u.tarefa_id and p.match_key = u.match_key
where public.app_role() in ('admin','gestor_axis','comercial');
