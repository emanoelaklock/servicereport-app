-- 0098 — Régua v2 do Painel de Desempenho ("Preenchimento online")
-- (1) Reedição por EVENTO com teto 6/mês (calibrável na carência), não RATs distintas.
-- (2) D+1 estreitado: meio ponto só até 12:00 do próximo dia ÚTIL; madrugada até 04:00 = D+0.
-- (3) RAT aberta (em andamento / sem encerramento / sem hora_termino) = atrasada quando o
--     prazo D+1 venceu; prazo aberto = pendente (fora da régua) — a view viva RECONCILIA ao
--     encerrar; o snapshot congela o fechamento.
-- Extras: improdutivas fora; RATs em janela de instabilidade conhecida fora (defensáveis).
-- Rótulo oficial da métrica: "Preenchimento online". Legenda-contrato (spec §8):
-- "Online = encerrada no dia do trabalho. Sem sinal não perde ponto — o app funciona
--  offline e o registro conta normalmente."

drop function if exists public.meu_placar(text);
drop function if exists public.desempenho_time(text);
drop function if exists public.desempenho_rats(text, uuid);
drop view if exists public.vw_desempenho_mensal cascade;
drop view if exists public.vw_reedicao_mensal cascade;
drop view if exists public.vw_rat_pontualidade cascade;

create view public.vw_rat_pontualidade as
with base as (
  select r.id as rat_id, r.tarefa_id, r.status,
         (r.respostas->>'hora_termino') is not null as tem_termino,
         coalesce(r.respostas->>'data',
                  to_char(r.data_tarefa at time zone 'America/Sao_Paulo','YYYY-MM-DD'))::date as dia
  from public.rats r
  where r.origem_registro = 'nativo' and r.status <> 'improdutiva'
),
enc as (
  select rat_id,
         max(em) filter (where evento='salvo_local' and detalhe='salvo pelo técnico') as enc_em
  from public.sync_eventos group by rat_id
),
calc as (
  select b.*, e.enc_em at time zone 'America/Sao_Paulo' as enc_sp,
         (b.dia + 1)::timestamp + interval '4 hours' as lim_d0,
         (b.dia + (case extract(dow from b.dia) when 5 then 3 when 6 then 2 else 1 end)::int)::timestamp + interval '12 hours' as lim_d1,
         (b.status <> 'em_andamento' and e.enc_em is not null and b.tem_termino) as encerrada_ok,
         exists (select 1 from public.app_instabilidade_janelas j where b.dia between j.inicio and j.fim) as janela
  from base b left join enc e on e.rat_id = b.rat_id
  where b.dia is not null
)
select rat_id, tarefa_id, dia, to_char(dia,'YYYY-MM') as mes, enc_sp::date as encerrada_dia,
  case
    when janela then 'fora_janela_bug'
    when not encerrada_ok and now() at time zone 'America/Sao_Paulo' < lim_d1 then 'pendente'
    when not encerrada_ok then 'atrasada'
    when enc_sp < lim_d0 then 'D0'
    when enc_sp < lim_d1 then 'D1'
    else 'atrasada'
  end as faixa,
  case
    when janela or (not encerrada_ok and now() at time zone 'America/Sao_Paulo' < lim_d1) then null
    when not encerrada_ok then 0.0
    when enc_sp < lim_d0 then 1.0
    when enc_sp < lim_d1 then 0.5
    else 0.0
  end as pts,
  janela as janela_instabilidade
from calc;

create view public.vw_reedicao_mensal as
select dt.tecnico_id, to_char(ev.em at time zone 'America/Sao_Paulo','YYYY-MM') as mes,
       count(*) as eventos_reedicao,
       count(distinct ev.rat_id) as rats_reeditadas
from public.sync_eventos ev
join public.vw_rat_pontualidade p on p.rat_id = ev.rat_id
join public.vw_device_tecnico dt on dt.device_id = ev.device_id
where ev.evento='salvo_local' and ev.detalhe='edição pós-confirmação'
  and (ev.em at time zone 'America/Sao_Paulo')::date > p.dia
group by 1, 2;

