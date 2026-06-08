-- Subnumeração da RAT dentro da tarefa: 04741_01, _02, ... (sequencial por tarefa).
alter table public.rats add column if not exists rat_seq int;

-- Backfill: numera as RATs existentes por tarefa, na ordem de criação.
with ordered as (
  select id, row_number() over (partition by tarefa_id order by criado_em nulls last, id) as rn
  from public.rats where tarefa_id is not null
)
update public.rats r set rat_seq = o.rn from ordered o
where o.id = r.id and r.rat_seq is null;

-- Atribui o próximo número ao inserir (offline -> atribuído ao sincronizar).
create or replace function public.tg_rat_seq() returns trigger language plpgsql as $$
begin
  if new.tarefa_id is not null and new.rat_seq is null then
    new.rat_seq := coalesce((select max(rat_seq) from public.rats where tarefa_id = new.tarefa_id), 0) + 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_rat_seq on public.rats;
create trigger trg_rat_seq before insert on public.rats
  for each row execute function public.tg_rat_seq();
