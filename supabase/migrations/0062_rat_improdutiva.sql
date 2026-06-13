-- Pacote FLUXO DO TÉCNICO — Commit 2 (RAT improdutiva: visita sem execução)
-- · A RAT ganha o eixo "Atendimento executado? Sim/Não" (§ "RAT improdutiva").
--   Não → registra deslocamento e tempo de quem foi, execução zerada, motivo.
-- · A Tarefa NÃO progride: fica 'aguardando_execucao' (nova ida). Por isso o
--   trigger 0053 (rat_inicia_tarefa) passa a NÃO promover quando a RAT é improdutiva.
-- · Aditivo e retrocompatível: colunas nullable; RAT antiga (atendimento_executado
--   NULL) segue promovendo a tarefa como antes (coalesce(...,true)).

alter table public.rats
  add column if not exists atendimento_executado boolean,
  add column if not exists motivo_improdutiva text,
  add column if not exists motivo_texto text;

-- Trigger 0053 reescrito: só promove aguardando_execucao → em_execucao se a visita
-- de fato executou. Visita improdutiva (atendimento_executado = false) deixa a tarefa
-- aguardando. NULL (RATs produtivas/antigas que não preenchem o campo) = promove.
create or replace function public.rat_inicia_tarefa() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tarefa_id is not null and coalesce(new.atendimento_executado, true) then
    update public.tarefas
       set status = 'em_execucao'
     where id = new.tarefa_id
       and status = 'aguardando_execucao';
  end if;
  return new;
end $$;
