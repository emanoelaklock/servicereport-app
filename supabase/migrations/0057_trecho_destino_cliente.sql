-- Viagem pode visitar VÁRIOS clientes (trecho 1 → cliente A, trecho 2 → cliente B,
-- trecho 3 → base). O cliente do destino vira dado explícito do trecho.
alter table public.deslocamento_trechos
  add column if not exists destino_cliente_id uuid references public.clientes(id);
create index if not exists idx_trechos_dest_cli on public.deslocamento_trechos (destino_cliente_id);

-- backfill: trecho com Local do cliente herda o cliente do local
update public.deslocamento_trechos t
   set destino_cliente_id = l.cliente_id
  from public.cliente_locais l
 where l.id = t.destino_local_id and t.destino_cliente_id is null;
