-- Status de Tarefa configuráveis (criar/editar nome e cor na tela de Configurações).
-- Os status do sistema (sistema=true) têm automação amarrada e ficam protegidos
-- (não podem ser apagados/desativados; nome e cor são editáveis).
create table if not exists public.status_tarefa (
  chave     text primary key,
  label     text not null,
  cor       text not null default '#48506A',
  ordem     int  not null default 100,
  sistema   boolean not null default false,
  ativo     boolean not null default true,
  criado_em timestamptz default now()
);
alter table public.status_tarefa enable row level security;
drop policy if exists status_read on public.status_tarefa;
create policy status_read on public.status_tarefa for select using (true);
drop policy if exists status_write on public.status_tarefa;
create policy status_write on public.status_tarefa for all
  using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));

insert into public.status_tarefa (chave,label,cor,ordem,sistema) values
 ('aguardando_execucao','Aguardando execução','#B7791F',10,true),
 ('em_execucao','Em execução','#1C54B8',20,true),
 ('concluida','Concluída','#0E9F6E',30,true),
 ('concluida_pendencia','Concluída c/ pendência','#DC2626',40,true),
 ('devolvida','Devolvida','#C2410C',50,true),
 ('aprovada_faturamento','Aprovada p/ faturamento','#0F766E',60,true),
 ('faturada','Faturada','#1B2A4A',70,true)
on conflict (chave) do nothing;
