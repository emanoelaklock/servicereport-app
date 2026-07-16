-- 0111 — F1: origem estruturada dos atendimentos (fundacional).
-- NÃO aplicada em produção neste commit: validada em transação com ROLLBACK
-- (DDL é transacional no Postgres). Aplicar via MCP quando o pacote for aprovado.
--
-- O que cria:
--   · tarefas.origem_tipo / tarefa_origem_id / rat_origem_id (aditivas, default seguro)
--   · tarefa_origem_eventos — auditoria IMUTÁVEL, SEM FK (histórico sobrevive à
--     exclusão da tarefa e não bloqueia o delete; decisão explícita — plano §2)
--   · validação central: vocabulário, consistência, pertencimento da RAT,
--     autorreferência, ciclos e justificativa obrigatória em alteração posterior
--   · criar_tarefa_app: DROP + CREATE (assinatura nova com defaults) — 'create or
--     replace' não adiciona parâmetro, e overload com subconjunto de argumentos
--     nomeados quebra a resolução do PostgREST; drop+create na mesma transação
--   · gerar_tarefa_de_pendencia — atômica e idempotente (chave do cliente +
--     advisory lock + reuso de continuação existente); PRESERVA tarefas.pendencias
--   · alterar_origem_tarefa — único caminho de alteração posterior (justificativa)
--
-- Guarda de escopo: NENHUMA view/RPC de desempenho é tocada; as colunas novas não
-- alimentam métrica alguma (F1 é só fundação).
--
-- Rollback (ordem): drop triggers trg_tarefas_origem_*, trg_rats_origem_del,
-- trg_toe_imutavel; drop functions novas; drop table tarefa_origem_eventos;
-- alter table tarefas drop column das 3 colunas; recriar criar_tarefa_app na
-- assinatura anterior (0043).

-- ─────────────────────────── 1 · Colunas de origem ───────────────────────────
alter table public.tarefas
  add column if not exists origem_tipo text not null default 'nova_solicitacao',
  add column if not exists tarefa_origem_id uuid references public.tarefas(id) on delete set null,
  add column if not exists rat_origem_id uuid references public.rats(id) on delete set null;

create index if not exists idx_tarefas_origem on public.tarefas(tarefa_origem_id)
  where tarefa_origem_id is not null;

-- ─────────────── 2 · Auditoria imutável (sem FK — ver cabeçalho) ───────────────
create table if not exists public.tarefa_origem_eventos (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null,            -- referência LÓGICA (sem FK): sobrevive à exclusão
  tarefa_numero bigint,               -- identificação humana no histórico
  evento text not null,               -- origem_definida | origem_alterada | pendencia_gerou_tarefa | backfill
  origem_tipo_old text, origem_tipo_new text,
  tarefa_origem_old uuid, tarefa_origem_new uuid,
  rat_origem_old uuid, rat_origem_new uuid,
  justificativa text,
  ator uuid default auth.uid(),
  em timestamptz not null default now()
);

alter table public.tarefa_origem_eventos enable row level security;
drop policy if exists toe_office_sel on public.tarefa_origem_eventos;
create policy toe_office_sel on public.tarefa_origem_eventos
  for select using (public.app_role() in ('admin','gestor_axis'));
revoke update, delete on public.tarefa_origem_eventos from anon, authenticated;

create or replace function public.toe_imutavel() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDITORIA_IMUTAVEL: tarefa_origem_eventos nao aceita update/delete';
end $$;
drop trigger if exists trg_toe_imutavel on public.tarefa_origem_eventos;
create trigger trg_toe_imutavel before update or delete on public.tarefa_origem_eventos
  for each row execute function public.toe_imutavel();

