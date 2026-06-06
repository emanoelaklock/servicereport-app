-- Corrige "infinite recursion detected in policy for relation deslocamentos".
-- As policies de deslocamentos e deslocamento_tecnicos se consultavam mutuamente
-- (uma faz subselect na outra), e a RLS de cada uma reativava a da outra → loop.
-- Solução: encapsular as checagens cruzadas em funções SECURITY DEFINER, que
-- rodam sem reaplicar RLS, quebrando o ciclo.

create or replace function public.desloc_is_aboard(d_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.deslocamento_tecnicos dt
    where dt.deslocamento_id = d_id and dt.tecnico_id = auth.uid()
  );
$$;

create or replace function public.desloc_is_owner(d_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.deslocamentos d
    where d.id = d_id and d.criado_por = auth.uid()
  );
$$;

grant execute on function public.desloc_is_aboard(uuid) to authenticated;
grant execute on function public.desloc_is_owner(uuid)  to authenticated;

-- deslocamentos: técnico a bordo pode ler (sem subselect direto → usa a função)
drop policy if exists desloc_tecnico_aboard_read on public.deslocamentos;
create policy desloc_tecnico_aboard_read on public.deslocamentos
  for select using (public.desloc_is_aboard(id));

-- deslocamento_tecnicos: o dono do trajeto gerencia os "a bordo" (via função)
drop policy if exists dt_tecnico_manage on public.deslocamento_tecnicos;
create policy dt_tecnico_manage on public.deslocamento_tecnicos
  for all using (public.desloc_is_owner(deslocamento_id))
  with check (public.desloc_is_owner(deslocamento_id));
