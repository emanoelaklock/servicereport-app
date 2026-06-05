-- Técnico lê os anexos (tabela) das tarefas em que está vinculado.
drop policy if exists ta_tecnico_sel on public.tarefa_anexos;
create policy ta_tecnico_sel on public.tarefa_anexos for select
  using (public.app_role() = 'tecnico_campo'
         and exists (select 1 from public.tarefa_tecnicos tt
                     where tt.tarefa_id = tarefa_anexos.tarefa_id and tt.tecnico_id = auth.uid()));

-- Técnico baixa os arquivos da pasta tarefas/<id>/ das suas tarefas (storage).
drop policy if exists rat_anexos_tarefa_tecnico on storage.objects;
create policy rat_anexos_tarefa_tecnico on storage.objects for select
  using (
    bucket_id = 'rat-anexos'
    and public.app_role() = 'tecnico_campo'
    and (storage.foldername(name))[1] = 'tarefas'
    and exists (
      select 1 from public.tarefa_tecnicos tt
      where tt.tarefa_id = ((storage.foldername(name))[2])::uuid
        and tt.tecnico_id = auth.uid()
    )
  );
