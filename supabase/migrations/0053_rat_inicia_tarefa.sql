-- Tarefa entra "em execução" automaticamente quando ganha a primeira RAT.
-- Gatilho no INSERT de rats: cobre o app online E RATs criadas offline que
-- sincronizam depois. Só promove a partir de 'aguardando_execucao'
-- (não rebaixa concluída/faturada etc.). A auditoria registra a mudança
-- via trg_audit_tarefas com o ator = técnico que criou a RAT.
-- Conteúdo idêntico ao aplicado via apply_migration 0053_rat_inicia_tarefa.
create or replace function public.rat_inicia_tarefa() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tarefa_id is not null then
    update public.tarefas
       set status = 'em_execucao'
     where id = new.tarefa_id
       and status = 'aguardando_execucao';
  end if;
  return new;
end $$;

drop trigger if exists trg_rat_inicia_tarefa on public.rats;
create trigger trg_rat_inicia_tarefa after insert on public.rats
  for each row execute function public.rat_inicia_tarefa();
