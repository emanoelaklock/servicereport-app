-- 0123 — F17: fecha a exposição das views definer legíveis por anon.
-- Levantamento e decisão de 20/07/2026 (radar F17): vw_participacoes_dia (254 participações),
-- vw_rats_busca (80 RATs com respostas::text inteiro) e vw_alerta_desloc_sem_volta eram
-- definer com grant total pra anon — qualquer pessoa com a anon key (pública no bundle) lia
-- tudo sem login. A sem-volta NASCEU invoker (0065) e PERDEU a opção quando a 0081 fez
-- `create or replace view` sem redeclará-la — o Postgres reseta reloptions no replace.
--
-- Correção (aprovada; validada antes por experimento com rollback — anon=0, admin=254,
-- técnico só escopo próprio, cadeia 0122=7):
--   · security_invoker = true nas três views (RLS de quem consulta passa a valer);
--   · revoke SELECT de anon nas três (defesa em profundidade: nega no grant, antes do RLS);
--   · NENHUMA policy-base alterada — acesso administrativo e escopo do técnico vêm do RLS
--     que já existe (office_all / tecnico_own etc.).
--
-- REGRA DA CASA a partir desta migração (documentada no CLAUDE.md): todo
-- `create or replace view` DEVE redeclarar `with (security_invoker = true)` — o replace
-- reseta a opção em silêncio (regressão real da 0081). Teste de regressão em
-- supabase/tests/teste_0123_views_invoker.sql vigia as reloptions das três.
--
-- A migração ABORTA (rollback total, inclusive os ALTERs) se:
--   · alguma view ficar sem security_invoker;
--   · o admin perder acesso esperado (participações totais/por branch, busca de RATs);
--   · o técnico enxergar QUALQUER linha fora do próprio escopo;
--   · o anon ainda conseguir SELECT (esperado: permission denied, não lista vazia).

do $$
declare
  ADM uuid; TEC uuid;
  base_total int; base_rat int; base_desloc int; base_rats int;
  v int; v2 int; v3 int; v4 int;
  allowed_rats uuid[]; allowed_desloc uuid[];
  negado boolean;
begin
  -- ── DDL (dentro do DO: atômico com as validações) ──
  execute 'alter view public.vw_participacoes_dia set (security_invoker = true)';
  execute 'alter view public.vw_rats_busca set (security_invoker = true)';
  execute 'alter view public.vw_alerta_desloc_sem_volta set (security_invoker = true)';
  execute 'revoke select on public.vw_participacoes_dia from anon';
  execute 'revoke select on public.vw_rats_busca from anon';
  execute 'revoke select on public.vw_alerta_desloc_sem_volta from anon';

  -- ── (1) as três views precisam declarar security_invoker ──
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('vw_participacoes_dia','vw_rats_busca','vw_alerta_desloc_sem_volta')
     and c.reloptions::text like '%security_invoker=true%';
  if v <> 3 then raise exception '0123: só % de 3 views com security_invoker — abortando', v; end if;

  -- ── baselines como postgres (dono das tabelas ignora RLS) ──
  select count(*) into base_total  from vw_participacoes_dia;
  select count(*) into base_rat    from vw_participacoes_dia where artefato_tipo = 'rat';
  select count(*) into base_desloc from vw_participacoes_dia where artefato_tipo <> 'rat';
  select count(*) into base_rats   from rats;

  -- ── (2) admin NÃO pode perder acesso ──
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
    perform count(*) from vw_alerta_desloc_sem_volta;   -- não pode dar erro (conteúdo pode ser 0)
    reset role;
    if v <> base_total then raise exception '0123: admin vê %/% participações — abortando', v, base_total; end if;
    if base_rat > 0 and v2 <> base_rat then raise exception '0123: admin vê %/% no branch rat — abortando', v2, base_rat; end if;
    if base_desloc > 0 and v3 <> base_desloc then raise exception '0123: admin vê %/% no branch deslocamento — abortando', v3, base_desloc; end if;
    if v4 <> base_rats then raise exception '0123: admin vê %/% RATs na busca — abortando', v4, base_rats; end if;
  end if;

  -- ── (3) técnico: NADA fora do próprio escopo (RLS: próprias + colegas nos artefatos dele) ──
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

  -- ── (4) anon: o revoke tem que NEGAR o select (permission denied, não lista vazia) ──
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
end $$;
