-- Corrige "record old has no field client_uuid" ao excluir deslocamentos/segmentos.
-- O CASE anterior referenciava old.client_uuid mesmo para tabelas sem essa coluna;
-- o PL/pgSQL valida TODOS os campos da expressão contra o tipo da tabela no plano.
-- Usar to_jsonb(old)->>'campo' resolve em runtime (null se a coluna não existir).
create or replace function public.tg_tombstone()
returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb; rid text;
begin
  j := to_jsonb(old);
  rid := coalesce(j->>'client_uuid', j->>'id');   -- rats usa client_uuid; demais usam id
  if rid is not null then
    insert into public.sync_tombstones (tabela, registro_id) values (tg_table_name, rid);
  end if;
  return old;
end $$;
