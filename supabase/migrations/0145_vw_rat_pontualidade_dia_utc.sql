-- 0145 — vw_rat_pontualidade: fallback do dia sem conversão de fuso (família 0144).
--
-- O problema (LATENTE, 0 linhas afetadas hoje): o `dia` da view caía em
-- to_char(data_tarefa AT TIME ZONE 'America/Sao_Paulo') quando a RAT não tinha Data
-- declarada. data_tarefa é MEIA-NOITE UTC da data declarada (convenção da casa,
-- reforçada pelo trigger da 0144) — converter pra SP volta 1 DIA. De quebra, o
-- COALESCE antigo não tratava declarada vazia/ilegível ('' :: date estoura a leitura).
--
-- O fix: mesma expressão das views-irmãs (vw_participacoes_dia/0056 e afins) —
-- coalesce(fn_date_ou_null(respostas->>'data'), data_tarefa::date). Nada mais muda:
-- a definição abaixo é a DE PRODUÇÃO (0097 + ajustes 0098/0102/0107), só o `dia`.
--
-- Postura de segurança INALTERADA e deliberada: a view segue DEFINER (sem
-- security_invoker) e SEM grant a anon/authenticated — é peça interna do motor de
-- desempenho, lida pelas RPCs SECURITY DEFINER do placar (0097+). Não é o caso F17
-- (nenhum papel de cliente enxerga a view direta). CREATE OR REPLACE reseta
-- reloptions — aqui o estado desejado É o default (sem opção), então nada a redeclarar.

create or replace view public.vw_rat_pontualidade as
with base as (
  select r.id as rat_id, r.tarefa_id, r.status,
         (r.respostas->>'hora_termino') is not null as tem_termino,
         coalesce(public.fn_date_ou_null(r.respostas->>'data'), (r.data_tarefa)::date) as dia
  from public.rats r
  where r.origem_registro = 'nativo' and r.status <> 'improdutiva'
), enc as (
  select sync_eventos.rat_id,
         max(sync_eventos.em) filter (where sync_eventos.evento = 'salvo_local'
                                        and sync_eventos.detalhe = 'salvo pelo técnico') as enc_em
  from public.sync_eventos
  group by sync_eventos.rat_id
), calc as (
  select b.rat_id, b.tarefa_id, b.status, b.tem_termino, b.dia,
         (e.enc_em at time zone 'America/Sao_Paulo') as enc_sp,
         (b.dia + 1)::timestamp + interval '04:00:00' as lim_d0,
         (b.dia + case extract(dow from b.dia) when 5 then 3 when 6 then 2 else 1 end)::timestamp
           + interval '12:00:00' as lim_d1,
         b.status <> 'em_andamento' and e.enc_em is not null and b.tem_termino as encerrada_ok,
         exists (select 1 from public.app_instabilidade_janelas j
                  where b.dia >= j.inicio and b.dia <= j.fim) as janela
  from base b
  left join enc e on e.rat_id = b.rat_id
  where b.dia is not null
)
select rat_id, tarefa_id, dia,
       to_char(dia::timestamptz, 'YYYY-MM') as mes,
       enc_sp::date as encerrada_dia,
       case
         when janela then 'fora_janela_bug'
         when not encerrada_ok and (now() at time zone 'America/Sao_Paulo') < lim_d1 then 'pendente'
         when not encerrada_ok then 'atrasada'
         when enc_sp < lim_d0 then 'D0'
         when enc_sp < lim_d1 then 'D1'
         else 'atrasada'
       end as faixa,
       case
         when janela or (not encerrada_ok and (now() at time zone 'America/Sao_Paulo') < lim_d1) then null::numeric
         when not encerrada_ok then 0.0
         when enc_sp < lim_d0 then 1.0
         when enc_sp < lim_d1 then 0.5
         else 0.0
       end as pts,
       janela as janela_instabilidade
from calc;

-- Guarda auto-abortante: a expressão nova está na view, a conversão SP saiu do `dia`
-- (segue legítima no enc_sp/now, que são INSTANTES reais), e a postura de segurança
-- não mudou (sem invoker, sem grant a anon/authenticated).
do $$
declare v_def text; v_opts text[]; n_grant int;
begin
  select pg_get_viewdef('public.vw_rat_pontualidade'::regclass, true) into v_def;
  if v_def not ilike '%fn_date_ou_null%' then
    raise exception '0145: view sem fn_date_ou_null no dia — abortando';
  end if;
  if v_def ~* 'data_tarefa\s+AT\s+TIME\s+ZONE' then
    raise exception '0145: data_tarefa ainda convertido de fuso na view — abortando';
  end if;
  select c.reloptions into v_opts from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'vw_rat_pontualidade';
  if v_opts is not null and 'security_invoker=true' = any(v_opts) then
    raise exception '0145: view ganhou security_invoker — postura mudou, abortando';
  end if;
  select count(*) into n_grant from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'vw_rat_pontualidade'
     and grantee in ('anon', 'authenticated');
  if n_grant > 0 then
    raise exception '0145: view exposta a anon/authenticated (% grants) — abortando', n_grant;
  end if;
end $$;
