-- teste_0135: fallback do checkpoint na derivação do status (caso Tarefa 04778).
-- RAT registrada SEM "Volta amanhã?" (ex.: gestão registrou via portal) não decide a
-- continuidade — decide o último checkpoint respondido. Roda em transação e dá ROLLBACK
-- no final (numero explícito, identity BY DEFAULT — não queima numeração).
-- Como rodar: psql/SQL editor com service role, colar o arquivo inteiro.
-- Falha = exception com o passo; sucesso = 'teste_0135 OK' no final.

begin;

insert into public.tarefas (id, numero, status)
values ('00000000-0000-4000-8000-000000000135', 913500, 'aguardando_execucao');

-- Passo 1 (cenário 04778): dia 1 fechado com "volto depois" → em_pausa.
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000151', '00000000-0000-4000-8000-000000000161',
        '00000000-0000-4000-8000-000000000135', 'registrado', true, '2026-07-01',
        '{"data":"2026-07-01","hora_inicio":"08:00","hora_termino":"17:00","volta_amanha":"Não","passagem_motivo":"volto_depois"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000135';
  if s <> 'em_pausa' then raise exception 'passo 1: esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 2 (o bug): dia 2 registrado SEM checkpoint (portal) → NÃO retoma; o último
-- checkpoint respondido (dia 1, volto depois) mantém em_pausa. Na 0130 flipava pra
-- em_execucao (foi o que o backfill fez com a 04778).
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000152', '00000000-0000-4000-8000-000000000162',
        '00000000-0000-4000-8000-000000000135', 'registrado', true, '2026-07-02',
        '{"data":"2026-07-02","hora_inicio":"08:00","hora_termino":"12:00"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000135';
  if s <> 'em_pausa' then raise exception 'passo 2 (fallback): esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 3: RAT nova em_andamento → retomada (em_execucao) — fallback não vale pra RAT aberta.
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000153', '00000000-0000-4000-8000-000000000163',
        '00000000-0000-4000-8000-000000000135', 'em_andamento', true, '2026-07-03',
        '{"data":"2026-07-03","hora_inicio":"08:00"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000135';
  if s <> 'em_execucao' then raise exception 'passo 3 (retomada): esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 4: dia 3 fechado com "Volta amanhã? = Sim"; depois dia 4 registrado sem checkpoint
-- → fallback acha 'Sim' (não volto_depois) → segue em_execucao.
update public.rats set status = 'registrado',
       respostas = respostas || '{"hora_termino":"17:00","volta_amanha":"Sim"}'::jsonb
 where id = '00000000-0000-4000-8000-000000000153';
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000154', '00000000-0000-4000-8000-000000000164',
        '00000000-0000-4000-8000-000000000135', 'registrado', true, '2026-07-04',
        '{"data":"2026-07-04","hora_inicio":"08:00","hora_termino":"12:00"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000135';
  if s <> 'em_execucao' then raise exception 'passo 4 (fallback Sim): esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 5: tarefa SÓ com RAT registrada sem checkpoint (nenhum checkpoint na base) →
-- comportamento da 0130 (em_execucao via atendimento_executado).
insert into public.tarefas (id, numero, status)
values ('00000000-0000-4000-8000-000000000136', 913501, 'aguardando_execucao');
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000155', '00000000-0000-4000-8000-000000000165',
        '00000000-0000-4000-8000-000000000136', 'registrado', true, '2026-07-01',
        '{"data":"2026-07-01","hora_inicio":"08:00","hora_termino":"12:00"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000136';
  if s <> 'em_execucao' then raise exception 'passo 5 (sem checkpoint algum): esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 6: improdutiva mais recente (sem checkpoint) → não mexe (segue em_execucao).
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas, motivo_improdutiva)
values ('00000000-0000-4000-8000-000000000156', '00000000-0000-4000-8000-000000000166',
        '00000000-0000-4000-8000-000000000136', 'registrado', false, '2026-07-05',
        '{"data":"2026-07-05"}'::jsonb, 'cliente_ausente');
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000136';
  if s <> 'em_execucao' then raise exception 'passo 6 (improdutiva): esperado em_execucao, veio %', s; end if;
end $$;

do $$ begin raise notice 'teste_0135 OK'; end $$;

rollback;
