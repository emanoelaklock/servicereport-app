-- 0069: transições automáticas Em Execução ↔ Em Pausa, no servidor (fonte da verdade).
-- Estende o rat_inicia_tarefa (0053/0062): além de aguardando→em_execucao, agora também
--   · PAUSAR:  RAT registrada "não volto amanhã / volto depois" → em_execucao → em_pausa
--   · RETOMAR: RAT executada reabre tarefa parada (aguardando OU em_pausa) → em_execucao
-- Por que no banco e não só no app: cobre RATs criadas OFFLINE que sincronizam depois
-- (idêntico ao 0053). Passa a disparar em INSERT *e* UPDATE (a RAT vira 'registrado' num
-- upsert posterior). NÃO trata pausa do mesmo dia (almoço/café) — decisão (b), fica fora.
-- NUNCA toca status terminais/admin (concluida / *_pendencia / devolvida / aprovada_faturamento
-- / faturada / em_espera_produtos): os UPDATEs têm WHERE de status restrito.

create or replace function public.rat_inicia_tarefa() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_latest uuid;
begin
  if new.tarefa_id is null then return new; end if;

  -- RETOMAR: RAT executada reabre tarefa parada → em_execucao.
  -- Guarda: não reabre se a própria RAT está encerrando como pausa (volta_amanha=Não).
  if coalesce(new.atendimento_executado, true)
     and coalesce(new.respostas->>'volta_amanha','') <> 'Não' then
    update public.tarefas set status = 'em_execucao'
     where id = new.tarefa_id and status in ('aguardando_execucao','em_pausa');
  end if;

  -- PAUSAR: RAT registrada "não volto amanhã / volto depois" → em_execucao → em_pausa,
  -- só se for a RAT MAIS RECENTE da tarefa (não deixa reedição de RAT antiga re-pausar).
  if new.status = 'registrado'
     and new.respostas->>'volta_amanha' = 'Não'
     and new.respostas->>'passagem_motivo' = 'volto_depois' then
    select r.id into v_latest from public.rats r
     where r.tarefa_id = new.tarefa_id
     order by coalesce(nullif(r.respostas->>'data','')::date,
                       (r.data_tarefa at time zone 'America/Sao_Paulo')::date) desc nulls last,
              r.criado_em desc
     limit 1;
    if v_latest = new.id then
      update public.tarefas set status = 'em_pausa'
       where id = new.tarefa_id and status = 'em_execucao';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_rat_inicia_tarefa on public.rats;
create trigger trg_rat_inicia_tarefa after insert or update on public.rats
  for each row execute function public.rat_inicia_tarefa();

-- DOWN: restaura a versão 0062 (só promove aguardando→em_execucao no INSERT).
