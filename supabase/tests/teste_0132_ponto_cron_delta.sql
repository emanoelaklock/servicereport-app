-- teste_0132_ponto_cron_delta.sql — auto-abortante (padrão da casa):
-- agenda o cron da 0132, valida schedule/comando e o REMOVE explicitamente (não deixa cron
-- ativo mesmo que cron.schedule não fosse transacional), então termina em RAISE → rollback.
-- Nada persiste; nenhum cron de ponto fica ativo.
-- Gates:
--  G1  schedule = '0 1,9,17 * * *' (3x/dia; UTC 01/09/17 = BRT 22/06/14)
--  G2  o comando chama a Edge ponto-sync (functions/v1/ponto-sync)
--  G3  usa o segredo do Vault (x-cron-secret + vault.decrypted_secrets)
--  G4  roda o modo DELTA
--  G5  NUNCA roda modo especial (carga/reconhecimento/colaboradores)
--  G6  nenhum segredo indevido no comando (sem TANGERINO_TOKEN / bearer)
--  G7  removido ao fim (0 crons 'ponto-sync-delta')
do $$
declare v_jobid bigint; v_cmd text; v_sched text; v_n int;
begin
  perform cron.unschedule(jobid) from cron.job where jobname='ponto-sync-delta';   -- estado limpo

  v_jobid := cron.schedule('ponto-sync-delta', '0 1,9,17 * * *', $cmd$
    select net.http_post(
      url := 'https://iwufrqmzcvaiyzynodkg.supabase.co/functions/v1/ponto-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{"modo":"delta"}'::jsonb
    );
  $cmd$);

  select schedule, command into v_sched, v_cmd from cron.job where jobid = v_jobid;
  if v_sched <> '0 1,9,17 * * *' then raise exception '0132 G1: schedule errado: %', v_sched; end if;
  if v_cmd not like '%functions/v1/ponto-sync%' then raise exception '0132 G2: nao chama a Edge ponto-sync'; end if;
  if v_cmd not like '%x-cron-secret%' or v_cmd not like '%vault.decrypted_secrets%' then raise exception '0132 G3: nao usa o segredo do vault'; end if;
  if v_cmd not like '%"modo":"delta"%' then raise exception '0132 G4: nao roda modo delta'; end if;
  if v_cmd like '%carga%' or v_cmd like '%reconhecimento%' or v_cmd like '%colaboradores%' then raise exception '0132 G5: cron nao pode rodar modo especial'; end if;
  if v_cmd like '%TANGERINO_TOKEN%' or v_cmd ~* 'bearer ' then raise exception '0132 G6: segredo indevido no comando'; end if;

  perform cron.unschedule(v_jobid);   -- remove explicitamente
  select count(*) into v_n from cron.job where jobname='ponto-sync-delta';
  if v_n <> 0 then raise exception '0132 G7: cron nao removido (%)', v_n; end if;

  raise exception '0132 OK: G1-G7 verdes — cron valido e removido, nada persiste';
end $$;
