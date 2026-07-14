-- 0106 — Novo motivo de edição de RAT: "Correção de texto" (correcao_texto)
-- Ajuste cosmético (typo, redação) feito pela gestão. REGRA: este motivo NÃO conta
-- em nenhuma métrica de desempenho/assertividade do técnico — nem no índice de
-- assertividade (§13, futuro) nem em qualquer lente sobre rat_edicoes; filtrar
-- motivo <> 'correcao_texto' ao construí-las.
alter table rat_edicoes drop constraint rat_edicoes_motivo_chk;
alter table rat_edicoes add constraint rat_edicoes_motivo_chk
  check (motivo = any (array['esquecimento_tecnico','completacao','mudanca_processo',
                             'pedido_cliente','correcao_texto','outro','sync_app']));
