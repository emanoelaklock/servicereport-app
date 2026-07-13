-- 0090: agenda o lembrete de devolvida — pg_cron a cada 4h → Edge Function lembrete-devolvida.
-- pg_net faz o http_post; o header x-cron-secret é LIDO de app_secrets (não fica hardcoded no job).
-- A função filtra devolvidas >24h não-notificadas no dia e envia push aos técnicos (máx 1/dia).
-- Idempotente: remove o agendamento anterior (se houver) antes de re-agendar.

create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('lembrete-devolvida-4h');
exception when others then null; end $$;

select cron.schedule(
  'lembrete-devolvida-4h',
  '0 */4 * * *',   -- minuto 0, a cada 4 horas (00,04,08,12,16,20 UTC)
  $cmd$
  select net.http_post(
    url := 'https://iwufrqmzcvaiyzynodkg.supabase.co/functions/v1/lembrete-devolvida',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select valor from public.app_secrets where chave = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- DOWN:
-- select cron.unschedule('lembrete-devolvida-4h');
