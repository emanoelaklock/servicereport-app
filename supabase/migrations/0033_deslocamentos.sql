-- Deslocamento (pernoite) — controle/log. Cada TRAJETO (perna) é um registro:
-- veículo + técnicos a bordo + origem→destino + saída/chegada + sentido (ida/volta).
-- Ida e volta são registros separados (cobre recombinação de técnicos/carros).
create table if not exists public.deslocamentos (
  id          uuid primary key default gen_random_uuid(),
  sentido     text not null default 'ida' check (sentido in ('ida','volta','outro')),
  veiculo_id  uuid references public.veiculos(id),
  cliente_id  uuid references public.clientes(id),
  origem      text,
  destino     text,
  saida_em    timestamptz,
  chegada_em  timestamptz,
  motivo      text,
  criado_por  uuid references public.usuarios(id),
  criado_em   timestamptz default now()
);
create table if not exists public.deslocamento_tecnicos (
  deslocamento_id uuid not null references public.deslocamentos(id) on delete cascade,
  tecnico_id      uuid not null references public.usuarios(id),
  primary key (deslocamento_id, tecnico_id)
);
create index if not exists idx_desloc_cliente on public.deslocamentos (cliente_id);
create index if not exists idx_desloc_saida on public.deslocamentos (saida_em);
create index if not exists idx_desloc_tec on public.deslocamento_tecnicos (tecnico_id);

alter table public.deslocamentos enable row level security;
alter table public.deslocamento_tecnicos enable row level security;

create policy desloc_office_all on public.deslocamentos
  for all using (app_role() = any (array['admin','gestor_axis'])) with check (app_role() = any (array['admin','gestor_axis']));
create policy desloc_comercial_read on public.deslocamentos
  for select using (app_role() = 'comercial');
create policy desloc_tecnico_own on public.deslocamentos
  for all using (app_role() = 'tecnico_campo' and criado_por = auth.uid())
  with check (app_role() = 'tecnico_campo' and criado_por = auth.uid());
create policy desloc_tecnico_aboard_read on public.deslocamentos
  for select using (exists (select 1 from public.deslocamento_tecnicos dt where dt.deslocamento_id = deslocamentos.id and dt.tecnico_id = auth.uid()));

create policy dt_office_all on public.deslocamento_tecnicos
  for all using (app_role() = any (array['admin','gestor_axis'])) with check (app_role() = any (array['admin','gestor_axis']));
create policy dt_comercial_read on public.deslocamento_tecnicos
  for select using (app_role() = 'comercial');
create policy dt_tecnico_manage on public.deslocamento_tecnicos
  for all using (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()))
  with check (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()));
create policy dt_tecnico_self_read on public.deslocamento_tecnicos
  for select using (tecnico_id = auth.uid());
