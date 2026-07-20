-- 0124 — P0 Fase A: fecha o escalonamento de privilégio via usuarios.role.
-- Auditoria de 20/07/2026: a policy "Admin update" (UPDATE TO public USING auth.uid()=id,
-- sem with_check nem trava de coluna) + ausência de trigger deixavam QUALQUER autenticado
-- fazer `update usuarios set role='admin'`; e portal_is_admin() mais 5 Edge Functions
-- (manage-users, portal-usuarios, omie-sync, viagem-merge, orcamento-importar-fotos) decidem
-- "admin" lendo usuarios.role → cadeia de escalonamento a admin global.
--
-- Fato que torna a correção segura: o CLIENTE NUNCA escreve em usuarios (única referência do
-- front é `select id,nome` em rat-view.js:364). Toda escrita legítima vem de Edge (service_role,
-- que ignora RLS) ou RPC SECURITY DEFINER. Logo as duas policies permissivas de escrita não
-- servem a nenhum fluxo e saem por inteiro; um trigger tranca role/ativo/id/email contra
-- qualquer papel não-privilegiado, restaurando a confiança em usuarios.role para todos os
-- leitores (Edges e portal_is_admin/portal_eu).
--
-- Escopo desta migração (Fase A do P0):
--   · trigger BEFORE INSERT/UPDATE que barra alteração de role/ativo/id/email — exceto
--     service_role/postgres/supabase_admin/supabase_auth_admin (backends legítimos);
--   · remove as policies permissivas "Admin insert" (INSERT check(true)) e "Admin update";
--   · NÃO toca policies de LEITURA (Leitura perfil proprio, usuarios_admin_select,
--     usuarios_lista_tecnicos) nem as Edge Functions (Fase B, à parte).
--
-- Atômica e auto-abortante: tudo num único DO; qualquer validação que falhe → rollback total
-- (inclusive a criação da função e do trigger). Aplicada em UMA transação.
--
-- ABORTA se: as policies permissivas não saírem · trigger ausente · alguma policy de leitura
-- sumir · nº de admins globais mudar · técnico conseguir UPDATE/INSERT · o trigger não barrar a
-- troca de role por um admin via REST · service_role NÃO conseguir alterar role/ativo ·
-- portal_is_admin()/portal_eu() ficarem incorretos.
--
-- As provas mutadoras são não-destrutivas: as tentativas de técnico não alteram nada (RLS/trigger
-- barram) e as de service_role são desfeitas por exceção interna (savepoint) antes do commit.

do $MIG$
declare
  v_pol int; v_trig int; v_readpol int; v_admins int;
  v_tec uuid; v_adm uuid; v_gadmin uuid; v_n int;
  v_role_before text; v_role_after text;
  v_svc_ok boolean; v_raised boolean;
  v_pia_tec boolean; v_pia_adm boolean; v_eu_is_admin boolean;
