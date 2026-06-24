-- 0079: rótulo mais claro do deslocamento do dia na Jornada.
-- O chip vinha "RAT Ida/02" (sem o nº da tarefa) — confuso. Passa a trazer o número da tarefa
-- no `referencia` ("Ida 4751" / "Retorno 4752"), pra o front mostrar "RAT Ida 4751/02".
-- SÓ muda o texto do rótulo dos branches desloc_dia; inicio/fim/horas/dedup intactos.
create or replace view public.vw_participacoes_dia as
 select rt.tecnico_id,
    coalesce(fn_date_ou_null(r.respostas ->> 'data'::text), r.data_tarefa::date) as dia,
    'rat'::text as artefato_tipo, r.id as artefato_id,
    coalesce(t.numero::text, ''::text) as referencia, r.rat_seq, r.cliente_id,
    coalesce(rt.inicio, fn_time_ou_null(r.respostas ->> 'hora_inicio'::text)) as inicio,
    coalesce(rt.fim, fn_time_ou_null(r.respostas ->> 'hora_termino'::text)) as fim,
    rt.inicio is not null or rt.fim is not null as ajustado
   from rat_tecnicos rt
     join rats r on r.id = rt.rat_id
     left join tarefas t on t.id = r.tarefa_id
union all
 select tt.tecnico_id,
    coalesce(tr.data, (tr.saida_em at time zone 'America/Sao_Paulo')::date) as dia,
    'deslocamento'::text as artefato_tipo, tr.deslocamento_id as artefato_id,
    coalesce(c.nome, ''::text) as referencia, tr.ordem as rat_seq, d.cliente_id,
    (tr.saida_em at time zone 'America/Sao_Paulo')::time without time zone as inicio,
    (tr.chegada_em at time zone 'America/Sao_Paulo')::time without time zone as fim,
    false as ajustado
   from trecho_tecnicos tt
     join deslocamento_trechos tr on tr.id = tt.trecho_id
     join deslocamentos d on d.id = tr.deslocamento_id
     left join clientes c on c.id = d.cliente_id
union all
 select rt.tecnico_id,
    coalesce(fn_date_ou_null(r.respostas ->> 'data'::text), r.data_tarefa::date) as dia,
    'desloc_dia'::text as artefato_tipo, r.id as artefato_id,
    'Ida'::text || coalesce(' ' || t.numero::text, ''::text) as referencia, r.rat_seq, r.cliente_id,
    fn_time_ou_null(r.respostas ->> 'desloc_inicial_ida'::text) as inicio,
    fn_time_ou_null(r.respostas ->> 'desloc_final_ida'::text) as fim,
    false as ajustado
   from rat_tecnicos rt
     join rats r on r.id = rt.rat_id
     left join tarefas t on t.id = r.tarefa_id
  where r.respostas ->> 'desloc_ida'::text = 'Sim'::text
    and fn_time_ou_null(r.respostas ->> 'desloc_inicial_ida'::text) is not null
    and fn_time_ou_null(r.respostas ->> 'desloc_final_ida'::text) is not null
union all
 select rt.tecnico_id,
    coalesce(fn_date_ou_null(r.respostas ->> 'data'::text), r.data_tarefa::date) as dia,
    'desloc_dia'::text as artefato_tipo, r.id as artefato_id,
    'Retorno'::text || coalesce(' ' || t.numero::text, ''::text) as referencia, r.rat_seq, r.cliente_id,
    fn_time_ou_null(r.respostas ->> 'desloc_inicial_retorno'::text) as inicio,
    fn_time_ou_null(r.respostas ->> 'desloc_final_retorno'::text) as fim,
    false as ajustado
   from rat_tecnicos rt
     join rats r on r.id = rt.rat_id
     left join tarefas t on t.id = r.tarefa_id
  where r.respostas ->> 'desloc_retorno'::text = 'Sim'::text
    and fn_time_ou_null(r.respostas ->> 'desloc_inicial_retorno'::text) is not null
    and fn_time_ou_null(r.respostas ->> 'desloc_final_retorno'::text) is not null;
