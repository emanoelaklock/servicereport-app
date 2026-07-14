-- 0107 — O indicador binário passa a contar CORREÇÃO DA GESTÃO por falha do técnico
-- (decisão 14/07). RAT com problema ganha o 4º critério: existir edição do portal
-- (rat_edicoes) com motivo 'esquecimento_tecnico' ou 'completacao'.
--  · Atribuição COLETIVA (todos os técnicos da RAT), como atraso e devolução.
--  · NÃO contam: correcao_texto (cosmético), mudanca_processo, pedido_cliente,
--    outro (ambíguo — quem quer que pese escolhe motivo classificado) e as linhas
--    motivo='sync_app' (reedição do técnico — já contada pelo caminho dos eventos,
--    sem dupla punição).
--  · operacao='restore' não conta; limitação v1: restaurar uma edição NÃO remove a
--    marca da edição original (documentado no spec).
-- Recria os dois RPCs do 0103 (tipo de retorno muda → drop primeiro).

drop function if exists public.desempenho_binario(text);
drop function if exists public.meu_resultado_rats(text);

create or replace function public.meu_resultado_rats(p_mes text)
returns table (rat_id uuid, tarefa_id uuid, tarefa_numero bigint, cliente_nome text,
               dia date, faixa text, reeditada_por_mim boolean, devolvida boolean,
               corrigida_gestao boolean)
language sql security definer set search_path = public as $$
  select p.rat_id, p.tarefa_id, t.numero, r.cliente_nome, p.dia, p.faixa,
    exists (select 1 from sync_eventos ev join vw_device_tecnico dt on dt.device_id = ev.device_id
            where ev.rat_id = p.rat_id and dt.tecnico_id = auth.uid()
              and ev.evento='salvo_local' and ev.detalhe='edição pós-confirmação'
              and (ev.em at time zone 'America/Sao_Paulo')::date > p.dia) as reeditada_por_mim,
    exists (select 1 from tarefa_devolucoes d
            where d.tarefa_id = p.tarefa_id
              and to_char(d.devolvida_em at time zone 'America/Sao_Paulo','YYYY-MM') = p_mes) as devolvida,
    exists (select 1 from rat_edicoes e
            where e.rat_id = p.rat_id and e.operacao <> 'restore'
              and e.motivo in ('esquecimento_tecnico','completacao')) as corrigida_gestao
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
               r_atraso bigint, r_reedicao bigint, r_devolucao bigint, r_ajuste bigint)
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
                and to_char(d.devolvida_em at time zone 'America/Sao_Paulo','YYYY-MM') = p_mes) as dev,
      exists (select 1 from rat_edicoes e
              where e.rat_id = p.rat_id and e.operacao <> 'restore'
                and e.motivo in ('esquecimento_tecnico','completacao')) as adj
    from vw_rat_pontualidade p
    join rat_tecnicos rt on rt.rat_id = p.rat_id
    where p.mes = p_mes and p.faixa in ('D0','D1','atrasada')
  )
  select tec, count(*), count(*) filter (where not (atraso or reed or dev or adj)),
         count(*) filter (where atraso or reed or dev or adj),
         count(*) filter (where atraso), count(*) filter (where reed),
         count(*) filter (where dev), count(*) filter (where adj)
  from par group by tec;
end $$;
