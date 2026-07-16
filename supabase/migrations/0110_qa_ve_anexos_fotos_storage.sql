-- 0110 — Completa a exceção do usuário de TESTE (0109): anexos, fotos e storage.
-- Conteúdo idêntico ao aplicado via apply_migration (MCP).
--
-- A 0109 liberou LEITURA de tarefas/rats/tarefa_tecnicos/rat_tecnicos pro usuário
-- de QA (sr_qa_ve_tudo()), mas os arquivos ligados a elas continuavam invisíveis:
--   · tarefa_anexos  (ta_tecnico_sel)           → exige vínculo em tarefa_tecnicos
--   · relatorio_fotos (relatorio_fotos_tecnico_own) → exige ser dono da RAT
--   · storage rat-anexos (rat_anexos_tarefa_tecnico / rat_anexos_tecnico)
--       → exige vínculo (tarefas/<id>/...) ou pasta própria (<tecnico_id>/...)
-- Resultado: no app do técnico, as fotos/anexos da tarefa e das RATs de outros
-- técnicos não apareciam pro usuário de teste.
--
-- Mesma natureza da 0109: somente SELECT; escrita segue a de um técnico comum.
-- Obs.: o SELECT no bucket rat-anexos é o bucket inteiro (inclui orcamentos/ e
-- assinaturas/fotos de RAT em <tecnico_id>/...) — necessário pra signed URLs.
--
-- Reverter:
--   drop policy qa_tarefa_anexos_sel on public.tarefa_anexos;
--   drop policy qa_relatorio_fotos_sel on public.relatorio_fotos;
--   drop policy qa_rat_anexos_sel on storage.objects;

drop policy if exists qa_tarefa_anexos_sel on public.tarefa_anexos;
create policy qa_tarefa_anexos_sel on public.tarefa_anexos
  for select using (public.sr_qa_ve_tudo());

drop policy if exists qa_relatorio_fotos_sel on public.relatorio_fotos;
create policy qa_relatorio_fotos_sel on public.relatorio_fotos
  for select using (public.sr_qa_ve_tudo());

drop policy if exists qa_rat_anexos_sel on storage.objects;
create policy qa_rat_anexos_sel on storage.objects
  for select using (bucket_id = 'rat-anexos' and public.sr_qa_ve_tudo());
