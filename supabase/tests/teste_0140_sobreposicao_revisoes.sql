-- Teste da sobreposicao_revisoes (migração 0140) — SEGURO EM PRODUÇÃO.
-- Roda inteiro num único DO $$ … $$ e SEMPRE termina em RAISE EXCEPTION:
--  · 'TESTES_OK …'  = passou (o erro é só o veículo do rollback — nada persiste);
--  · 'TESTE FALHOU …' = detalhe do caso que quebrou.
--
-- Casos (autorização — o dado em si é trivial, o risco é o gate):
--  1. estrutura: RLS ligado, anon sem privilégio, check do par ordenado funciona
--  2. admin (role authenticated + claims reais) INSERE e LÊ a própria revisão
--  3. técnico (claims reais de tecnico_campo) NÃO lê (0 linhas) e NÃO insere (42501)
do $$
declare
  RA constant uuid := '00000000-0000-4000-8000-000000000001';
  RB constant uuid := '00000000-0000-4000-8000-000000000002';
  v_n int;
  v_tec uuid;
begin
  -- caso 1: estrutura
  if not exists (select 1 from pg_class c where c.oid = 'public.sobreposicao_revisoes'::regclass and c.relrowsecurity)
     then raise exception 'TESTE FALHOU (caso 1): RLS desligado'; end if;
  if has_table_privilege('anon', 'public.sobreposicao_revisoes', 'select')
     then raise exception 'TESTE FALHOU (caso 1): anon com SELECT'; end if;
  begin
    insert into sobreposicao_revisoes (rat_menor, rat_maior) values (RB, RA);   -- invertido
    raise exception 'TESTE FALHOU (caso 1): check do par ordenado não barrou (maior, menor)';
  exception when check_violation then null;
  end;

  -- caso 2: admin real via caminho do portal
  perform set_config('request.jwt.claims',
    (select jsonb_build_object('sub', usuario_id)::text from portal_acessos
      where app_chave = 'service_report' and role_chave = 'admin' limit 1), true);
  execute 'set local role authenticated';
  insert into sobreposicao_revisoes (rat_menor, rat_maior, dia, conflito_inicio, conflito_fim, revisado_nome)
  values (RA, RB, date '2020-01-06', time '10:00', time '11:00', 'ZZ TESTE 0140');
  select count(*) into v_n from sobreposicao_revisoes where rat_menor = RA and rat_maior = RB;
  if v_n <> 1 then raise exception 'TESTE FALHOU (caso 2): admin não leu a própria revisão (%)', v_n; end if;
  execute 'reset role';

  -- caso 3: técnico de campo real — não lê, não escreve
  select tt.tecnico_id into v_tec from tarefa_tecnicos tt limit 1;
  if v_tec is null then raise exception 'TESTE FALHOU (caso 3): sem técnico p/ fixture'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_tec)::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from sobreposicao_revisoes where rat_menor = RA and rat_maior = RB;
  if v_n <> 0 then raise exception 'TESTE FALHOU (caso 3): técnico leu % revisão(ões)', v_n; end if;
  begin
    insert into sobreposicao_revisoes (rat_menor, rat_maior) values (RA, RB);
    raise exception 'TESTE FALHOU (caso 3): técnico conseguiu inserir revisão';
  exception when insufficient_privilege then null;   -- 42501 esperado (RLS with check)
  end;
  execute 'reset role';

  raise exception 'TESTES_OK: estrutura + admin insere/lê + técnico bloqueado (rollback total — nada persistiu)';
end $$;
