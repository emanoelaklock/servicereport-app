-- Teste da vw_alerta_sobreposicao (migração 0122) — SEGURO EM PRODUÇÃO.
-- Roda inteiro num único DO $$ … $$ e SEMPRE termina em RAISE EXCEPTION:
--  · mensagem 'TESTES_OK …'  = todos os casos passaram (o erro é só o veículo do rollback);
--  · mensagem 'TESTE FALHOU …' = detalhe do caso que quebrou.
-- O rollback desfaz TUDO (fixtures, view, efeitos de trigger) — nada persiste no banco.
--
-- Fixtures: técnicos REAIS (dois usuários de nome único — o trigger fn_rat_sync_tempo casa
-- por nome) num DIA-FIXTURE remoto (05-06/01/2020, anterior ao sistema) — impossível colidir
-- com dados reais; as asserções filtram pelos ids das RATs de teste.
--
-- Casos cobertos (pedido da Fase 1):
--  1. sobreposição real (parcial)        → 1 par, intervalo conflitante correto
--  2. RAT aninhada                       → 1 par, intervalo = janela interna
--  3. períodos sem conflito (encostam)   → nenhum par
--  4. pausas/almoço                      → não criam nem removem par (view só olha RAT×RAT)
--  5. técnico diferente                  → janelas que se cruzam entre pessoas ≠ não geram par
--  6. dia ainda aberto (hoje)            → fora da view
--  extra: participação com fim nulo     → fora dos pares
--  extra: autorização — sem claims (app_role() null) a view devolve 0 linhas; as asserções
--         rodam com claims de um admin real (o filtro da view espelha o PAGE_ALLOWED da Jornada)
do $$
declare
  T1 uuid; T1_NOME text; T2 uuid; T2_NOME text;
  CLI constant uuid := gen_random_uuid();
  DIA_F constant date := date '2020-01-06';                       -- dia-fixture ENCERRADO
  DIA_HOJE date := (now() at time zone 'America/Sao_Paulo')::date; -- dia ABERTO
  TA uuid := gen_random_uuid(); TB uuid := gen_random_uuid(); TC uuid := gen_random_uuid();
  TD uuid := gen_random_uuid(); TE uuid := gen_random_uuid(); TF uuid := gen_random_uuid();
  RA uuid := gen_random_uuid(); RB uuid := gen_random_uuid(); RC uuid := gen_random_uuid();
  RD uuid := gen_random_uuid(); RE_ uuid := gen_random_uuid(); RF uuid := gen_random_uuid();
  RG uuid := gen_random_uuid(); RH uuid := gen_random_uuid(); RI uuid := gen_random_uuid();
  RJ uuid := gen_random_uuid();
  ids uuid[];
  v_n int; r record;
