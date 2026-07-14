-- 0102 — Fix F3/F2: tarefas.numero é BIGINT (os RPCs declaravam integer e estouravam
-- em runtime — a lente de devoluções vinha vazia e o detalhe quebraria no go-live);
-- e desempenho_rats ganha numero+cliente pros links do drill-down.

drop function if exists public.desempenho_devolucoes(text, uuid);
create function public.desempenho_devolucoes(p_mes text, p_tecnico uuid default null)
returns table (tarefa_id uuid, numero bigint, cats text[], devolvida_em timestamptz,
               resolvida_em timestamptz, origem text, total_na_tarefa bigint)
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  return query
    select d.tarefa_id, t.numero, d.cats, d.devolvida_em, d.resolvida_em, d.origem,
           (select count(*) from tarefa_devolucoes x where x.tarefa_id = d.tarefa_id)
    from tarefa_devolucoes d join tarefas t on t.id = d.tarefa_id
    where to_char(d.devolvida_em at time zone 'America/Sao_Paulo','YYYY-MM') = p_mes
      and (p_tecnico is null
           or exists (select 1 from rats r join rat_tecnicos rt on rt.rat_id = r.id
                      where r.tarefa_id = d.tarefa_id and rt.tecnico_id = p_tecnico)
           or exists (select 1 from tarefa_tecnicos tt
                      where tt.tarefa_id = d.tarefa_id and tt.tecnico_id = p_tecnico))
    order by d.devolvida_em desc;
end $$;

drop function if exists public.desempenho_rats(text, uuid);
create function public.desempenho_rats(p_mes text, p_tecnico uuid)
returns table (rat_id uuid, tarefa_id uuid, tarefa_numero bigint, cliente_nome text,
               dia date, faixa text, pts numeric, janela_instabilidade boolean)
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  return query
    select p.rat_id, p.tarefa_id, t.numero, r.cliente_nome, p.dia, p.faixa, p.pts, p.janela_instabilidade
    from vw_rat_pontualidade p
    join rat_tecnicos rt on rt.rat_id = p.rat_id
    join rats r on r.id = p.rat_id
    left join tarefas t on t.id = p.tarefa_id
    where p.mes = p_mes and rt.tecnico_id = p_tecnico
    order by p.dia;
end $$;

drop function if exists public.meu_placar_rats(text);
create function public.meu_placar_rats(p_mes text)
returns table (rat_id uuid, tarefa_id uuid, tarefa_numero bigint, cliente_nome text,
               dia date, faixa text, pts numeric)
language sql security definer set search_path = public as $$
  select p.rat_id, p.tarefa_id, t.numero, r.cliente_nome, p.dia, p.faixa, p.pts
  from vw_rat_pontualidade p
  join rat_tecnicos rt on rt.rat_id = p.rat_id
  join rats r on r.id = p.rat_id
  left join tarefas t on t.id = p.tarefa_id
  cross join desempenho_config c
  where c.id = 1 and c.inicio is not null and p.mes >= to_char(c.inicio, 'YYYY-MM')
    and p.mes = p_mes and rt.tecnico_id = auth.uid()
  order by p.dia desc;
$$;
