-- Foto do usuário (avatar), centralizada na tabela usuarios (mesma do Portal).
-- Upload é feito no Portal; o SR apenas exibe (bucket público 'avatars').
-- Conteúdo idêntico ao aplicado via apply_migration 0051_usuarios_foto.
alter table public.usuarios add column if not exists foto_url text;

insert into storage.buckets (id, name, public)
values ('avatars','avatars', true)
on conflict (id) do update set public = true;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists avatars_write on storage.objects;
create policy avatars_write on storage.objects for insert to authenticated with check (bucket_id = 'avatars');
drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to authenticated using (bucket_id = 'avatars');
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated using (bucket_id = 'avatars');

drop function if exists public.sr_perfil();
create function public.sr_perfil()
returns table(role text, nome text, ativo boolean, cargo text, foto_url text)
language sql stable security definer set search_path = public as $$
  select
    (select role_chave from public.portal_acessos
       where usuario_id = auth.uid() and app_chave = 'service_report' limit 1) as role,
    u.nome, u.ativo, u.cargo, u.foto_url
  from public.usuarios u
  where u.id = auth.uid();
$$;

drop function if exists public.sr_usuarios();
create function public.sr_usuarios()
returns table(id uuid, nome text, email text, cargo text, role text, ativo boolean, foto_url text)
language sql stable security definer set search_path = public as $$
  select u.id, u.nome, u.email, u.cargo, pa.role_chave as role, u.ativo, u.foto_url
  from public.usuarios u
  join public.portal_acessos pa
    on pa.usuario_id = u.id and pa.app_chave = 'service_report'
  where exists (
    select 1 from public.portal_acessos c
    where c.usuario_id = auth.uid() and c.app_chave = 'service_report'
  )
  order by u.nome;
$$;

grant execute on function public.sr_perfil() to authenticated;
grant execute on function public.sr_usuarios() to authenticated;
