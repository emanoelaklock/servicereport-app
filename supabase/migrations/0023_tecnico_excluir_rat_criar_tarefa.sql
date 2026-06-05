-- Técnico pode EXCLUIR as próprias RATs (materiais/fotos já tinham ALL do dono).
drop policy if exists rats_tecnico_del on public.rats;
create policy rats_tecnico_del on public.rats for delete
  using (public.app_role() = 'tecnico_campo' and tecnico_id = auth.uid());

-- Técnico pode CRIAR Tarefa (atendimento não pré-agendado), como criador.
drop policy if exists os_tecnico_ins on public.tarefas;
create policy os_tecnico_ins on public.tarefas for insert
  with check (public.app_role() = 'tecnico_campo' and criado_por = auth.uid());

-- Técnico pode se AUTO-ATRIBUIR à tarefa.
drop policy if exists tt_tecnico_ins on public.tarefa_tecnicos;
create policy tt_tecnico_ins on public.tarefa_tecnicos for insert
  with check (public.app_role() = 'tecnico_campo' and tecnico_id = auth.uid());
