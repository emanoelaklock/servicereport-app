-- Teste de regressão da 0138 (F22) — SEGURO EM PRODUÇÃO.
-- Mesmo corpo da migração + fixture descartável + RAISE final incondicional → rollback total:
--   · 'TESTES_OK …' = tudo passou (o erro é só o veículo do rollback);
--   · '0138: …'     = qual condição falhou.
-- PROVA POSITIVA: técnico que NÃO enxerga as RATs alheias da tarefa (RLS) insere e recebe o
--   seq GLOBAL correto (max real + 1), não o max do escopo dele.
-- PROVA NEGATIVA: com a função de volta a INVOKER (estado pré-0138), o MESMO insert estoura
--   unique_violation — reproduz o bug do caso Pablo/4949 e prova que o DEFINER é o que cura.
do $$
declare
  TEC uuid; OUTRO uuid; T_ID uuid;
  v_seq int; v_visiveis int; v_bug boolean := false;
begin
  -- ── aplica o corpo da 0138 (idempotente; roda antes E depois do merge) ──
  execute $fix$
    create or replace function public.tg_rat_seq()
    returns trigger
    language plpgsql
    security definer
    set search_path = public, pg_temp
    as $body$
    begin
      if new.tarefa_id is not null and new.rat_seq is null then
        perform pg_advisory_xact_lock(hashtextextended(new.tarefa_id::text, 0));
        new.rat_seq := coalesce((select max(rat_seq) from public.rats where tarefa_id = new.tarefa_id), 0) + 1;
      end if;
      return new;
    end $body$
  $fix$;

  -- ── atores reais do ambiente (padrão teste_0123) ──
  select pa.usuario_id into TEC from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.role_chave = 'tecnico_campo' limit 1;
  select pa.usuario_id into OUTRO from portal_acessos pa
   where pa.app_chave = 'service_report' and pa.usuario_id <> TEC limit 1;
  if TEC is null or OUTRO is null then
    raise exception '0138: ambiente sem técnico/segundo usuário — teste inconclusivo (NADA aplicado)';
  end if;

  -- ── fixture descartável (rollback no fim): tarefa + 2 RATs de OUTRO usuário ──
  insert into tarefas (numero) select coalesce(max(numero), 0) + 1 from tarefas returning id into T_ID;
  insert into rats (client_uuid, tarefa_id, tecnico_id) values (gen_random_uuid(), T_ID, OUTRO);
  insert into rats (client_uuid, tarefa_id, tecnico_id) values (gen_random_uuid(), T_ID, OUTRO);

  -- ── PONTO CEGO (documenta o porquê do fix): o técnico não vê as RATs de OUTRO ──
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',TEC)::text, true);
  set local role authenticated;
  select count(*) into v_visiveis from rats where tarefa_id = T_ID;
  if v_visiveis <> 0 then
    raise exception '0138: técnico vê % RAT(s) alheia(s) — premissa do bug mudou, revisar o cenário', v_visiveis;
  end if;

  -- ── PROVA POSITIVA: insert do técnico "cego" recebe o seq global (3), sem colisão ──
  insert into rats (client_uuid, tarefa_id, tecnico_id) values (gen_random_uuid(), T_ID, TEC)
    returning rat_seq into v_seq;
  if v_seq is distinct from 3 then
    raise exception '0138: seq atribuído = % (esperado 3 = max real + 1) — abortando', v_seq;
  end if;

  -- ── PROVA NEGATIVA: função INVOKER (pré-0138) reproduz o duplicate key do caso Pablo ──
  reset role;
  execute $bug$
    create or replace function public.tg_rat_seq()
    returns trigger
    language plpgsql
    as $body$
    begin
      if new.tarefa_id is not null and new.rat_seq is null then
        perform pg_advisory_xact_lock(hashtextextended(new.tarefa_id::text, 0));
        new.rat_seq := coalesce((select max(rat_seq) from public.rats where tarefa_id = new.tarefa_id), 0) + 1;
      end if;
      return new;
    end $body$
  $bug$;
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',TEC)::text, true);
  set local role authenticated;
  begin
    -- Recria o cenário cego: transfere a RAT que o técnico acabou de ganhar pro OUTRO
    -- (como postgres) — o técnico volta a ver 0 RATs da tarefa enquanto o real é 3.
    -- Insert dele com a função INVOKER: max visível 0 → seq 1 → colide com a seq 1 alheia.
    reset role;
    update rats set tecnico_id = OUTRO where tarefa_id = T_ID and tecnico_id = TEC;
    perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',TEC)::text, true);
    set local role authenticated;
    insert into rats (client_uuid, tarefa_id, tecnico_id) values (gen_random_uuid(), T_ID, TEC);
    -- chegou aqui = NÃO colidiu = a premissa da prova negativa falhou
  exception when unique_violation then
    v_bug := true;   -- bug reproduzido: invoker + linhas invisíveis = duplicate key
  end;
  if not v_bug then
    raise exception '0138: prova negativa NÃO reproduziu o duplicate key — revisar premissas';
  end if;
  reset role;

  raise exception 'TESTES_OK 0138 — definer numera global (3/3), invoker reproduz o bug; rollback total agora.';
end $$;
