-- 0115 — Trilha comercial (C1): fundação de banco — snapshot do levantamento,
-- eventos imutáveis e validação de cliente nos dois sentidos.
-- Escopo RESTRITO (decisão do gate): nada de UI, navegação, PDF, backfill,
-- alteração nas edges nem remoção de orcamentos.tarefa_id.
--
-- O que cria:
--   · orcamentos.levantamento_snapshot jsonb — snapshot IMUTÁVEL do levantamento,
--     capturado NO SERVIDOR no INSERT com pre_orcamento_id (server-authoritative:
--     o que o client mandar nesse campo é sobrescrito). Registros históricos
--     permanecem SEM snapshot até o backfill específico (C5).
--   · trilha_comercial_eventos — auditoria ADITIVA e IMUTÁVEL, SEM FK rígida
--     (sobrevive a exclusões), TOTALMENTE SEPARADA da F1 (tabela própria, GUC
--     próprio sr.trilha_motivo — nunca sr.origem_*, nunca tarefa_origem_eventos).
--   · validação de mesmo cliente nos DOIS sentidos: insert do orçamento com pré,
--     troca do pré, troca do cliente do orçamento vinculado e troca do cliente
--     do pré já vinculado (trigger no pre_orcamentos).
--   · corrigir_elo_pre_orcamento(p_orcamento, p_novo_pre, p_justificativa) —
--     ÚNICO caminho de correção/remoção posterior do elo; re-snapshot acompanha
--     o elo; evento com old/new do vínculo E dos snapshots.
--
-- PRODUTOR ÚNICO por tipo de evento (decisão congelada): os eventos de ELO e
-- SNAPSHOT nascem SÓ dos triggers desta migração — uma operação atômica gera UM
-- evento (orcamento_criado_de_pre já carrega o snapshot; correção gera um único
-- elo_corrigido/elo_removido). Eventos de TAREFA (tarefa_gerada/resincronizada/
-- removida) nascem SÓ da RPC registrar_evento_tarefa_trilha (§8) — as edges
-- fornecem contexto (ator, motivo, op) e o BANCO grava; retry deduplicado pelo
-- índice único uq_tce_op. Sem sobreposição edge×trigger em nenhum tipo.
--
-- CONCORRÊNCIA (gate C1): a validação de cliente usa SELECT ... FOR UPDATE na
-- linha do pré — criação/correção de orçamento e troca de cliente do pré
-- serializam na mesma row lock; nunca persiste orçamento e pré de clientes
-- diferentes. A corrigir_elo_pre_orcamento serializa correções simultâneas na
-- row lock do UPDATE em orcamentos, e retry da mesma correção não gera evento
-- (old IS NOT DISTINCT FROM new → trigger de evento não dispara).
--
-- Guarda de escopo: F1 (tarefas.origem_*, tarefa_origem_eventos) intocada;
-- nenhuma view/RPC de desempenho tocada; 0114 (orcamento_em) intocada e
-- compatível (os triggers convivem).
--
-- Rollback: drop trigger trg_trilha_orc_valida, trg_trilha_orc_evento on
-- orcamentos; drop trigger trg_trilha_pre_cliente on pre_orcamentos; drop
-- trigger trg_tce_imutavel on trilha_comercial_eventos; drop function
-- corrigir_elo_pre_orcamento, trilha_orc_valida, trilha_orc_evento,
-- trilha_pre_cliente_valida, trilha_snapshot_pre, tce_imutavel; drop table
-- trilha_comercial_eventos; alter table orcamentos drop column levantamento_snapshot.

-- ───────────────────────── 1 · Coluna do snapshot ─────────────────────────
alter table public.orcamentos
  add column if not exists levantamento_snapshot jsonb;

