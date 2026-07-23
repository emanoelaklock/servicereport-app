-- 0129 — Encerramento do C2 (pós-classificação real de 22-23/07/2026):
--
-- (0) usuarios.tangerino_elegivel — "Participa da integração com o Tangerino".
--     · boolean NOT NULL default FALSE (novos usuários nascem fora da integração);
--     · backfill: TRUE somente para quem JÁ possui vínculo ativo em ponto_colaboradores_map
--       (vínculos existentes preservados; demais usuários permanecem false);
--     · alteração SÓ pelo backend (padrão 0124: toda escrita em usuarios é service_role;
--       a Edge portal-usuarios já autoriza somente admin) — gestor/técnico nunca alteram;
--     · desmarcar usuário COM vínculo ativo é BLOQUEADO (desvincule antes, fluxo auditado);
--     · marcar/desmarcar NUNCA cria nem remove vínculo (nenhum efeito colateral);
--     · toda alteração gera auditoria em ponto_elegivel_eventos (valor anterior, novo,
--       ator, origem da execução, data/hora) — trilha imutável;
--     · acesso ao portal NÃO interfere; ativo/inativo segue dimensão separada.
-- (1) sr_usuarios_vinculo(): dropdown da tela de vínculos SEM exigir acesso ao portal
--     (bug real: usuária ativa sem acesso não aparecia). Devolve as três dimensões
--     separadas: ativo/inativo · tem_acesso · tangerino_elegivel. Guarda por app_role().
-- (2) Integridade da auditoria de vínculos: origem_execucao ('portal'|'sql_assistido'|
--     'sistema'), aprovado_por e evento_ref em ponto_vinculo_eventos; triggers PARAM de
--     mascarar service_role como usuário (ator = auth.uid() real; null fora do portal).
-- (3) Evento compensatório de regularização do vínculo 6140202 (original intocado).

-- ── (0a) coluna ──
alter table public.usuarios
  add column if not exists tangerino_elegivel boolean not null default false;

-- ── (0b) trilha de auditoria do checkbox (imutável) ──
create table if not exists public.ponto_elegivel_eventos (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null,          -- sem FK: histórico sobrevive a tudo (padrão auditoria)
  valor_anterior  boolean,
  valor_novo      boolean not null,
  ator            uuid,                   -- auth.uid() real ou ator verificado repassado pela Edge
  origem_execucao text check (origem_execucao in ('portal','sql_assistido','sistema')),
  em              timestamptz not null default now()
);
create index if not exists idx_ponto_eleg_ev_usr on public.ponto_elegivel_eventos (usuario_id, em desc);
alter table public.ponto_elegivel_eventos enable row level security;
drop policy if exists pelev_office_sel on public.ponto_elegivel_eventos;
create policy pelev_office_sel on public.ponto_elegivel_eventos
  for select using (app_role() = any (array['admin','gestor_axis']));
revoke all on table public.ponto_elegivel_eventos from anon;

create or replace function public.tg_ponto_eleg_ev_imutavel()
returns trigger language plpgsql as $$
begin
  if current_user in ('service_role','postgres','supabase_admin') then
    return coalesce(new, old);
  end if;
  raise exception 'ponto_elegivel_eventos é imutável (histórico de auditoria)' using errcode = '42501';
end $$;
drop trigger if exists trg_ponto_eleg_ev_imutavel on public.ponto_elegivel_eventos;
create trigger trg_ponto_eleg_ev_imutavel before update or delete on public.ponto_elegivel_eventos
  for each row execute function public.tg_ponto_eleg_ev_imutavel();

-- ── (0c) classificador da origem (usado também pela auditoria de vínculos) ──
-- 'portal' = usuário autenticado (JWT direto, ou verificado pela Edge que repassa via GUC);
-- 'sql_assistido' = operação administrativa assistida por SQL (GUC explícito);
-- 'sistema' = migration/rotina. GUC só é alcançável por contexto de backend.
create or replace function public.ponto_origem_execucao()
returns text language sql stable as $$
  select case
    when auth.uid() is not null then 'portal'
    when current_setting('app.ponto_origem', true) in ('portal','sql_assistido')
      then current_setting('app.ponto_origem', true)
    else 'sistema'
  end;
$$;
-- Postgres dá EXECUTE a public por default — revoga: só os triggers (rodando como owner)
-- usam esta função; nenhum cliente precisa chamá-la.
revoke all on function public.ponto_origem_execucao() from public, anon, authenticated;

