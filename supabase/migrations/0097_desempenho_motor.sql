-- 0097 — Painel de Desempenho: MOTOR (Fase 1) — EM REVISÃO, não aplicada
-- Nota mensal 0–100 = 65·pontualidade + 15·(1−reedição) + 20·(1−devolução)
--   · Encerramento no dia (COLETIVA): D+0 = 1 · D+1 ÚTIL = 0,5 · depois/nunca = 0
--   · Reedição pós-encerramento em dia posterior (INDIVIDUAL — device→técnico)
--   · Devolução (COLETIVA — técnicos das RATs da tarefa devolvida)
-- Acesso SÓ por RPC (privacidade imposta no servidor): meu_placar() devolve a
-- linha do próprio técnico; desempenho_time() exige admin/gestor. As views não
-- têm grant pra authenticated — são detalhes internos dos RPCs.
-- v1 usa a proxy validada na Fase 0 (último "salvo pelo técnico" do sync);
-- v2 trocará pelo carimbo local respostas_ts (migração 0096).

-- ── 0) Config do painel: o CORTE do go-live mora AQUI e é aplicado nos RPCs
--       (ponto único de saída). inicio NULL = painel desligado (pré-requisito
--       v575 estável no Android da frota); ao ligar, só meses >= inicio saem
--       pelos RPCs e pelo snapshot — retroativo nunca entra no placar.
--       Carência = inicio + 28 dias (o app mostra o selo até lá). ──
create table if not exists public.desempenho_config (
  id smallint primary key default 1 check (id = 1),
  inicio date,                          -- null = painel desligado
  atualizado_em timestamptz default now()
);
insert into public.desempenho_config (id, inicio) values (1, null) on conflict do nothing;
alter table public.desempenho_config enable row level security;
create policy dcfg_leitura_portal on public.desempenho_config
  for select using (public.app_role() in ('admin','gestor_axis'));

-- Metadados públicos pro card (início + fim da carência) — sem dados de ninguém.
create or replace function public.desempenho_status()
returns table (inicio date, carencia_ate date)
language sql security definer set search_path = public as $$
  select inicio, inicio + 28 from desempenho_config where id = 1;
$$;

-- ── 1) Janelas de instabilidade conhecidas do app (flag no drill-down: blinda
--       a conversa da gestão da defesa "o app travava" — marca, NÃO altera nota) ──
create table if not exists public.app_instabilidade_janelas (
  id serial primary key,
  inicio date not null,
  fim date not null,
  descricao text not null
);
alter table public.app_instabilidade_janelas enable row level security;
create policy instab_leitura_portal on public.app_instabilidade_janelas
  for select using (public.app_role() in ('admin','gestor_axis'));
insert into public.app_instabilidade_janelas (inicio, fim, descricao) values
  ('2026-06-30','2026-07-06','Crash/tela branca no "Encerrar RAT do Dia" (Android) — do hotfix v559 ao fix definitivo v575');

-- ── 2) device → técnico (atribuição INDIVIDUAL da reedição) ──
-- O aparelho pertence ao técnico que envia RATs por ele; em empate, o mais frequente.
create or replace view public.vw_device_tecnico as
select distinct on (device_id) device_id, tecnico_id
from (
  select device_id, tecnico_id, count(*) as n
  from public.rats
  where device_id is not null and tecnico_id is not null
  group by 1,2
) x
order by device_id, n desc;

