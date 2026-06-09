-- Sincroniza o papel do Service Report com o Portal (portal-tross).
-- O papel efetivo do SR vem de portal_acessos (app_chave='service_report'),
-- e NÃO de usuarios.role (que guarda o papel global do Portal, ex.: 'colaborador').
-- app_role() é usada SOMENTE por políticas do Service Report (verificado em pg_policies),
-- então redirecioná-la não afeta os outros apps do mesmo banco.
-- Conteúdo idêntico ao aplicado via apply_migration 0050_sr_role_from_portal.

create or replace function public.app_role()
returns text
language sql stable security definer set search_path = public as $$
  select role_chave
  from public.portal_acessos
  where usuario_id = auth.uid() and app_chave = 'service_report'
  limit 1;
$$;

create or replace function public.sr_perfil()
returns table(role text, nome text, ativo boolean, cargo text)
language sql stable security definer set search_path = public as $$
  select
    (select role_chave from public.portal_acessos
       where usuario_id = auth.uid() and app_chave = 'service_report' limit 1) as role,
    u.nome, u.ativo, u.cargo
  from public.usuarios u
  where u.id = auth.uid();
$$;

create or replace function public.sr_usuarios()
returns table(id uuid, nome text, email text, cargo text, role text, ativo boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.nome, u.email, u.cargo, pa.role_chave as role, u.ativo
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