-- ───────────── 2 · Eventos da trilha (aditivo, imutável, sem FK) ─────────────
create table if not exists public.trilha_comercial_eventos (
  id uuid primary key default gen_random_uuid(),
  orcamento_id uuid not null,          -- referência LÓGICA (sem FK): sobrevive à exclusão
  orcamento_numero int,                -- identificação humana no histórico
  evento text not null,                -- orcamento_criado_de_pre | elo_corrigido | elo_removido |
                                       -- tarefa_gerada | tarefa_resincronizada | tarefa_removida | (backfill no C5)
  pre_old uuid, pre_numero_old int,
  pre_new uuid, pre_numero_new int,
  snapshot_old jsonb, snapshot_new jsonb,
  tarefa_id uuid, tarefa_numero int,   -- eventos de tarefa (C2): referência lógica, sem FK
  op_id uuid,                          -- identificador da operação (dedup de retry das edges)
  justificativa text,
  ator uuid default auth.uid(),
  em timestamptz not null default now()
);
-- retry da MESMA operação nunca duplica evento (dedup no banco, não na edge)
create unique index if not exists uq_tce_op on public.trilha_comercial_eventos (evento, op_id)
  where op_id is not null;

alter table public.trilha_comercial_eventos enable row level security;
drop policy if exists tce_office_sel on public.trilha_comercial_eventos;
create policy tce_office_sel on public.trilha_comercial_eventos
  for select using (
    public.app_role() in ('admin','gestor_axis','comercial')
    or exists (select 1 from public.portal_acessos pa
                where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial'
                  and pa.role_chave in ('Administrador','Gestor','Comercial')));
revoke insert, update, delete on public.trilha_comercial_eventos from anon, authenticated;

create or replace function public.tce_imutavel() returns trigger
language plpgsql as $$
begin
  raise exception 'TRILHA_AUDITORIA_IMUTAVEL: trilha_comercial_eventos nao aceita update/delete';
end $$;
drop trigger if exists trg_tce_imutavel on public.trilha_comercial_eventos;
create trigger trg_tce_imutavel before update or delete on public.trilha_comercial_eventos
  for each row execute function public.tce_imutavel();

-- ───────────── 3 · Snapshot do levantamento (builder central) ─────────────
-- Campos do dossiê: identidade do pré, dono, data, tempos reais (visita/desloc),
-- duração consolidada e a PREVISÃO original (estimativa, unidade preservada).
create or replace function public.trilha_snapshot_pre(p_pre uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pre_id', p.id, 'pre_numero', p.numero, 'cliente_id', p.cliente_id,
    'tecnico_id', p.tecnico_id, 'tecnico_nome', p.tecnico_nome, 'data', p.data,
    'visita_inicio', p.respostas->>'visita_inicio',
    'visita_termino', p.respostas->>'visita_termino',
    'ida', p.respostas->>'ida', 'retorno', p.respostas->>'retorno',
    'tempo_min', p.tempo_trabalhado,
    'estimativa', p.respostas->'estimativa',
    'capturado_em', now())
  from public.pre_orcamentos p where p.id = p_pre
$$;

