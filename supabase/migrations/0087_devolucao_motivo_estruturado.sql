-- 0087: motivo de devolução ESTRUTURADO (categorias + detalhe) — Fase A.
-- Hoje a devolução da TAREFA grava só um texto concatenado em tarefas.motivo_devolucao.
-- Esta migração é ADITIVA: mantém esse texto (renderizado) p/ back-compat e fallback do app,
-- e adiciona as CATEGORIAS (códigos) + o DETALHE livre — base do índice de assertividade e
-- do que as Fases B/C/D vão reusar.
--
-- SEM CHECK dos códigos de propósito: a Fase B (devolução por RAT) precisa adicionar códigos
-- sem nova migração, e a validação do conjunto válido vive no portal (mais fácil de evoluir).
-- Colunas nullable, nada reescrito → zero risco de perda de histórico.

alter table public.tarefas
  add column if not exists motivo_devolucao_cats    text[],   -- ex.: {'rat_nao_preenchida','outro'}
  add column if not exists motivo_devolucao_detalhe text;     -- texto livre (obrigatório qdo 'outro')

-- Códigos previstos (REFERÊNCIA; não há CHECK):
--   por Tarefa: material_divergente · rat_nao_preenchida · outro
--   por RAT (no interim ficam disponíveis no nível Tarefa — Opção 2; migram p/ o nível RAT na Fase B):
--     preenchimento_incompleto · produto_incorreto · pausa_horario_incorreto ·
--     descricao_insuficiente · pendencia_nao_registrada
-- tarefas.motivo_devolucao (texto) segue populado com o RENDERIZADO (labels + detalhe) p/ display
-- e fallback dos registros anteriores a esta migração.

-- DOWN:
-- alter table public.tarefas
--   drop column if exists motivo_devolucao_cats,
--   drop column if exists motivo_devolucao_detalhe;
