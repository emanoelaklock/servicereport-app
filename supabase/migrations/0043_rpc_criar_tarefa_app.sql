-- Cria tarefa do app (offline) de forma robusta: SECURITY DEFINER, criado_por = auth.uid().
-- Evita as sutilezas de RLS (upsert exige UPDATE; criado_por nulo etc.) que faziam
-- a tarefa offline falhar com "new row violates row-level security policy".
create or replace function public.criar_tarefa_app(
  p_id              uuid,
  p_cliente_id      uuid,
  p_status          text,
  p_tipo_servico_id uuid,
  p_orientacao      text,
  p_data_agendada   date,
  p_tecnicos        uuid[]
) returns void
language plpgsql security definer set search_path = public as $$
declare r text; tid uuid;
begin
  r := app_role();
  if r is null or r not in ('tecnico_campo','admin','gestor_axis') then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  insert into public.tarefas (id, cliente_id, status, tipo_servico_id, orientacao, data_agendada, criado_por)
  values (p_id, p_cliente_id, coalesce(p_status, 'aguardando_execucao'), p_tipo_servico_id, p_orientacao, p_data_agendada, auth.uid())
  on conflict (id) do nothing;
  if p_tecnicos is not null then
    foreach tid in array p_tecnicos loop
      insert into public.tarefa_tecnicos (tarefa_id, tecnico_id) values (p_id, tid)
      on conflict (tarefa_id, tecnico_id) do nothing;
    end loop;
  end if;
end $$;

revoke all on function public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[]) from public;
grant execute on function public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[]) to authenticated;
