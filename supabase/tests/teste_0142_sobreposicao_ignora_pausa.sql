-- Teste da vw_alerta_sobreposicao pós-0142 (pausa explica o cruzamento) — SEGURO EM PRODUÇÃO.
-- Roda inteiro num único DO $$ … $$ e SEMPRE termina em RAISE EXCEPTION:
--  · 'TESTES_OK …'  = passou (o erro é só o veículo do rollback — nada persiste);
--  · 'TESTE FALHOU …' = detalhe do caso que quebrou.
-- Fixtures no molde do teste_0122: técnico REAL de nome único, dia-fixture 2020-01-06.
--
-- Casos (todas as RATs são do MESMO técnico no MESMO dia — cada caso usa uma FAIXA de
-- horário disjunta das demais, senão os casos cruzam entre si e viram pares espúrios):
--  P1. base SEM pausa (13:00–15:00 × 14:30–16:00)                       → par APARECE
--  P2. pausa na 1ª RAT cobre o conflito (05:50–07:10 ⊇ 06:00–07:00)     → some
--  P3. pausa PARCIAL (09:30–09:45 não cobre 09:00–10:00)                → par APARECE
--  P4. pausa na 2ª RAT do par cobre o conflito (16:55–17:35 ⊇ 17–17:30) → some
--  extra: sem claims → 0 linhas (gate admin preservado no replace)
do $$
declare
  T1 uuid; T1_NOME text;
  CLI constant uuid := gen_random_uuid();
  DIA_F constant date := date '2020-01-06';
  TA uuid := gen_random_uuid(); TB uuid := gen_random_uuid(); TC uuid := gen_random_uuid(); TD uuid := gen_random_uuid();
  TE uuid := gen_random_uuid(); TF uuid := gen_random_uuid(); TG uuid := gen_random_uuid(); TH uuid := gen_random_uuid();
  RA uuid := gen_random_uuid(); RB uuid := gen_random_uuid(); RC uuid := gen_random_uuid(); RD uuid := gen_random_uuid();
  RE_ uuid := gen_random_uuid(); RF uuid := gen_random_uuid(); RG uuid := gen_random_uuid(); RH uuid := gen_random_uuid();
  ids uuid[];
  v_n int;
begin
  -- técnico real de nome único (o trigger fn_rat_sync_tempo casa por nome)
  select u.id, u.nome into T1, T1_NOME from usuarios u
   where u.nome is not null and trim(u.nome) <> ''
     and not exists (select 1 from usuarios x where x.id <> u.id and lower(trim(x.nome)) = lower(trim(u.nome)))
   order by u.nome limit 1;
  if T1 is null then raise exception 'TESTE FALHOU: não achei usuário de nome único'; end if;

  insert into clientes (id, nome) values (CLI, 'ZZ TESTE PAUSA 0142 (rollback)');
  insert into tarefas (id, numero, cliente_id, status) values
    (TA, 99971, CLI, 'em_execucao'), (TB, 99972, CLI, 'em_execucao'),
    (TC, 99973, CLI, 'em_execucao'), (TD, 99974, CLI, 'em_execucao'),
    (TE, 99975, CLI, 'em_execucao'), (TF, 99976, CLI, 'em_execucao'),
    (TG, 99977, CLI, 'em_execucao'), (TH, 99978, CLI, 'em_execucao');

  -- P1: base sem pausa → par
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RA, gen_random_uuid(), TA, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '13:00', 'hora_termino', '15:00', 'tecnicos_responsaveis', T1_NOME)),
    (RB, gen_random_uuid(), TB, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '14:30', 'hora_termino', '16:00', 'tecnicos_responsaveis', T1_NOME));

  -- P2 (faixa 05–08): pausa na 1ª cobre o conflito 06:00–07:00 → some
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RC, gen_random_uuid(), TC, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '05:00', 'hora_termino', '08:00', 'tecnicos_responsaveis', T1_NOME,
                        'pausa', 'Sim', 'pausa_inicio', '05:50', 'pausa_termino', '07:10')),
    (RD, gen_random_uuid(), TD, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '06:00', 'hora_termino', '07:00', 'tecnicos_responsaveis', T1_NOME));

  -- P3 (faixa 08:10–12): pausa PARCIAL (09:30–09:45 não cobre 09:00–10:00) → par continua
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RE_, gen_random_uuid(), TE, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '08:10', 'hora_termino', '12:00', 'tecnicos_responsaveis', T1_NOME,
                        'pausa', 'Sim', 'pausa_inicio', '09:30', 'pausa_termino', '09:45')),
    (RF, gen_random_uuid(), TF, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '09:00', 'hora_termino', '10:00', 'tecnicos_responsaveis', T1_NOME));

  -- P4 (faixa 16:30–20): pausa na 2ª RAT do par cobre o conflito 17:00–17:30 → some
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RG, gen_random_uuid(), TG, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '16:30', 'hora_termino', '20:00', 'tecnicos_responsaveis', T1_NOME)),
    (RH, gen_random_uuid(), TH, CLI, 'ZZ', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '17:00', 'hora_termino', '17:30', 'tecnicos_responsaveis', T1_NOME,
                        'pausa', 'Sim', 'pausa_inicio', '16:55', 'pausa_termino', '17:35'));

  ids := array[RA, RB, RC, RD, RE_, RF, RG, RH];

  -- extra: sem claims → 0 linhas
  select count(*) into v_n from vw_alerta_sobreposicao
   where (rat_a->>'rat_id')::uuid = any(ids) or (rat_b->>'rat_id')::uuid = any(ids);
  if v_n <> 0 then raise exception 'TESTE FALHOU (gate): sem claims a view devolveu % linhas', v_n; end if;

  perform set_config('request.jwt.claims',
    (select jsonb_build_object('sub', usuario_id)::text from portal_acessos
      where app_chave = 'service_report' and role_chave = 'admin' limit 1), true);

  select count(*) into v_n from vw_alerta_sobreposicao
   where (rat_a->>'rat_id')::uuid = any(ids) or (rat_b->>'rat_id')::uuid = any(ids);
  if v_n <> 2 then raise exception 'TESTE FALHOU: esperava exatamente 2 pares (P1 e P3), achei %', v_n; end if;

  if not exists (select 1 from vw_alerta_sobreposicao
                  where (rat_a->>'rat_id')::uuid = RA and (rat_b->>'rat_id')::uuid = RB)
     then raise exception 'TESTE FALHOU (P1): par base sem pausa não apareceu'; end if;
  if exists (select 1 from vw_alerta_sobreposicao
              where (rat_a->>'rat_id')::uuid in (RC, RD) or (rat_b->>'rat_id')::uuid in (RC, RD))
     then raise exception 'TESTE FALHOU (P2): pausa cobrindo o conflito não excluiu o par'; end if;
  if not exists (select 1 from vw_alerta_sobreposicao
                  where (rat_a->>'rat_id')::uuid = RE_ and (rat_b->>'rat_id')::uuid = RF)
     then raise exception 'TESTE FALHOU (P3): pausa parcial excluiu par que devia alertar'; end if;
  if exists (select 1 from vw_alerta_sobreposicao
              where (rat_a->>'rat_id')::uuid in (RG, RH) or (rat_b->>'rat_id')::uuid in (RG, RH))
     then raise exception 'TESTE FALHOU (P4): pausa na 2ª RAT do par não excluiu'; end if;

  raise exception 'TESTES_OK: P1-P4 + gate passaram (rollback total — nada persistiu)';
end $$;
