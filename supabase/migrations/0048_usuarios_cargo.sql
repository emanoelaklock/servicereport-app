-- Cargo (função/título) do usuário — texto livre, separado do papel de sistema (role).
-- Usado apenas para exibição no portal; permissões continuam regidas por usuarios.role.
alter table public.usuarios add column if not exists cargo text;
