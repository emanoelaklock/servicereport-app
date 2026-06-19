-- 0072: pausa do MESMO DIA em tempo real → Tarefa "Em Pausa" enquanto a pausa está aberta,
-- voltando a "Em Execução" ao retomar. (Revisita a decisão (b): agora a pausa ativa FLIPA o
-- status, pro admin acompanhar.) Estende o rat_inicia_tarefa (0069) computando um ALVO e
-- aplicando-o só sobre status controláveis (aguardando/em_execucao/em_pausa) — nunca terminais.
-- Pausa ativa = RAT em_andamento, pausa=Sim, início preenchido e término vazio.
create or replace function public.rat_inicia_tarefa() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_target text; v_latest uuid; v_pausa_ativa boolean;
begin
  if new.tarefa_id is null then return new; end if;

  v_pausa_ativa := (new.status = 'em_andamento'
                    and new.respostas->>'pausa' = 'Sim'
                    and nullif(new.respostas->>'pausa_inicio', '') is not null
                    and nullif(new.respostas->>'pausa_termino', '') is null);

  if v_pausa_ativa then
    v_target := 'em_pausa';                                  -- pausa do dia ABERTA (tempo real)
  elsif new.status = 'registrado'
        and new.respostas->>'volta_amanha' = 'Não'
        and new.respostas->>'passagem_motivo' = 'volto_depois' then
    -- "volto depois": só a RAT MAIS RECENTE da tarefa pode pausar (não reedição de antiga)
    select r.id into v_latest from public.rats r
      where r.tarefa_id = new.tarefa_id
      order by coalesce(nullif(r.respostas->>'data','')::date,
                        (r.data_tarefa at time zone 'America/Sao_Paulo')::date) desc nulls last,
               r.criado_em desc
      limit 1;
    v_target := case when v_latest = new.id then 'em_pausa' else null end;
  elsif coalesce(new.atendimento_executado, true) then
    v_target := 'em_execucao';                               -- executada, sem pausa ativa → retoma/inicia
  else
    v_target := null;                                        -- improdutiva: não mexe (segue aguardando)
  end if;

  if v_target is not null then
    update public.tarefas
       set status = v_target
     where id = new.tarefa_id
       and status in ('aguardando_execucao','em_execucao','em_pausa')   -- nunca toca terminal/admin
       and status <> v_target;
  end if;
  return new;
end $$;

-- O trigger trg_rat_inicia_tarefa (INSERT OR UPDATE, do 0069) continua valendo.

-- Realtime: o portal de Tarefas assina mudanças de `tarefas` (status em tempo real).
alter publication supabase_realtime add table public.tarefas;

-- Backfill (uma vez): tarefas em_execucao cuja RAT está em pausa ABERTA agora → em_pausa.
update public.tarefas t set status = 'em_pausa'
 where t.status = 'em_execucao'
   and exists (select 1 from public.rats r where r.tarefa_id = t.id
     and r.status = 'em_andamento' and r.respostas->>'pausa' = 'Sim'
     and nullif(r.respostas->>'pausa_inicio','') is not null
     and nullif(r.respostas->>'pausa_termino','') is null);

-- DOWN: restaurar a função do 0069; alter publication supabase_realtime drop table public.tarefas;

