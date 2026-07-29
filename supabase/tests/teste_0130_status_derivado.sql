-- teste_0130: derivação do status da Tarefa a partir do CONJUNTO de RATs + guard
-- contra escrita defasada (app antigo). Roda em transação e dá ROLLBACK no final —
-- não cria tarefa real nem queima numeração (numero explícito, identity BY DEFAULT).
-- Como rodar: psql/SQL editor com service role, colar o arquivo inteiro.
-- Falha = exception com o passo; sucesso = 'teste_0130 OK' no final.

begin;

-- Palco: tarefa de teste + ids fixos (rollback apaga tudo).
insert into public.tarefas (id, numero, status)
values ('00000000-0000-4000-8000-000000000130', 913000, 'aguardando_execucao');

-- Passo 1: primeira RAT do dia (em andamento, sem pausa) → Tarefa inicia (em_execucao).
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000141',
        '00000000-0000-4000-8000-000000000130', 'em_andamento', true, '2026-07-28',
        '{"data":"2026-07-28","hora_inicio":"08:00"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_execucao' then raise exception 'passo 1: esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 2: pausa ABERTA na RAT do dia → em_pausa (0072, agora derivado do conjunto).
update public.rats set respostas = respostas || '{"pausa":"Sim","pausa_inicio":"09:00"}'::jsonb
 where id = '00000000-0000-4000-8000-000000000131';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_pausa' then raise exception 'passo 2: esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 3 (GUARD — o bug da 04853): app antigo escreve 'em_execucao' direto com pausa
-- aberta → o guard mantém em_pausa. Antes desta migração, essa escrita vencia.
update public.tarefas set status = 'em_execucao'
 where id = '00000000-0000-4000-8000-000000000130';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_pausa' then raise exception 'passo 3 (guard): esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 4 (ordem-independência): reenvio de OUTRA RAT (dia anterior, registrada) enquanto
-- a pausa segue aberta → continua em_pausa. Na versão por-linha, este upsert flipava
-- para em_execucao (foi exatamente o flapping da auditoria da 04853).
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000132', '00000000-0000-4000-8000-000000000142',
        '00000000-0000-4000-8000-000000000130', 'registrado', true, '2026-07-27',
        '{"data":"2026-07-27","hora_inicio":"08:00","hora_termino":"17:00","volta_amanha":"Sim"}'::jsonb);
update public.rats set atualizado_em = now() where id = '00000000-0000-4000-8000-000000000132';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_pausa' then raise exception 'passo 4 (ordem): esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 5: pausa ENCERRADA → retoma (em_execucao).
update public.rats set respostas = respostas || '{"pausa_termino":"10:00"}'::jsonb
 where id = '00000000-0000-4000-8000-000000000131';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_execucao' then raise exception 'passo 5: esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 6: dia encerrado com "não volto amanhã / volto depois" → em_pausa.
update public.rats set status = 'registrado',
       respostas = respostas || '{"hora_termino":"11:00","volta_amanha":"Não","passagem_motivo":"volto_depois"}'::jsonb
 where id = '00000000-0000-4000-8000-000000000131';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_pausa' then raise exception 'passo 6: esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 7: RAT nova no dia seguinte → retoma (em_execucao), regra "nova RAT → Em execução".
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000133', '00000000-0000-4000-8000-000000000143',
        '00000000-0000-4000-8000-000000000130', 'em_andamento', true, '2026-07-29',
        '{"data":"2026-07-29","hora_inicio":"08:00"}'::jsonb);
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'em_execucao' then raise exception 'passo 7: esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 8: status terminal/admin NUNCA é tocado por evento de RAT.
update public.tarefas set status = 'concluida' where id = '00000000-0000-4000-8000-000000000130';
update public.rats set atualizado_em = now() where id = '00000000-0000-4000-8000-000000000133';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000130';
  if s <> 'concluida' then raise exception 'passo 8 (terminal): esperado concluida, veio %', s; end if;
end $$;

do $$ begin raise notice 'teste_0130 OK'; end $$;

rollback;