-- ─────────────────────── 3 · Validação central (trigger) ───────────────────────
-- Regras: vocabulário · nova_solicitacao sem vínculos · outros tipos exigem
-- tarefa_origem_id · sem autorreferência · RAT pertence à tarefa de origem ·
-- sem ciclo na cadeia de origem · alteração posterior exige justificativa
-- ('sr.origem_motivo', setado pelas RPCs; o set-null por exclusão da origem recebe
-- motivo automático do trigger de delete — por isso vínculo nulo com motivo passa).
create or replace function public.tarefas_origem_valida() returns trigger
language plpgsql as $$
declare v_next uuid; v_prof int := 0; v_rat_tarefa uuid; v_motivo text;
begin
  v_motivo := nullif(trim(coalesce(current_setting('sr.origem_motivo', true), '')), '');

  -- primeiro a regra mais fundamental: alteração posterior exige justificativa
  -- (mensagem certa para quem tentar UPDATE direto fora da RPC)
  if tg_op = 'UPDATE' and (old.origem_tipo is distinct from new.origem_tipo
      or old.tarefa_origem_id is distinct from new.tarefa_origem_id
      or old.rat_origem_id is distinct from new.rat_origem_id) then
    if v_motivo is null then
      raise exception 'ORIGEM_SEM_JUSTIFICATIVA: alteracao de origem/vinculo exige justificativa (use alterar_origem_tarefa)';
    end if;
  end if;

  if new.origem_tipo is null or new.origem_tipo not in
     ('nova_solicitacao','continuacao_planejada','retorno_relacionado','suspeita_retrabalho') then
    raise exception 'ORIGEM_TIPO_INVALIDO: %', new.origem_tipo;
  end if;

  if new.origem_tipo = 'nova_solicitacao' then
    if new.tarefa_origem_id is not null or new.rat_origem_id is not null then
      raise exception 'ORIGEM_INCONSISTENTE: nova_solicitacao nao leva vinculo de origem';
    end if;
  elsif new.tarefa_origem_id is null and v_motivo is null then
    -- vínculo nulo só é aceito em mudança de sistema justificada (origem excluída)
    raise exception 'ORIGEM_SEM_VINCULO: % exige tarefa_origem_id', new.origem_tipo;
  end if;

  if new.tarefa_origem_id = new.id then
    raise exception 'ORIGEM_AUTORREFERENCIA: a tarefa nao pode ser origem de si mesma';
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
  before insert or update of origem_tipo, tarefa_origem_id, rat_origem_id
  on public.tarefas for each row execute function public.tarefas_origem_valida();

-- ───────────────────── 4 · Auditoria automática (trigger) ─────────────────────
-- SECURITY DEFINER: o insert em tarefa_origem_eventos passa por cima do RLS
-- (usuário comum não tem policy de INSERT lá — escrita só por este caminho).
create or replace function public.tarefas_origem_audita() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_motivo text; v_evento text;
begin
  v_motivo := nullif(trim(coalesce(current_setting('sr.origem_motivo', true), '')), '');
  v_evento := nullif(trim(coalesce(current_setting('sr.origem_evento', true), '')), '');
  if tg_op = 'INSERT' then
    if new.origem_tipo <> 'nova_solicitacao' or new.tarefa_origem_id is not null then
      insert into public.tarefa_origem_eventos
        (tarefa_id, tarefa_numero, evento, origem_tipo_new, tarefa_origem_new, rat_origem_new, justificativa)
      values (new.id, new.numero, coalesce(v_evento, 'origem_definida'),
              new.origem_tipo, new.tarefa_origem_id, new.rat_origem_id, v_motivo);
    end if;
  elsif (old.origem_tipo is distinct from new.origem_tipo
      or old.tarefa_origem_id is distinct from new.tarefa_origem_id
      or old.rat_origem_id is distinct from new.rat_origem_id) then
    insert into public.tarefa_origem_eventos
      (tarefa_id, tarefa_numero, evento, origem_tipo_old, origem_tipo_new,
       tarefa_origem_old, tarefa_origem_new, rat_origem_old, rat_origem_new, justificativa)
    values (new.id, new.numero, coalesce(v_evento, 'origem_alterada'),
            old.origem_tipo, new.origem_tipo, old.tarefa_origem_id, new.tarefa_origem_id,
            old.rat_origem_id, new.rat_origem_id, v_motivo);
  end if;
  return null;
end $$;
drop trigger if exists trg_tarefas_origem_audita on public.tarefas;
create trigger trg_tarefas_origem_audita
  after insert or update of origem_tipo, tarefa_origem_id, rat_origem_id
  on public.tarefas for each row execute function public.tarefas_origem_audita();

-- ─────── 5 · Motivo automático quando a origem (tarefa/RAT) é excluída ───────
-- O ON DELETE SET NULL dispara os triggers de UPDATE nas tarefas filhas; estes
-- BEFORE DELETE garantem a justificativa de sistema para esse caminho.
create or replace function public.tarefas_origem_del_motivo() returns trigger
language plpgsql as $$
begin
  perform set_config('sr.origem_motivo',
    'tarefa de origem excluida (N ' || coalesce(old.numero::text, '?') || ')', true);
  return old;
end $$;
drop trigger if exists trg_tarefas_origem_del on public.tarefas;
create trigger trg_tarefas_origem_del before delete on public.tarefas
  for each row execute function public.tarefas_origem_del_motivo();

create or replace function public.rats_origem_del_motivo() returns trigger
language plpgsql as $$
begin
  perform set_config('sr.origem_motivo', 'RAT de origem excluida', true);
  return old;
end $$;
drop trigger if exists trg_rats_origem_del on public.rats;
create trigger trg_rats_origem_del before delete on public.rats
  for each row execute function public.rats_origem_del_motivo();

