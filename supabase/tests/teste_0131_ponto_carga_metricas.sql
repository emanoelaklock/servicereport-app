-- teste_0131_ponto_carga_metricas.sql — auto-abortante (padrão teste_0128/0129/0130):
-- aplica a DDL da 0131 e prova as INVARIANTES DE BANCO da carga histórica contra
-- ponto_marcacoes; termina em RAISE ('0131 OK …') → rollback TOTAL (ponto_marcacoes
-- volta a 0; colunas não persistem). Nada é importado de verdade.
-- Gates:
--  G1  colunas de métrica novas (inalteradas/abertas/excluidas_sinalizadas) com default 0
--  G2  upsert por tangerino_punch_id: reimportação do MESMO id NÃO duplica
--  G3  mesmo id com origem_modificado_em maior → atualiza a linha (correção com mesmo id)
--  G4  excluded=true preservado no espelho (nunca apagamento físico)
--  G5  dateOut null → saida null preservada (marcação aberta)
--  G6  "ausência não apaga": janela posterior sem o id anterior NÃO o remove (upsert-only)
--  G7  papel de app (authenticated) NÃO escreve em ponto_marcacoes (RLS: sem policy de insert)
--  G8  vínculos e fora do escopo intactos (a carga não toca decisões)
do $$
declare
  v_tec uuid; v_tec2 uuid; v_n int; v_raised boolean; v_saida timestamptz; v_excl boolean;
  v_assin_ini text; v_assin_fim text; v_fora_ini int;
begin
  select md5(string_agg(tecnico_id::text||':'||tangerino_employee_id::text, ',' order by tangerino_employee_id))
    into v_assin_ini from ponto_colaboradores_map where ativo;
  select count(*) into v_fora_ini from ponto_fora_escopo;
  select m.tecnico_id into v_tec from ponto_colaboradores_map m where m.ativo limit 1;
  select pa.usuario_id into v_tec2 from portal_acessos pa where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  if v_tec is null or v_tec2 is null then raise exception '0131: fixtures ausentes'; end if;

  -- aplica a DDL da 0131
  execute 'alter table public.ponto_sync_execucoes add column if not exists inalteradas int not null default 0,
     add column if not exists abertas int not null default 0, add column if not exists excluidas_sinalizadas int not null default 0';

  -- G1
  select count(*) into v_n from information_schema.columns where table_schema='public' and table_name='ponto_sync_execucoes'
    and column_name in ('inalteradas','abertas','excluidas_sinalizadas') and column_default='0';
  if v_n <> 3 then raise exception '0131 G1: colunas de metrica ausentes/sem default (%)', v_n; end if;

  -- G2
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, excluido_origem, tz_origem, origem_modificado_em)
  values (9990001, v_tec, date '2026-07-01', '2026-07-01T11:00:00Z', '2026-07-01T15:00:00Z', 'APPROVED', false, 'SAO_PAULO', '2026-07-01T15:01:00Z')
  on conflict (tangerino_punch_id) do update set saida=excluded.saida, origem_modificado_em=excluded.origem_modificado_em;
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, excluido_origem, tz_origem, origem_modificado_em)
  values (9990001, v_tec, date '2026-07-01', '2026-07-01T11:00:00Z', '2026-07-01T15:00:00Z', 'APPROVED', false, 'SAO_PAULO', '2026-07-01T15:01:00Z')
  on conflict (tangerino_punch_id) do update set saida=excluded.saida, origem_modificado_em=excluded.origem_modificado_em;
  select count(*) into v_n from ponto_marcacoes where tangerino_punch_id=9990001;
  if v_n <> 1 then raise exception '0131 G2: upsert duplicou (% linhas)', v_n; end if;

  -- G3
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, excluido_origem, tz_origem, origem_modificado_em)
  values (9990001, v_tec, date '2026-07-01', '2026-07-01T11:00:00Z', '2026-07-01T16:30:00Z', 'APPROVED', false, 'SAO_PAULO', '2026-07-01T16:31:00Z')
  on conflict (tangerino_punch_id) do update set saida=excluded.saida, origem_modificado_em=excluded.origem_modificado_em;
  select saida into v_saida from ponto_marcacoes where tangerino_punch_id=9990001;
  if v_saida <> '2026-07-01T16:30:00Z'::timestamptz then raise exception '0131 G3: correcao nao aplicada'; end if;

  -- G4
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, excluido_origem, tz_origem, origem_modificado_em)
  values (9990002, v_tec, date '2026-07-02', '2026-07-02T11:00:00Z', '2026-07-02T15:00:00Z', 'APPROVED', true, 'SAO_PAULO', '2026-07-02T15:01:00Z')
  on conflict (tangerino_punch_id) do update set excluido_origem=excluded.excluido_origem;
  select excluido_origem into v_excl from ponto_marcacoes where tangerino_punch_id=9990002;
  if not v_excl then raise exception '0131 G4: excluded nao preservado'; end if;
  if not exists (select 1 from ponto_marcacoes where tangerino_punch_id=9990002) then raise exception '0131 G4: apagamento fisico'; end if;

  -- G5
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, excluido_origem, tz_origem, pendente_metade)
  values (9990003, v_tec, date '2026-07-03', '2026-07-03T13:00:00Z', null, 'PENDING', false, 'SAO_PAULO', 'SAIDA')
  on conflict (tangerino_punch_id) do nothing;
  select saida into v_saida from ponto_marcacoes where tangerino_punch_id=9990003;
  if v_saida is not null then raise exception '0131 G5: saida null nao preservada'; end if;

  -- G6
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, excluido_origem, tz_origem)
  values (9990004, v_tec, date '2026-07-04', '2026-07-04T11:00:00Z', '2026-07-04T15:00:00Z', 'APPROVED', false, 'SAO_PAULO')
  on conflict (tangerino_punch_id) do nothing;
  if not exists (select 1 from ponto_marcacoes where tangerino_punch_id=9990001) then raise exception '0131 G6: ausencia apagou registro anterior'; end if;

  -- G7
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role','authenticated')::text, true);
    set local role authenticated;
    insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, status_origem, tz_origem)
    values (9990099, v_tec, date '2026-07-05', '2026-07-05T11:00:00Z', 'APPROVED', 'SAO_PAULO');
  exception when insufficient_privilege then v_raised := true; end;
  reset role;
  if not v_raised then
    select count(*) into v_n from ponto_marcacoes where tangerino_punch_id=9990099;
    if v_n <> 0 then raise exception '0131 G7: papel de app escreveu em ponto_marcacoes'; end if;
  end if;

  -- G8
  select md5(string_agg(tecnico_id::text||':'||tangerino_employee_id::text, ',' order by tangerino_employee_id))
    into v_assin_fim from ponto_colaboradores_map where ativo;
  if v_assin_fim is distinct from v_assin_ini then raise exception '0131 G8: assinatura dos vinculos mudou'; end if;
  if (select count(*) from ponto_fora_escopo) <> v_fora_ini then raise exception '0131 G8: fora do escopo mudou'; end if;

  raise exception '0131 OK: G1-G8 verdes — rollback total (ponto_marcacoes volta a 0)';
end $$;
