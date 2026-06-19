-- 0066: cores de status alinhadas à PALETA DA MARCA (CLAUDE.md / card colors-brand).
--
-- Mapeamento por significado (cor = significado):
--   aguardando_execucao  -> #F7B81E (amarelo · atenção)
--   em_execucao          -> #1E8AE0 (azul · info/ação)
--   concluida            -> #179A47 (verde · ok/execução)
--   concluida_pendencia  -> #F4861F (laranja · ressalva)
--   devolvida            -> #E5403A (vermelho · erro/pendência)
--   aprovada_faturamento -> #8E45B5 (roxo)
--   em_espera_produtos   -> #D63384 (rosa)
--   faturada             -> #1B2A4A (navy da marca — inalterado)
--
-- ⚠ ACOPLAMENTO COM DEPLOY: a `cor` é usada como TEXTO (pílula da lista de Tarefas,
-- "Nº" do calendário). Amarelo/laranja como texto só ficam legíveis COM o código
-- `corTextoLegivel` (texto escuro sobre tom claro). Aplicar este UPDATE SOMENTE
-- junto/depois do deploy desse código, senão "Aguardando"/"Concluída c/ pendência"
-- ficam ilegíveis no portal já em produção.
--
-- Reversível: bloco DOWN (valores atuais) comentado no fim.
update status_tarefa set cor = case chave
  when 'aguardando_execucao'  then '#F7B81E'
  when 'em_execucao'          then '#1E8AE0'
  when 'concluida'            then '#179A47'
  when 'concluida_pendencia'  then '#F4861F'
  when 'devolvida'            then '#E5403A'
  when 'aprovada_faturamento' then '#8E45B5'
  when 'em_espera_produtos'   then '#D63384'
  when 'faturada'             then '#1B2A4A'
  else cor end
where chave in ('aguardando_execucao','em_execucao','concluida','concluida_pendencia',
                'devolvida','aprovada_faturamento','em_espera_produtos','faturada');

-- ───────────────────────── DOWN (reverter) ─────────────────────────
-- update status_tarefa set cor = case chave
--   when 'aguardando_execucao'  then '#B7791F'
--   when 'em_execucao'          then '#1C54B8'
--   when 'concluida'            then '#0E9F6E'
--   when 'concluida_pendencia'  then '#ff7300'
--   when 'devolvida'            then '#f20232'
--   when 'aprovada_faturamento' then '#0F766E'
--   when 'em_espera_produtos'   then '#ba1c78'
--   when 'faturada'             then '#1B2A4A'
--   else cor end
-- where chave in ('aguardando_execucao','em_execucao','concluida','concluida_pendencia',
--                 'devolvida','aprovada_faturamento','em_espera_produtos','faturada');