-- ── (0d) regras do checkbox: só backend altera; desmarcar vinculado é bloqueado ──
create or replace function public.tg_usuarios_tangerino_elegivel()
returns trigger language plpgsql as $$
begin
  if new.tangerino_elegivel is distinct from old.tangerino_elegivel then
    -- mesmo padrão da 0124: papel de app NUNCA altera (a autorização de admin acontece
    -- na Edge portal-usuarios, que roda como service_role)
    if current_user not in ('service_role','postgres','supabase_admin','supabase_auth_admin') then
      raise exception 'tangerino_elegivel: alteração somente pelo backend (admin via portal)'
        using errcode = '42501';
    end if;
    -- desmarcar exige desvínculo prévio pelo fluxo auditado — vale para QUALQUER papel
    if old.tangerino_elegivel and not new.tangerino_elegivel
       and exists (select 1 from public.ponto_colaboradores_map m
                    where m.tecnico_id = new.id and m.ativo) then
      raise exception 'usuário possui vínculo ativo com o Tangerino — desvincule primeiro (fluxo auditado)';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_usuarios_tangerino_elegivel on public.usuarios;
create trigger trg_usuarios_tangerino_elegivel before update on public.usuarios
  for each row execute function public.tg_usuarios_tangerino_elegivel();

-- ── (0e) auditoria automática de toda alteração do checkbox ──
create or replace function public.tg_usuarios_eleg_evento()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tangerino_elegivel is distinct from old.tangerino_elegivel then
    insert into public.ponto_elegivel_eventos (usuario_id, valor_anterior, valor_novo, ator, origem_execucao)
    values (new.id, old.tangerino_elegivel, new.tangerino_elegivel,
            coalesce(auth.uid(), nullif(current_setting('app.ponto_ator', true), '')::uuid),
            public.ponto_origem_execucao());
  end if;
  return new;
end $$;
drop trigger if exists trg_usuarios_eleg_evento on public.usuarios;
create trigger trg_usuarios_eleg_evento after update on public.usuarios
  for each row execute function public.tg_usuarios_eleg_evento();

-- Higiene de EXECUTE nas funções de trigger (não são chamáveis por clientes de qualquer
-- forma — retornam trigger — mas o default 'public' sai por princípio de menor privilégio).
revoke all on function public.tg_ponto_eleg_ev_imutavel() from public, anon, authenticated;
revoke all on function public.tg_usuarios_tangerino_elegivel() from public, anon, authenticated;
revoke all on function public.tg_usuarios_eleg_evento() from public, anon, authenticated;

