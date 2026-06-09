-- Notificações push: inscrições por usuário + segredos (VAPID).
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.usuarios(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  criado_em   timestamptz default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_sub_own on public.push_subscriptions;
create policy push_sub_own on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Segredos do app: lidos só pelo service role (sem policies = nenhum acesso via API).
create table if not exists public.app_secrets (chave text primary key, valor text not null);
alter table public.app_secrets enable row level security;
-- Os valores VAPID são inseridos manualmente (não versionados):
--   insert into public.app_secrets (chave,valor) values ('vapid_public','...'),('vapid_private','...');
