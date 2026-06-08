-- Garante rat_seq único por tarefa mesmo com inserts concorrentes:
-- advisory lock por tarefa (serializa) + índice único (rede de segurança).
create unique index if not exists uq_rats_tarefa_seq
  on public.rats (tarefa_id, rat_seq) where rat_seq is not null;

create or replace function public.tg_rat_seq() returns trigger language plpgsql as $$
begin
  if new.tarefa_id is not null and new.rat_seq is null then
    -- bloqueia outras transações que inserem RAT para a MESMA tarefa até esta confirmar
    perform pg_advisory_xact_lock(hashtextextended(new.tarefa_id::text, 0));
    new.rat_seq := coalesce((select max(rat_seq) from public.rats where tarefa_id = new.tarefa_id), 0) + 1;
  end if;
  return new;
end $$;
