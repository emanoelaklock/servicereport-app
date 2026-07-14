-- 0100 — F2 (card do técnico): RPC do detalhe "Minhas RATs"
-- O desempenho_rats() é admin/gestor (drill-down do ranking). O técnico precisa da
-- MESMA visão só das PRÓPRIAS RATs — auth.uid() imposto no servidor, com o corte do
-- go-live (painel desligado ou mês pré-início → vazio), como no meu_placar().
-- Aplicar junto com o merge da F2 (o card chama meu_placar/desempenho_status/este).

create or replace function public.meu_placar_rats(p_mes text)
returns table (rat_id uuid, tarefa_id uuid, tarefa_numero integer, cliente_nome text,
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
