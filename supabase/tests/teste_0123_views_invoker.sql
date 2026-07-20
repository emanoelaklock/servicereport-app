-- Teste de regressão da 0123 (F17) — SEGURO EM PRODUÇÃO.
-- Mesmo corpo da migração + RAISE final incondicional → rollback total garantido:
--   · 'TESTES_OK …'   = tudo passou (o erro é só o veículo do rollback);
--   · '0123: …'       = qual condição de aborto disparou.
-- Serve ANTES do merge (aplica os ALTERs dentro da transação e valida) e DEPOIS
-- (revalida idempotente + vigia as reloptions: um `create or replace view` futuro que
-- esqueça de redeclarar `with (security_invoker = true)` derruba a opção em silêncio —
-- regressão real da 0081 na vw_alerta_desloc_sem_volta; este teste a pega).
do $$
declare
  ADM uuid; TEC uuid;
  base_total int; base_rat int; base_desloc int; base_rats int;
  v int; v2 int; v3 int; v4 int;
  allowed_rats uuid[]; allowed_desloc uuid[];
  negado boolean;
begin
  execute 'alter view public.vw_participacoes_dia set (security_invoker = true)';
  execute 'alter view public.vw_rats_busca set (security_invoker = true)';
  execute 'alter view public.vw_alerta_desloc_sem_volta set (security_invoker = true)';
  execute 'revoke select on public.vw_participacoes_dia from anon';
  execute 'revoke select on public.vw_rats_busca from anon';
  execute 'revoke select on public.vw_alerta_desloc_sem_volta from anon';

  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('vw_participacoes_dia','vw_rats_busca','vw_alerta_desloc_sem_volta')
     and c.reloptions::text like '%security_invoker=true%';
  if v <> 3 then raise exception '0123: só % de 3 views com security_invoker — abortando', v; end if;

  select count(*) into base_total  from vw_participacoes_dia;
  select count(*) into base_rat    from vw_participacoes_dia where artefato_tipo = 'rat';
  select count(*) into base_desloc from vw_participacoes_dia where artefato_tipo <> 'rat';
  select count(*) into base_rats   from rats;

  select usuario_id into ADM from portal_acessos
   where app_chave = 'service_report' and role_chave = 'admin' limit 1;
  if ADM is null then
    raise notice '0123: sem usuário admin no ambiente — checagens de admin puladas';
  else
    perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',ADM)::text, true);
    set local role authenticated;
    select count(*) into v  from vw_participacoes_dia;
    select count(*) into v2 from vw_participacoes_dia where artefato_tipo = 'rat';
    select count(*) into v3 from vw_participacoes_dia where artefato_tipo <> 'rat';
    select count(*) into v4 from vw_rats_busca;
    perform count(*) from vw_alerta_desloc_sem_volta;
    reset role;
    if v <> base_total then raise exception '0123: admin vê %/% participações — abortando', v, base_total; end if;
    if base_rat > 0 and v2 <> base_rat then raise exception '0123: admin vê %/% no branch rat — abortando', v2, base_rat; end if;
    if base_desloc > 0 and v3 <> base_desloc then raise exception '0123: admin vê %/% no branch deslocamento — abortando', v3, base_desloc; end if;
    if v4 <> base_rats then raise exception '0123: admin vê %/% RATs na busca — abortando', v4, base_rats; end if;
  end if;

  select pa.usuario_id into TEC from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave = 'tecnico_campo'
     and exists (select 1 from rat_tecnicos rt where rt.tecnico_id = pa.usuario_id)
   limit 1;
  if TEC is null then
    raise notice '0123: sem técnico com participações — checagem de escopo pulada';
  else
    allowed_rats   := array(select id from rats where tecnico_id = TEC);
    allowed_desloc := array(select d.id from deslocamentos d where d.criado_por = TEC
                            union
                            select dt.deslocamento_id from deslocamento_tecnicos dt where dt.tecnico_id = TEC);
    perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',TEC)::text, true);
    set local role authenticated;
    select count(*) into v from vw_participacoes_dia p
     where not ( p.tecnico_id = TEC
              or (p.artefato_tipo in ('rat','desloc_dia') and p.artefato_id = any(allowed_rats))
              or (p.artefato_tipo = 'deslocamento'        and p.artefato_id = any(allowed_desloc)) );
    select count(*) into v2 from vw_rats_busca where not (id = any(allowed_rats));
    select count(*) into v3 from vw_participacoes_dia;
    reset role;
    if v <> 0 then raise exception '0123: técnico enxerga % participações fora do escopo — abortando', v; end if;
    if v2 <> 0 then raise exception '0123: técnico enxerga % RATs alheias na busca — abortando', v2; end if;
    if base_total > 0 and v3 >= base_total then
      raise exception '0123: RLS não filtrou o técnico (%/%) — abortando', v3, base_total;
    end if;
  end if;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  negado := false;
  begin
    perform count(*) from vw_participacoes_dia;
  exception when insufficient_privilege then negado := true;
  end;
  if not negado then raise exception '0123: anon ainda seleciona vw_participacoes_dia — abortando'; end if;
  negado := false;
  begin
    perform count(*) from vw_rats_busca;
  exception when insufficient_privilege then negado := true;
  end;
  if not negado then raise exception '0123: anon ainda seleciona vw_rats_busca — abortando'; end if;
  negado := false;
  begin
    perform count(*) from vw_alerta_desloc_sem_volta;
  exception when insufficient_privilege then negado := true;
  end;
  if not negado then raise exception '0123: anon ainda seleciona vw_alerta_desloc_sem_volta — abortando'; end if;
  reset role;

  raise exception 'TESTES_OK: invoker + revoke validados nas 3 views — admin íntegro, técnico no escopo, anon negado (rollback total)';
end $$;
