-- Teste da fn_preorc_sync_almoco (migração 0143) — SEGURO EM PRODUÇÃO.
-- Roda inteiro num único DO $$ … $$ e SEMPRE termina em RAISE EXCEPTION:
--  · 'TESTES_OK …'  = passou (o erro é só o veículo do rollback — nada persiste);
--  · 'TESTE FALHOU …' = detalhe do caso que quebrou.
-- Fixtures em dias remotos (2020-01-07/08, anteriores ao sistema) — impossível colidir com
-- almoço real (unique tecnico_id+dia).
--
-- Casos:
--  1. pré-orç com almoço e equipe de 2 → `almocos` ganha 1 linha POR TÉCNICO (pre_orcamento)
--  2. update da janela → linhas refletem a nova janela (delete + re-registro)
--  3. técnico JÁ tem almoço no dia por RAT com janela DIFERENTE → vira almoco_conflitos
--     (nunca somado em silêncio); o registro da RAT permanece
--  4. remover o almoço do pré-orç → linhas do artefato somem
do $$
declare
  T1 uuid; T2 uuid;
  P1 constant uuid := gen_random_uuid();
  P2 constant uuid := gen_random_uuid();
  RATX constant uuid := gen_random_uuid();
  DIA1 constant date := date '2020-01-07';
  DIA2 constant date := date '2020-01-08';
  v_n int; v_ini time;
begin
  select u.id into T1 from usuarios u where u.nome is not null order by u.nome limit 1;
  select u.id into T2 from usuarios u where u.nome is not null and u.id <> T1 order by u.nome desc limit 1;
  if T1 is null or T2 is null then raise exception 'TESTE FALHOU: preciso de 2 usuários'; end if;

  -- caso 1: insert com almoço + equipe [T1, T2] (dono = T1)
  insert into pre_orcamentos (id, client_uuid, tecnico_id, data, respostas)
  values (P1, gen_random_uuid(), T1, DIA1::timestamptz,
          jsonb_build_object('data', DIA1::text, 'almoco_inicio', '03:00', 'almoco_termino', '04:00',
                             'tecnicos', jsonb_build_array(jsonb_build_object('id', T1), jsonb_build_object('id', T2))));
  select count(*) into v_n from almocos where artefato_tipo = 'pre_orcamento' and artefato_id = P1;
  if v_n <> 2 then raise exception 'TESTE FALHOU (caso 1): esperava 2 almoços (T1+T2), achei %', v_n; end if;

  -- caso 2: update da janela → reflete
  update pre_orcamentos set respostas = respostas || '{"almoco_inicio":"03:10","almoco_termino":"04:10"}'::jsonb
   where id = P1;
  select min(inicio) into v_ini from almocos where artefato_tipo = 'pre_orcamento' and artefato_id = P1;
  if v_ini is distinct from time '03:10'
     then raise exception 'TESTE FALHOU (caso 2): janela não atualizou (início = %)', v_ini; end if;

  -- caso 3: T1 já almoça DIA2 por uma RAT (janela 03:00–04:00); pré-orç divergente no mesmo dia
  insert into almocos (tecnico_id, dia, inicio, fim, origem, artefato_tipo, artefato_id)
  values (T1, DIA2, time '03:00', time '04:00', 'manual', 'rat', RATX);
  insert into pre_orcamentos (id, client_uuid, tecnico_id, data, respostas)
  values (P2, gen_random_uuid(), T1, DIA2::timestamptz,
          jsonb_build_object('data', DIA2::text, 'almoco_inicio', '03:30', 'almoco_termino', '04:30'));
  if not exists (select 1 from almoco_conflitos where tecnico_id = T1 and dia = DIA2 and artefato_tipo = 'pre_orcamento')
     then raise exception 'TESTE FALHOU (caso 3): divergência não virou almoco_conflitos'; end if;
  if not exists (select 1 from almocos where tecnico_id = T1 and dia = DIA2 and artefato_tipo = 'rat' and inicio = time '03:00')
     then raise exception 'TESTE FALHOU (caso 3): almoço da RAT foi sobrescrito'; end if;

  -- caso 4: remover o almoço do pré-orç → linhas somem
  update pre_orcamentos set respostas = respostas - 'almoco_inicio' - 'almoco_termino' where id = P1;
  select count(*) into v_n from almocos where artefato_tipo = 'pre_orcamento' and artefato_id = P1;
  if v_n <> 0 then raise exception 'TESTE FALHOU (caso 4): almoço removido continuou materializado (%)', v_n; end if;

  raise exception 'TESTES_OK: 4 casos passaram (equipe, update, conflito preservado, remoção) — rollback total';
end $$;
