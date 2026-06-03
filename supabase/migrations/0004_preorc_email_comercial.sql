-- #4.5 — PDF (servidor) + e-mail (Resend).
-- Idempotência do e-mail ao comercial quando um pré-orçamento é concluído:
-- a Edge Function `documentos` (action pre_orcamento_concluido) só envia se
-- email_comercial_em estiver nulo, e carimba após o envio.
alter table public.pre_orcamentos add column if not exists email_comercial_em timestamptz;
