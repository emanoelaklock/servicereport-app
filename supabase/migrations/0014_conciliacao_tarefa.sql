-- #5.1 Conciliação de material no nível da Tarefa (5 colunas).
-- Orçada + Levada vivem aqui (nível Tarefa); Utilizada vem das RATs (materiais, origem 'usado').

create table if not exists public.tarefa_materiais (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  produto_id uuid references public.produtos(id),
  codigo_produto text,
  descricao text not null,
  unidade text,
  preco_unitario numeric not null default 0,   -- oculto do técnico (ver view sem preço)
  qtd_orcada numeric not null default 0,        -- comercial (vem do orçamento; trava no aprovado)
  qtd_levada numeric not null default 0,        -- administrativo (saída de estoque)
  origem text not null default 'orcamento' check (origem in ('orcamento','avulso')),
  match_key text generated always as (
    coalesce(produto_id::text, nullif(btrim(lower(codigo_produto)), ''), btrim(lower(descricao)))
  ) stored,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists ix_tm_tarefa on public.tarefa_materiais (tarefa_id);
create index if not exists ix_tm_produto on public.tarefa_materiais (produto_id);

create or replace function public.fn_touch_tarefa_materiais() returns trigger
language plpgsql as $$ begin new.atualizado_em = now(); return new; end $$;
drop trigger if exists trg_touch_tm on public.tarefa_materiais;
create trigger trg_touch_tm before update on public.tarefa_materiais
for each row execute function public.fn_touch_tarefa_materiais();

-- RLS: escritório (admin/gestor/comercial) acesso total; técnico não lê a base (preço).
alter table public.tarefa_materiais enable row level security;
drop policy if exists tm_office_all on public.tarefa_materiais;
create policy tm_office_all on public.tarefa_materiais for all
  using (public.app_role() in ('admin','gestor_axis','comercial'))
  with check (public.app_role() in ('admin','gestor_axis','comercial'));

-- View de conciliação (5 colunas) — nível Tarefa. Escritório apenas (expõe preço).
create or replace view public.vw_conciliacao_tarefa as
with plano as (
  select tarefa_id, match_key,
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

-- View sem preço para o técnico: vê Orçada e Levada (leitura) das próprias tarefas.
create or replace view public.vw_tarefa_materiais_tecnico as
select tm.id, tm.tarefa_id, tm.produto_id, tm.codigo_produto, tm.descricao, tm.unidade,
       tm.qtd_orcada, tm.qtd_levada
from public.tarefa_materiais tm
where exists (
  select 1 from public.tarefas t
  where t.id = tm.tarefa_id
    and (public.app_role() in ('admin','gestor_axis','comercial') or t.tecnico_id = auth.uid())
);
