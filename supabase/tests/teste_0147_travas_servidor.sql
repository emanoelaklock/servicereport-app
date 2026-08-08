-- Teste de regressão da 0147 (F2) — SEGURO EM PRODUÇÃO (padrão teste_0138).
-- Fixture descartável + RAISE final incondicional → rollback total:
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0147: …'     = qual condição falhou.
-- As provas rodam sob o papel REAL `authenticated` com claims de técnico/admin — as
-- isenções de infra (postgres/service_role) fazem parte do desenho e são cobertas
-- pela prova P6 (postgres insere improdutiva sem motivo e passa: consolidação não trava).
do $$
declare
  TEC uuid; ADM uuid; T1 uuid; T2 uuid; T3 uuid;
  v boolean; agora_min int; fut_min int; fut_hhmm text; hoje_br text;
begin
  select pa.usuario_id into TEC from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave = 'tecnico_campo' limit 1;
  select pa.usuario_id into ADM from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave in ('admin', 'gestor_axis') limit 1;
  if TEC is null or ADM is null then
    raise exception '0147: ambiente sem técnico/admin — teste inconclusivo (NADA aplicado)';
  end if;

  -- fixture (como postgres): 3 tarefas, técnico responsável em todas (policy os_tecnico_upd)
  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T1;
  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T2;
  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T3;
  insert into tarefa_tecnicos (tarefa_id, tecnico_id) values (T1, TEC), (T2, TEC), (T3, TEC);

  -- ── como TÉCNICO (authenticated) ──
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', TEC)::text, true);
  set local role authenticated;

  -- (N1) improdutiva SEM motivo → barrada
  v := false;
  begin
    insert into rats (client_uuid, tarefa_id, tecnico_id, status, atendimento_executado, respostas)
      values (gen_random_uuid(), T1, TEC, 'improdutiva', false, jsonb_build_object('data', '2026-08-01'));
  exception when others then
    if sqlerrm not ilike '%SR_VALIDA%improdutiva%' then raise exception '0147: N1 rejeitou pelo motivo errado (%)', sqlerrm; end if;
    v := true;
  end;
  if not v then raise exception '0147: N1 improdutiva sem motivo PASSOU — abortando'; end if;

  -- (P1) improdutiva COM motivo → passa
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, atendimento_executado, motivo_improdutiva, respostas)
    values (gen_random_uuid(), T1, TEC, 'improdutiva', false, 'cliente_ausente', jsonb_build_object('data', '2026-08-01'));

  -- (N2) hora ilegível → barrada
  v := false;
  begin
    insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
      values (gen_random_uuid(), T1, TEC, 'em_andamento', jsonb_build_object('data', '2026-08-02', 'hora_inicio', '25:99'));
  exception when others then
    if sqlerrm not ilike '%SR_VALIDA%ilegível%' then raise exception '0147: N2 rejeitou pelo motivo errado (%)', sqlerrm; end if;
    v := true;
  end;
  if not v then raise exception '0147: N2 hora ilegível PASSOU — abortando'; end if;

  -- (N3) ordem invertida REAL (14:11→13:30, distância 23h49) → barrada
  v := false;
  begin
    insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
      values (gen_random_uuid(), T1, TEC, 'registrado', jsonb_build_object('data', '2026-08-02', 'hora_inicio', '14:11', 'hora_termino', '13:30'));
  exception when others then
    if sqlerrm not ilike '%SR_VALIDA%invertida%' then raise exception '0147: N3 rejeitou pelo motivo errado (%)', sqlerrm; end if;
    v := true;
  end;
  if not v then raise exception '0147: N3 ordem invertida PASSOU — abortando'; end if;

  -- (P2) madrugada legítima (22:00→02:00, distância 4h) → passa
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T1, TEC, 'registrado', jsonb_build_object('data', '2026-08-02', 'hora_inicio', '22:00', 'hora_termino', '02:00'));

  -- (N4) término no FUTURO em RAT de hoje (agora+2h, se couber no dia) → barrada
  agora_min := (extract(epoch from (now() at time zone 'America/Sao_Paulo')::time) / 60)::int;
  fut_min := least(agora_min + 120, 1439);
  if fut_min > agora_min + 15 then
    hoje_br := to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD');
    fut_hhmm := lpad((fut_min / 60)::text, 2, '0') || ':' || lpad((fut_min % 60)::text, 2, '0');
    v := false;
    begin
      insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
        values (gen_random_uuid(), T2, TEC, 'registrado', jsonb_build_object('data', hoje_br, 'hora_inicio', '08:00', 'hora_termino', fut_hhmm));
    exception when others then
      if sqlerrm not ilike '%SR_VALIDA%futuro%' then raise exception '0147: N4 rejeitou pelo motivo errado (%)', sqlerrm; end if;
      v := true;
    end;
    if not v then raise exception '0147: N4 término no futuro PASSOU — abortando'; end if;
  else
    raise notice '0147: N4 pulada (madrugada — agora+2h não cabe no dia)';
  end if;

  -- (P3) RAT normal de dia passado → passa (vira a RAT registrada de T1 pro teste de conclusão)
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T1, TEC, 'registrado', jsonb_build_object('data', '2026-08-03', 'hora_inicio', '08:00', 'hora_termino', '17:00'));

  -- (N5) técnico conclui tarefa SEM RAT → barrada
  v := false;
  begin
    update tarefas set status = 'concluida' where id = T2;
  exception when others then
    if sqlerrm not ilike '%SR_VALIDA%RAT registrada%' then raise exception '0147: N5 rejeitou pelo motivo errado (%)', sqlerrm; end if;
    v := true;
  end;
  if not v then raise exception '0147: N5 concluir sem RAT PASSOU — abortando'; end if;

  -- (N6) retorno em aberto ("volto depois") → concluir barrado
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, respostas)
    values (gen_random_uuid(), T3, TEC, 'registrado',
            jsonb_build_object('data', '2026-08-03', 'hora_inicio', '08:00', 'hora_termino', '17:00',
                               'volta_amanha', 'Não', 'passagem_motivo', 'volto_depois'));
  v := false;
  begin
    update tarefas set status = 'concluida' where id = T3;
  exception when others then
    if sqlerrm not ilike '%SR_VALIDA%retorno em aberto%' then raise exception '0147: N6 rejeitou pelo motivo errado (%)', sqlerrm; end if;
    v := true;
  end;
  if not v then raise exception '0147: N6 concluir com retorno em aberto PASSOU — abortando'; end if;

  -- (P4) técnico conclui T1 (tem RAT registrada, sem retorno em aberto) → passa
  update tarefas set status = 'concluida' where id = T1;

  -- ── como ADMIN: isenção (força com ciência — o alerta F12 segue apontando) ──
  reset role;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', ADM)::text, true);
  set local role authenticated;
  -- (P5) admin conclui T2 SEM RAT → passa
  update tarefas set status = 'concluida' where id = T2;

  -- ── como POSTGRES: isenção de infra (consolidação/migração não trava) ──
  reset role;
  -- (P6) improdutiva sem motivo por papel de infra → passa
  insert into rats (client_uuid, tarefa_id, tecnico_id, status, atendimento_executado, respostas)
    values (gen_random_uuid(), T2, TEC, 'improdutiva', false, jsonb_build_object('data', '2026-08-04'));

  raise exception 'TESTES_OK 0147 — N1-N6 barradas com a mensagem certa; madrugada/motivo/dia passado passam; admin e infra isentos; rollback total agora.';
end $$;
