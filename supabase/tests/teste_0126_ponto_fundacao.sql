-- Teste de regressão da 0126 (fundação do ponto) — SEGURO EM PRODUÇÃO.
-- Padrão da casa (teste_0124): aplica o DDL dentro da transação, prova as garantias e
-- levanta exceção incondicional no fim → rollback total, nada persiste.
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0126: …'     = qual condição falhou.
-- Provas: RLS ligada nas 4 tabelas · nenhuma policy para anon · técnico não lê nem escreve ·
-- admin lê · unicidade tangerino_punch_id e do map · config nasce com 1 linha e tolerâncias nulas.
do $MIG$
declare
  v_n int; v_tec uuid; v_adm uuid; v_raised boolean;
  v_claims_tec text; v_claims_adm text;
begin
  -- ── aplica o DDL da 0126 (idempotente; se já mergeada, re-aplica sem efeito) ──
  -- (corpo idêntico ao arquivo da migração — manter em sincronia ao revisar)
  execute $DDL$
    create table if not exists public.ponto_colaboradores_map (
      tecnico_id uuid primary key references public.usuarios(id),
      tangerino_employee_id bigint not null unique,
      tangerino_external_id text,
      vinculado_por uuid not null references public.usuarios(id),
      vinculado_em timestamptz not null default now(),
      ativo boolean not null default true,
      observacao text
    );
  $DDL$;
  execute 'alter table public.ponto_colaboradores_map enable row level security';
  execute 'drop policy if exists pmap_office_all on public.ponto_colaboradores_map';
  execute $P$ create policy pmap_office_all on public.ponto_colaboradores_map
    for all using (app_role() = any (array['admin','gestor_axis']))
    with check (app_role() = any (array['admin','gestor_axis'])) $P$;

  execute $DDL$
    create table if not exists public.ponto_marcacoes (
      id uuid primary key default gen_random_uuid(),
      tangerino_punch_id bigint not null unique,
      tecnico_id uuid not null references public.usuarios(id),
      dia date not null,
      entrada timestamptz, saida timestamptz,
      entrada_raw text, saida_raw text,
      status_origem text not null check (status_origem in ('APPROVED','PENDING','REPROVED')),
      excluido_origem boolean not null default false,
      editado_origem boolean not null default false,
      pendente_metade text check (pendente_metade in ('ENTRADA','SAIDA','AMBOS')),
      tz_origem text not null,
      origem_modificado_em timestamptz,
      importado_em timestamptz not null default now(),
      atualizado_em timestamptz not null default now()
    );
  $DDL$;
  execute 'alter table public.ponto_marcacoes enable row level security';
  execute 'drop policy if exists pmar_office_sel on public.ponto_marcacoes';
  execute $P$ create policy pmar_office_sel on public.ponto_marcacoes
    for select using (app_role() = any (array['admin','gestor_axis'])) $P$;

  execute $DDL$
    create table if not exists public.ponto_sync_execucoes (
      id uuid primary key default gen_random_uuid(),
      iniciado_em timestamptz not null default now(),
      terminado_em timestamptz,
      tipo text not null check (tipo in ('delta','janela7d','carga_historica','reconhecimento')),
      cursor_anterior bigint, cursor_novo bigint,
      paginas int not null default 0, novas int not null default 0,
      atualizadas int not null default 0, descartadas_sem_vinculo int not null default 0,
      status text not null default 'ok' check (status in ('ok','erro','parcial')),
      erro_sanitizado text
    );
  $DDL$;
  execute 'alter table public.ponto_sync_execucoes enable row level security';
  execute 'drop policy if exists pexe_office_sel on public.ponto_sync_execucoes';
  execute $P$ create policy pexe_office_sel on public.ponto_sync_execucoes
    for select using (app_role() = any (array['admin','gestor_axis'])) $P$;

  execute $DDL$
    create table if not exists public.ponto_config (
      id int primary key default 1 check (id = 1),
      tolerancia_inicio_min int, tolerancia_termino_min int, tolerancia_duracao_min int,
      janela_almoco_ini time not null default '10:00',
      janela_almoco_fim time not null default '15:00',
      gap_minimo_almoco_min int not null default 15,
      transicao_max_min int not null default 5,
      retencao_meses int not null default 12,
      atualizado_em timestamptz not null default now()
    );
  $DDL$;
  execute 'insert into public.ponto_config (id) values (1) on conflict (id) do nothing';
  execute 'alter table public.ponto_config enable row level security';
  execute 'drop policy if exists pcfg_office_all on public.ponto_config';
  execute $P$ create policy pcfg_office_all on public.ponto_config
    for all using (app_role() = any (array['admin','gestor_axis']))
    with check (app_role() = any (array['admin','gestor_axis'])) $P$;

  -- ── (1) RLS ligada nas 4 tabelas ──
  select count(*) into v_n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relrowsecurity
     and c.relname in ('ponto_colaboradores_map','ponto_marcacoes','ponto_sync_execucoes','ponto_config');
  if v_n <> 4 then raise exception '0126: RLS desligada em alguma tabela (%/4)', v_n; end if;

  -- ── (2) nenhuma policy cita anon; e marcacoes/execucoes não têm policy de escrita ──
  select count(*) into v_n from pg_policies
   where schemaname = 'public'
     and tablename in ('ponto_colaboradores_map','ponto_marcacoes','ponto_sync_execucoes','ponto_config')
     and 'anon' = any (coalesce(roles, '{}'));
  if v_n <> 0 then raise exception '0126: policy com role anon (%)', v_n; end if;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename in ('ponto_marcacoes','ponto_sync_execucoes')
     and cmd <> 'SELECT';
  if v_n <> 0 then raise exception '0126: policy de escrita indevida no espelho/trilha (%)', v_n; end if;

  -- ── (3) simulação de papéis: técnico não lê; admin lê ──
  select pa.usuario_id into v_tec from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave = 'tecnico_campo' limit 1;
  select pa.usuario_id into v_adm from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave in ('admin','gestor_axis') limit 1;
  if v_tec is null or v_adm is null then raise exception '0126: faltam perfis para simular'; end if;

  -- carga mínima como service (dentro da tx) para o SELECT ter o que (não) devolver
  insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
  values (v_tec, 999901, v_adm);
  insert into public.ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, status_origem, tz_origem)
  values (999901001, v_tec, current_date, 'APPROVED', 'SAO_PAULO');

  v_claims_tec := json_build_object('sub', v_tec, 'role', 'authenticated')::text;
  v_claims_adm := json_build_object('sub', v_adm, 'role', 'authenticated')::text;

  perform set_config('request.jwt.claims', v_claims_tec, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.ponto_marcacoes;
  if v_n <> 0 then raise exception '0126: técnico lê o espelho (%)', v_n; end if;
  select count(*) into v_n from public.ponto_colaboradores_map;
  if v_n <> 0 then raise exception '0126: técnico lê o map (%)', v_n; end if;

  v_raised := false;
  begin
    insert into public.ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, status_origem, tz_origem)
    values (999901002, v_tec, current_date, 'APPROVED', 'SAO_PAULO');
  exception when insufficient_privilege or others then v_raised := true; end;
  if not v_raised then raise exception '0126: técnico conseguiu escrever no espelho'; end if;

  perform set_config('request.jwt.claims', v_claims_adm, true);
  select count(*) into v_n from public.ponto_marcacoes;
  if v_n < 1 then raise exception '0126: admin não lê o espelho'; end if;
  perform set_config('role', 'postgres', true);

  -- ── (4) unicidade ──
  v_raised := false;
  begin
    insert into public.ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, status_origem, tz_origem)
    values (999901001, v_tec, current_date, 'APPROVED', 'SAO_PAULO');
  exception when unique_violation then v_raised := true; end;
  if not v_raised then raise exception '0126: tangerino_punch_id duplicado passou'; end if;

  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_adm, 999901, v_adm);   -- mesmo employee_id p/ outro técnico
  exception when unique_violation then v_raised := true; end;
  if not v_raised then raise exception '0126: tangerino_employee_id duplicado passou'; end if;

  -- ── (5) config: 1 linha, tolerâncias nulas até a calibração (gate C3) ──
  select count(*) into v_n from public.ponto_config;
  if v_n <> 1 then raise exception '0126: ponto_config sem linha única (%)', v_n; end if;
  select count(*) into v_n from public.ponto_config
   where tolerancia_inicio_min is null and tolerancia_termino_min is null and tolerancia_duracao_min is null;
  if v_n <> 1 then raise exception '0126: tolerâncias deveriam nascer nulas'; end if;

  raise exception 'TESTES_OK 0126 — fundação do ponto validada (rollback total desta transação)';
end $MIG$;
