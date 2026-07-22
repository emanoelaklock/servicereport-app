-- 0127 — Defesa em profundidade: REVOKE de anon nas 4 tabelas ponto_* (achado da
-- validação de grants do PR-C1, 22/07). O Supabase concede grants de tabela default a
-- anon/authenticated no schema public; o RLS já nega tudo a anon (provado: 0 linhas,
-- teste_0126), mas o padrão da casa (lição F17) remove também o grant — o RLS deixa de
-- ser a única linha de defesa. `authenticated` mantém o grant (as policies decidem).
-- SOMENTE anon; nenhuma outra role é tocada. Rollback: re-grant (sem efeito prático
-- enquanto o RLS existir).
revoke all on table public.ponto_colaboradores_map from anon;
revoke all on table public.ponto_marcacoes from anon;
revoke all on table public.ponto_sync_execucoes from anon;
revoke all on table public.ponto_config from anon;

-- Auto-verificação: aborta a transação se algum grant de anon sobreviver.
do $$
declare v_n int;
begin
  select count(*) into v_n from information_schema.table_privileges
   where table_schema = 'public' and grantee = 'anon'
     and table_name in ('ponto_colaboradores_map','ponto_marcacoes','ponto_sync_execucoes','ponto_config');
  if v_n <> 0 then
    raise exception '0127: anon ainda tem % grant(s) nas tabelas ponto_*', v_n;
  end if;
end $$;