-- ── 3) Pontualidade por RAT (régua B, D+1 ÚTIL) + flag de instabilidade ──
-- "D+1 útil": sexta→segunda e sábado→segunda contam meio ponto (dow: 0=dom…6=sáb).
create or replace view public.vw_rat_pontualidade as
with base as (
  select r.id as rat_id, r.tarefa_id, r.status,
         coalesce(r.respostas->>'data',
                  to_char(r.data_tarefa at time zone 'America/Sao_Paulo','YYYY-MM-DD'))::date as dia
  from public.rats r
  where r.origem_registro = 'nativo'
),
enc as (
  select rat_id,
         max(em) filter (where evento='salvo_local' and detalhe='salvo pelo técnico') as enc_em
  from public.sync_eventos group by rat_id
)
select b.rat_id, b.tarefa_id, b.dia,
       to_char(b.dia, 'YYYY-MM') as mes,
       (e.enc_em at time zone 'America/Sao_Paulo')::date as encerrada_dia,
       case
         when b.status = 'em_andamento' or e.enc_em is null then 'nunca'
         when (e.enc_em at time zone 'America/Sao_Paulo')::date <= b.dia then 'D0'
         when (e.enc_em at time zone 'America/Sao_Paulo')::date
              <= b.dia + (case extract(dow from b.dia) when 5 then 3 when 6 then 2 else 1 end)::int then 'D1'
         else 'atrasada'
       end as faixa,
       case
         when b.status = 'em_andamento' or e.enc_em is null then 0.0
         when (e.enc_em at time zone 'America/Sao_Paulo')::date <= b.dia then 1.0
         when (e.enc_em at time zone 'America/Sao_Paulo')::date
              <= b.dia + (case extract(dow from b.dia) when 5 then 3 when 6 then 2 else 1 end)::int then 0.5
         else 0.0
       end as pts,
       exists (select 1 from public.app_instabilidade_janelas j where b.dia between j.inicio and j.fim) as janela_instabilidade
from base b
left join enc e on e.rat_id = b.rat_id
where b.dia is not null;

-- ── 4) Reedição pós-encerramento em DIA POSTERIOR, por técnico/mês (INDIVIDUAL) ──
create or replace view public.vw_reedicao_mensal as
select dt.tecnico_id, to_char(ev.em at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes,
       count(distinct ev.rat_id) as rats_reeditadas
from public.sync_eventos ev
join public.vw_rat_pontualidade p on p.rat_id = ev.rat_id
join public.vw_device_tecnico dt on dt.device_id = ev.device_id
where ev.evento = 'salvo_local' and ev.detalhe = 'edição pós-confirmação'
  and (ev.em at time zone 'America/Sao_Paulo')::date > p.dia
group by 1, 2;

-- ── 5) Devoluções por técnico/mês (COLETIVA: técnicos das RATs da tarefa devolvida;
--       fallback tarefa_tecnicos quando a tarefa ainda não tem RAT) ──
-- Limitação v1 documentada: devolvida_em guarda a ÚLTIMA devolução — devoluções
-- repetidas da mesma tarefa no mesmo mês contam uma vez.
create or replace view public.vw_devolucao_mensal as
with dev as (
  select t.id as tarefa_id, to_char(t.devolvida_em at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes
  from public.tarefas t where t.devolvida_em is not null
),
tecs as (
  select d.tarefa_id, d.mes, rt.tecnico_id
  from dev d join public.rats r on r.tarefa_id = d.tarefa_id
  join public.rat_tecnicos rt on rt.rat_id = r.id
  union
  select d.tarefa_id, d.mes, tt.tecnico_id
  from dev d join public.tarefa_tecnicos tt on tt.tarefa_id = d.tarefa_id
  where not exists (select 1 from public.rats r where r.tarefa_id = d.tarefa_id)
)
select tecnico_id, mes, count(distinct tarefa_id) as tarefas_devolvidas
from tecs group by 1, 2;

-- ── 6) Desempenho mensal por técnico (a view que o card e o ranking leem) ──
create or replace view public.vw_desempenho_mensal as
with pont as (
  select rt.tecnico_id, p.mes,
         count(*) as rats,
         count(*) filter (where p.faixa = 'D0') as d0,
         count(*) filter (where p.faixa = 'D1') as d1,
         count(*) filter (where p.faixa = 'atrasada') as atrasadas,
         count(*) filter (where p.faixa = 'nunca') as nunca,
         count(*) filter (where p.janela_instabilidade) as em_janela_instab,
         avg(p.pts) as pontualidade,
         count(distinct p.tarefa_id) as tarefas
  from public.vw_rat_pontualidade p
  join public.rat_tecnicos rt on rt.rat_id = p.rat_id
  group by 1, 2
)
select po.tecnico_id, u.nome as tecnico_nome, po.mes,
       po.rats, po.d0, po.d1, po.atrasadas, po.nunca, po.em_janela_instab,
       coalesce(re.rats_reeditadas, 0) as reedicoes,
       coalesce(dv.tarefas_devolvidas, 0) as devolucoes,
       round(100 * po.pontualidade) as comp_pontualidade,
       round(100 * (1 - least(1.0, coalesce(re.rats_reeditadas, 0)::numeric / nullif(po.rats, 0)))) as comp_reedicao,
       round(100 * (1 - least(1.0, coalesce(dv.tarefas_devolvidas, 0)::numeric / nullif(po.tarefas, 0)))) as comp_devolucao,
       round(100 * ( 0.65 * po.pontualidade
                   + 0.15 * (1 - least(1.0, coalesce(re.rats_reeditadas, 0)::numeric / nullif(po.rats, 0)))
                   + 0.20 * (1 - least(1.0, coalesce(dv.tarefas_devolvidas, 0)::numeric / nullif(po.tarefas, 0))) )) as nota
