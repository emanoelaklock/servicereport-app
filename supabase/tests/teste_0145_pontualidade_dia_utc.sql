-- Teste de regressão da 0145 — SEGURO EM PRODUÇÃO (padrão teste_0138/0144).
-- Fixture descartável + RAISE final incondicional → rollback total:
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0145: …'     = qual condição falhou.
-- PROVAS: (1) RAT com Data declarada → dia = declarada; (2) RAT SEM declarada →
--   dia = data UTC do carimbo (28/07, NÃO 27/07 — era o off-by-one do fallback SP);
--   (3) declarada vazia ('') não estoura a leitura da view (o COALESCE antigo
--   fazia ''::date → erro) e cai no carimbo UTC.
-- Nota: rats com trigger 0144 ativo — no caso (1) o carimbo re-deriva da declarada
--   (irrelevante pra prova); nos casos (2)/(3) o carimbo informado fica.
do $$
declare
  T_ID uuid; R1 uuid; R2 uuid; R3 uuid; v_dia date;
begin
  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T_ID;

  -- (1) declarada 28/07 (carimbo re-derivado pela 0144)
  insert into rats (client_uuid, tarefa_id, origem_registro, status, data_tarefa, respostas)
    values (gen_random_uuid(), T_ID, 'nativo', 'registrado', '2026-08-05T00:00:00Z', jsonb_build_object('data', '2026-07-28'))
    returning id into R1;
  -- (2) sem declarada, carimbo meia-noite UTC de 28/07
  insert into rats (client_uuid, tarefa_id, origem_registro, status, data_tarefa, respostas)
    values (gen_random_uuid(), T_ID, 'nativo', 'registrado', '2026-07-28T00:00:00Z', '{}'::jsonb)
    returning id into R2;
  -- (3) declarada VAZIA, mesmo carimbo
  insert into rats (client_uuid, tarefa_id, origem_registro, status, data_tarefa, respostas)
    values (gen_random_uuid(), T_ID, 'nativo', 'registrado', '2026-07-28T00:00:00Z', jsonb_build_object('data', ''))
    returning id into R3;

  select dia into v_dia from vw_rat_pontualidade where rat_id = R1;
  if v_dia is distinct from date '2026-07-28' then
    raise exception '0145: declarada não mandou no dia (veio %) — abortando', v_dia;
  end if;

  select dia into v_dia from vw_rat_pontualidade where rat_id = R2;
  if v_dia is distinct from date '2026-07-28' then
    raise exception '0145: fallback do carimbo veio % (esperado 2026-07-28 UTC; 27 = off-by-one SP) — abortando', v_dia;
  end if;

  select dia into v_dia from vw_rat_pontualidade where rat_id = R3;
  if v_dia is distinct from date '2026-07-28' then
    raise exception '0145: declarada vazia veio % (esperado carimbo UTC 2026-07-28) — abortando', v_dia;
  end if;

  raise exception 'TESTES_OK 0145 — declarada manda; sem/vazia caem no carimbo UTC sem off-by-one nem erro de cast; rollback total agora.';
end $$;
