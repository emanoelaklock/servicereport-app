-- Teste da vw_alerta_rat_fotos_orfas (migração 0139) — SEGURO EM PRODUÇÃO.
-- Roda inteiro num único DO $$ … $$ e SEMPRE termina em RAISE EXCEPTION:
--  · mensagem 'TESTES_OK …'  = todos os casos passaram (o erro é só o veículo do rollback);
--  · mensagem 'TESTE FALHOU …' = detalhe do caso que quebrou.
-- O rollback desfaz TUDO (fixtures em storage.objects/rats/pre_orcamentos/sync_tombstones,
-- view) — nada persiste no banco.
--
-- Casos:
--  1. pasta órfã (fotos sem RAT, > 1h)        → APARECE, com técnico e contagem certos
--  2. pasta com RAT correspondente            → fora
--  3. pasta com tombstone (RAT excluída)      → fora
--  4. pasta de pré-orçamento                  → fora
--  5. pasta órfã RECENTE (< 1h, sync em voo)  → fora
--  extra: autorização — sem claims (app_role() null) a view devolve 0 linhas; as asserções
--         rodam como ADMIN real E sob `set local role authenticated` (prova o caminho
--         completo do portal: grant na view + grants/RLS de storage.objects via
--         rat_anexos_admin + anti-joins sob RLS de admin).
do $$
declare
  TEC uuid; TEC_NOME text;
  R_ORFA   constant uuid := gen_random_uuid();
  R_OK     constant uuid := gen_random_uuid();
  R_TOMB   constant uuid := gen_random_uuid();
  R_PREORC constant uuid := gen_random_uuid();
  R_FRESCA constant uuid := gen_random_uuid();
  ids uuid[];
  v_n int; r record;