from pont po
join public.usuarios u on u.id = po.tecnico_id
left join public.vw_reedicao_mensal re on re.tecnico_id = po.tecnico_id and re.mes = po.mes
left join public.vw_devolucao_mensal dv on dv.tecnico_id = po.tecnico_id and dv.mes = po.mes;

-- Views são detalhe interno: sem acesso direto pra clientes.
revoke all on public.vw_device_tecnico, public.vw_rat_pontualidade,
              public.vw_reedicao_mensal, public.vw_devolucao_mensal,
              public.vw_desempenho_mensal from anon, authenticated;

-- ── 7) Snapshot mensal (placar oficial congelado — histórico imutável) ──
create table if not exists public.desempenho_snapshots (
  mes text not null,
  tecnico_id uuid not null,
  dados jsonb not null,          -- linha completa da view no fechamento
  nota numeric not null,
  gerado_em timestamptz not null default now(),
  primary key (mes, tecnico_id)
);
alter table public.desempenho_snapshots enable row level security;
create policy snap_leitura_portal on public.desempenho_snapshots
  for select using (public.app_role() in ('admin','gestor_axis'));

create or replace function public.gerar_snapshot_desempenho(p_mes text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer; v_inicio date;
begin
  if public.app_role() not in ('admin') then raise exception 'sem permissão'; end if;
  select inicio into v_inicio from desempenho_config where id = 1;
  if v_inicio is null or p_mes < to_char(v_inicio, 'YYYY-MM') then
    raise exception 'painel desligado ou mês anterior ao go-live (%)', v_inicio;
  end if;
  delete from desempenho_snapshots where mes = p_mes;
  insert into desempenho_snapshots (mes, tecnico_id, dados, nota)
  select mes, tecnico_id, to_jsonb(v.*), nota from vw_desempenho_mensal v where mes = p_mes;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── 8) RPCs de acesso (privacidade E corte do go-live no servidor) ──
-- Card do técnico: SÓ a própria linha — nunca nota/nome de colegas. O corte é
-- aqui: mês anterior ao go-live (ou painel desligado) não sai NUNCA pro app —
-- o payload que chega no aparelho já vem filtrado por uid E por data.
create or replace function public.meu_placar(p_mes text)
returns setof public.vw_desempenho_mensal
language sql security definer set search_path = public as $$
  select v.* from vw_desempenho_mensal v, desempenho_config c
  where c.id = 1 and c.inicio is not null and v.mes >= to_char(c.inicio, 'YYYY-MM')
    and v.mes = p_mes and v.tecnico_id = auth.uid();
$$;

-- Ranking/drill-down: admin e gestor (mesmo corte).
create or replace function public.desempenho_time(p_mes text)
returns setof public.vw_desempenho_mensal
language plpgsql security definer set search_path = public as $$
declare v_inicio date;
begin
  if public.app_role() not in ('admin','gestor_axis') then raise exception 'sem permissão'; end if;
  select inicio into v_inicio from desempenho_config where id = 1;
  if v_inicio is null or p_mes < to_char(v_inicio, 'YYYY-MM') then return; end if;
  return query select * from vw_desempenho_mensal where mes = p_mes order by nota desc;
end $$;

-- Drill-down do técnico (admin/gestor): as RATs do mês com faixa + flag de instabilidade.
create or replace function public.desempenho_rats(p_mes text, p_tecnico uuid)
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
