-- 0113 — F1.1: referência externa na origem do atendimento (caso Auvo).
-- Motivo (caso real: Tarefa 04748): a origem do atendimento pode estar num sistema
-- anterior (Auvo) — não existe tarefa no SR para vincular, e a 0111 exigia
-- tarefa_origem_id para qualquer tipo relacionado (ORIGEM_SEM_VINCULO).
--
-- O que muda:
--   · tarefas.origem_ref_externa text — referência textual (ex.: 'Auvo 7534999/4')
--   · regra central: tipos relacionados exigem tarefa do SR OU referência externa,
--     MUTUAMENTE EXCLUSIVAS (ref externa só quando NÃO há tarefa no SR);
--     nova_solicitacao não aceita nenhuma das duas
--   · auditoria: colunas aditivas ref_externa_old/new em tarefa_origem_eventos
--     (tabela imutável — ALTER aditivo não toca linhas) + evento em alteração
--   · alterar_origem_tarefa: DROP + CREATE com p_ref_externa default null
--     ('create or replace' não adiciona parâmetro; default preserva chamadas atuais)
--   · criar_tarefa_app NÃO muda (app do técnico não aponta origem; o portal
--     insere direto em tarefas e já passa pelo trigger)
--
-- Guarda de escopo: nenhuma view/RPC de desempenho é tocada; a coluna nova não
-- alimenta métrica alguma.
--
-- Rollback: recriar tarefas_origem_valida/tarefas_origem_audita da 0111; recriar
-- triggers com o OF antigo; drop function alterar_origem_tarefa(uuid,text,uuid,uuid,text,text)
-- e recriar a de 5 parâmetros (0111); alter table tarefas drop column origem_ref_externa;
-- (colunas de auditoria podem ficar — aditivas e nulas).

-- ─────────────────────────── 1 · Coluna nova ───────────────────────────
alter table public.tarefas
  add column if not exists origem_ref_externa text;

alter table public.tarefa_origem_eventos
  add column if not exists ref_externa_old text,
  add column if not exists ref_externa_new text;

-- ─────────────────── 2 · Validação central (substitui a da 0111) ───────────────────
create or replace function public.tarefas_origem_valida() returns trigger
language plpgsql as $$
declare v_next uuid; v_prof int := 0; v_rat_tarefa uuid; v_motivo text; v_cli_orig uuid;
begin
  v_motivo := nullif(trim(coalesce(current_setting('sr.origem_motivo', true), '')), '');
  new.origem_ref_externa := nullif(trim(coalesce(new.origem_ref_externa, '')), '');

  if new.origem_ref_externa is not null and length(new.origem_ref_externa) > 120 then
    raise exception 'ORIGEM_REF_LONGA: referencia externa passa de 120 caracteres';
  end if;

  -- alteração posterior exige justificativa (mensagem certa para UPDATE fora da RPC)
  if tg_op = 'UPDATE' and (old.origem_tipo is distinct from new.origem_tipo
      or old.tarefa_origem_id is distinct from new.tarefa_origem_id
      or old.rat_origem_id is distinct from new.rat_origem_id
      or old.origem_ref_externa is distinct from new.origem_ref_externa) then
    if v_motivo is null then
      raise exception 'ORIGEM_SEM_JUSTIFICATIVA: alteracao de origem/vinculo exige justificativa (use alterar_origem_tarefa)';
    end if;
  end if;

  if new.origem_tipo is null or new.origem_tipo not in
     ('nova_solicitacao','continuacao_planejada','retorno_relacionado','suspeita_retrabalho') then
    raise exception 'ORIGEM_TIPO_INVALIDO: %', new.origem_tipo;
  end if;

  if new.origem_tipo = 'nova_solicitacao' then
    if new.tarefa_origem_id is not null or new.rat_origem_id is not null
       or new.origem_ref_externa is not null then
      raise exception 'ORIGEM_INCONSISTENTE: nova_solicitacao nao leva vinculo nem referencia externa';
    end if;
  else
    -- referência externa é para atendimento SEM tarefa no SR — nunca junto do vínculo
    if new.tarefa_origem_id is not null and new.origem_ref_externa is not null then
      raise exception 'ORIGEM_REF_COM_VINCULO: use a tarefa de origem OU a referencia externa, nao ambas';
    end if;
    if new.tarefa_origem_id is null and new.origem_ref_externa is null and v_motivo is null then
      -- vínculo nulo só é aceito em mudança de sistema justificada (origem excluída)
      raise exception 'ORIGEM_SEM_VINCULO: % exige tarefa de origem ou referencia externa', new.origem_tipo;
    end if;
  end if;

  if new.tarefa_origem_id = new.id then
    raise exception 'ORIGEM_AUTORREFERENCIA: a tarefa nao pode ser origem de si mesma';
  end if;

  if new.tarefa_origem_id is not null then
    select t.cliente_id into v_cli_orig from public.tarefas t where t.id = new.tarefa_origem_id;
    if v_cli_orig is distinct from new.cliente_id then
      raise exception 'ORIGEM_CLIENTE_DIVERGENTE: a tarefa de origem e de outro cliente';
    end if;
  end if;

  if new.rat_origem_id is not null then
    select r.tarefa_id into v_rat_tarefa from public.rats r where r.id = new.rat_origem_id;
    if v_rat_tarefa is null or v_rat_tarefa is distinct from new.tarefa_origem_id then
      raise exception 'RAT_ORIGEM_NAO_PERTENCE: a RAT de origem nao e da tarefa de origem';
    end if;
  end if;

  v_next := new.tarefa_origem_id;
  while v_next is not null loop
    if v_next = new.id then raise exception 'ORIGEM_CICLO: cadeia de origem voltaria a esta tarefa'; end if;
    v_prof := v_prof + 1;
    if v_prof > 64 then raise exception 'ORIGEM_CADEIA_PROFUNDA: mais de 64 niveis'; end if;
    select t.tarefa_origem_id into v_next from public.tarefas t where t.id = v_next;
  end loop;

  return new;
