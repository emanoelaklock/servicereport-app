-- 0067: view de BUSCA GLOBAL de RATs (banco todo) — alimenta a aba "Lista" do calendário.
-- Só leitura, security_invoker (respeita RLS de quem consulta), dropável (`drop view`).
-- Expõe campos de exibição + a coluna `busca` (texto concatenado, INCLUI o conteúdo do
-- respostas) para `ilike` no servidor. `colaboradores` = técnico principal ∪ co-responsáveis.
-- `dia_rat` = data declarada na RAT (respostas.data) com fallback p/ data_tarefa em fuso BR.
create or replace view vw_rats_busca
with (security_invoker = true) as
select
  r.id, r.rat_seq, r.data_tarefa, r.status as rat_status, r.cliente_nome,
  coalesce(nullif(r.respostas->>'data',''), (r.data_tarefa at time zone 'America/Sao_Paulo')::date::text) as dia_rat,
  t.id as tarefa_id, t.numero as tarefa_numero, t.status as tarefa_status,
  t.pedido_compra, o.numero as orcamento_numero, t.orientacao,
  tn.nomes as colaboradores,
  lower(concat_ws(' ',
    lpad(t.numero::text, 5, '0'),
    coalesce(t.numero::text, '') || '/' || lpad(coalesce(r.rat_seq, 0)::text, 2, '0'),
    r.cliente_nome, tn.nomes, t.pedido_compra, o.numero::text, t.orientacao,
    r.respostas::text)) as busca
from rats r
left join tarefas t    on t.id = r.tarefa_id
left join orcamentos o on o.id = t.orcamento_id
left join lateral (
  select string_agg(distinct nome, ' · ' order by nome) as nomes from (
    select r.tecnico_nome as nome where r.tecnico_nome is not null
    union
    select u.nome from rat_tecnicos rt join usuarios u on u.id = rt.tecnico_id where rt.rat_id = r.id
  ) s(nome)
) tn on true;

-- DOWN: drop view vw_rats_busca;
