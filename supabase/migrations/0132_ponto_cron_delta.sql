-- 0132 — C4: agenda o cron da sincronização DELTA do ponto (pg_cron + pg_net + Vault).
--
-- Frequência: 3x/dia (decisão da gestão; conservador enquanto a Sólides não confirma o rate
-- limit — ajustável depois). Horários em América/Sao_Paulo (UTC-3 fixo, sem horário de verão):
--   06:00, 14:00, 22:00 BRT  ==  09:00, 17:00, 01:00 UTC  →  cron '0 1,9,17 * * *'.
--
-- Segue o PADRÃO DA CASA (jobs lembrete-*): net.http_post para a Edge com o header
-- x-cron-secret lido de vault.decrypted_secrets['cron_secret'] (mesmo segredo já usado pelos
-- outros crons; app_secrets.cron_secret == vault.cron_secret, então a Edge autentica). O token
-- do Tangerino NÃO aparece aqui — fica só no Function Secret; o cron só dispara a Edge.
--
-- A Edge roda o modo DELTA (incremental por lastUpdate + janela D-7), que:
--   · importa vinculados; ignora e conta fora_escopo; pendentes → 'parcial' sem avanço de cursor;
--   · upsert por tangerino_punch_id (idempotente); nunca apaga; cursor só avança em sucesso.
-- A carga histórica (modo 'carga') é MANUAL/admin — o cron NUNCA a executa.
--
-- Idempotente: remove um agendamento anterior de mesmo nome antes de recriar.

-- remove agendamento anterior (no-op se não existir)
select cron.unschedule(jobid) from cron.job where jobname = 'ponto-sync-delta';

-- agenda 3x/dia (UTC 01/09/17 = BRT 22/06/14)
select cron.schedule('ponto-sync-delta', '0 1,9,17 * * *', $cmd$
  select net.http_post(
    url := 'https://iwufrqmzcvaiyzynodkg.supabase.co/functions/v1/ponto-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{"modo":"delta"}'::jsonb
  );
$cmd$);
