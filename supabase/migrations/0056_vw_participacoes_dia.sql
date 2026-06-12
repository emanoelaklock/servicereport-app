-- Horas do dia por técnico (spec §8): fonte canônica das PARTICIPAÇÕES.
-- Uma linha por (técnico, artefato) com o intervalo DELE:
--   · RAT: horário próprio (rat_tecnicos.inicio/fim) ou herdado da RAT
--   · Deslocamento: trechos em que está a bordo (saída→chegada)
-- O cálculo (Σ união dos intervalos − almoço único do dia) é do cliente/admin.
-- security_invoker: a view respeita a RLS de quem consulta.
create or replace view public.vw_participacoes_dia
with (security_invoker = true) as
select rt.tecnico_id,
       coalesce(fn_date_ou_null(r.respostas->>'data'), r.data_tarefa::date) as dia,
       'rat'::text                                   as artefato_tipo,
       r.id                                          as artefato_id,
       coalesce(t.numero::text, '')                  as referencia,
       r.rat_seq,
       r.cliente_id,
       coalesce(rt.inicio, fn_time_ou_null(r.respostas->>'hora_inicio'))  as inicio,
       coalesce(rt.fim,    fn_time_ou_null(r.respostas->>'hora_termino')) as fim,
       (rt.inicio is not null or rt.fim is not null) as ajustado
  from public.rat_tecnicos rt
  join public.rats r on r.id = rt.rat_id
  left join public.tarefas t on t.id = r.tarefa_id
union all
select tt.tecnico_id,
       coalesce(tr.data, tr.saida_em::date)          as dia,
       'deslocamento'::text,
       tr.deslocamento_id,
       coalesce(c.nome, ''),
       tr.ordem,
       d.cliente_id,
       tr.saida_em::time,
       tr.chegada_em::time,
       false
  from public.trecho_tecnicos tt
  join public.deslocamento_trechos tr on tr.id = tt.trecho_id
  join public.deslocamentos d on d.id = tr.deslocamento_id
  left join public.clientes c on c.id = d.cliente_id;
