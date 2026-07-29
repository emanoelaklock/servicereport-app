-- 0130: status da Tarefa DERIVADO DO CONJUNTO de RATs — mata o flapping (caso Tarefa 04853).
--
-- Problema real observado (auditoria da 04853, 28–29/07):
--   O trigger 0072/0082 derivava o alvo SÓ da linha upsertada (NEW), e o app antigo ainda
--   fazia um UPDATE direto em tarefas.status após cada upsert de RAT (sync.js passo 4c).
--   Resultado: cada sync gerava pares "Em execução ↔ Em pausa" no mesmo segundo e o ÚLTIMO
--   gravado vencia — o portal ficou "Em execução" a noite inteira com a RAT em pausa aberta.
--
-- Correção (três peças, todas idempotentes e independentes de ordem):
--   1) tarefa_status_alvo(tarefa): função ÚNICA de derivação, olhando TODAS as RATs da tarefa
--      (pausa aberta em qualquer RAT em_andamento → em_pausa; senão decide pela RAT mais
--      recente, com a mesma ordenação do 0082). Snapshot velho reprocessado → mesmo alvo.
--   2) rat_inicia_tarefa(): passa a delegar à função (INSERT/UPDATE em rats, trigger 0069).
--   3) trg_tarefa_status_guard (BEFORE UPDATE em tarefas): app ANTIGO ainda no ar tenta
--      escrever 'em_execucao' com pausa aberta → o guard mantém 'em_pausa'. Sem isso, a
--      migração só faria efeito depois do deploy do app (PWA pode demorar a atualizar).
--
-- Nunca toca status terminais/admin (concluida/*_pendencia/devolvida/aprovada_faturamento/
-- faturada/em_espera_produtos) — mesmas guardas de sempre (WHERE de status restrito).
-- Backfill ao final corrige quem já está errado hoje (a 04853 inclusive).
-- Teste: supabase/tests/teste_0130_status_derivado.sql (transação com rollback).

-- 1) Derivação única, a partir do CONJUNTO de RATs da tarefa.
create or replace function public.tarefa_status_alvo(p_tarefa uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    -- pausa do dia ABERTA em qualquer RAT em andamento → em_pausa (semântica 0072, agora global)
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

-- 2) O trigger de rats delega à derivação (substitui a versão 0082, que só olhava NEW).
create or replace function public.rat_inicia_tarefa() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_target text;
begin
  if new.tarefa_id is null then return new; end if;
  v_target := public.tarefa_status_alvo(new.tarefa_id);
  if v_target is not null then
    update public.tarefas set status = v_target
     where id = new.tarefa_id
       and status in ('aguardando_execucao','em_execucao','em_pausa')   -- nunca terminal/admin
       and status <> v_target;
  end if;
  return new;
end $$;
-- trg_rat_inicia_tarefa (AFTER INSERT OR UPDATE, do 0069) continua valendo.

-- 3) Guard contra escrita defasada do app antigo: 'em_execucao' com pausa aberta não passa.
--    Só age em status controláveis e só na transição para em_execucao — admin segue livre
--    para concluir/devolver/faturar; a retomada real (pausa fechada) muda o alvo e passa.
create or replace function public.tarefa_status_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'em_execucao'
     and old.status in ('aguardando_execucao','em_execucao','em_pausa')
     and public.tarefa_status_alvo(new.id) = 'em_pausa' then
    new.status := 'em_pausa';
  end if;
  return new;
end $$;

drop trigger if exists trg_tarefa_status_guard on public.tarefas;
create trigger trg_tarefa_status_guard before update of status on public.tarefas
  for each row execute function public.tarefa_status_guard();

-- 4) Backfill: corrige tarefas controláveis cujo status atual difere do derivado.
--    (A 04853 volta para em_pausa se a pausa da RAT do dia seguir aberta.)
update public.tarefas t
   set status = a.alvo
  from (select t2.id, public.tarefa_status_alvo(t2.id) as alvo
          from public.tarefas t2
         where t2.status in ('aguardando_execucao','em_execucao','em_pausa')) a
 where a.id = t.id and a.alvo is not null and a.alvo <> t.status;

-- DOWN: recriar rat_inicia_tarefa do 0082; drop trigger trg_tarefa_status_guard on tarefas;
--       drop function tarefa_status_guard(); drop function tarefa_status_alvo(uuid);
