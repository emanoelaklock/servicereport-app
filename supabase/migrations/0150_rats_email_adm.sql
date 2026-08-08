-- 0150 — item 2 do roadmap: e-mail à administração quando a RAT do dia é encerrada.
-- Carimbo de idempotência do envio (espelho do email_comercial_em do pré-orçamento):
-- a Edge `documentos` (action 'rat_registrada') só envia se NULL e carimba ao enviar.
alter table public.rats add column if not exists email_adm_em timestamptz;

-- Backfill: RATs JÁ encerradas ganham carimbo sentinela — o e-mail é do EVENTO de
-- encerrar; sem isso, o próximo re-sync de uma registrada antiga (edição de campo,
-- retry) dispararia e-mail atrasado de semanas. Só encerramentos NOVOS notificam.
update public.rats set email_adm_em = now()
 where email_adm_em is null and status in ('registrado', 'concluida', 'concluida_pendencia');

-- Guarda auto-abortante: coluna presente + nenhuma registrada sem carimbo.
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'rats' and column_name = 'email_adm_em';
  if n <> 1 then raise exception '0150: coluna email_adm_em ausente — abortando'; end if;
  select count(*) into n from public.rats
   where email_adm_em is null and status in ('registrado', 'concluida', 'concluida_pendencia');
  if n > 0 then raise exception '0150: % registrada(s) sem carimbo após backfill — abortando', n; end if;
end $$;
