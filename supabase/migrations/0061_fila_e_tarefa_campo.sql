-- Pacote FLUXO DO TÉCNICO — Commit 1 (Home/Agenda + Fila + Nova tarefa em campo)
-- · tarefas ganha local (texto) e previsao_dias (multi-dia: "previsto ~N")
-- · fila_tarefas(): tarefas ABERTAS (sem responsável) que o técnico pode pegar
--   (a RLS normal só mostra as tarefas DELE — a fila precisa de SECURITY DEFINER)
-- · pegar_tarefa(): o técnico se atribui a uma tarefa aberta (vira responsável)

alter table public.tarefas
  add column if not exists local_servico text,
  add column if not exists previsao_dias int;

-- Fila: só colunas necessárias ao app do técnico (NÃO expõe valor_hora/modalidade — §12).
create or replace function public.fila_tarefas()
returns table (
  id uuid, numero bigint, cliente_id uuid, status text,
  data_agendada date, tipo_servico_id uuid, orientacao text,
  local_servico text, previsao_dias int
)
language sql stable security definer set search_path = public as $$
  select t.id, t.numero, t.cliente_id, t.status, t.data_agendada,
         t.tipo_servico_id, t.orientacao, t.local_servico, t.previsao_dias
  from public.tarefas t
  where public.app_role() = 'tecnico_campo'
    and not exists (select 1 from public.tarefa_tecnicos tt where tt.tarefa_id = t.id)
    and t.status in ('aguardando_execucao','em_execucao','devolvida')
  order by t.data_agendada asc nulls last, t.numero desc
  limit 100;
$$;

-- Pegar: o técnico vira responsável de uma tarefa SEM responsável (idempotente p/ ele mesmo).
-- A promoção da tarefa p/ "em_execucao" segue acontecendo no insert da 1ª RAT (trigger 0053).
create or replace function public.pegar_tarefa(p_tarefa uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() <> 'tecnico_campo' then
    raise exception 'apenas técnico de campo pode pegar tarefa';
  end if;
  if exists (select 1 from public.tarefa_tecnicos
             where tarefa_id = p_tarefa and tecnico_id <> auth.uid()) then
    raise exception 'tarefa já tem responsável';
  end if;
  insert into public.tarefa_tecnicos (tarefa_id, tecnico_id)
  values (p_tarefa, auth.uid())
  on conflict do nothing;
end $$;

grant execute on function public.fila_tarefas() to authenticated;
grant execute on function public.pegar_tarefa(uuid) to authenticated;

-- "Nova tarefa em campo" agora carrega o local opcional (p_local). Recria a RPC com o
-- parâmetro no fim (defaulted) — chamadas antigas com 7 args seguem válidas.
drop function if exists public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[]);
create or replace function public.criar_tarefa_app(
  p_id uuid, p_cliente_id uuid, p_status text, p_tipo_servico_id uuid,
  p_orientacao text, p_data_agendada date, p_tecnicos uuid[], p_local text default null
) returns void language plpgsql security definer set search_path to 'public' as $function$
declare r text; tid uuid;
begin
  r := app_role();
  if r is null or r not in ('tecnico_campo','admin','gestor_axis') then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  insert into public.tarefas (id, cliente_id, status, tipo_servico_id, orientacao, data_agendada, local_servico, criado_por)
  values (p_id, p_cliente_id, coalesce(p_status, 'aguardando_execucao'), p_tipo_servico_id, p_orientacao, p_data_agendada, p_local, auth.uid())
  on conflict (id) do nothing;
  if p_tecnicos is not null then
    foreach tid in array p_tecnicos loop
      insert into public.tarefa_tecnicos (tarefa_id, tecnico_id) values (p_id, tid)
      on conflict (tarefa_id, tecnico_id) do nothing;
    end loop;
  end if;
end $function$;
grant execute on function public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[],text) to authenticated;
