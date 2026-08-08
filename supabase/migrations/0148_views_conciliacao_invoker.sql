-- 0148 — fecha o furo F17 remanescente: views de conciliação/material legíveis por anon.
--
-- Achado do triple check de 08/08 (advisor security_definer_view, nível ERROR, +
-- prova de exposição): 4 views DEFINER com grant a anon — `vw_conciliacao` (anon lia
-- 140 linhas), `vw_rat_material_conflito` (73), `vw_conciliacao_tarefa` e
-- `vw_tarefa_materiais_tecnico` (0 linhas hoje, mas grant + definer = mesmo furo).
-- Mesma anatomia do F17/0123 — eram os itens "no radar, não iniciados" do P0.
--
-- O fix, por view (consumo auditado no código antes de mexer):
-- · vw_conciliacao_tarefa + vw_rat_material_conflito (portal admin, tarefa.js):
--   security_invoker = true + revoke anon. O admin segue lendo pelo RLS das bases
--   (materiais_admin_all / tm_office_all / tarefas_admin_all — conferido).
-- · vw_conciliacao: SEM consumidor no código (js/functions) — invoker + revoke de
--   anon E authenticated (gestão ad-hoc usa papel de infra).
-- · vw_tarefa_materiais_tecnico (app do TÉCNICO, 2 pontos): o DEFINER é DELIBERADO —
--   o técnico não tem SELECT em tarefa_materiais e a view existe justamente pra ele
--   ver orçado/levado sem preço. Fica definer + authenticated; só o anon sai.
--   Aceito e registrado: qualquer authenticated lê material (sem preço) de qualquer
--   tarefa por ela — estreitar é backlog, não regressão.
-- Regra da casa (CLAUDE.md): ALTER VIEW ... SET preserva a definição sem replace
-- (não re-declara colunas nem reseta nada além do que setamos).
--
-- Bônus de endurecimento (advisor function_search_path_mutable): fn_date_ou_null e
-- fn_time_ou_null ganham search_path travado — a primeira vive em ÍNDICE (0146) e
-- em triggers (0144); deriva de search_path era risco teórico, agora zero.

alter view public.vw_conciliacao_tarefa      set (security_invoker = true);
alter view public.vw_rat_material_conflito   set (security_invoker = true);
alter view public.vw_conciliacao             set (security_invoker = true);
-- vw_tarefa_materiais_tecnico permanece DEFINER (deliberado — ver cabeçalho)

revoke all on public.vw_conciliacao_tarefa      from anon;
revoke all on public.vw_rat_material_conflito   from anon;
revoke all on public.vw_conciliacao             from anon, authenticated;
revoke all on public.vw_tarefa_materiais_tecnico from anon;

alter function public.fn_date_ou_null(text) set search_path = public, pg_temp;
alter function public.fn_time_ou_null(text) set search_path = public, pg_temp;

-- Guarda auto-abortante: invoker onde deve, definer onde deve, anon fora das 4,
-- e as PROVAS de acesso (admin lê as do portal; técnico lê a dele; anon barrado).
do $$
declare
  ADM uuid; TEC uuid; v_opts text[]; n int; v_ok boolean;
begin
  -- estados de invoker/definer
  for n in 1..3 loop
    select c.reloptions into v_opts from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = (array['vw_conciliacao_tarefa','vw_rat_material_conflito','vw_conciliacao'])[n];
    if v_opts is null or not ('security_invoker=true' = any(v_opts)) then
      raise exception '0148: view % sem security_invoker — abortando', (array['vw_conciliacao_tarefa','vw_rat_material_conflito','vw_conciliacao'])[n];
    end if;
  end loop;
  select c.reloptions into v_opts from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'vw_tarefa_materiais_tecnico';
  if v_opts is not null and 'security_invoker=true' = any(v_opts) then
    raise exception '0148: vw_tarefa_materiais_tecnico virou invoker — quebraria o app do técnico, abortando';
  end if;

  -- anon sem NENHUM privilégio nas 4
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and table_name in ('vw_conciliacao_tarefa','vw_rat_material_conflito','vw_conciliacao','vw_tarefa_materiais_tecnico');
  if n > 0 then raise exception '0148: anon ainda tem % grant(s) nas views — abortando', n; end if;

  -- provas de acesso com papéis reais
  select pa.usuario_id into ADM from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave in ('admin','gestor_axis') limit 1;
  select pa.usuario_id into TEC from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave = 'tecnico_campo' limit 1;
  if ADM is null or TEC is null then raise exception '0148: ambiente sem admin/técnico — abortando'; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',ADM)::text, true);
  set local role authenticated;
  perform count(*) from public.vw_conciliacao_tarefa;      -- admin lê (invoker via RLS das bases)
  perform count(*) from public.vw_rat_material_conflito;
  reset role;

  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',TEC)::text, true);
  set local role authenticated;
  perform count(*) from public.vw_tarefa_materiais_tecnico;  -- técnico segue lendo (definer)
  reset role;

  v_ok := false;
  begin
    set local role anon;
    perform count(*) from public.vw_conciliacao;
  exception when insufficient_privilege then v_ok := true;
  end;
  reset role;
  if not v_ok then raise exception '0148: anon AINDA lê vw_conciliacao — abortando'; end if;
end $$;