-- ── (0f) setter oficial p/ a Edge portal-usuarios (admin já autenticado lá) ──
-- security definer + grant SÓ a service_role: o ator verificado pela Edge chega por
-- parâmetro e vai à auditoria via GUC; origem = 'portal' (fluxo oficial do app).
create or replace function public.sr_set_tangerino_elegivel(p_usuario uuid, p_valor boolean, p_ator uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.ponto_origem', 'portal', true);
  perform set_config('app.ponto_ator', coalesce(p_ator::text, ''), true);
  update public.usuarios set tangerino_elegivel = p_valor where id = p_usuario;
  if not found then raise exception 'usuário não encontrado'; end if;
  perform set_config('app.ponto_origem', '', true);
  perform set_config('app.ponto_ator', '', true);
end $$;
revoke all on function public.sr_set_tangerino_elegivel(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.sr_set_tangerino_elegivel(uuid, boolean, uuid) to service_role;

-- ── (0g) backfill: quem já tem vínculo ativo vira elegível (auditado como 'sistema');
--        NENHUM vínculo é criado/alterado aqui — só o flag dos já vinculados ──
update public.usuarios u set tangerino_elegivel = true
 where exists (select 1 from public.ponto_colaboradores_map m
                where m.tecnico_id = u.id and m.ativo)
   and u.tangerino_elegivel = false;

-- ── (1) RPC do dropdown de vínculo (três dimensões separadas) ──
drop function if exists public.sr_usuarios_vinculo();
create or replace function public.sr_usuarios_vinculo()
returns table(id uuid, nome text, ativo boolean, tem_acesso boolean, tangerino_elegivel boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.nome, u.ativo,
         exists (select 1 from public.portal_acessos pa
                  where pa.usuario_id = u.id and pa.app_chave = 'service_report') as tem_acesso,
         u.tangerino_elegivel
  from public.usuarios u
  where public.app_role() = any (array['admin','gestor_axis'])
  order by u.nome;
$$;
revoke all on function public.sr_usuarios_vinculo() from public, anon;
grant execute on function public.sr_usuarios_vinculo() to authenticated;

-- ── (2) origem da execução na trilha de vínculos ──
alter table public.ponto_vinculo_eventos
  add column if not exists origem_execucao text
    check (origem_execucao in ('portal','sql_assistido','sistema')),
  add column if not exists aprovado_por uuid,
  add column if not exists evento_ref uuid;

alter table public.ponto_vinculo_eventos
  drop constraint if exists ponto_vinculo_eventos_acao_check;
alter table public.ponto_vinculo_eventos
  add constraint ponto_vinculo_eventos_acao_check
  check (acao in ('vinculado','alterado','desvinculado','fora_escopo','retorno_escopo','regularizacao'));

-- Triggers reescritos: ator = auth.uid() REAL (sem coalesce para o usuário da linha —
-- era isso que atribuía operação service_role como execução direta do usuário).
create or replace function public.tg_ponto_map_evento()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ator   uuid := auth.uid();
  v_origem text := public.ponto_origem_execucao();
begin
  if tg_op = 'INSERT' then
    insert into public.ponto_vinculo_eventos
      (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por)
    values (new.tecnico_id, new.tangerino_employee_id, 'vinculado', new.origem_sugestao, v_ator, v_origem, new.vinculado_por);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.tangerino_employee_id is distinct from old.tangerino_employee_id
       or new.ativo is distinct from old.ativo then
      insert into public.ponto_vinculo_eventos
        (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por, detalhe)
      values (new.tecnico_id, new.tangerino_employee_id, 'alterado', new.origem_sugestao, v_ator, v_origem, new.vinculado_por,
              'employee ' || old.tangerino_employee_id || ' → ' || new.tangerino_employee_id ||
              case when new.ativo is distinct from old.ativo then ' · ativo ' || old.ativo || '→' || new.ativo else '' end);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.ponto_vinculo_eventos
      (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por)
    values (old.tecnico_id, old.tangerino_employee_id, 'desvinculado', old.origem_sugestao, v_ator, v_origem, old.vinculado_por);
    return old;
  end if;
  return null;
end $$;

create or replace function public.tg_ponto_fe_evento()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ator   uuid := auth.uid();
  v_origem text := public.ponto_origem_execucao();
begin
  if tg_op = 'INSERT' then
    insert into public.ponto_vinculo_eventos
      (tecnico_id, tangerino_employee_id, acao, ator, origem_execucao, aprovado_por, detalhe)
    values (null, new.tangerino_employee_id, 'fora_escopo', v_ator, v_origem, new.decidido_por, new.motivo);
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.ponto_vinculo_eventos
      (tecnico_id, tangerino_employee_id, acao, ator, origem_execucao, aprovado_por, detalhe)
    values (null, old.tangerino_employee_id, 'retorno_escopo', v_ator, v_origem, old.decidido_por,
            'reversão (motivo original: ' || old.motivo || ')');
    return old;
  end if;
  return null;
end $$;

-- ── (3) evento compensatório de regularização (idempotente; não toca no original) ──
do $$
declare
  v_ev uuid;
  v_ja uuid;
begin
  select e.id into v_ev from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 6140202 and e.acao = 'vinculado'
   order by e.em limit 1;
  select e.id into v_ja from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 6140202 and e.acao = 'regularizacao' limit 1;
  if v_ev is not null and v_ja is null then
    insert into public.ponto_vinculo_eventos
      (tecnico_id, tangerino_employee_id, acao, ator, origem_execucao, aprovado_por, evento_ref, detalhe)
    select e.tecnico_id, 6140202, 'regularizacao',
           null,                -- não houve execução direta pelo portal
           'sql_assistido',     -- forma real da execução regularizada
           e.ator,              -- responsável que aprovou (registrado no evento original)
           v_ev,
           'regularização: vínculo confirmado administrativamente por SQL assistido em 23/07/2026 '
           || '(o dropdown da tela não listava usuário SR sem acesso ao portal — corrigido na 0129); '
           || 'evento original preservado e imutável'
    from public.ponto_vinculo_eventos e where e.id = v_ev;
  end if;
end $$;
