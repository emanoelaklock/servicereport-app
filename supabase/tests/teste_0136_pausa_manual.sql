-- teste_0136: pausa manual da gestão durável (marcador + guard).
-- Roda em transação e dá ROLLBACK no final (numero explícito, identity BY DEFAULT).
-- Como rodar: psql/SQL editor com service role, colar o arquivo inteiro.
-- Falha = exception com o passo; sucesso = 'teste_0136 OK' no final.

begin;

-- Palco: tarefa em execução (RAT de 01/07 registrada com "volta amanhã = Sim").
insert into public.tarefas (id, numero, status)
values ('00000000-0000-4000-8000-000000000140', 913600, 'aguardando_execucao');
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000171', '00000000-0000-4000-8000-000000000181',
        '00000000-0000-4000-8000-000000000140', 'registrado', true, '2026-07-01',
        '{"data":"2026-07-01","hora_inicio":"08:00","hora_termino":"17:00","volta_amanha":"Sim"}'::jsonb);

-- Passo 1: pausa manual da gestão (marcador junto do status) → em_pausa com marcador.
update public.tarefas
   set status = 'em_pausa',
       pausa_manual_em = '2026-07-10 14:00:00+00',
       pausa_manual_por = '00000000-0000-4000-8000-000000000199',
       pausa_manual_motivo = 'Cliente pediu para segurar'
 where id = '00000000-0000-4000-8000-000000000140';
do $$ declare s text; p timestamptz; begin
  select status, pausa_manual_em into s, p from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_pausa' or p is null then raise exception 'passo 1: esperado em_pausa+marcador, veio % (marcador %)', s, p; end if;
end $$;

-- Passo 2: edição de RAT ANTIGA (reprocessa o trigger; alvo derivado = em_execucao) → segura.
update public.rats set atualizado_em = now() where id = '00000000-0000-4000-8000-000000000171';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_pausa' then raise exception 'passo 2 (edicao RAT antiga): esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 3: sync ATRASADO de RAT criada antes da pausa (criado_em explícito no passado) → segura.
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas, criado_em)
values ('00000000-0000-4000-8000-000000000172', '00000000-0000-4000-8000-000000000182',
        '00000000-0000-4000-8000-000000000140', 'registrado', true, '2026-07-02',
        '{"data":"2026-07-02","hora_inicio":"08:00","hora_termino":"12:00","volta_amanha":"Sim"}'::jsonb,
        '2026-07-02 15:00:00+00');
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_pausa' then raise exception 'passo 3 (sync atrasado): esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 4 (refinamento — RAT RETROATIVA, caso 04790): RAT criada DEPOIS da pausa mas
-- documentando dia ANTERIOR à pausa (registro tardio) → NÃO é retomada de campo, segura.
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000173', '00000000-0000-4000-8000-000000000183',
        '00000000-0000-4000-8000-000000000140', 'registrado', true, '2026-07-05',
        '{"data":"2026-07-05","hora_inicio":"08:00","hora_termino":"12:00","volta_amanha":"Sim"}'::jsonb);
do $$ declare s text; p timestamptz; begin
  select status, pausa_manual_em into s, p from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_pausa' or p is null then raise exception 'passo 4 (RAT retroativa): esperado em_pausa+marcador, veio % (marcador %)', s, p; end if;
end $$;

-- Passo 5: RETOMADA REAL — RAT criada depois da pausa E com dia declarado >= dia da pausa
-- → em_execucao e marcador limpo sozinho.
insert into public.rats (id, client_uuid, tarefa_id, status, atendimento_executado, data_tarefa, respostas)
values ('00000000-0000-4000-8000-000000000174', '00000000-0000-4000-8000-000000000184',
        '00000000-0000-4000-8000-000000000140', 'em_andamento', true, '2026-07-15',
        '{"data":"2026-07-15","hora_inicio":"08:00"}'::jsonb);
do $$ declare s text; p timestamptz; begin
  select status, pausa_manual_em into s, p from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_execucao' or p is not null then raise exception 'passo 5 (retomada real): esperado em_execucao sem marcador, veio % (marcador %)', s, p; end if;
end $$;

-- Passo 6: re-pausa manual e DESPAUSA EXPLÍCITA (mesmo UPDATE limpa o marcador) → passa.
update public.tarefas
   set status = 'em_pausa', pausa_manual_em = now(), pausa_manual_por = '00000000-0000-4000-8000-000000000199'
 where id = '00000000-0000-4000-8000-000000000140';
update public.tarefas
   set status = 'em_execucao', pausa_manual_em = null, pausa_manual_por = null, pausa_manual_motivo = null
 where id = '00000000-0000-4000-8000-000000000140';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_execucao' then raise exception 'passo 6 (despausa explicita): esperado em_execucao, veio %', s; end if;
end $$;

-- Passo 7: escrita DEFASADA estilo app antigo (status sem tocar o marcador) → bloqueada.
update public.tarefas set status = 'em_pausa', pausa_manual_em = now() where id = '00000000-0000-4000-8000-000000000140';
update public.tarefas set status = 'em_execucao' where id = '00000000-0000-4000-8000-000000000140';
do $$ declare s text; begin
  select status into s from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'em_pausa' then raise exception 'passo 7 (escrita defasada): esperado em_pausa, veio %', s; end if;
end $$;

-- Passo 8: status terminal/admin NUNCA é bloqueado e limpa o marcador.
update public.tarefas set status = 'concluida' where id = '00000000-0000-4000-8000-000000000140';
do $$ declare s text; p timestamptz; begin
  select status, pausa_manual_em into s, p from public.tarefas where id = '00000000-0000-4000-8000-000000000140';
  if s <> 'concluida' or p is not null then raise exception 'passo 8 (terminal): esperado concluida sem marcador, veio % (marcador %)', s, p; end if;
end $$;

do $$ begin raise notice 'teste_0136 OK'; end $$;

rollback;