begin
  -- ── DDL ──
  execute $DDL$
    create or replace function public.tg_usuarios_protege_privilegios()
    returns trigger language plpgsql as $FN$
    begin
      -- backends legítimos escrevem livremente: Edge (service_role), migração/dashboard
      -- (postgres/supabase_admin), backend de auth (supabase_auth_admin)
      if current_user in ('service_role','postgres','supabase_admin','supabase_auth_admin') then
        return new;
      end if;
      if tg_op = 'INSERT' then
        raise exception 'usuarios: inserção somente pelo backend (service_role)' using errcode = '42501';
      end if;
      if new.role  is distinct from old.role
         or new.ativo is distinct from old.ativo
         or new.id    is distinct from old.id
         or lower(coalesce(new.email,'')) is distinct from lower(coalesce(old.email,'')) then
        raise exception 'usuarios: role/ativo/id/email só podem ser alterados pelo backend (service_role)'
          using errcode = '42501';
      end if;
      return new;
    end $FN$;
  $DDL$;
  execute 'drop policy if exists "Admin insert" on public.usuarios';
  execute 'drop policy if exists "Admin update" on public.usuarios';
  execute 'drop trigger if exists trg_usuarios_protege on public.usuarios';
  execute 'create trigger trg_usuarios_protege before insert or update on public.usuarios '
       || 'for each row execute function public.tg_usuarios_protege_privilegios()';

  -- ── (1) policies permissivas removidas ──
  select count(*) into v_pol from pg_policies
   where schemaname='public' and tablename='usuarios' and policyname in ('Admin insert','Admin update');
  if v_pol <> 0 then raise exception '0124: policies permissivas ainda presentes (%)', v_pol; end if;

  -- ── (2) trigger presente ──
  select count(*) into v_trig from pg_trigger t join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='usuarios' and t.tgname='trg_usuarios_protege';
  if v_trig <> 1 then raise exception '0124: trigger ausente'; end if;

  -- ── (3) policies de LEITURA intactas ──
  select count(*) into v_readpol from pg_policies
   where schemaname='public' and tablename='usuarios' and cmd='SELECT'
     and policyname in ('Leitura perfil proprio','usuarios_admin_select','usuarios_lista_tecnicos');
  if v_readpol <> 3 then raise exception '0124: policies de leitura alteradas (%/3)', v_readpol; end if;

  -- ── (4) admins globais inalterados ──
  select count(*) into v_admins from usuarios where role='admin';
  if v_admins <> 4 then raise exception '0124: admins globais mudaram (%)', v_admins; end if;

  -- ── alvos de teste (dinâmicos: técnico e admin reais) ──
  select pa.usuario_id into v_tec    from portal_acessos pa where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  select pa.usuario_id into v_adm    from portal_acessos pa where pa.app_chave='service_report' and pa.role_chave='admin' limit 1;
  select id           into v_gadmin  from usuarios where role='admin' limit 1;
  if v_tec is null or v_adm is null or v_gadmin is null then raise exception '0124: alvos de teste ausentes'; end if;
  select role into v_role_before from usuarios where id=v_tec;

  -- ── (5a) técnico NÃO altera o próprio role (RLS nega → 0 linhas) ──
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_tec)::text, true);
  set local role authenticated;
  update usuarios set role='admin' where id=v_tec;
  get diagnostics v_n = row_count;
  reset role;
  if v_n <> 0 then raise exception '0124: técnico conseguiu UPDATE do próprio usuario (% linhas)', v_n; end if;

  -- ── (5b) técnico NÃO insere usuário ──
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_tec)::text, true);
    set local role authenticated;
    insert into usuarios (id, nome, role, ativo) values (gen_random_uuid(), 'ZZ TESTE', 'admin', true);
  exception when others then v_raised := true;
  end;
  reset role;
  if not v_raised then raise exception '0124: técnico conseguiu INSERT em usuarios'; end if;

  -- ── (6) SR-admin passa no RLS, mas o TRIGGER barra a troca de role de terceiro ──
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_adm)::text, true);
    set local role authenticated;
    update usuarios set role='admin' where id=v_tec;
  exception when others then v_raised := true;
  end;
  reset role;
  if not v_raised then raise exception '0124: trigger não barrou troca de role por admin via REST'; end if;
  select role into v_role_after from usuarios where id=v_tec;
  if v_role_after is distinct from v_role_before then
    raise exception '0124: role do técnico mudou (% -> %)', v_role_before, v_role_after;
  end if;

  -- ── (7) service_role CONSEGUE alterar role/ativo (isento); desfeito por exceção interna ──
  v_svc_ok := false;
  begin
    set local role service_role;
    update usuarios set role='admin' where id=v_tec;
    get diagnostics v_n = row_count;
    v_svc_ok := (v_n = 1);
    raise exception 'UNDO_SVC';
  exception when others then
    reset role;
    if sqlerrm <> 'UNDO_SVC' then raise exception '0124: service_role NÃO alterou role (%)', sqlerrm; end if;
  end;
  if not v_svc_ok then raise exception '0124: service_role não escreveu role'; end if;

  v_svc_ok := false;
  begin
    set local role service_role;
    update usuarios set ativo = not ativo where id=v_tec;
    get diagnostics v_n = row_count;
    v_svc_ok := (v_n = 1);
    raise exception 'UNDO_SVC2';
  exception when others then
    reset role;
    if sqlerrm <> 'UNDO_SVC2' then raise exception '0124: service_role NÃO alterou ativo (%)', sqlerrm; end if;
  end;
  if not v_svc_ok then raise exception '0124: service_role não alterou ativo'; end if;

  -- ── (8) portal_is_admin()/portal_eu() seguem corretos ──
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_tec)::text, true);
  set local role authenticated;
  select portal_is_admin() into v_pia_tec;
  reset role;
  if v_pia_tec then raise exception '0124: portal_is_admin() true para técnico'; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_gadmin)::text, true);
  set local role authenticated;
  select portal_is_admin() into v_pia_adm;
  select is_admin into v_eu_is_admin from portal_eu();
  reset role;
  if not v_pia_adm then raise exception '0124: portal_is_admin() false para admin global'; end if;
  if not v_eu_is_admin then raise exception '0124: portal_eu().is_admin false para admin global'; end if;
end $MIG$;