-- ──────────── 6 · criar_tarefa_app — drop + create (assinatura nova) ────────────
-- Motivo do DROP: 'create or replace' não pode adicionar parâmetros (viraria
-- overload), e o PostgREST falha com overloads onde o conjunto menor de argumentos
-- nomeados é subconjunto do maior. Drop+create na MESMA transação = sem janela.
--
-- ATENÇÃO (drift repo × banco, detectado no teste): a função REAL em produção tem
-- 8 parâmetros — o arquivo 0043 (7) está defasado; foi acrescentado 'p_local text
-- default null' (grava tarefas.local_servico) direto via MCP. O app publicado envia
-- 8 chaves (js/sync.js:265-270, inclui p_local); a recuperação de FK envia 7
-- (js/sync.js:83, sem p_local — default cobre). A assinatura nova preserva p_local.
drop function if exists public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[]);        -- legado (0043), se existir
drop function if exists public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[],text);   -- versão real em produção
create function public.criar_tarefa_app(
  p_id              uuid,
  p_cliente_id      uuid,
  p_status          text,
  p_tipo_servico_id uuid,
  p_orientacao      text,
  p_data_agendada   date,
  p_tecnicos        uuid[],
  p_local           text default null,
  p_origem_tipo       text default 'nova_solicitacao',
  p_tarefa_origem_id  uuid default null,
  p_rat_origem_id     uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare r text; tid uuid; v_n int; v_exist public.tarefas%rowtype;
begin
  r := app_role();
  if r is null or r not in ('tecnico_campo','admin','gestor_axis') then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  insert into public.tarefas (id, cliente_id, status, tipo_servico_id, orientacao, data_agendada,
                              local_servico, criado_por, origem_tipo, tarefa_origem_id, rat_origem_id)
  values (p_id, p_cliente_id, coalesce(p_status, 'aguardando_execucao'), p_tipo_servico_id,
          p_orientacao, p_data_agendada, p_local, auth.uid(),
          coalesce(p_origem_tipo, 'nova_solicitacao'), p_tarefa_origem_id, p_rat_origem_id)
  on conflict (id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- id já existia: só prossegue (técnicos) se for retry LEGÍTIMO da mesma operação
    -- do mesmo usuário; senão, jamais anexar técnicos à tarefa de outra operação.
    select * into v_exist from public.tarefas t where t.id = p_id;
    if v_exist.criado_por is distinct from auth.uid()
       or v_exist.cliente_id is distinct from p_cliente_id then
      raise exception 'IDEMPOTENCIA_CONFLITO: p_id ja usado por outra operacao/usuario';
    end if;
  end if;
  if p_tecnicos is not null then
    foreach tid in array p_tecnicos loop
      insert into public.tarefa_tecnicos (tarefa_id, tecnico_id) values (p_id, tid)
      on conflict (tarefa_id, tecnico_id) do nothing;
    end loop;
  end if;
end $$;
revoke all on function public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[],text,text,uuid,uuid) from public;
grant execute on function public.criar_tarefa_app(uuid,uuid,text,uuid,text,date,uuid[],text,text,uuid,uuid) to authenticated;

-- ───────── 7 · gerar_tarefa_de_pendencia — atômica e idempotente ─────────
-- Idempotência é POR CHAVE DE OPERAÇÃO: p_id nasce no cliente quando o modal abre
-- (crypto.randomUUID); duplo-clique e retry reenviam o MESMO id e recebem a tarefa
-- já criada (o_ja_existia=true). Uma segunda continuação legítima da mesma
-- tarefa/RAT (modal aberto de novo → id novo) NÃO é bloqueada — decisão da revisão
-- da gestão. Advisory lock serializa corridas simultâneas na mesma origem.
-- PRESERVA tarefas.pendencias na origem (correção do fluxo antigo).
create or replace function public.gerar_tarefa_de_pendencia(
  p_id uuid, p_tarefa_origem uuid, p_rat_origem uuid, p_tipo_servico uuid, p_orientacao text
) returns table (o_id uuid, o_numero bigint, o_ja_existia boolean)
language plpgsql security definer set search_path = public as $$
declare v_role text; v_orig public.tarefas%rowtype; v_exist public.tarefas%rowtype;
begin
  v_role := app_role();
  if v_role is null or v_role not in ('admin','gestor_axis') then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  if p_id is null or p_tarefa_origem is null or p_tipo_servico is null then
    raise exception 'PARAMETROS_OBRIGATORIOS: p_id, p_tarefa_origem e p_tipo_servico';
  end if;

  select * into v_orig from public.tarefas t where t.id = p_tarefa_origem;
  if not found then raise exception 'TAREFA_ORIGEM_INEXISTENTE'; end if;

  perform pg_advisory_xact_lock(hashtext('gerar_pendencia:' || p_tarefa_origem::text));

  -- idempotência pela CHAVE DA OPERAÇÃO: retry/duplo-clique reenviam o mesmo p_id
  -- (gerado quando o modal abre) e recebem a tarefa já criada. Segunda continuação
  -- legítima da mesma tarefa/RAT (modal reaberto → id novo) NÃO é bloqueada.
  -- Mesma chave com PAYLOAD DIFERENTE não é retry — é conflito, nunca respondido
  -- em silêncio com a tarefa de outra operação.
  select * into v_exist from public.tarefas t where t.id = p_id;
  if found then
    if v_exist.origem_tipo is distinct from 'continuacao_planejada'
       or v_exist.tarefa_origem_id is distinct from p_tarefa_origem
       or v_exist.rat_origem_id is distinct from p_rat_origem
       or v_exist.tipo_servico_id is distinct from p_tipo_servico
       or coalesce(v_exist.orientacao, '') <> coalesce(nullif(trim(coalesce(p_orientacao, '')), ''), '') then
      raise exception 'IDEMPOTENCIA_CONFLITO: p_id ja usado com payload diferente';
    end if;
    return query select v_exist.id, v_exist.numero, true; return;
  end if;

  insert into public.tarefas (id, cliente_id, tipo_servico_id, status, orientacao, observacoes,
                              criado_por, origem_tipo, tarefa_origem_id, rat_origem_id)
  values (p_id, v_orig.cliente_id, p_tipo_servico, 'aguardando_execucao',
          nullif(trim(coalesce(p_orientacao,'')), ''),
          case when v_orig.numero is not null
               then 'Gerada da pendência da Tarefa Nº ' || lpad(v_orig.numero::text, 5, '0') || '.'
               else 'Gerada de pendência de RAT.' end,
          auth.uid(), 'continuacao_planejada', p_tarefa_origem, p_rat_origem);

  -- a pendência virou tarefa própria; a origem fecha SEM perder o texto
  if v_orig.status = 'concluida_pendencia' then
    update public.tarefas set status = 'concluida' where id = p_tarefa_origem;
  end if;

  insert into public.tarefa_origem_eventos
    (tarefa_id, tarefa_numero, evento, tarefa_origem_new, rat_origem_new, justificativa)
  values (p_tarefa_origem, v_orig.numero, 'pendencia_gerou_tarefa', p_id, p_rat_origem,
          'Pendência gerou nova tarefa (continuação planejada)');

  return query select t.id, t.numero, false from public.tarefas t where t.id = p_id;
end $$;
revoke all on function public.gerar_tarefa_de_pendencia(uuid,uuid,uuid,uuid,text) from public;
grant execute on function public.gerar_tarefa_de_pendencia(uuid,uuid,uuid,uuid,text) to authenticated;

-- ───────── 8 · alterar_origem_tarefa — único caminho de alteração posterior ─────────
create or replace function public.alterar_origem_tarefa(
  p_tarefa uuid, p_origem_tipo text, p_tarefa_origem uuid, p_rat_origem uuid, p_justificativa text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role text; v_n int;
begin
  v_role := app_role();
  if v_role is null or v_role not in ('admin','gestor_axis') then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_justificativa), '')) < 5 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: informe o motivo da alteracao (min. 5 caracteres)';
  end if;
  -- consistência estrita no caminho de usuário: o trigger aceita vínculo nulo com
  -- motivo (caminho de sistema — origem excluída); aqui a regra é integral.
  if p_origem_tipo <> 'nova_solicitacao' and p_tarefa_origem is null then
    raise exception 'ORIGEM_SEM_VINCULO: % exige tarefa de origem', p_origem_tipo;
  end if;
  perform set_config('sr.origem_motivo', trim(p_justificativa), true);
  update public.tarefas
     set origem_tipo = p_origem_tipo, tarefa_origem_id = p_tarefa_origem, rat_origem_id = p_rat_origem
   where id = p_tarefa;
  get diagnostics v_n = row_count;   -- PERFORM abaixo sobrescreveria FOUND
  -- limpa o motivo: set_config transacional não pode "vazar" justificativa para
  -- outra escrita na mesma transação
  perform set_config('sr.origem_motivo', '', true);
  if v_n = 0 then raise exception 'TAREFA_INEXISTENTE'; end if;
end $$;
revoke all on function public.alterar_origem_tarefa(uuid,text,uuid,uuid,text) from public;
grant execute on function public.alterar_origem_tarefa(uuid,text,uuid,uuid,text) to authenticated;

-- Backfill dos 7 casos determinísticos NÃO está aqui — é o commit 4 (dry-run +
-- conferência), rodando com sr.origem_motivo='backfill deterministico (0111)' e
-- sr.origem_evento='backfill'.
