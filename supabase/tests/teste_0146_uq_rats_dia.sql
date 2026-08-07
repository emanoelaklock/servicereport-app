-- Teste de regressão da 0146 (F3) — SEGURO EM PRODUÇÃO (padrão teste_0138/0144).
-- Fixture descartável + RAISE final incondicional → rollback total:
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0146: …'     = qual condição falhou.
-- PROVAS: (1) NEGATIVA — 2ª RAT do MESMO técnico/tarefa/dia estoura 23505 no índice
--   uq_rats_tarefa_dia_tecnico (é o sinal que o sync.js trata sem loop);
--   (2) improdutiva + nova RAT do MESMO dia passa (fluxo legítimo fica fora do índice);
--   (3) mesmo técnico em DIAS diferentes passa; (4) OUTRO técnico no MESMO dia passa
--   (coexistência entre técnicos preservada — decisão do triple check 07/08);
--   (5) EDITAR a Data declarada para um dia já coberto também estoura 23505 (a 0144
--   re-carimba e o índice pega o update).
do $$
declare
  T_ID uuid; TEC_A uuid; TEC_B uuid;
  R_LIVRE uuid; v_bug boolean;
begin
  -- atores reais do ambiente (rats.tecnico_id tem FK pra usuarios — padrão teste_0138)
  select pa.usuario_id into TEC_A from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave = 'tecnico_campo' limit 1;
  select pa.usuario_id into TEC_B from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.usuario_id <> TEC_A limit 1;
  if TEC_A is null or TEC_B is null then
    raise exception '0146: ambiente sem dois usuários — teste inconclusivo (NADA aplicado)';
  end if;

  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T_ID;

  -- base: RAT do técnico A no dia 28/07
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T_ID, TEC_A, 'registrado', jsonb_build_object('data', '2026-07-28'));

  -- (1) NEGATIVA: 2ª RAT de A no mesmo dia → 23505 do índice
  v_bug := false;
  begin
    insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
      values (gen_random_uuid(), T_ID, TEC_A, 'em_andamento', jsonb_build_object('data', '2026-07-28'));
  exception when unique_violation then
    if sqlerrm not ilike '%uq_rats_tarefa_dia_tecnico%' then
      raise exception '0146: 23505 veio de OUTRO índice (%) — abortando', sqlerrm;
    end if;
    v_bug := true;
  end;
  if not v_bug then raise exception '0146: duplicata do mesmo técnico/dia NÃO foi barrada — abortando'; end if;

  -- (2) improdutiva no mesmo dia + já existir a registrada: passa (parcial exclui improdutiva)
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T_ID, TEC_A, 'improdutiva', jsonb_build_object('data', '2026-07-28'));

  -- (3) mesmo técnico, dia diferente: passa
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T_ID, TEC_A, 'em_andamento', jsonb_build_object('data', '2026-07-29'))
    returning client_uuid into R_LIVRE;

  -- (4) OUTRO técnico, mesmo dia 28/07: passa (coexistência preservada)
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T_ID, TEC_B, 'em_andamento', jsonb_build_object('data', '2026-07-28'));

  -- (5) EDITAR a Data da RAT de 29/07 para 28/07 (dia já coberto por A) → 23505 no UPDATE
  v_bug := false;
  begin
    update rats set respostas = jsonb_set(respostas, '{data}', '"2026-07-28"') where client_uuid = R_LIVRE;
  exception when unique_violation then
    if sqlerrm not ilike '%uq_rats_tarefa_dia_tecnico%' then
      raise exception '0146: 23505 do update veio de OUTRO índice (%) — abortando', sqlerrm;
    end if;
    v_bug := true;
  end;
  if not v_bug then raise exception '0146: mudar a Data pra dia já coberto NÃO foi barrado — abortando'; end if;

  raise exception 'TESTES_OK 0146 — duplicata barrada (insert e update de Data), improdutiva/dias distintos/outro técnico passam; rollback total agora.';
end $$;
