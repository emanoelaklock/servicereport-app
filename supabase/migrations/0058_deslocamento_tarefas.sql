-- Deslocamento referencia TAREFAS em aberto dos clientes do destino
-- (spec §4.1: tarefas opcionais, nunca tarefa única — pode vincular mais de uma).
create table if not exists public.deslocamento_tarefas (
  deslocamento_id uuid not null references public.deslocamentos(id) on delete cascade,
  tarefa_id       uuid not null references public.tarefas(id) on delete cascade,
  primary key (deslocamento_id, tarefa_id)
);
create index if not exists idx_desloc_tarefas_tar on public.deslocamento_tarefas (tarefa_id);
alter table public.deslocamento_tarefas enable row level security;
drop policy if exists dtar_office_all on public.deslocamento_tarefas;
create policy dtar_office_all on public.deslocamento_tarefas
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists dtar_comercial_read on public.deslocamento_tarefas;
create policy dtar_comercial_read on public.deslocamento_tarefas
  for select using (app_role() = 'comercial');
drop policy if exists dtar_tecnico_own on public.deslocamento_tarefas;
create policy dtar_tecnico_own on public.deslocamento_tarefas
  for all using (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()))
  with check (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()));
drop policy if exists dtar_aboard_read on public.deslocamento_tarefas;
create policy dtar_aboard_read on public.deslocamento_tarefas
  for select using (exists (select 1 from public.deslocamento_tecnicos dt
                            where dt.deslocamento_id = deslocamento_tarefas.deslocamento_id
                              and dt.tecnico_id = auth.uid()));
