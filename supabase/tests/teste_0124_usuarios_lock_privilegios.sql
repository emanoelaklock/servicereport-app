-- Teste de regressão da 0124 (P0 Fase A) — SEGURO EM PRODUÇÃO.
-- Corpo idêntico ao da migração + RAISE final incondicional → rollback total garantido:
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0124: …'     = qual condição de aborto disparou.
-- Aplica o DDL (função+trigger+drops) dentro da transação, prova as garantias e desfaz tudo —
-- nada persiste (as provas mutadoras de service_role são revertidas por exceção interna).
-- Roda ANTES do merge (validação) e como regressão permanente (o trigger tem que barrar o
-- técnico e isentar o service_role; as policies permissivas não podem reaparecer).
do $MIG$
declare
  v_pol int; v_trig int; v_readpol int; v_admins int;
  v_tec uuid; v_adm uuid; v_gadmin uuid; v_n int;
  v_role_before text; v_role_after text;
  v_svc_ok boolean; v_raised boolean;
  v_pia_tec boolean; v_pia_adm boolean; v_eu_is_admin boolean;
begin
  execute $DDL$
    create or replace function public.tg_usuarios_protege_privilegios()
    returns trigger language plpgsql as $FN$
    begin
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

  select count(*) into v_pol from pg_policies
   where schemaname='public' and tablename='usuarios' and policyname in ('Admin insert','Admin update');
  if v_pol <> 0 then raise exception '0124: policies permissivas ainda presentes (%)', v_pol; end if;

  select count(*) into v_trig from pg_trigger t join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='usuarios' and t.tgname='trg_usuarios_protege';
  if v_trig <> 1 then raise exception '0124: trigger ausente'; end if;

  select count(*) into v_readpol from pg_policies
   where schemaname='public' and tablename='usuarios' and cmd='SELECT'
     and policyname in ('Leitura perfil proprio','usuarios_admin_select','usuarios_lista_tecnicos');
  if v_readpol <> 3 then raise exception '0124: policies de leitura alteradas (%/3)', v_readpol; end if;

  select count(*) into v_admins from usuarios where role='admin';
  if v_admins <> 4 then raise exception '0124: admins globais mudaram (%)', v_admins; end if;

  select pa.usuario_id into v_tec    from portal_acessos pa where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  select pa.usuario_id into v_adm    from portal_acessos pa where pa.app_chave='service_report' and pa.role_chave='admin' limit 1;
  select id           into v_gadmin  from usuarios where role='admin' limit 1;
  if v_tec is null or v_adm is null or v_gadmin is null then raise exception '0124: alvos de teste ausentes'; end if;
  select role into v_role_before from usuarios where id=v_tec;

  -- (5a) técnico não altera o próprio role (RLS nega → 0 linhas)
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_tec)::text, true);
  set local role authenticated;
  update usuarios set role='admin' where id=v_tec;
  get diagnostics v_n = row_count;
  reset role;
  if v_n <> 0 then raise exception '0124: técnico conseguiu UPDATE do próprio usuario (% linhas)', v_n; end if;

  -- (5b) técnico não insere
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_tec)::text, true);
    set local role authenticated;
    insert into usuarios (id, nome, role, ativo) values (gen_random_uuid(), 'ZZ TESTE', 'admin', true);
  exception when others then v_raised := true;
  end;
  reset role;
  if not v_raised then raise exception '0124: técnico conseguiu INSERT em usuarios'; end if;

  -- (6) SR-admin passa no RLS, mas o trigger barra a troca de role de terceiro
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

  -- (7) service_role consegue alterar role/ativo (isento); desfeito por exceção interna
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

  -- (8) portal_is_admin()/portal_eu() seguem corretos
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

  raise exception 'TESTES_OK: trigger + drops validados — técnico bloqueado (update/insert), valores intactos, service_role opera role/ativo, 4 admins globais e portal_is_admin/portal_eu corretos (rollback total)';
end $MIG$;