begin
  -- (re)cria a view com a MESMA definição da migração 0122 (rollback desfaz; se a migração
  -- já tiver sido aplicada, é um replace idempotente)
  execute $v$
    create or replace view vw_alerta_sobreposicao
    with (security_invoker = true) as
    with part as (
      select pd.tecnico_id, pd.dia, pd.artefato_id, pd.referencia, pd.rat_seq,
             pd.cliente_id, pd.inicio, pd.fim
        from vw_participacoes_dia pd
       where pd.artefato_tipo = 'rat'
         and pd.inicio is not null and pd.fim is not null
         and pd.fim > pd.inicio
    )
    select a.tecnico_id, u.nome as tecnico_nome, a.dia,
           greatest(a.inicio, b.inicio) as conflito_inicio,
           least(a.fim, b.fim)          as conflito_fim,
           jsonb_build_object('rat_id', a.artefato_id, 'numero', a.referencia, 'rat_seq', a.rat_seq,
                              'cliente', ca.nome, 'inicio', a.inicio, 'fim', a.fim) as rat_a,
           jsonb_build_object('rat_id', b.artefato_id, 'numero', b.referencia, 'rat_seq', b.rat_seq,
                              'cliente', cb.nome, 'inicio', b.inicio, 'fim', b.fim) as rat_b
      from part a
      join part b
        on b.tecnico_id = a.tecnico_id and b.dia = a.dia
       and (a.inicio, a.artefato_id) < (b.inicio, b.artefato_id)
       and greatest(a.inicio, b.inicio) < least(a.fim, b.fim)
      left join usuarios u  on u.id  = a.tecnico_id
      left join clientes ca on ca.id = a.cliente_id
      left join clientes cb on cb.id = b.cliente_id
     where a.dia < (now() at time zone 'America/Sao_Paulo')::date
       and public.app_role() = any (array['admin', 'gestor_axis'])
  $v$;

  -- dois técnicos reais de nome ÚNICO (case-insensitive) — o trigger casa por nome
  select u.id, u.nome into T1, T1_NOME from usuarios u
   where u.nome is not null and trim(u.nome) <> ''
     and not exists (select 1 from usuarios x where x.id <> u.id and lower(trim(x.nome)) = lower(trim(u.nome)))
   order by u.nome limit 1;
  select u.id, u.nome into T2, T2_NOME from usuarios u
   where u.nome is not null and trim(u.nome) <> '' and u.id <> T1
     and not exists (select 1 from usuarios x where x.id <> u.id and lower(trim(x.nome)) = lower(trim(u.nome)))
   order by u.nome desc limit 1;
  if T1 is null or T2 is null then raise exception 'TESTE FALHOU: não achei 2 usuários de nome único'; end if;

  insert into clientes (id, nome) values (CLI, 'ZZ TESTE SOBREPOSICAO (rollback)');
  insert into tarefas (id, numero, cliente_id, status) values
    (TA, 99991, CLI, 'em_execucao'), (TB, 99992, CLI, 'em_execucao'), (TC, 99993, CLI, 'em_execucao'),
    (TD, 99994, CLI, 'em_execucao'), (TE, 99995, CLI, 'em_execucao'), (TF, 99996, CLI, 'em_execucao');

  -- ── fixtures de RAT (o trigger materializa rat_tecnicos a partir de respostas) ──
  -- caso 1: sobreposição PARCIAL — T1: 13:00–15:00 (TA) × 14:30–16:00 (TB) → conflito 14:30–15:00
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RA, gen_random_uuid(), TA, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '13:00', 'hora_termino', '15:00', 'tecnicos_responsaveis', T1_NOME)),
    (RB, gen_random_uuid(), TB, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '14:30', 'hora_termino', '16:00', 'tecnicos_responsaveis', T1_NOME));

  -- caso 2 (+4): RAT ANINHADA — T1: 08:00–12:00 (TC) contém 09:00–10:00 (TD) → conflito 09:00–10:00.
  -- A RAT externa declara PAUSA (10:30–11:00) e ALMOÇO (11:30–12:00): não muda o par.
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RC, gen_random_uuid(), TC, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '08:00', 'hora_termino', '12:00', 'tecnicos_responsaveis', T1_NOME,
                        'pausa', 'Sim', 'pausa_inicio', '10:30', 'pausa_termino', '11:00',
                        'almoco', 'Sim', 'almoco_inicio', '11:30', 'almoco_termino', '12:00')),
    (RD, gen_random_uuid(), TD, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '09:00', 'hora_termino', '10:00', 'tecnicos_responsaveis', T1_NOME));

  -- caso 3: SEM conflito — T1: 16:00–17:00 × 17:00–18:00 (encostam) → nenhum par
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RE_, gen_random_uuid(), TE, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '16:00', 'hora_termino', '17:00', 'tecnicos_responsaveis', T1_NOME)),
    (RF, gen_random_uuid(), TF, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '17:00', 'hora_termino', '18:00', 'tecnicos_responsaveis', T1_NOME));

  -- caso 5: TÉCNICO DIFERENTE — T2: 08:30–09:30 (cruza a janela de RC/RD, mas é OUTRA pessoa)
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RG, gen_random_uuid(), TA, CLI, 'ZZ TESTE', T2, T2_NOME, 'registrado', DIA_F,
     jsonb_build_object('data', DIA_F::text, 'hora_inicio', '08:30', 'hora_termino', '09:30', 'tecnicos_responsaveis', T2_NOME));

  -- caso 6: DIA AINDA ABERTO (hoje) — T1: 08:00–12:00 × 09:00–10:00 → fora da view
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RH, gen_random_uuid(), TB, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_HOJE,
     jsonb_build_object('data', DIA_HOJE::text, 'hora_inicio', '08:00', 'hora_termino', '12:00', 'tecnicos_responsaveis', T1_NOME)),
    (RI, gen_random_uuid(), TC, CLI, 'ZZ TESTE', T1, T1_NOME, 'registrado', DIA_HOJE,
     jsonb_build_object('data', DIA_HOJE::text, 'hora_inicio', '09:00', 'hora_termino', '10:00', 'tecnicos_responsaveis', T1_NOME));

  -- extra: participação com FIM NULO no dia fechado (RAT aberta esquecida) → fora dos pares
  insert into rats (id, client_uuid, tarefa_id, cliente_id, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas) values
    (RJ, gen_random_uuid(), TD, CLI, 'ZZ TESTE', T1, T1_NOME, 'em_andamento', date '2020-01-05',
     jsonb_build_object('data', '2020-01-05', 'hora_inicio', '09:00', 'tecnicos_responsaveis', T1_NOME));

  ids := array[RA, RB, RC, RD, RE_, RF, RG, RH, RI, RJ];

  -- ── extra (autorização): sem claims, app_role() é null → view vazia ──
  select count(*) into v_n from vw_alerta_sobreposicao
   where (rat_a->>'rat_id')::uuid = any(ids) or (rat_b->>'rat_id')::uuid = any(ids);
  if v_n <> 0 then raise exception 'TESTE FALHOU (autorização): sem claims a view devolveu % linhas', v_n; end if;

  -- daqui em diante, consulta como um ADMIN real (app_role() resolve por auth.uid())
  perform set_config('request.jwt.claims',
    (select jsonb_build_object('sub', usuario_id)::text from portal_acessos
      where app_chave = 'service_report' and role_chave = 'admin' limit 1), true);

  -- ── asserções (sempre filtradas pelas RATs do fixture) ──
  select count(*) into v_n from vw_alerta_sobreposicao
   where (rat_a->>'rat_id')::uuid = any(ids) or (rat_b->>'rat_id')::uuid = any(ids);
  if v_n <> 2 then raise exception 'TESTE FALHOU: esperava exatamente 2 pares, achei %', v_n; end if;

  -- caso 1: parcial 14:30–15:00, rat_a = a que começa primeiro (RA)
  select * into r from vw_alerta_sobreposicao
   where (rat_a->>'rat_id')::uuid = RA and (rat_b->>'rat_id')::uuid = RB;
  if r is null then raise exception 'TESTE FALHOU (caso 1): par RA×RB não apareceu'; end if;
  if r.tecnico_id <> T1 or r.dia <> DIA_F or r.conflito_inicio <> time '14:30' or r.conflito_fim <> time '15:00'
     then raise exception 'TESTE FALHOU (caso 1): intervalo %–% (esperava 14:30–15:00)', r.conflito_inicio, r.conflito_fim; end if;
  if (r.rat_a->>'numero') <> '99991' or (r.rat_b->>'numero') <> '99992'
     then raise exception 'TESTE FALHOU (caso 1): tarefas %×% (esperava 99991×99992)', r.rat_a->>'numero', r.rat_b->>'numero'; end if;

  -- caso 2: aninhada 09:00–10:00 (pausa/almoço da RAT externa não interferem)
  select * into r from vw_alerta_sobreposicao
   where (rat_a->>'rat_id')::uuid = RC and (rat_b->>'rat_id')::uuid = RD;
  if r is null then raise exception 'TESTE FALHOU (caso 2): par RC×RD (aninhada) não apareceu'; end if;
  if r.conflito_inicio <> time '09:00' or r.conflito_fim <> time '10:00'
     then raise exception 'TESTE FALHOU (caso 2): intervalo %–% (esperava 09:00–10:00)', r.conflito_inicio, r.conflito_fim; end if;

  -- caso 3: encostar não é sobreposição
  if exists (select 1 from vw_alerta_sobreposicao
              where (rat_a->>'rat_id')::uuid in (RE_, RF) or (rat_b->>'rat_id')::uuid in (RE_, RF))
     then raise exception 'TESTE FALHOU (caso 3): RATs que só encostam geraram par'; end if;

  -- caso 4: almoço derivado não vira par (a tabela almocos recebeu o registro do fixture e a view a ignora)
  select count(*) into v_n from almocos where tecnico_id = T1 and dia = DIA_F;
  if v_n <> 1 then raise exception 'TESTE FALHOU (caso 4): almoço do fixture não materializou (%)', v_n; end if;

  -- caso 5: sem par cruzando técnicos e nenhum par para T2
  if exists (select 1 from vw_alerta_sobreposicao
              where tecnico_id = T2 and ((rat_a->>'rat_id')::uuid = any(ids) or (rat_b->>'rat_id')::uuid = any(ids)))
     then raise exception 'TESTE FALHOU (caso 5): par indevido para técnico diferente'; end if;

  -- caso 6: dia aberto fora da view
  if exists (select 1 from vw_alerta_sobreposicao
              where (rat_a->>'rat_id')::uuid in (RH, RI) or (rat_b->>'rat_id')::uuid in (RH, RI))
     then raise exception 'TESTE FALHOU (caso 6): dia ainda aberto apareceu na view'; end if;

  -- extra: fim nulo fora dos pares
  if exists (select 1 from vw_alerta_sobreposicao
              where (rat_a->>'rat_id')::uuid = RJ or (rat_b->>'rat_id')::uuid = RJ)
     then raise exception 'TESTE FALHOU (extra): participação sem fim entrou num par'; end if;

  raise exception 'TESTES_OK: 6 casos + extras (fim nulo, autorização) passaram (rollback total — nada persistiu)';
end $$;
