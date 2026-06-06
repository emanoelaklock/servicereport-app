-- Base (matriz) para deslocamentos: cidade/UF de onde a equipe sai e para onde volta.
-- Tabela de 1 linha (id fixo = 1). Todos leem; só admin/gestor escreve.
create table if not exists public.org_config (
  id            smallint primary key default 1 check (id = 1),
  base_cidade   text,
  base_uf       text,
  atualizado_em timestamptz default now()
);
insert into public.org_config (id) values (1) on conflict (id) do nothing;

alter table public.org_config enable row level security;

drop policy if exists org_config_read on public.org_config;
create policy org_config_read on public.org_config for select using (true);

drop policy if exists org_config_write on public.org_config;
create policy org_config_write on public.org_config
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
