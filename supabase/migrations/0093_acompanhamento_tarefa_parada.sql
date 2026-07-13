-- 0093: acompanhamento de tarefa "parada" (em execução / em pausa sem atividade há +N dias).
-- Serviço começou (RAT iniciada ou status mexido) mas travou: técnico não voltou pra concluir,
-- ou ficou "em pausa" sem previsão. Vira alerta no Painel + push diário pro técnico (limite 5 dias).

-- Carimbo de "já notifiquei hoje" (dedup do push, igual devolvida_notif_em).
alter table public.tarefas
  add column if not exists acompanhamento_notif_em timestamptz;

-- View: define "parada há N dias" numa fonte ÚNICA (portal e Edge Function leem daqui).
-- ultima_atividade = data da última RAT; se não há RAT, cai pra data agendada; senão, criação.
-- dias_parada em fuso BR (America/Sao_Paulo), pra bater com o resto do portal.
create or replace view public.vw_tarefas_acompanhamento
with (security_invoker = on) as
select t.id, t.numero, t.cliente_id, t.status,
       ua.ultima_atividade,
       ((now() at time zone 'America/Sao_Paulo')::date - ua.ultima_atividade) as dias_parada
from public.tarefas t
cross join lateral (
  select coalesce(
    (select max(coalesce(fn_date_ou_null(r.respostas->>'data'), r.data_tarefa::date))
       from public.rats r where r.tarefa_id = t.id),
    t.data_agendada,
    (t.criado_em at time zone 'America/Sao_Paulo')::date
  ) as ultima_atividade
) ua
where t.status in ('em_execucao', 'em_pausa');

-- DOWN:
-- drop view if exists public.vw_tarefas_acompanhamento;
-- alter table public.tarefas drop column if exists acompanhamento_notif_em;
