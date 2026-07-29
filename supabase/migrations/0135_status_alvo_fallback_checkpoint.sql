-- 0135: tarefa_status_alvo — fallback pro último checkpoint respondido (caso Tarefa 04778).
--
-- O que aconteceu (auditoria de 29/07):
--   A 04778 estava Em pausa desde 06/07 (RAT 1 fechou com "volto depois" em 26/06; a RAT 2
--   de 03/07 foi registrada PELA GESTÃO via portal — fluxo sem o checkpoint "Volta amanhã?",
--   então ficou sem volta_amanha/passagem_motivo; a gestão pausou a Tarefa manualmente).
--   O backfill da 0130 rederivou o status pelo conjunto de RATs: a RAT mais recente (a 2)
--   não tem checkpoint → coalesce(atendimento_executado, true) → 'em_execucao', e a pausa
--   manual foi atropelada (auditoria 29/07 12:52Z, ator nulo = backfill).
--
-- Bug da 0130: a derivação decide pela RAT mais recente MESMO quando ela nunca respondeu o
-- checkpoint de passagem. O próprio app não faz isso — passagemAberta() (tecnico.js) olha a
-- RAT mais recente QUE RESPONDEU volta_amanha. RAT registrada sem checkpoint (portal) não
-- diz nada sobre continuidade; quem diz é o último checkpoint respondido.
--
-- Correção: no ramo da RAT mais recente, se ela está 'registrado' SEM volta_amanha (e não é
-- improdutiva), decidir pela RAT mais recente com checkpoint respondido (mesma ordenação).
-- Sem nenhum checkpoint na tarefa → comportamento atual (em_execucao). Regras intactas:
--   - pausa do dia aberta em RAT em_andamento → em_pausa (tempo real);
--   - RAT nova em_andamento → em_execucao (retomada — RAT em andamento não cai no fallback);
--   - RAT mais recente improdutiva → null (não mexe);
--   - nunca toca status terminal/admin (WHERE restrito do trigger/guard, inalterado).
--
-- Dry-run em produção (29/07): com a nova derivação, a ÚNICA tarefa controlável com
-- alvo <> status é a 04778 (em_execucao → em_pausa). Backfill ao final reaplica.
-- Teste: supabase/tests/teste_0135_fallback_checkpoint.sql (transação com rollback).

create or replace function public.tarefa_status_alvo(p_tarefa uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    -- pausa do dia ABERTA em qualquer RAT em andamento → em_pausa (semântica 0072, global)
    when exists (
      select 1 from public.rats r
       where r.tarefa_id = p_tarefa
         and r.status = 'em_andamento'
         and r.respostas->>'pausa' = 'Sim'
         and nullif(r.respostas->>'pausa_inicio','') is not null
         and nullif(r.respostas->>'pausa_termino','') is null)
      then 'em_pausa'
    else (
      -- senão, decide pela RAT MAIS RECENTE (mesma ordenação do 0082)
      select case
        -- registrada SEM checkpoint (ex.: gestão registrou via portal): o dia fechado não
        -- diz nada sobre continuidade — decide o último checkpoint respondido (0135)
        when r.status = 'registrado'
         and r.respostas->>'volta_amanha' is null
         and coalesce(r.atendimento_executado, true) then
          coalesce((
            select case
              when r2.respostas->>'volta_amanha' = 'Não'
               and r2.respostas->>'passagem_motivo' = 'volto_depois' then 'em_pausa'
              else 'em_execucao'
            end
            from public.rats r2
            where r2.tarefa_id = p_tarefa
              and r2.respostas->>'volta_amanha' is not null
            order by coalesce(nullif(r2.respostas->>'data','')::date, r2.data_tarefa::date) desc nulls last,
                     r2.criado_em desc
            limit 1), 'em_execucao')
        when r.status = 'registrado'
         and r.respostas->>'volta_amanha' = 'Não'
         and r.respostas->>'passagem_motivo' = 'volto_depois' then 'em_pausa'
        when coalesce(r.atendimento_executado, true) then 'em_execucao'
        else null   -- improdutiva mais recente → não mexe (segue como está)
      end
      from public.rats r
      where r.tarefa_id = p_tarefa
      order by coalesce(nullif(r.respostas->>'data','')::date, r.data_tarefa::date) desc nulls last,
               r.criado_em desc
      limit 1)
  end
$$;

-- Backfill: reaplica a derivação corrigida (só status controláveis; a 04778 volta a em_pausa).
update public.tarefas t
   set status = a.alvo
  from (select t2.id, public.tarefa_status_alvo(t2.id) as alvo
          from public.tarefas t2
         where t2.status in ('aguardando_execucao','em_execucao','em_pausa')) a
 where a.id = t.id and a.alvo is not null and a.alvo <> t.status;

-- DOWN: recriar tarefa_status_alvo da 0130 (sem o ramo de fallback).
