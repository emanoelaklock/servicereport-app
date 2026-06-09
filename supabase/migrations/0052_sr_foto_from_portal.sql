-- A foto do usuário é gravada pelo Portal em usuarios.foto (base64 data URI).
-- As RPCs do SR passam a devolver essa foto (com fallback no foto_url do bucket).
-- Conteúdo idêntico ao aplicado via apply_migration 0052_sr_foto_from_portal.
create or replace function public.sr_perfil()
returns table(role text, nome text, ativo boolean, cargo text, foto_url text)
language sql stable security definer set search_path = public as $$
  select
    (select role_chave from public.portal_acessos
       where usuario_id = auth.uid() and app_chave = 'service_report' limit 1) as role,
    u.nome, u.ativo, u.cargo, coalesce(u.foto, u.foto_url) as foto_url
  from public.usuarios u
  where u.id = auth.uid();
$$;

create or replace function public.sr_usuarios()
returns table(id uuid, nome text, email text, cargo text, role text, ativo boolean, foto_url text)
language sql stable security definer set search_path = public as $$
  select u.id, u.nome, u.email, u.cargo, pa.role_chave as role, u.ativo,
         coalesce(u.foto, u.foto_url) as foto_url
  from public.usuarios u
  join public.portal_acessos pa
    on pa.usuario_id = u.id and pa.app_chave = 'service_report'
  where exists (
    select 1 from public.portal_acessos c
    where c.usuario_id = auth.uid() and c.app_chave = 'service_report'
  )
  order by u.nome;
$$;
