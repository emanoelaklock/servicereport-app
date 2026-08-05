-- Teste da envio_preso_revisoes (migração 0141) — SEGURO EM PRODUÇÃO.
-- Roda inteiro num único DO $$ … $$ e SEMPRE termina em RAISE EXCEPTION:
--  · 'TESTES_OK …'  = passou (o erro é só o veículo do rollback — nada persiste);
--  · 'TESTE FALHOU …' = detalhe do caso que quebrou.
--
-- Casos (autorização — o dado é trivial, o risco é o gate; molde do teste_0140):
--  1. estrutura: RLS ligado, anon sem privilégio
--  2. admin (role authenticated + claims reais) INSERE e LÊ a própria revisão
--  3. técnico (claims reais de tecnico_campo) NÃO lê (0 linhas) e NÃO insere (42501)
do $$
declare
  RC constant uuid := '00000000-0000-4000-8000-000000000141';
  v_n int;
  v_tec uuid;
begin
  if not exists (select 1 from pg_class c where c.oid = 'public.envio_preso_revisoes'::regclass and c.relrowsecurity)
     then raise exception 'TESTE FALHOU (caso 1): RLS desligado'; end if;
  if has_table_privilege('anon', 'public.envio_preso_revisoes', 'select')
     then raise exception 'TESTE FALHOU (caso 1): anon com SELECT'; end if;

  perform set_config('request.jwt.claims',
    (select jsonb_build_object('sub', usuario_id)::text from portal_acessos
      where app_chave = 'service_report' and role_chave = 'admin' limit 1), true);
  execute 'set local role authenticated';
  insert into envio_preso_revisoes (rat_client_uuid, revisado_nome, nota)
  values (RC, 'ZZ TESTE 0141', 'fixture');
  select count(*) into v_n from envio_preso_revisoes where rat_client_uuid = RC;
  if v_n <> 1 then raise exception 'TESTE FALHOU (caso 2): admin não leu a própria revisão (%)', v_n; end if;
  execute 'reset role';

  select tt.tecnico_id into v_tec from tarefa_tecnicos tt limit 1;
  if v_tec is null then raise exception 'TESTE FALHOU (caso 3): sem técnico p/ fixture'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_tec)::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from envio_preso_revisoes where rat_client_uuid = RC;
  if v_n <> 0 then raise exception 'TESTE FALHOU (caso 3): técnico leu % revisão(ões)', v_n; end if;
  begin
    insert into envio_preso_revisoes (rat_client_uuid) values ('00000000-0000-4000-8000-000000000142');
    raise exception 'TESTE FALHOU (caso 3): técnico conseguiu inserir revisão';
  exception when insufficient_privilege then null;   -- 42501 esperado (RLS with check)
  end;
  execute 'reset role';

  raise exception 'TESTES_OK: estrutura + admin insere/lê + técnico bloqueado (rollback total — nada persistiu)';
end $$;
