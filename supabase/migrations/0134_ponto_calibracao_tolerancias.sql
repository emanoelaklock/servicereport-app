-- 0134_ponto_calibracao_tolerancias.sql
-- Calibração das tolerâncias de conciliação de almoço (SR × Tangerino).
--
-- Decisão da gestão (PR #138), a partir do estudo read-only de 58 pares válidos:
--   • início   : 5 min   (P95 observado ≈ 4,2 min)
--   • término  : 10 min  (P95 observado ≈ 7,0 min)
--   • duração  : 5 min   (P95 observado ≈ 5,0 min)
--
-- Fica em migração PRÓPRIA — separada da view (0133) de propósito: um
-- `create or replace view` futuro reseta reloptions, mas NÃO deve mexer em dado
-- de configuração. A calibração é um dado one-time; ajustes posteriores da gestão
-- entram por UPDATE em ponto_config (tela/Configurações), não por re-run desta view.
--
-- Escopo: SOMENTE ponto_config (id=1). Não toca almocos, ponto_marcacoes,
-- vínculos, cron ou qualquer outro objeto. Idempotente.

update public.ponto_config
   set tolerancia_inicio_min  = 5,
       tolerancia_termino_min = 10,
       tolerancia_duracao_min = 5
 where id = 1;

-- Garante a existência da linha singleton (não sobrescreve se já veio da 0126).
insert into public.ponto_config (id, tolerancia_inicio_min, tolerancia_termino_min, tolerancia_duracao_min)
values (1, 5, 10, 5)
on conflict (id) do nothing;
