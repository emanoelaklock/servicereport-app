-- Quando false, a sincronização do Omie ignora este cliente (não sobrescreve campos editados
-- manualmente nem reimporta clientes excluídos).
alter table public.clientes
  add column if not exists sync_omie boolean not null default true;
