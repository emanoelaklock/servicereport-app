-- 0076: corrige o fuso dos horários de DESLOCAMENTO em vw_participacoes_dia.
-- saida_em/chegada_em dos trechos são timestamptz; o `::time` extraía a hora no fuso da
-- SESSÃO (UTC), então a Jornada mostrava o deslocamento ~3h adiantado (ex.: 19:03 BRT virava
-- 22:03). As RATs já usavam `time` local, por isso só o deslocamento aparecia errado.
-- Fix: converter para America/Sao_Paulo antes de extrair hora (e a data de fallback).
-- Só recalcula a EXIBIÇÃO; durações (chegada − saída) são independentes de fuso.
create or replace view public.vw_participacoes_dia as
 select rt.tecnico_id,
    coalesce(fn_date_ou_null(r.respostas ->> 'data'::text), r.data_tarefa::date) as dia,
    'rat'::text as artefato_tipo,
    r.id as artefato_id,
    coalesce(t.numero::text, ''::text) as referencia,
    r.rat_seq,
    r.cliente_id,
    coalesce(rt.inicio, fn_time_ou_null(r.respostas ->> 'hora_inicio'::text)) as inicio,
    coalesce(rt.fim, fn_time_ou_null(r.respostas ->> 'hora_termino'::text)) as fim,
    rt.inicio is not null or rt.fim is not null as ajustado
   from rat_tecnicos rt
     join rats r on r.id = rt.rat_id
     left join tarefas t on t.id = r.tarefa_id
union all
 select tt.tecnico_id,
    coalesce(tr.data, (tr.saida_em at time zone 'America/Sao_Paulo')::date) as dia,
    'deslocamento'::text as artefato_tipo,
    tr.deslocamento_id as artefato_id,
    coalesce(c.nome, ''::text) as referencia,
    tr.ordem as rat_seq,
    d.cliente_id,
    (tr.saida_em at time zone 'America/Sao_Paulo')::time without time zone as inicio,
    (tr.chegada_em at time zone 'America/Sao_Paulo')::time without time zone as fim,
    false as ajustado
   from trecho_tecnicos tt
     join deslocamento_trechos tr on tr.id = tt.trecho_id
     join deslocamentos d on d.id = tr.deslocamento_id
     left join clientes c on c.id = d.cliente_id;
