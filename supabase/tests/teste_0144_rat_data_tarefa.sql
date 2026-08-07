-- Teste de regressão da 0144 — SEGURO EM PRODUÇÃO (padrão teste_0138).
-- Fixture descartável + RAISE final incondicional → rollback total:
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0144: …'     = qual condição falhou.
-- PROVAS: (1) insert com Data declarada retroativa re-carimba data_tarefa;
--   (2) mudar a Data declarada move o carimbo junto; (3) update direto de data_tarefa
--   contradizendo a declarada perde (a declarada vence); (4) Data declarada VAZIA
--   não bloqueia o save nem re-carimba; (5) sem Data declarada, o carimbo que veio fica.
-- Nota: data malformada (ex.: '2026-02-31') não é testável aqui — quebra ANTES no cast
-- direto do tarefa_status_alvo (0130:47, pré-existente à 0144); o app só produz
-- YYYY-MM-DD válido ou vazio, e o fn_date_ou_null do trigger da 0144 tolera ambos.
do $$
declare
  T_ID uuid; R_ID uuid; v_dt timestamptz;
  dia_utc text;
begin
  -- fixture descartável
  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T_ID;

  -- (1) INSERT retroativo: criada "em 05/08" com serviço declarado em 28/07
  insert into rats (client_uuid, tarefa_id, data_tarefa, respostas)
    values (gen_random_uuid(), T_ID, '2026-08-05T00:00:00Z', jsonb_build_object('data', '2026-07-28'))
    returning id, data_tarefa into R_ID, v_dt;
  dia_utc := to_char(v_dt at time zone 'UTC', 'YYYY-MM-DD');
  if dia_utc <> '2026-07-28' then
    raise exception '0144: insert não re-carimbou pela declarada (ficou %) — abortando', dia_utc;
  end if;

  -- (2) UPDATE da Data declarada: o carimbo acompanha
  update rats set respostas = jsonb_set(respostas, '{data}', '"2026-07-29"') where id = R_ID
    returning data_tarefa into v_dt;
  dia_utc := to_char(v_dt at time zone 'UTC', 'YYYY-MM-DD');
  if dia_utc <> '2026-07-29' then
    raise exception '0144: mudar a declarada não moveu o carimbo (ficou %) — abortando', dia_utc;
  end if;

  -- (3) UPDATE direto de data_tarefa contradizendo a declarada: a declarada vence
  update rats set data_tarefa = '2026-08-01T00:00:00Z' where id = R_ID
    returning data_tarefa into v_dt;
  dia_utc := to_char(v_dt at time zone 'UTC', 'YYYY-MM-DD');
  if dia_utc <> '2026-07-29' then
    raise exception '0144: update direto de data_tarefa venceu a declarada (ficou %) — abortando', dia_utc;
  end if;

  -- (4) Data declarada VAZIA: save passa e o carimbo NÃO muda
  update rats set respostas = jsonb_set(respostas, '{data}', '""') where id = R_ID
    returning data_tarefa into v_dt;
  dia_utc := to_char(v_dt at time zone 'UTC', 'YYYY-MM-DD');
  if dia_utc <> '2026-07-29' then
    raise exception '0144: declarada vazia mexeu no carimbo (ficou %) — abortando', dia_utc;
  end if;

  -- (5) Sem Data declarada: o carimbo que veio fica
  insert into rats (client_uuid, tarefa_id, data_tarefa, respostas)
    values (gen_random_uuid(), T_ID, '2026-08-05T00:00:00Z', '{}'::jsonb)
    returning data_tarefa into v_dt;
  dia_utc := to_char(v_dt at time zone 'UTC', 'YYYY-MM-DD');
  if dia_utc <> '2026-08-05' then
    raise exception '0144: sem declarada o carimbo mudou (ficou %) — abortando', dia_utc;
  end if;

  raise exception 'TESTES_OK 0144 — declarada re-carimba (insert/update), vence update direto, ilegível/ausente preservam; rollback total agora.';
end $$;