-- ───── 4 · Validação central + captura (BEFORE em orcamentos) ─────
-- Regras: elo e snapshot só mudam com justificativa (GUC sr.trilha_motivo, setado
-- pela RPC); mesmo cliente sempre que houver elo (insert, troca do pré e troca do
-- cliente do orçamento); snapshot é server-authoritative e ACOMPANHA o elo
-- (insert com pré captura; correção recaptura; remoção zera — o histórico fica
-- no evento). Editar o pré depois NÃO altera snapshot já capturado (estável).
create or replace function public.trilha_orc_valida() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_motivo text; v_cli uuid;
begin
  v_motivo := nullif(trim(coalesce(current_setting('sr.trilha_motivo', true), '')), '');

  if tg_op = 'UPDATE' then
    if old.pre_orcamento_id is distinct from new.pre_orcamento_id and v_motivo is null then
      raise exception 'TRILHA_SEM_JUSTIFICATIVA: alteracao do elo com o pre-orcamento exige corrigir_elo_pre_orcamento (justificativa)';
    end if;
    if old.levantamento_snapshot is distinct from new.levantamento_snapshot
       and old.pre_orcamento_id is not distinct from new.pre_orcamento_id
       and v_motivo is null then
      raise exception 'TRILHA_SNAPSHOT_IMUTAVEL: o snapshot do levantamento so muda por correcao justificada do elo';
    end if;
  end if;

  -- mesmo cliente nos dois lados sempre que houver elo (cobre insert, troca do
  -- pré e troca do cliente do orçamento vinculado).
  -- FOR UPDATE (prova de concorrência do gate C1): a criação/correção segura a
  -- LINHA DO PRÉ até o fim da transação; a troca de cliente do pré precisa do
  -- mesmo lock — as duas operações serializam e nunca persiste orçamento e pré
  -- de clientes diferentes (quem chega depois relê o estado commitado e cai na
  -- validação TRILHA_CLIENTE_DIVERGENTE).
  if new.pre_orcamento_id is not null then
    select p.cliente_id into v_cli from public.pre_orcamentos p
     where p.id = new.pre_orcamento_id for update;
    if not found then
      raise exception 'TRILHA_PRE_INEXISTENTE: pre-orcamento do elo nao existe';
    end if;
    if v_cli is distinct from new.cliente_id then
      raise exception 'TRILHA_CLIENTE_DIVERGENTE: cliente do orcamento difere do cliente do pre-orcamento';
    end if;
  end if;

  -- snapshot acompanha o elo (server-authoritative)
  if tg_op = 'INSERT' then
    new.levantamento_snapshot := case when new.pre_orcamento_id is null then null
      else public.trilha_snapshot_pre(new.pre_orcamento_id) end;
  elsif old.pre_orcamento_id is distinct from new.pre_orcamento_id then
    new.levantamento_snapshot := case when new.pre_orcamento_id is null then null
      else public.trilha_snapshot_pre(new.pre_orcamento_id) end;
  end if;

  return new;
end $$;
drop trigger if exists trg_trilha_orc_valida on public.orcamentos;
create trigger trg_trilha_orc_valida
  before insert or update of pre_orcamento_id, cliente_id, levantamento_snapshot
  on public.orcamentos for each row execute function public.trilha_orc_valida();

-- ───── 5 · Evento único por operação atômica (AFTER em orcamentos) ─────
-- INSERT com pré → 1 evento orcamento_criado_de_pre (JÁ carrega o snapshot).
-- Correção → 1 evento elo_corrigido/elo_removido com old/new do vínculo e dos
-- snapshots. (Roda depois de trg_orcamento_numero, então new.numero está setado.)
create or replace function public.trilha_orc_evento() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_motivo text; v_num_old int;
begin
  v_motivo := nullif(trim(coalesce(current_setting('sr.trilha_motivo', true), '')), '');
  if tg_op = 'INSERT' then
    if new.pre_orcamento_id is not null then
      insert into public.trilha_comercial_eventos
        (orcamento_id, orcamento_numero, evento, pre_new, pre_numero_new, snapshot_new, justificativa)
      values (new.id, new.numero, 'orcamento_criado_de_pre', new.pre_orcamento_id,
              (new.levantamento_snapshot->>'pre_numero')::int, new.levantamento_snapshot, v_motivo);
    end if;
  elsif old.pre_orcamento_id is distinct from new.pre_orcamento_id then
    select p.numero into v_num_old from public.pre_orcamentos p where p.id = old.pre_orcamento_id;
    insert into public.trilha_comercial_eventos
      (orcamento_id, orcamento_numero, evento,
       pre_old, pre_numero_old, pre_new, pre_numero_new,
       snapshot_old, snapshot_new, justificativa)
    values (new.id, new.numero,
      case when new.pre_orcamento_id is null then 'elo_removido' else 'elo_corrigido' end,
      old.pre_orcamento_id, coalesce((old.levantamento_snapshot->>'pre_numero')::int, v_num_old),
      new.pre_orcamento_id, (new.levantamento_snapshot->>'pre_numero')::int,
      old.levantamento_snapshot, new.levantamento_snapshot, v_motivo);
  end if;
  return null;
end $$;
drop trigger if exists trg_trilha_orc_evento on public.orcamentos;
create trigger trg_trilha_orc_evento
  after insert or update of pre_orcamento_id
  on public.orcamentos for each row execute function public.trilha_orc_evento();

