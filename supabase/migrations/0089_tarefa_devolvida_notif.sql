-- 0089: marcador de "já notifiquei" o lembrete de devolvida — evita spam do push.
-- devolvida_notif_em = quando o ÚLTIMO push do lembrete foi enviado pra esta tarefa.
--
-- A Edge Function `lembrete-devolvida` (rodada pelo pg_cron a cada 4h) seleciona:
--   status = 'devolvida'
--   AND devolvida_em < now() - interval '24 hours'
--   AND (devolvida_notif_em IS NULL OR devolvida_notif_em < now() - interval '24 hours')
-- → envia push aos técnicos da tarefa e re-carimba devolvida_notif_em = now().
-- Efeito: cada tarefa recebe no MÁXIMO 1 push por dia, até o técnico retornar o trabalho
-- (quando o status sai de 'devolvida', ela não entra mais no filtro).
--
-- Aditiva, nullable, nada reescrito.

alter table public.tarefas
  add column if not exists devolvida_notif_em timestamptz;

-- DOWN:
-- alter table public.tarefas drop column if exists devolvida_notif_em;
