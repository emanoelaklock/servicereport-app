-- 0065: View de CONFERÊNCIA (leitura) — "deslocamento de ida sem volta no dia".
--
-- Para a Thaís conferir na Jornada: dias em que um técnico teve deslocamento de IDA
-- mas NENHUMA volta registrada no mesmo dia, e SEM pernoite cobrindo o dia.
-- É só leitura — NÃO trava o técnico, NÃO altera dados. Reversível: `drop view`.
--
-- Decisões (registro):
--  · SÓ dias passados (`dia < hoje`) — "dia fechou" sem falso positivo no meio do dia.
--  · Fuso America/Sao_Paulo em TODAS as comparações de data (sem off-by-one).
--  · Agrega por TÉCNICO × DIA (a volta pode estar em RAT diferente do mesmo dia → bool_or).
--  · Técnicos = principal (rats.tecnico_id) ∪ co-responsáveis (rat_tecnicos) — é conferência.
--  · Pernoite cobre o dia = deslocamento (pai ou trecho) cujo intervalo inclui o dia,
--    INCLUSIVE viagem aberta (chegada nula = ainda fora). Não usa `sentido` (aceita 'outro').
--  · Só modelo novo (respostas tem desloc_ida/desloc_retorno); legado é invisível (não tem
--    volta separada → nunca gera falso positivo).
--  · security_invoker = true → respeita o RLS de quem consulta (admin/gestor).
create or replace view vw_alerta_desloc_sem_volta
with (security_invoker = true) as
with rat_tec as (
  select
    r.id as rat_id, r.tarefa_id, r.rat_seq, r.cliente_nome,
    (r.data_tarefa at time zone 'America/Sao_Paulo')::date as dia,
    t.tecnico_id,
    coalesce((r.respostas->>'desloc_ida')     = 'Sim', false) as tem_ida,
    coalesce((r.respostas->>'desloc_retorno') = 'Sim', false) as tem_volta
  from rats r
  cross join lateral (
    select r.tecnico_id where r.tecnico_id is not null
    union
    select rt.tecnico_id from rat_tecnicos rt where rt.rat_id = r.id
  ) t(tecnico_id)
  where r.data_tarefa is not null
    and (r.respostas ? 'desloc_ida' or r.respostas ? 'desloc_retorno')
),
dia_tec as (
  select tecnico_id, dia,
    bool_or(tem_ida)   as tem_ida,
    bool_or(tem_volta) as tem_volta,
    string_agg(distinct cliente_nome, ' · ') as clientes,
    jsonb_agg(distinct jsonb_build_object(
      'rat_id', rat_id, 'tarefa_id', tarefa_id, 'rat_seq', rat_seq, 'cliente', cliente_nome
    )) as rats
  from rat_tec
  group by tecnico_id, dia
)
select d.tecnico_id, u.nome as tecnico_nome, d.dia, d.clientes, d.rats
from dia_tec d
left join usuarios u on u.id = d.tecnico_id
where d.dia < (now() at time zone 'America/Sao_Paulo')::date
  and d.tem_ida
  and not d.tem_volta
  and not exists (
    select 1
    from deslocamento_tecnicos dt
    join deslocamentos dd on dd.id = dt.deslocamento_id
    left join deslocamento_trechos tr on tr.deslocamento_id = dd.id
    where dt.tecnico_id = d.tecnico_id
      and (
        ( (dd.saida_em at time zone 'America/Sao_Paulo')::date <= d.dia
          and (dd.chegada_em is null
               or (dd.chegada_em at time zone 'America/Sao_Paulo')::date >= d.dia) )
        or tr.data = d.dia
        or ( tr.saida_em is not null
             and (tr.saida_em at time zone 'America/Sao_Paulo')::date <= d.dia
             and (tr.chegada_em is null
                  or (tr.chegada_em at time zone 'America/Sao_Paulo')::date >= d.dia) )
      )
  );
