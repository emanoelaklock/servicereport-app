-- Técnico lê os equipamentos das tarefas em que está vinculado.
drop policy if exists te_tecnico_sel on public.tarefa_equipamentos;
create policy te_tecnico_sel on public.tarefa_equipamentos for select
  using (public.app_role() = 'tecnico_campo'
         and exists (select 1 from public.tarefa_tecnicos tt
                     where tt.tarefa_id = tarefa_equipamentos.tarefa_id and tt.tecnico_id = auth.uid()));
