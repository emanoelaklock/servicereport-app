-- 0109 — Usuário de TESTE vê TODAS as tarefas/RATs no app do técnico.
-- Conteúdo idêntico ao aplicado via apply_migration (MCP).
--
-- Contexto: o usuário teste.traders@tsrv.interno (QA) precisa enxergar todas as
-- RATs no app do técnico. O app não filtra no cliente — quem escopa é o RLS:
--   · tarefas  (os_tecnico_sel)          → só tarefas com vínculo em tarefa_tecnicos
--   · rats     (tarefas_tecnico_select)  → só tecnico_id = auth.uid()
--   · tarefa_tecnicos (tt_tecnico_sel)   → só as próprias linhas/tarefas
--   · rat_tecnicos (rt_tecnico_read)     → só participações próprias ou de RATs próprias
--
-- Esta migração cria uma exceção de LEITURA (somente SELECT) para o usuário de
-- teste, mantendo o papel tecnico_campo. Escrita continua a de um técnico comum
-- (insert/update/delete presos a tecnico_id/criado_por = auth.uid()).
--
-- Reverter:
--   drop policy qa_tarefas_sel on public.tarefas;
--   drop policy qa_rats_sel on public.rats;
--   drop policy qa_tt_sel on public.tarefa_tecnicos;
--   drop policy qa_rat_tecnicos_sel on public.rat_tecnicos;
--   drop function public.sr_qa_ve_tudo();

-- Um único ponto de verdade pro(s) usuário(s) de teste — trocar/adicionar aqui.
create or replace function public.sr_qa_ve_tudo()
returns boolean
language sql stable
set search_path to 'public'
as $$
  select auth.uid() in (
    '695f5e8a-c747-42ed-92ba-9fb70d21ebb6'  -- teste.traders@tsrv.interno
  );
$$;

drop policy if exists qa_tarefas_sel on public.tarefas;
create policy qa_tarefas_sel on public.tarefas
  for select using (public.sr_qa_ve_tudo());

drop policy if exists qa_rats_sel on public.rats;
create policy qa_rats_sel on public.rats
  for select using (public.sr_qa_ve_tudo());

drop policy if exists qa_tt_sel on public.tarefa_tecnicos;
create policy qa_tt_sel on public.tarefa_tecnicos
  for select using (public.sr_qa_ve_tudo());

drop policy if exists qa_rat_tecnicos_sel on public.rat_tecnicos;
create policy qa_rat_tecnicos_sel on public.rat_tecnicos
  for select using (public.sr_qa_ve_tudo());
