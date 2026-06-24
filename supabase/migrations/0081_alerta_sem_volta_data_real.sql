-- 0081: corrige o alerta "deslocamento de ida sem volta".
-- BUG: a view agrupava por (data_tarefa AT TIME ZONE 'America/Sao_Paulo')::date. data_tarefa é
-- guardada como meia-noite UTC, então a conversão de fuso DERRUBAVA o dia (23/06 00:00+00 → 22/06),
-- e além disso usava a data AGENDADA em vez da data REAL da RAT (respostas.data). Resultado: ida e
-- volta do mesmo dia caíam em dias diferentes → alerta falso.
-- CORREÇÃO: usar o mesmo "dia" da vw_participacoes_dia → coalesce(respostas.data, data_tarefa::date).
-- Também passa o número da tarefa no jsonb (rótulo "RAT 4751/02" no front).
create or replace view public.vw_alerta_desloc_sem_volta as
 with rat_tec as (
   select r.id as rat_id, r.tarefa_id, r.rat_seq, r.cliente_nome,
     coalesce(fn_date_ou_null(r.respostas ->> 'data'::text), r.data_tarefa::date) as dia,
     tn.numero as tarefa_numero,
     t.tecnico_id,
     coalesce((r.respostas ->> 'desloc_ida'::text) = 'Sim'::text, false) as tem_ida,
     coalesce((r.respostas ->> 'desloc_retorno'::text) = 'Sim'::text, false) as tem_volta
    from rats r
      left join tarefas tn on tn.id = r.tarefa_id
      cross join lateral ( select r.tecnico_id where r.tecnico_id is not null
                           union
                           select rt.tecnico_id from rat_tecnicos rt where rt.rat_id = r.id ) t(tecnico_id)
   where r.data_tarefa is not null and (r.respostas ? 'desloc_ida'::text or r.respostas ? 'desloc_retorno'::text)
 ), dia_tec as (
   select rat_tec.tecnico_id, rat_tec.dia,
     bool_or(rat_tec.tem_ida) as tem_ida,
     bool_or(rat_tec.tem_volta) as tem_volta,
     string_agg(distinct rat_tec.cliente_nome, ' · '::text) as clientes,
     jsonb_agg(distinct jsonb_build_object('rat_id', rat_tec.rat_id, 'tarefa_id', rat_tec.tarefa_id,
       'rat_seq', rat_tec.rat_seq, 'numero', rat_tec.tarefa_numero, 'cliente', rat_tec.cliente_nome)) as rats
    from rat_tec
   group by rat_tec.tecnico_id, rat_tec.dia
 )
 select d.tecnico_id, u.nome as tecnico_nome, d.dia, d.clientes, d.rats
   from dia_tec d
     left join usuarios u on u.id = d.tecnico_id
  where d.dia < (now() at time zone 'America/Sao_Paulo'::text)::date
    and d.tem_ida and not d.tem_volta
    and not (exists ( select 1
       from deslocamento_tecnicos dt
         join deslocamentos dd on dd.id = dt.deslocamento_id
         left join deslocamento_trechos tr on tr.deslocamento_id = dd.id
      where dt.tecnico_id = d.tecnico_id
        and ( ((dd.saida_em at time zone 'America/Sao_Paulo'::text)::date <= d.dia
               and (dd.chegada_em is null or (dd.chegada_em at time zone 'America/Sao_Paulo'::text)::date >= d.dia))
              or tr.data = d.dia
              or (tr.saida_em is not null and (tr.saida_em at time zone 'America/Sao_Paulo'::text)::date <= d.dia
                  and (tr.chegada_em is null or (tr.chegada_em at time zone 'America/Sao_Paulo'::text)::date >= d.dia)) )));
