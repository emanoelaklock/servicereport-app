-- Exclusão em cascata (admin/gestor). SECURITY DEFINER para tratar as FKs NO ACTION
-- (materiais/sync_eventos por rat; rats/orcamentos por tarefa); demais têm CASCADE.

create or replace function public.admin_excluir_rat(p_rat uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() not in ('admin','gestor_axis') then
    raise exception 'sem permissão';
  end if;
  delete from public.materiais where rat_id = p_rat;
  delete from public.sync_eventos where rat_id = p_rat;
  delete from public.rats where id = p_rat;  -- relatorio_fotos têm cascade
end $$;

create or replace function public.admin_excluir_tarefa(p_tarefa uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if public.app_role() not in ('admin','gestor_axis') then
    raise exception 'sem permissão';
  end if;
  for r in select id from public.rats where tarefa_id = p_tarefa loop
    delete from public.materiais where rat_id = r;
    delete from public.sync_eventos where rat_id = r;
    delete from public.rats where id = r;
  end loop;
  update public.orcamentos set tarefa_id = null where tarefa_id = p_tarefa;
  delete from public.tarefas where id = p_tarefa;  -- tarefa_materiais/tecnicos/anexos/equipamentos têm cascade
end $$;

revoke all on function public.admin_excluir_rat(uuid) from public, anon;
revoke all on function public.admin_excluir_tarefa(uuid) from public, anon;
grant execute on function public.admin_excluir_rat(uuid) to authenticated;
grant execute on function public.admin_excluir_tarefa(uuid) to authenticated;