begin
  -- (re)cria a view com a MESMA definição da migração 0139 (replace idempotente; rollback desfaz)
  execute $v$
    create or replace view vw_alerta_rat_fotos_orfas
    with (security_invoker = true) as
    with pastas as (
      select (storage.foldername(o.name))[1] as seg_tecnico,
             (storage.foldername(o.name))[2] as seg_rat,
             count(*)          as arquivos,
             min(o.created_at) as primeiro_envio,
             max(o.created_at) as ultimo_envio
        from storage.objects o
       where o.bucket_id = 'rat-anexos'
         and array_length(storage.foldername(o.name), 1) = 2
         and (storage.foldername(o.name))[1] ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
         and (storage.foldername(o.name))[2] ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
       group by 1, 2
    )
    select p.seg_rat::uuid     as rat_client_uuid,
           p.seg_tecnico::uuid as tecnico_id,
           u.nome              as tecnico_nome,
           p.arquivos,
           p.primeiro_envio,
           p.ultimo_envio
      from pastas p
      left join usuarios u on u.id = p.seg_tecnico::uuid
     where not exists (select 1 from rats r            where r.client_uuid  = p.seg_rat::uuid)
       and not exists (select 1 from pre_orcamentos po where po.client_uuid = p.seg_rat::uuid)
       and not exists (select 1 from sync_tombstones st where st.registro_id = p.seg_rat)
       and p.ultimo_envio < now() - interval '1 hour'
       and public.app_role() = any (array['admin', 'gestor_axis'])
  $v$;

  -- um técnico real qualquer (dono das pastas-fixture)
  select u.id, u.nome into TEC, TEC_NOME from usuarios u where u.nome is not null limit 1;
  if TEC is null then raise exception 'TESTE FALHOU: nenhum usuário disponível p/ fixture'; end if;

  ids := array[R_ORFA, R_OK, R_TOMB, R_PREORC, R_FRESCA];

  -- ── fixtures no Storage (pastas {tecnico}/{uuid}/…) ──
  insert into storage.objects (bucket_id, name, created_at) values
    ('rat-anexos', TEC || '/' || R_ORFA   || '/foto-t1.jpg', now() - interval '2 hours'),
    ('rat-anexos', TEC || '/' || R_ORFA   || '/foto-t2.jpg', now() - interval '2 hours'),
    ('rat-anexos', TEC || '/' || R_OK     || '/foto-t3.jpg', now() - interval '2 hours'),
    ('rat-anexos', TEC || '/' || R_TOMB   || '/foto-t4.jpg', now() - interval '2 hours'),
    ('rat-anexos', TEC || '/' || R_PREORC || '/foto-t5.jpg', now() - interval '2 hours'),
    ('rat-anexos', TEC || '/' || R_FRESCA || '/foto-t6.jpg', now());

  -- caso 2: RAT correspondente existe (tarefa_id null: não mexe em rat_seq/status de tarefa real)
  insert into rats (id, client_uuid, cliente_nome, tecnico_id, tecnico_nome, status, data_tarefa, respostas)
  values (gen_random_uuid(), R_OK, 'ZZ TESTE 0139', TEC, TEC_NOME, 'registrado', date '2020-01-06', '{}'::jsonb);

  -- caso 3: tombstone (RAT que existiu e foi excluída — tg_tombstone grava client_uuid p/ rats)
  insert into sync_tombstones (tabela, registro_id) values ('rats', R_TOMB::text);

  -- caso 4: pasta de pré-orçamento (mesmo bucket/layout; numero é identity ALWAYS — default)
  insert into pre_orcamentos (id, client_uuid) values (gen_random_uuid(), R_PREORC);

  -- ── extra (autorização): sem claims, app_role() é null → view vazia ──
  select count(*) into v_n from vw_alerta_rat_fotos_orfas where rat_client_uuid = any(ids);
  if v_n <> 0 then raise exception 'TESTE FALHOU (autorização): sem claims a view devolveu % linhas', v_n; end if;

  -- daqui em diante, o caminho REAL do portal: role authenticated + claims de um admin
  perform set_config('request.jwt.claims',
    (select jsonb_build_object('sub', usuario_id)::text from portal_acessos
      where app_chave = 'service_report' and role_chave = 'admin' limit 1), true);
  execute 'set local role authenticated';

  -- caso 1: a órfã aparece, uma linha, técnico e contagem certos
  select count(*) into v_n from vw_alerta_rat_fotos_orfas where rat_client_uuid = any(ids);
  if v_n <> 1 then raise exception 'TESTE FALHOU: esperava exatamente 1 pasta órfã, achei %', v_n; end if;
  select * into r from vw_alerta_rat_fotos_orfas where rat_client_uuid = R_ORFA;
  if r is null then raise exception 'TESTE FALHOU (caso 1): pasta órfã não apareceu'; end if;
  if r.tecnico_id <> TEC or r.arquivos <> 2
     then raise exception 'TESTE FALHOU (caso 1): tecnico/arquivos = %/% (esperava %/2)', r.tecnico_id, r.arquivos, TEC; end if;

  -- casos 2-5: explicadas ficam fora
  if exists (select 1 from vw_alerta_rat_fotos_orfas where rat_client_uuid = R_OK)
     then raise exception 'TESTE FALHOU (caso 2): pasta com RAT apareceu como órfã'; end if;
  if exists (select 1 from vw_alerta_rat_fotos_orfas where rat_client_uuid = R_TOMB)
     then raise exception 'TESTE FALHOU (caso 3): pasta com tombstone apareceu como órfã'; end if;
  if exists (select 1 from vw_alerta_rat_fotos_orfas where rat_client_uuid = R_PREORC)
     then raise exception 'TESTE FALHOU (caso 4): pasta de pré-orçamento apareceu como órfã'; end if;
  if exists (select 1 from vw_alerta_rat_fotos_orfas where rat_client_uuid = R_FRESCA)
     then raise exception 'TESTE FALHOU (caso 5): pasta recente (<1h, sync em voo) apareceu'; end if;

  execute 'reset role';
  raise exception 'TESTES_OK: 5 casos + autorização (sem claims / authenticated+admin) passaram (rollback total — nada persistiu)';
end $$;
