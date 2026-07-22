-- 0128 — PR-C2: vínculos Tangerino ↔ SR com auditoria e papéis (desenho Fase C §4).
-- · origem_sugestao no map (externalId | cpf | manual) — registra DE ONDE veio a sugestão
--   confirmada (a confirmação é sempre humana; sugestão nunca vira vínculo sozinha).
-- · ponto_vinculo_eventos: histórico imutável (vinculado/alterado/desvinculado) escrito por
--   TRIGGER security definer — desvincular/corrigir preserva o passado; colaborador inativo
--   permanece no histórico mesmo se a linha do map for removida.
-- · RLS do map dividida: admin ESCREVE; gestor_axis SÓ consulta (decisão da C2).
-- Unicidades (já da 0126): PK tecnico_id ⇒ um usuário SR nunca tem 2 colaboradores ativos;
-- unique(tangerino_employee_id) ⇒ um colaborador nunca está em 2 usuários.

-- ── (1) origem da sugestão confirmada ──
alter table public.ponto_colaboradores_map
  add column if not exists origem_sugestao text not null default 'manual'
    check (origem_sugestao in ('externalId','cpf','manual'));

-- ── (2) histórico imutável de vínculos E de decisões de escopo ──
-- tecnico_id é NULO nos eventos de escopo (fora_escopo/retorno_escopo não têm usuário SR).
create table if not exists public.ponto_vinculo_eventos (
  id                    uuid primary key default gen_random_uuid(),
  tecnico_id            uuid,                     -- sem FK: histórico sobrevive a tudo (padrão auditoria)
  tangerino_employee_id bigint not null,
  acao                  text not null check (acao in ('vinculado','alterado','desvinculado','fora_escopo','retorno_escopo')),
  origem_sugestao       text,
  ator                  uuid,                     -- quem confirmou/desfez (auth.uid do momento)
  em                    timestamptz not null default now(),
  detalhe               text
);
create index if not exists idx_ponto_vinc_ev_tec on public.ponto_vinculo_eventos (tecnico_id, em desc);
alter table public.ponto_vinculo_eventos enable row level security;
drop policy if exists pvev_office_sel on public.ponto_vinculo_eventos;
create policy pvev_office_sel on public.ponto_vinculo_eventos
  for select using (app_role() = any (array['admin','gestor_axis']));
revoke all on table public.ponto_vinculo_eventos from anon;   -- padrão 0127 desde o berço

-- Imutabilidade: update/delete de evento é rejeitado para qualquer papel de app
-- (só service_role/postgres passam — mesmo padrão da trilha de auditoria da casa).
create or replace function public.tg_ponto_vinculo_ev_imutavel()
returns trigger language plpgsql as $$
begin
  if current_user in ('service_role','postgres','supabase_admin') then
    return coalesce(new, old);
  end if;
  raise exception 'ponto_vinculo_eventos é imutável (histórico de auditoria)' using errcode = '42501';
end $$;
drop trigger if exists trg_ponto_vinc_ev_imutavel on public.ponto_vinculo_eventos;
create trigger trg_ponto_vinc_ev_imutavel before update or delete on public.ponto_vinculo_eventos
  for each row execute function public.tg_ponto_vinculo_ev_imutavel();

-- ── (3) trigger que escreve o histórico a partir do map (security definer) ──
create or replace function public.tg_ponto_map_evento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ator uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator)
    values (new.tecnico_id, new.tangerino_employee_id, 'vinculado', new.origem_sugestao, coalesce(v_ator, new.vinculado_por));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.tangerino_employee_id is distinct from old.tangerino_employee_id
       or new.ativo is distinct from old.ativo then
      insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, detalhe)
      values (new.tecnico_id, new.tangerino_employee_id, 'alterado', new.origem_sugestao, coalesce(v_ator, new.vinculado_por),
              'employee ' || old.tangerino_employee_id || ' → ' || new.tangerino_employee_id ||
              case when new.ativo is distinct from old.ativo then ' · ativo ' || old.ativo || '→' || new.ativo else '' end);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator)
    values (old.tecnico_id, old.tangerino_employee_id, 'desvinculado', old.origem_sugestao, coalesce(v_ator, old.vinculado_por));
    return old;
  end if;
  return null;
end $$;
drop trigger if exists trg_ponto_map_evento on public.ponto_colaboradores_map;
create trigger trg_ponto_map_evento after insert or update or delete on public.ponto_colaboradores_map
  for each row execute function public.tg_ponto_map_evento();

