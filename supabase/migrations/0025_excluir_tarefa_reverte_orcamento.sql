-- Ao excluir uma Tarefa vinculada a um orçamento, o orçamento volta para
-- "aguardando aprovação" (status rascunho) — reaprovar cria uma nova Tarefa.
create or replace function public.admin_excluir_tarefa(p_tarefa uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r uuid; v_orc uuid;
begin
  if public.app_role() not in ('admin','gestor_axis') then
    raise exception 'sem permissão';
  end if;
  select orcamento_id into v_orc from public.tarefas where id = p_tarefa;
  for r in select id from public.rats where tarefa_id = p_tarefa loop
    delete from public.materiais where rat_id = r;
    delete from public.sync_eventos where rat_id = r;
    delete from public.rats where id = r;
  end loop;
  update public.orcamentos set tarefa_id = null where tarefa_id = p_tarefa;
  delete from public.tarefas where id = p_tarefa;  -- tarefa_materiais/tecnicos/anexos/equipamentos têm cascade
  if v_orc is not null then
    update public.orcamentos set status = 'rascunho', data_resposta = null where id = v_orc;
  end if;
end $$;

-- Conserta orçamentos já órfãos (aprovados sem tarefa) — volta p/ aguardando aprovação.
update public.orcamentos o
set status = 'rascunho', data_resposta = null
where o.status = 'aprovado'
  and not exists (select 1 from public.tarefas t where t.orcamento_id = o.id);
