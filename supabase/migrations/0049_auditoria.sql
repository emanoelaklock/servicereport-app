-- Trilha de auditoria (quem fez o quê, quando) — base da Linha do tempo da tarefa.
-- Gatilhos em tarefas/rats/tarefa_tecnicos gravam eventos com ator = auth.uid().
-- Depende de salvar responsáveis por diferença (sem delete-all) para não gerar ruído.
-- Conteúdo idêntico ao aplicado via apply_migration 0049_auditoria.
create table if not exists public.auditoria (
  id          uuid primary key default gen_random_uuid(),
  tarefa_id   uuid,
  entidade    text not null,
  entidade_id uuid,
  acao        text not null,
  detalhe     text,
  ator        uuid,
  ator_nome   text,
  em          timestamptz not null default now()
);
create index if not exists auditoria_tarefa_em_idx on public.auditoria(tarefa_id, em);

alter table public.auditoria enable row level security;
drop policy if exists auditoria_sel on public.auditoria;
create policy auditoria_sel on public.auditoria for select
  using (public.app_role() in ('admin','gestor_axis'));

create or replace function public._ator_nome(uid uuid) returns text
  language sql security definer stable set search_path = public as $$
  select nome from public.usuarios where id = uid
$$;
create or replace function public._status_label(chave text) returns text
  language sql security definer stable set search_path = public as $$
  select coalesce((select label from public.status_tarefa where chave = $1), $1)
$$;
create or replace function public._rat_sit(s text) returns text
  language sql immutable as $$
  select case s
    when 'em_andamento' then 'Em andamento'
    when 'concluida' then 'Concluída'
    when 'concluida_pendencia' then 'Concluída c/ pendência'
    else coalesce(s, '—') end
$$;

create or replace function public.audit_tarefas() returns trigger
  language plpgsql security definer set search_path = public as $$
declare a uuid := auth.uid();
begin
  if (tg_op = 'INSERT') then
    insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
    values (new.id,'tarefa',new.id,'criada','Tarefa criada',coalesce(a,new.criado_por),public._ator_nome(coalesce(a,new.criado_por)));
    return new;
  elsif (tg_op = 'UPDATE') then
    if (new.status is distinct from old.status) then
      insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
      values (new.id,'tarefa',new.id,'status_alterado',
        public._status_label(old.status)||' → '||public._status_label(new.status),a,public._ator_nome(a));
    end if;
    if (coalesce(new.faturado,false) is distinct from coalesce(old.faturado,false)) then
      insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
      values (new.id,'tarefa',new.id,
        case when new.faturado then 'faturada' else 'faturamento_desfeito' end,
        case when new.faturado then 'Tarefa faturada'||coalesce(' · Nota '||new.numero_nota,'') else 'Faturamento desfeito' end,
        a,public._ator_nome(a));
    end if;
    return new;
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_tarefas on public.tarefas;
create trigger trg_audit_tarefas after insert or update on public.tarefas
  for each row execute function public.audit_tarefas();

create or replace function public.audit_rats() returns trigger
  language plpgsql security definer set search_path = public as $$
declare a uuid := auth.uid();
begin
  if (tg_op = 'INSERT') then
    insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
    values (new.tarefa_id,'rat',new.id,'rat_criada','RAT criada',coalesce(a,new.tecnico_id),public._ator_nome(coalesce(a,new.tecnico_id)));
    return new;
  elsif (tg_op = 'UPDATE') then
    if (new.status is distinct from old.status) then
      insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
      values (new.tarefa_id,'rat',new.id,'rat_status',
        'RAT '||public._rat_sit(new.status),coalesce(a,new.tecnico_id),public._ator_nome(coalesce(a,new.tecnico_id)));
    end if;
    return new;
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_rats on public.rats;
create trigger trg_audit_rats after insert or update on public.rats
  for each row execute function public.audit_rats();

create or replace function public.audit_tarefa_tecnicos() returns trigger
  language plpgsql security definer set search_path = public as $$
declare a uuid := auth.uid();
begin
  if (tg_op = 'INSERT') then
    insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
    values (new.tarefa_id,'responsavel',new.tecnico_id,'tecnico_atribuido','Responsável atribuído: '||coalesce(public._ator_nome(new.tecnico_id),'—'),a,public._ator_nome(a));
    return new;
  elsif (tg_op = 'DELETE') then
    insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
    values (old.tarefa_id,'responsavel',old.tecnico_id,'tecnico_removido','Responsável removido: '||coalesce(public._ator_nome(old.tecnico_id),'—'),a,public._ator_nome(a));
    return old;
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_tarefa_tecnicos on public.tarefa_tecnicos;
create trigger trg_audit_tarefa_tecnicos after insert or delete on public.tarefa_tecnicos
  for each row execute function public.audit_tarefa_tecnicos();
