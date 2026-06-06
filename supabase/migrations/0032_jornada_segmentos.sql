-- §10.1 fase 2 (dia contínuo): linha do tempo de segmentos do técnico.
-- Cada segmento = uma atividade contígua (trabalho/pausa/almoço/deslocamento).
-- Offline-first: id = client_uuid gerado no aparelho; sync por upsert idempotente.
create table if not exists public.jornada_segmentos (
  id            uuid primary key,
  tecnico_id    uuid not null references public.usuarios(id),
  data          date not null,
  tipo          text not null check (tipo in ('trabalho','pausa','almoco','deslocamento')),
  titulo        text,
  tipo_servico_id uuid references public.tipos_servico(id),
  cliente_id    uuid references public.clientes(id),
  tarefa_id     uuid references public.tarefas(id) on delete set null,
  inicio        timestamptz not null,
  fim           timestamptz,
  device_id     text,
  recebido_em   timestamptz default now(),
  criado_em     timestamptz default now()
);
create index if not exists idx_jornada_seg_tec_data on public.jornada_segmentos (tecnico_id, data);
create index if not exists idx_jornada_seg_tarefa on public.jornada_segmentos (tarefa_id);

alter table public.jornada_segmentos enable row level security;

create policy jornada_seg_tecnico_own on public.jornada_segmentos
  for all using (tecnico_id = auth.uid()) with check (tecnico_id = auth.uid());
create policy jornada_seg_office_read on public.jornada_segmentos
  for select using (app_role() = any (array['admin','gestor_axis','comercial']));
