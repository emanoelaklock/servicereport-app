-- 0149 — P1a passo de endurecimento: app_secrets fora do alcance de anon/authenticated.
--
-- A tabela public.app_secrets (4 segredos vivos) tinha grant COMPLETO a anon e
-- authenticated — o RLS deny-all (sem policy) já bloqueava a leitura, mas era defesa
-- de camada única e violava o CLAUDE.md (achado P1a; triple check 08/08 confirmou os
-- grants ainda vivos). Revoga TUDO de anon/authenticated; service_role (as 4 Edges,
-- inclusive o fallback temporário do 1º PR) e os papéis de infra seguem lendo.
-- Os 3 crons do cron_secret já leem do VAULT (0125) — nenhuma dependência de cliente.

revoke all on public.app_secrets from anon, authenticated;

-- Guarda auto-abortante: zero grants de cliente; service_role preservado.
do $$
declare n int;
begin
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'app_secrets'
     and grantee in ('anon', 'authenticated');
  if n > 0 then raise exception '0149: app_secrets ainda com % grant(s) de cliente — abortando', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'app_secrets'
     and grantee = 'service_role' and privilege_type = 'SELECT';
  if n < 1 then raise exception '0149: service_role PERDEU o select de app_secrets (fallback das Edges quebraria) — abortando'; end if;
end $$;
