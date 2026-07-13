-- 0094: agenda o lembrete de acompanhamento — pg_cron 1x/dia → Edge Function lembrete-acompanhamento.
-- Limite de 5 dias é medido em dias, então 1x/dia basta (diferente da devolvida, a cada 4h).
-- 12:00 UTC = 09:00 BR (nudge de manhã). pg_net faz o http_post; x-cron-secret lido de app_secrets.

create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('lembrete-acompanhamento-diario');
exception when others then null; end $$;

select cron.schedule(
  'lembrete-acompanhamento-diario',
  '0 12 * * *',
  $cmd$
  select net.http_post(
    url := 'https://iwufrqmzcvaiyzynodkg.supabase.co/functions/v1/lembrete-acompanhamento',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select valor from public.app_secrets where chave = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- DOWN:
-- select cron.unschedule('lembrete-acompanhamento-diario');
