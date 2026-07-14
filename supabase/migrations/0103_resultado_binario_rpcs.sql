-- 0103 — Redesenho final do card F2: RPCs NOVOS (nenhum RPC/view/snapshot existente alterado)
-- App do técnico passa a mostrar "% de RATs sem problema"; o portal mantém a composta
-- ("Índice interno de disciplina"). Critérios de RAT com problema (versão atual):
--   · encerrada depois de D+1 / ainda aberta com prazo vencido (faixa 'atrasada' — coletivo)
--   · reeditada em dia posterior PELO PRÓPRIO técnico (individual, device→técnico)
--   · tarefa devolvida pela gestão no mês (coletivo)
-- D+0 e D+1 não sujam a RAT (D+1 = encerramento tardio, informativo).

create or replace function public.meu_resultado_rats(p_mes text)
returns table (rat_id uuid, tarefa_id uuid, tarefa_numero bigint, cliente_nome text,
               dia date, faixa text, reeditada_por_mim boolean, devolvida boolean)
language sql security definer set search_path = public as $$
  select p.rat_id, p.tarefa_id, t.numero, r.cliente_nome, p.dia, p.faixa,
    exists (select 1 from sync_eventos ev join vw_device_tecnico dt on dt.device_id = ev.device_id
            where ev.rat_id = p.rat_id and dt.tecnico_id = auth.uid()
              and ev.evento='salvo_local' and ev.detalhe='edição pós-confirmação'
              and (ev.em at time zone 'America/Sao_Paulo')::date > p.dia) as reeditada_por_mim,
    exists (select 1 from tarefa_devolucoes d
            where d.tarefa_id = p.tarefa_id
              and to_char(d.devolvida_em at time zone 'America/Sao_Paulo','YYYY-MM') = p_mes) as devolvida
  from vw_rat_pontualidade p
  join rat_tecnicos rt on rt.rat_id = p.rat_id
  join rats r on r.id = p.rat_id
  left join tarefas t on t.id = p.tarefa_id
  cross join desempenho_config c
  where c.id = 1 and c.inicio is not null and p.mes >= to_char(c.inicio, 'YYYY-MM')
    and p.mes = p_mes and rt.tecnico_id = auth.uid()
  order by p.dia desc;
$$;

create or replace function public.desempenho_binario(p_mes text)
returns table (tecnico_id uuid, elegiveis bigint, sem_problema bigint, com_problema bigint,
               r_atraso bigint, r_reedicao bigint, r_devolucao bigint)
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  return query
  with par as (
    select p.rat_id, rt.tecnico_id as tec,
      p.faixa = 'atrasada' as atraso,
      exists (select 1 from sync_eventos ev join vw_device_tecnico dt on dt.device_id = ev.device_id
              where ev.rat_id = p.rat_id and dt.tecnico_id = rt.tecnico_id
                and ev.evento='salvo_local' and ev.detalhe='edição pós-confirmação'
                and (ev.em at time zone 'America/Sao_Paulo')::date > p.dia) as reed,
      exists (select 1 from tarefa_devolucoes d
              where d.tarefa_id = p.tarefa_id
                and to_char(d.devolvida_em at time zone 'America/Sao_Paulo','YYYY-MM') = p_mes) as dev
    from vw_rat_pontualidade p
    join rat_tecnicos rt on rt.rat_id = p.rat_id
    where p.mes = p_mes and p.faixa in ('D0','D1','atrasada')
  )
  select tec, count(*), count(*) filter (where not (atraso or reed or dev)),
         count(*) filter (where atraso or reed or dev),
         count(*) filter (where atraso), count(*) filter (where reed), count(*) filter (where dev)
  from par group by tec;
end $$;