end $$;
drop trigger if exists trg_tarefas_origem_valida on public.tarefas;
create trigger trg_tarefas_origem_valida
  before insert or update of origem_tipo, tarefa_origem_id, rat_origem_id, cliente_id, origem_ref_externa
  on public.tarefas for each row execute function public.tarefas_origem_valida();

-- ─────────────── 3 · Auditoria automática (substitui a da 0111) ───────────────
create or replace function public.tarefas_origem_audita() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_motivo text; v_evento text;
begin
  v_motivo := nullif(trim(coalesce(current_setting('sr.origem_motivo', true), '')), '');
  v_evento := nullif(trim(coalesce(current_setting('sr.origem_evento', true), '')), '');
  if tg_op = 'INSERT' then
    if new.origem_tipo <> 'nova_solicitacao' or new.tarefa_origem_id is not null
       or new.origem_ref_externa is not null then
      insert into public.tarefa_origem_eventos
        (tarefa_id, tarefa_numero, evento, origem_tipo_new, tarefa_origem_new, rat_origem_new,
         ref_externa_new, justificativa)
      values (new.id, new.numero, coalesce(v_evento, 'origem_definida'),
              new.origem_tipo, new.tarefa_origem_id, new.rat_origem_id,
              new.origem_ref_externa, v_motivo);
    end if;
  elsif (old.origem_tipo is distinct from new.origem_tipo
      or old.tarefa_origem_id is distinct from new.tarefa_origem_id
      or old.rat_origem_id is distinct from new.rat_origem_id
      or old.origem_ref_externa is distinct from new.origem_ref_externa) then
    insert into public.tarefa_origem_eventos
      (tarefa_id, tarefa_numero, evento, origem_tipo_old, origem_tipo_new,
       tarefa_origem_old, tarefa_origem_new, rat_origem_old, rat_origem_new,
       ref_externa_old, ref_externa_new, justificativa)
    values (new.id, new.numero, coalesce(v_evento, 'origem_alterada'),
            old.origem_tipo, new.origem_tipo, old.tarefa_origem_id, new.tarefa_origem_id,
            old.rat_origem_id, new.rat_origem_id,
            old.origem_ref_externa, new.origem_ref_externa, v_motivo);
  end if;
  return null;
end $$;
drop trigger if exists trg_tarefas_origem_audita on public.tarefas;
create trigger trg_tarefas_origem_audita
  after insert or update of origem_tipo, tarefa_origem_id, rat_origem_id, origem_ref_externa
  on public.tarefas for each row execute function public.tarefas_origem_audita();

-- ───── 4 · alterar_origem_tarefa — drop + create (parâmetro novo com default) ─────
drop function if exists public.alterar_origem_tarefa(uuid,text,uuid,uuid,text);
create function public.alterar_origem_tarefa(
  p_tarefa uuid, p_origem_tipo text, p_tarefa_origem uuid, p_rat_origem uuid,
  p_justificativa text, p_ref_externa text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role text; v_n int; v_ref text;
begin
  v_role := app_role();
  if v_role is null or v_role not in ('admin','gestor_axis') then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_justificativa), '')) < 5 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: informe o motivo da alteracao (min. 5 caracteres)';
  end if;
  v_ref := nullif(trim(coalesce(p_ref_externa, '')), '');
  -- consistência estrita no caminho de usuário (o trigger repete tudo; aqui a
  -- mensagem sai antes do UPDATE): relacionado exige tarefa OU referência externa
  if p_origem_tipo <> 'nova_solicitacao' and p_tarefa_origem is null and v_ref is null then
    raise exception 'ORIGEM_SEM_VINCULO: % exige tarefa de origem ou referencia externa', p_origem_tipo;
  end if;
  if p_tarefa_origem is not null and v_ref is not null then
    raise exception 'ORIGEM_REF_COM_VINCULO: use a tarefa de origem OU a referencia externa, nao ambas';
  end if;
  perform set_config('sr.origem_motivo', trim(p_justificativa), true);
  update public.tarefas
     set origem_tipo = p_origem_tipo, tarefa_origem_id = p_tarefa_origem,
         rat_origem_id = p_rat_origem, origem_ref_externa = v_ref
   where id = p_tarefa;
  get diagnostics v_n = row_count;   -- PERFORM abaixo sobrescreveria FOUND
  perform set_config('sr.origem_motivo', '', true);
  if v_n = 0 then raise exception 'TAREFA_INEXISTENTE'; end if;
end $$;
revoke all on function public.alterar_origem_tarefa(uuid,text,uuid,uuid,text,text) from public;
grant execute on function public.alterar_origem_tarefa(uuid,text,uuid,uuid,text,text) to authenticated;
