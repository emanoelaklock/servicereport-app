-- Fotos do orçamento: reusa relatorio_fotos (+ orcamento_id) e o bucket privado
-- rat-anexos sob a pasta orcamentos/. Office (admin/gestor/comercial) gerencia.
alter table public.relatorio_fotos add column if not exists orcamento_id uuid references public.orcamentos(id) on delete cascade;
create index if not exists idx_relatorio_fotos_orcamento on public.relatorio_fotos(orcamento_id);

drop policy if exists relatorio_fotos_orcamento_office on public.relatorio_fotos;
create policy relatorio_fotos_orcamento_office on public.relatorio_fotos for all to authenticated
  using (app_role() = any (array['admin','gestor_axis','comercial']) and orcamento_id is not null)
  with check (app_role() = any (array['admin','gestor_axis','comercial']) and orcamento_id is not null);

drop policy if exists rat_anexos_orcamento_office on storage.objects;
create policy rat_anexos_orcamento_office on storage.objects for all to authenticated
  using (bucket_id = 'rat-anexos' and app_role() = any (array['admin','gestor_axis','comercial']) and (storage.foldername(name))[1] = 'orcamentos')
  with check (bucket_id = 'rat-anexos' and app_role() = any (array['admin','gestor_axis','comercial']) and (storage.foldername(name))[1] = 'orcamentos');
