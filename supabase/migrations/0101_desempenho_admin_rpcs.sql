-- 0101 — F3 (página Desempenho do portal): RPCs de apoio (admin/gestor)
-- 1) desempenho_devolucoes: devoluções do mês (todas ou de um técnico), com o total
--    histórico por tarefa (reincidência) — base das três lentes.
-- 2) desempenho_definir_inicio: a "segunda chave" do go-live vira um clique com
--    confirmação na página (admin-only), em vez de SQL manual.

create or replace function public.desempenho_devolucoes(p_mes text, p_tecnico uuid default null)
returns table (tarefa_id uuid, numero integer, cats text[], devolvida_em timestamptz,
               resolvida_em timestamptz, origem text, total_na_tarefa bigint)
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  return query
    select d.tarefa_id, t.numero, d.cats, d.devolvida_em, d.resolvida_em, d.origem,
           (select count(*) from tarefa_devolucoes x where x.tarefa_id = d.tarefa_id) as total_na_tarefa
    from tarefa_devolucoes d join tarefas t on t.id = d.tarefa_id
    where to_char(d.devolvida_em at time zone 'America/Sao_Paulo','YYYY-MM') = p_mes
      and (p_tecnico is null
           or exists (select 1 from rats r join rat_tecnicos rt on rt.rat_id = r.id
                      where r.tarefa_id = d.tarefa_id and rt.tecnico_id = p_tecnico)
           or exists (select 1 from tarefa_tecnicos tt
                      where tt.tarefa_id = d.tarefa_id and tt.tecnico_id = p_tecnico))
    order by d.devolvida_em desc;
end $$;

create or replace function public.desempenho_definir_inicio(p_inicio date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() <> 'admin' then raise exception 'sem permissão'; end if;
  if p_inicio is null then raise exception 'data obrigatória'; end if;
  update desempenho_config set inicio = p_inicio, atualizado_em = now() where id = 1;
end $$;
