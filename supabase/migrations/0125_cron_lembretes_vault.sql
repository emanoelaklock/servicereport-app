-- 0125 — P1a Fase 2: reaponta os 2 jobs do pg_cron para o Vault (cron_secret),
-- tirando a leitura direta de public.app_secrets. Os jobs `lembrete-devolvida-4h` (0090) e
-- `lembrete-acompanhamento-diario` (0094) montavam o header `x-cron-secret` com
--   (select valor from public.app_secrets where chave = 'cron_secret')
-- — dependência DB-side da tabela no schema público. Passam a ler de `vault.decrypted_secrets`.
--
-- PRÉ-REQUISITO MANUAL (fora desta migração; NENHUM valor entra em migração/commit/log):
--   você cria o segredo no Vault com o MESMO valor do cron_secret atual, no SQL editor/Dashboard:
--     select vault.create_secret('<VALOR_DO_CRON_SECRET_ATUAL>', 'cron_secret');
--
-- Esta migração é AUTO-ABORTANTE: só reaponta se o Vault secret já existir E bater com o valor
-- atual (comparação booleana `is distinct from` — o valor nunca é exibido). A Edge valida o header
-- contra CRON_SECRET (env) OU o fallback app_secrets (ainda presente na Fase 1); como o Vault
-- carrega o mesmo valor, a validação continua passando — sem indisponibilidade.
--
-- Aplicar DEPOIS de criar o Vault secret. Validação pós-apply (manual): disparar o corpo de um
-- job uma vez e conferir 200 na Edge (não 401). Rollback: reaplicar 0090/0094 (subquery em
-- app_secrets), que ainda existe até a Fase final.

do $mig$
declare r record;
begin
  create extension if not exists pg_net;

  -- ── guarda: Vault secret precisa existir e ser idêntico ao cron_secret atual ──
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    raise exception '0125: crie o Vault secret cron_secret (mesmo valor atual) ANTES de aplicar esta migração';
  end if;
  if (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
     is distinct from (select valor from public.app_secrets where chave = 'cron_secret') then
    raise exception '0125: valor do Vault cron_secret diverge do cron_secret atual — corrija antes de reapontar';
  end if;

  -- ── remove os agendamentos atuais (por nome) ──
  for r in select jobid from cron.job
            where jobname in ('lembrete-devolvida-4h', 'lembrete-acompanhamento-diario') loop
    perform cron.unschedule(r.jobid);
  end loop;

  -- ── reagenda lendo o cron_secret do Vault ──
  perform cron.schedule('lembrete-devolvida-4h', '0 */4 * * *', $cmd$
  select net.http_post(
    url := 'https://iwufrqmzcvaiyzynodkg.supabase.co/functions/v1/lembrete-devolvida',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb );
  $cmd$);

  perform cron.schedule('lembrete-acompanhamento-diario', '0 12 * * *', $cmd$
  select net.http_post(
    url := 'https://iwufrqmzcvaiyzynodkg.supabase.co/functions/v1/lembrete-acompanhamento',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb );
  $cmd$);

  -- ── validações (falhou → rollback total) ──
  if exists (select 1 from cron.job
             where jobname in ('lembrete-devolvida-4h', 'lembrete-acompanhamento-diario')
               and command ilike '%app_secrets%') then
    raise exception '0125: cron ainda referencia app_secrets após reapontar';
  end if;
  if (select count(*) from cron.job
       where jobname in ('lembrete-devolvida-4h', 'lembrete-acompanhamento-diario')
         and command ilike '%vault.decrypted_secrets%') <> 2 then
    raise exception '0125: os 2 jobs deveriam apontar para vault.decrypted_secrets';
  end if;
  if (select count(*) from cron.job
       where jobname in ('lembrete-devolvida-4h', 'lembrete-acompanhamento-diario')
         and active) <> 2 then
    raise exception '0125: os 2 jobs deveriam continuar ativos';
  end if;
end $mig$;