create view public.vw_desempenho_mensal as
with pont as (
  select rt.tecnico_id, p.mes,
         count(*) filter (where p.pts is not null) as rats,
         count(*) filter (where p.faixa='D0') as d0,
         count(*) filter (where p.faixa='D1') as d1,
         count(*) filter (where p.faixa='atrasada') as atrasadas,
         count(*) filter (where p.faixa='pendente') as pendentes,
         count(*) filter (where p.faixa='fora_janela_bug') as em_janela_instab,
         avg(p.pts) as pontualidade,
         count(distinct p.tarefa_id) filter (where p.pts is not null) as tarefas
  from public.vw_rat_pontualidade p
  join public.rat_tecnicos rt on rt.rat_id = p.rat_id
  group by 1, 2
)
select po.tecnico_id, u.nome as tecnico_nome, po.mes,
       po.rats, po.d0, po.d1, po.atrasadas, po.pendentes, po.em_janela_instab,
       coalesce(re.eventos_reedicao, 0) as reedicoes,
       coalesce(dv.tarefas_devolvidas, 0) as devolucoes,
       round(100 * coalesce(po.pontualidade, 1)) as comp_pontualidade,
       round(100 * (1 - least(1.0, coalesce(re.eventos_reedicao, 0)::numeric / 6))) as comp_reedicao,
       round(100 * (1 - least(1.0, coalesce(dv.tarefas_devolvidas, 0)::numeric / nullif(po.tarefas, 0)))) as comp_devolucao,
       round(100 * ( 0.65 * coalesce(po.pontualidade, 1)
                   + 0.15 * (1 - least(1.0, coalesce(re.eventos_reedicao, 0)::numeric / 6))
                   + 0.20 * (1 - least(1.0, coalesce(dv.tarefas_devolvidas, 0)::numeric / nullif(po.tarefas, 0))) )) as nota
from pont po
join public.usuarios u on u.id = po.tecnico_id
left join public.vw_reedicao_mensal re on re.tecnico_id = po.tecnico_id and re.mes = po.mes
left join public.vw_devolucao_mensal dv on dv.tecnico_id = po.tecnico_id and dv.mes = po.mes;

revoke all on public.vw_rat_pontualidade, public.vw_reedicao_mensal, public.vw_desempenho_mensal
  from anon, authenticated;

comment on view public.vw_desempenho_mensal is 'Preenchimento online (régua v2): 65% encerramento-no-dia (D0 até 04h do dia seguinte=1; D1 até 12h do próximo dia útil=0,5; senão 0; aberta com prazo vencido=atrasada, prazo aberto=pendente/fora; improdutivas e janelas de instabilidade fora) + 15% reedição (eventos em dia posterior, teto 6) + 20% devoluções.';

create function public.meu_placar(p_mes text)
returns setof public.vw_desempenho_mensal
language sql security definer set search_path = public as $$
  select v.* from vw_desempenho_mensal v, desempenho_config c
  where c.id = 1 and c.inicio is not null and v.mes >= to_char(c.inicio, 'YYYY-MM')
    and v.mes = p_mes and v.tecnico_id = auth.uid();
$$;

create function public.desempenho_time(p_mes text)
returns setof public.vw_desempenho_mensal
language plpgsql security definer set search_path = public as $$
declare v_inicio date;
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  select inicio into v_inicio from desempenho_config where id = 1;
  if v_inicio is null or p_mes < to_char(v_inicio, 'YYYY-MM') then return; end if;
  return query select * from vw_desempenho_mensal where mes = p_mes order by nota desc;
end $$;

create function public.desempenho_rats(p_mes text, p_tecnico uuid)
returns table (rat_id uuid, tarefa_id uuid, dia date, faixa text, pts numeric, janela_instabilidade boolean)
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  return query
    select p.rat_id, p.tarefa_id, p.dia, p.faixa, p.pts, p.janela_instabilidade
    from vw_rat_pontualidade p join rat_tecnicos rt on rt.rat_id = p.rat_id
    where p.mes = p_mes and rt.tecnico_id = p_tecnico
    order by p.dia;
end $$;
