-- Teste do gate de autorização das Edges migradas na P0 Fase B (READ-ONLY, seguro em produção).
-- omie-sync, viagem-merge (caminho "escritório") e orcamento-importar-fotos passaram a autorizar
-- por portal_acessos do app service_report (papel por-app), não mais por usuarios.role (coluna
-- outrora auto-editável — migração 0124). Este teste replica EXATAMENTE a query que as Edges
-- fazem — `select role_chave from portal_acessos where usuario_id=? and app_chave='service_report'`
-- e a checagem `role_chave in ('admin','gestor_axis')` — para os 5 perfis. Termina sempre em RAISE
-- (não altera nada). NÃO invoca as Edge Functions (elas são Deno; o gate é a decisão de banco).
do $$
declare
  ALLOW_ROLES constant text[] := array['admin','gestor_axis'];
  v_tec uuid; v_adm uuid; v_gadmin uuid; v_noacc uuid;
  r text; ok boolean;
  res text := '';
begin
  select usuario_id into v_tec    from portal_acessos where app_chave='service_report' and role_chave='tecnico_campo' limit 1;
  select usuario_id into v_adm    from portal_acessos where app_chave='service_report' and role_chave='admin' limit 1;
  select id          into v_gadmin from usuarios where role='admin' limit 1;
  -- usuário SEM acesso ao service_report (tem acesso a outro app, ex. gestao_comercial)
  select pa.usuario_id into v_noacc from portal_acessos pa
   where pa.app_chave <> 'service_report'
     and not exists (select 1 from portal_acessos x where x.usuario_id=pa.usuario_id and x.app_chave='service_report')
   limit 1;
  if v_tec is null or v_adm is null or v_gadmin is null or v_noacc is null then
    raise exception 'FALHOU: faltou representante (tec=% adm=% gadmin=% noacc=%)', v_tec, v_adm, v_gadmin, v_noacc;
  end if;

  -- (1) técnico → deny
  select role_chave into r from portal_acessos where usuario_id=v_tec and app_chave='service_report';
  if coalesce(r,'') = any(ALLOW_ROLES) then raise exception 'FALHOU: técnico (%) autorizado', r; end if;
  res := res || format('tecnico[%s]=DENY; ', r);

  -- (2) SR-admin → allow
  select role_chave into r from portal_acessos where usuario_id=v_adm and app_chave='service_report';
  if not (coalesce(r,'') = any(ALLOW_ROLES)) then raise exception 'FALHOU: SR-admin (%) negado', r; end if;
  res := res || format('sr_admin[%s]=ALLOW; ', r);

  -- (3) gestor_axis → allow (lógica; 0 usuários vivos hoje no service_report)
  if not ('gestor_axis' = any(ALLOW_ROLES)) then raise exception 'FALHOU: gestor_axis fora da allow-list'; end if;
  res := res || 'gestor_axis=ALLOW(0 vivos); ';

  -- (4) sem acesso ao app → deny (role_chave NULL)
  r := null;
  select role_chave into r from portal_acessos where usuario_id=v_noacc and app_chave='service_report';
  if coalesce(r,'') = any(ALLOW_ROLES) then raise exception 'FALHOU: usuário sem acesso autorizado (%)', r; end if;
  res := res || format('sem_acesso[%s]=DENY; ', coalesce(r,'NULL'));

  -- (5) admin global (usuarios.role='admin') — só autoriza se TAMBÉM tiver service_report admin/gestor
  select role_chave into r from portal_acessos where usuario_id=v_gadmin and app_chave='service_report';
  if not (coalesce(r,'') = any(ALLOW_ROLES)) then raise exception 'FALHOU: admin global % sem SR office (%)', v_gadmin, coalesce(r,'NULL'); end if;
  res := res || format('admin_global[sr=%s]=ALLOW; ', r);

  raise exception 'TESTES_OK gate service_report -> %', res;
end $$;
