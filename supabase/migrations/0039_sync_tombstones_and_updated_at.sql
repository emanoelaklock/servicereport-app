-- Sync robusto (offline-first): updated_at + tombstones + Realtime.
-- Permite delta-sync (puxar só o que mudou) e reconciliar exclusões no aparelho.

-- updated_at em todas as entidades offline (rats já tem atualizado_em)
alter table public.deslocamentos     add column if not exists atualizado_em timestamptz not null default now();
alter table public.jornada_segmentos add column if not exists atualizado_em timestamptz not null default now();

create or replace function public.tg_set_atualizado_em()
returns trigger language plpgsql as $$
begin new.atualizado_em := now(); return new; end $$;

drop trigger if exists trg_upd_desloc on public.deslocamentos;
create trigger trg_upd_desloc before update on public.deslocamentos
  for each row execute function public.tg_set_atualizado_em();
drop trigger if exists trg_upd_seg on public.jornada_segmentos;
create trigger trg_upd_seg before update on public.jornada_segmentos
  for each row execute function public.tg_set_atualizado_em();
drop trigger if exists trg_upd_rats on public.rats;
create trigger trg_upd_rats before update on public.rats
  for each row execute function public.tg_set_atualizado_em();

-- Lápides (tombstones): registra exclusões para o app offline reconciliar.
create table if not exists public.sync_tombstones (
  id          bigserial primary key,
  tabela      text not null,
  registro_id text not null,            -- chave que o app usa localmente
  deletado_em timestamptz not null default now()
);
create index if not exists idx_tomb_deletado on public.sync_tombstones (deletado_em);
alter table public.sync_tombstones enable row level security;
drop policy if exists tomb_read on public.sync_tombstones;
create policy tomb_read on public.sync_tombstones for select using (true);

-- registra a lápide em qualquer exclusão (SECURITY DEFINER: independe do papel de quem apaga)
create or replace function public.tg_tombstone()
returns trigger language plpgsql security definer set search_path = public as $$
declare rid text;
begin
  rid := case tg_table_name when 'rats' then old.client_uuid::text else old.id::text end;
  insert into public.sync_tombstones (tabela, registro_id) values (tg_table_name, rid);
  return old;
end $$;

drop trigger if exists trg_tomb_desloc on public.deslocamentos;
create trigger trg_tomb_desloc after delete on public.deslocamentos
  for each row execute function public.tg_tombstone();
drop trigger if exists trg_tomb_seg on public.jornada_segmentos;
create trigger trg_tomb_seg after delete on public.jornada_segmentos
  for each row execute function public.tg_tombstone();
drop trigger if exists trg_tomb_rats on public.rats;
create trigger trg_tomb_rats after delete on public.rats
  for each row execute function public.tg_tombstone();

-- Realtime: publica as tabelas (idempotente)
do $$
begin
  begin alter publication supabase_realtime add table public.deslocamentos; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.jornada_segmentos; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.sync_tombstones; exception when duplicate_object then null; end;
end $$;