-- ───── 6 · Cliente do PRÉ já vinculado não muda (sentido reverso) ─────
create or replace function public.trilha_pre_cliente_valida() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.cliente_id is distinct from new.cliente_id
     and exists (select 1 from public.orcamentos o where o.pre_orcamento_id = old.id) then
    raise exception 'TRILHA_CLIENTE_DIVERGENTE: pre-orcamento vinculado a orcamento nao pode trocar de cliente';
  end if;
  return new;
end $$;
drop trigger if exists trg_trilha_pre_cliente on public.pre_orcamentos;
create trigger trg_trilha_pre_cliente
  before update of cliente_id on public.pre_orcamentos
  for each row execute function public.trilha_pre_cliente_valida();

-- ───── 7 · RPC de correção/remoção justificada do elo ─────
-- p_novo_pre = uuid → corrige o elo (mesmo cliente, re-snapshot);
-- p_novo_pre = null → remove o elo (snapshot zera; histórico fica no evento).
-- Papel: escritório do SR (app_role) OU gestão-comercial do portal — espelha a
-- semântica de papel da edge aprovar-orcamento v7.
create or replace function public.corrigir_elo_pre_orcamento(
  p_orcamento uuid, p_novo_pre uuid, p_justificativa text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_ok boolean; v_n int;
begin
  v_ok := (public.app_role() in ('admin','gestor_axis','comercial'))
       or exists (select 1 from public.portal_acessos pa
                   where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial'
                     and pa.role_chave in ('Administrador','Gestor','Comercial'));
  if not coalesce(v_ok, false) then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_justificativa), '')) < 5 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: informe o motivo da correcao (min. 5 caracteres)';
  end if;
  perform set_config('sr.trilha_motivo', trim(p_justificativa), true);
  update public.orcamentos set pre_orcamento_id = p_novo_pre where id = p_orcamento;
  get diagnostics v_n = row_count;
  -- limpa o GUC: a justificativa nao pode vazar para outra escrita da transacao
  perform set_config('sr.trilha_motivo', '', true);
  if v_n = 0 then raise exception 'ORCAMENTO_INEXISTENTE'; end if;
end $$;
revoke all on function public.corrigir_elo_pre_orcamento(uuid,uuid,text) from public;
grant execute on function public.corrigir_elo_pre_orcamento(uuid,uuid,text) to authenticated;

-- ───── 8 · Eventos de tarefa (C2): RPC controlada — produtor único no banco ─────
-- As edges (aprovar-orcamento / reabrir-orcamento) FORNECEM o contexto transacional
-- (ator, motivo, identificador da operação) e ESTA RPC grava o evento — nenhum
-- evento é inserido direto pela edge nem por trigger (sem duplicação edge×trigger).
-- Restrita ao service_role (só as edges chamam); retry da mesma operação (mesmo
-- p_op) é deduplicado pelo índice único uq_tce_op — sem evento duplicado.
create or replace function public.registrar_evento_tarefa_trilha(
  p_orcamento uuid, p_evento text, p_tarefa uuid, p_tarefa_numero int,
  p_ator uuid, p_motivo text, p_op uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare v_num int;
begin
  if p_evento not in ('tarefa_gerada','tarefa_resincronizada','tarefa_removida') then
    raise exception 'TRILHA_EVENTO_INVALIDO: %', p_evento;
  end if;
  if p_orcamento is null or p_op is null then
    raise exception 'TRILHA_PARAMETROS: p_orcamento e p_op sao obrigatorios';
  end if;
  select o.numero into v_num from public.orcamentos o where o.id = p_orcamento;
  insert into public.trilha_comercial_eventos
    (orcamento_id, orcamento_numero, evento, tarefa_id, tarefa_numero, op_id, justificativa, ator)
  values (p_orcamento, v_num, p_evento, p_tarefa, p_tarefa_numero, p_op,
          nullif(trim(coalesce(p_motivo, '')), ''), p_ator)
  on conflict (evento, op_id) where op_id is not null do nothing;
end $$;
revoke all on function public.registrar_evento_tarefa_trilha(uuid,text,uuid,int,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.registrar_evento_tarefa_trilha(uuid,text,uuid,int,uuid,text,uuid) to service_role;