-- ── (4) FORA DO ESCOPO: decisão manual, com motivo, auditável e reversível ──
-- Colaborador do Tangerino que NÃO participa da operação técnica do SR (ex.: administrativo).
-- NUNCA inferido automaticamente: só admin marca, com motivo obrigatório; reversão = delete
-- (evento 'retorno_escopo' preserva o histórico). Distingue "pendente de decisão" de
-- "intencionalmente fora" — base das métricas separadas da importação.
create table if not exists public.ponto_fora_escopo (
  tangerino_employee_id bigint primary key,
  motivo                text not null check (length(btrim(motivo)) >= 3),
  decidido_por          uuid not null references public.usuarios(id),
  decidido_em           timestamptz not null default now()
);
alter table public.ponto_fora_escopo enable row level security;
drop policy if exists pfe_read on public.ponto_fora_escopo;
create policy pfe_read on public.ponto_fora_escopo
  for select using (app_role() = any (array['admin','gestor_axis']));
drop policy if exists pfe_admin_ins on public.ponto_fora_escopo;
create policy pfe_admin_ins on public.ponto_fora_escopo
  for insert with check (app_role() = 'admin');
drop policy if exists pfe_admin_del on public.ponto_fora_escopo;
create policy pfe_admin_del on public.ponto_fora_escopo
  for delete using (app_role() = 'admin');
revoke all on table public.ponto_fora_escopo from anon;

-- Conflito vínculo × fora_escopo é IMPOSSÍVEL nos dois sentidos:
create or replace function public.tg_ponto_fe_valida()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.ponto_colaboradores_map m
              where m.tangerino_employee_id = new.tangerino_employee_id) then
    raise exception 'colaborador está VINCULADO — desvincule antes de marcar fora do escopo';
  end if;
  return new;
end $$;
drop trigger if exists trg_ponto_fe_valida on public.ponto_fora_escopo;
create trigger trg_ponto_fe_valida before insert on public.ponto_fora_escopo
  for each row execute function public.tg_ponto_fe_valida();

create or replace function public.tg_ponto_map_valida_escopo()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.ponto_fora_escopo f
              where f.tangerino_employee_id = new.tangerino_employee_id) then
    raise exception 'colaborador está FORA DO ESCOPO — retorne-o ao escopo antes de vincular';
  end if;
  return new;
end $$;
drop trigger if exists trg_ponto_map_valida_escopo on public.ponto_colaboradores_map;
create trigger trg_ponto_map_valida_escopo before insert or update of tangerino_employee_id
  on public.ponto_colaboradores_map
  for each row execute function public.tg_ponto_map_valida_escopo();

-- Auditoria da decisão de escopo (mesmo histórico imutável dos vínculos):
create or replace function public.tg_ponto_fe_evento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ator uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, ator, detalhe)
    values (null, new.tangerino_employee_id, 'fora_escopo', coalesce(v_ator, new.decidido_por), new.motivo);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, ator, detalhe)
    values (null, old.tangerino_employee_id, 'retorno_escopo', coalesce(v_ator, old.decidido_por),
            'reversão (motivo original: ' || old.motivo || ')');
    return old;
  end if;
  return null;
end $$;
drop trigger if exists trg_ponto_fe_evento on public.ponto_fora_escopo;
create trigger trg_ponto_fe_evento after insert or delete on public.ponto_fora_escopo
  for each row execute function public.tg_ponto_fe_evento();

-- ── (5) métricas da importação separadas (nada desaparece em silêncio) ──
-- descartadas_sem_vinculo era ambígua (esquecimento × decisão). Passa a:
--   pendentes_sem_vinculo  = colaborador que AINDA exige decisão (bloqueia: execução 'parcial', sem cursor)
--   ignoradas_fora_escopo  = decisão intencional e auditada (não bloqueia)
--   invalidas              = marcação sem id/sem dia utilizável (contada, nunca silenciosa)
alter table public.ponto_sync_execucoes rename column descartadas_sem_vinculo to pendentes_sem_vinculo;
alter table public.ponto_sync_execucoes add column if not exists ignoradas_fora_escopo int not null default 0;
alter table public.ponto_sync_execucoes add column if not exists invalidas int not null default 0;

-- ── (6) papéis no map: admin escreve; gestor só consulta ──
drop policy if exists pmap_office_all on public.ponto_colaboradores_map;
drop policy if exists pmap_read on public.ponto_colaboradores_map;
create policy pmap_read on public.ponto_colaboradores_map
  for select using (app_role() = any (array['admin','gestor_axis']));
drop policy if exists pmap_admin_ins on public.ponto_colaboradores_map;
create policy pmap_admin_ins on public.ponto_colaboradores_map
  for insert with check (app_role() = 'admin');
drop policy if exists pmap_admin_upd on public.ponto_colaboradores_map;
create policy pmap_admin_upd on public.ponto_colaboradores_map
  for update using (app_role() = 'admin') with check (app_role() = 'admin');
drop policy if exists pmap_admin_del on public.ponto_colaboradores_map;
create policy pmap_admin_del on public.ponto_colaboradores_map
  for delete using (app_role() = 'admin');
