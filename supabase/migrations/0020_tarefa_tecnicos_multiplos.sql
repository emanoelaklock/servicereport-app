-- Técnicos por Tarefa agora é N:N (múltipla escolha).
create table if not exists public.tarefa_tecnicos (
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  tecnico_id uuid not null,
  criado_em timestamptz not null default now(),
  primary key (tarefa_id, tecnico_id)
);
insert into public.tarefa_tecnicos (tarefa_id, tecnico_id)
select id, tecnico_id from public.tarefas where tecnico_id is not null
on conflict do nothing;

alter table public.tarefa_tecnicos enable row level security;
drop policy if exists tt_office_all on public.tarefa_tecnicos;
create policy tt_office_all on public.tarefa_tecnicos for all
  using (public.app_role() in ('admin','gestor_axis'))
  with check (public.app_role() in ('admin','gestor_axis'));
drop policy if exists tt_tecnico_sel on public.tarefa_tecnicos;
create policy tt_tecnico_sel on public.tarefa_tecnicos for select
  using (public.app_role() = 'tecnico_campo' and tecnico_id = auth.uid());

-- RLS de tarefas: técnico vê/edita as tarefas em que está VINCULADO (N:N)
drop policy if exists os_tecnico_sel on public.tarefas;
create policy os_tecnico_sel on public.tarefas for select
  using (public.app_role() = 'tecnico_campo'
         and exists (select 1 from public.tarefa_tecnicos tt where tt.tarefa_id = tarefas.id and tt.tecnico_id = auth.uid()));
drop policy if exists os_tecnico_upd on public.tarefas;
create policy os_tecnico_upd on public.tarefas for update
  using (public.app_role() = 'tecnico_campo'
         and exists (select 1 from public.tarefa_tecnicos tt where tt.tarefa_id = tarefas.id and tt.tecnico_id = auth.uid()));
-- técnico não cria Tarefa (escritório/edge function fazem) — remove policy de insert dependente
drop policy if exists os_tecnico_ins on public.tarefas;

-- View sem preço do técnico usa o vínculo N:N
create or replace view public.vw_tarefa_materiais_tecnico as
select tm.id, tm.tarefa_id, tm.produto_id, tm.codigo_produto, tm.descricao, tm.unidade,
       tm.qtd_orcada, tm.qtd_levada
from public.tarefa_materiais tm
where exists (
  select 1 from public.tarefas t
  where t.id = tm.tarefa_id
    and (public.app_role() in ('admin','gestor_axis','comercial')
         or exists (select 1 from public.tarefa_tecnicos tt where tt.tarefa_id = t.id and tt.tecnico_id = auth.uid()))
);

-- remove a coluna de atribuição única (substituída pelo N:N)
alter table public.tarefas drop column if exists tecnico_id;
