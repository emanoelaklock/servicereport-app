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
-- elo_corrigido/elo_removido). Eventos de TAREFA (C2b — atomicidade): nascem
-- SEMPRE NA MESMA TRANSAÇÃO da mutação — tarefa_gerada (trigger AFTER INSERT em
-- tarefas com orcamento_id, §8), tarefa_removida (trigger BEFORE DELETE, §8) e
-- tarefa_resincronizada (dentro da RPC sincronizar_tarefa_orcamento, §9). As
-- edges NÃO gravam evento algum e NÃO fazem operação+auditoria em chamadas
-- separadas: chamam UMA RPC (§9/§10) e o banco muta+registra atomicamente —
-- falha no evento desfaz a mutação. Sem sobreposição edge×trigger em nenhum tipo.
--
-- IDEMPOTÊNCIA (C2b): derivada da TRANSIÇÃO REAL no banco, não de op aleatório —
--   · tarefa_gerada: uq_tarefas_orcamento garante 1 tarefa/orçamento → 1 insert
--     = 1 evento; retry cai no ramo de ressincronização;
--   · tarefa_removida: a linha só é deletada uma vez; retry não encontra tarefa
--     → nenhum evento novo;
--   · tarefa_resincronizada: evento só quando a ressincronização ALTEROU algo
--     (guardas IS DISTINCT FROM em cada escrita); retry da mesma solicitação
--     (mesmo estado desejado) não muda nada → nenhum evento novo.
--
-- CONCORRÊNCIA (gates C1/C2): a validação de cliente usa SELECT ... FOR UPDATE na
-- linha do pré — criação/correção de orçamento e troca de cliente do pré
-- serializam na mesma row lock; nunca persiste orçamento e pré de clientes
-- diferentes. A corrigir_elo_pre_orcamento serializa correções simultâneas na
-- row lock do UPDATE em orcamentos, e retry da mesma correção não gera evento
-- (old IS NOT DISTINCT FROM new → trigger de evento não dispara). As RPCs de
-- tarefa (§9/§10) serializam na row lock do orçamento (FOR UPDATE): aprovações
-- e reaberturas simultâneas do mesmo orçamento executam uma por vez.
--
-- Guarda de escopo: F1 (tarefas.origem_*, tarefa_origem_eventos) intocada;
-- nenhuma view/RPC de desempenho tocada; 0114 (orcamento_em) intocada e
-- compatível (os triggers convivem).
--
-- Rollback: drop trigger trg_trilha_orc_valida, trg_trilha_orc_evento on
-- orcamentos; drop trigger trg_trilha_pre_cliente on pre_orcamentos; drop
-- trigger trg_trilha_tarefa_ins, trg_trilha_tarefa_del on tarefas; drop
-- trigger trg_tce_imutavel on trilha_comercial_eventos; drop function
-- corrigir_elo_pre_orcamento, sincronizar_tarefa_orcamento,
-- remover_tarefa_orcamento, trilha_tarefa_gerada, trilha_tarefa_removida,
-- trilha_orc_valida, trilha_orc_evento, trilha_pre_cliente_valida,
-- trilha_snapshot_pre, tce_imutavel; drop table trilha_comercial_eventos;
-- alter table orcamentos drop column levantamento_snapshot.

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
  tarefa_id uuid, tarefa_numero int,   -- eventos de tarefa (C2b): referência lógica, sem FK
  justificativa text,
  ator uuid default auth.uid(),
  em timestamptz not null default now()
);
-- (C2b) Sem op_id: a deduplicação de retry NÃO usa identificador aleatório da
-- edge — deriva da transição real (ver IDEMPOTÊNCIA no cabeçalho e §§8-10).

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

-- ───── 8 · Eventos de tarefa (C2b): triggers — evento NA MESMA transação da mutação ─────
-- Bloqueador de atomicidade resolvido no banco: nenhum evento nasce em request
-- separada. Falha ao gravar o evento desfaz a própria mutação (mesma transação).
-- O invariante vale para QUALQUER via de escrita (RPC, edge, SQL direto), não só
-- para o caminho feliz das edges. Contexto (ator/motivo) chega por GUCs
-- transacionais setados pelas RPCs §9/§10; sem GUC, ator cai em criado_por (insert)
-- ou auth.uid(). INSERT...VALUES com subselect do número: o evento é gravado mesmo
-- que o orçamento já não exista (referência lógica, sem FK).
create or replace function public.trilha_tarefa_gerada() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trilha_comercial_eventos
    (orcamento_id, orcamento_numero, evento, tarefa_id, tarefa_numero, justificativa, ator)
  values (new.orcamento_id,
          (select o.numero from public.orcamentos o where o.id = new.orcamento_id),
          'tarefa_gerada', new.id, new.numero,
          nullif(trim(coalesce(current_setting('sr.trilha_motivo', true), '')), ''),
          coalesce(new.criado_por, auth.uid()));
  return new;
end $$;
drop trigger if exists trg_trilha_tarefa_ins on public.tarefas;
create trigger trg_trilha_tarefa_ins
  after insert on public.tarefas
  for each row when (new.orcamento_id is not null)
  execute function public.trilha_tarefa_gerada();

create or replace function public.trilha_tarefa_removida() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trilha_comercial_eventos
    (orcamento_id, orcamento_numero, evento, tarefa_id, tarefa_numero, justificativa, ator)
  values (old.orcamento_id,
          (select o.numero from public.orcamentos o where o.id = old.orcamento_id),
          'tarefa_removida', old.id, old.numero,
          nullif(trim(coalesce(current_setting('sr.trilha_motivo', true), '')), ''),
          coalesce(nullif(current_setting('sr.trilha_ator', true), '')::uuid, auth.uid()));
  return old;
end $$;
drop trigger if exists trg_trilha_tarefa_del on public.tarefas;
create trigger trg_trilha_tarefa_del
  before delete on public.tarefas
  for each row when (old.orcamento_id is not null)
  execute function public.trilha_tarefa_removida();

-- ───── 9 · RPC única de aprovação: gera OU ressincroniza a Tarefa (mesma transação) ─────
-- A edge aprovar-orcamento chama SÓ esta RPC: mutação (tarefa + Orçada) e evento
-- são uma transação. FOR UPDATE no orçamento serializa aprovações simultâneas.
-- Consolidação da Orçada portada da edge v7 (1 linha por produto/descrição;
-- "primeira ocorrência" determinística por criado_em, id — a chave espelha o
-- match_key gerado de tarefa_materiais para linhas nascidas da aprovação).
-- Idempotência: retry sem mudança real → alterou=false e NENHUM evento novo.
create or replace function public.sincronizar_tarefa_orcamento(
  p_orcamento uuid, p_ator uuid, p_motivo text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_o record; v_tid uuid; v_tnum int; v_orient text;
  v_mudou int := 0; v_n int; v_materiais int;
begin
  select o.id, o.cliente_id, o.servico_descricao, o.servico_valor into v_o
    from public.orcamentos o where o.id = p_orcamento for update;
  if not found then raise exception 'ORCAMENTO_INEXISTENTE'; end if;

  v_orient := nullif(v_o.servico_descricao, '');

  -- Orçada desejada (consolidada por produto/descrição)
  drop table if exists pg_temp._trilha_desejada;
  create temp table _trilha_desejada as
  with mats as (
    select oi.produto_id,
           coalesce(nullif(oi.descricao, ''), p.descricao, '(sem descrição)') as descricao,
           oi.unidade,
           case when oi.produto_id is not null then p.codigo end as codigo_produto,
           coalesce(oi.preco_unitario, 0) as preco_unitario,
           coalesce(oi.quantidade, 0) as quantidade,
           oi.criado_em, oi.id
      from public.orcamento_itens oi
      left join public.produtos p on p.id = oi.produto_id
     where oi.orcamento_id = p_orcamento and oi.tipo in ('material','avulso')
  )
  select coalesce(produto_id::text, btrim(lower(descricao))) as mkey,
         (array_agg(produto_id      order by criado_em, id))[1] as produto_id,
         (array_agg(descricao       order by criado_em, id))[1] as descricao,
         (array_agg(unidade         order by criado_em, id))[1] as unidade,
         (array_agg(codigo_produto  order by criado_em, id))[1] as codigo_produto,
         (array_agg(preco_unitario  order by criado_em, id))[1] as preco_unitario,
         sum(quantidade) as qtd_orcada
    from mats group by 1;
  select count(*) into v_materiais from pg_temp._trilha_desejada;

  select t.id, t.numero into v_tid, v_tnum from public.tarefas t where t.orcamento_id = p_orcamento;

  if v_tid is null then
    -- regra de negócio (edge v7): tarefa só nasce se houver serviço
    if nullif(trim(coalesce(v_o.servico_descricao, '')), '') is null
       and coalesce(v_o.servico_valor, 0) <= 0 then
      raise exception 'TAREFA_SEM_SERVICO: orcamento so de produtos nao gera Tarefa';
    end if;
    perform set_config('sr.trilha_motivo', coalesce(p_motivo, ''), true);
    insert into public.tarefas (orcamento_id, cliente_id, status, criado_por, orientacao)
    values (p_orcamento, v_o.cliente_id, 'aguardando_execucao', p_ator, v_orient)
    returning id, numero into v_tid, v_tnum;  -- trg_trilha_tarefa_ins grava tarefa_gerada nesta transação
    perform set_config('sr.trilha_motivo', '', true);
    insert into public.tarefa_materiais
      (tarefa_id, produto_id, codigo_produto, descricao, unidade, preco_unitario, qtd_orcada, qtd_levada, origem)
    select v_tid, d.produto_id, d.codigo_produto, d.descricao, d.unidade, d.preco_unitario, d.qtd_orcada, 0, 'orcamento'
      from pg_temp._trilha_desejada d;
    return jsonb_build_object('acao','gerada','tarefa_id',v_tid,'tarefa_numero',v_tnum,'materiais',v_materiais);
  end if;

  -- ressincronização: só escreve o que estiver de fato diferente (a idempotência
  -- deriva da transição real — retry sem mudança não escreve nem gera evento)
  update public.tarefas set orientacao = v_orient
   where id = v_tid and orientacao is distinct from v_orient;
  get diagnostics v_n = row_count; v_mudou := v_mudou + v_n;

  update public.tarefa_materiais tm set
    qtd_orcada = d.qtd_orcada, preco_unitario = d.preco_unitario,
    descricao = d.descricao, codigo_produto = d.codigo_produto, unidade = d.unidade,
    atualizado_em = now()
   from pg_temp._trilha_desejada d
   where tm.tarefa_id = v_tid and tm.match_key = d.mkey
     and (tm.qtd_orcada, tm.preco_unitario, tm.descricao, tm.codigo_produto, tm.unidade)
         is distinct from (d.qtd_orcada, d.preco_unitario, d.descricao, d.codigo_produto, d.unidade);
  get diagnostics v_n = row_count; v_mudou := v_mudou + v_n;

  insert into public.tarefa_materiais
    (tarefa_id, produto_id, codigo_produto, descricao, unidade, preco_unitario, qtd_orcada, qtd_levada, origem)
  select v_tid, d.produto_id, d.codigo_produto, d.descricao, d.unidade, d.preco_unitario, d.qtd_orcada, 0, 'orcamento'
    from pg_temp._trilha_desejada d
   where not exists (select 1 from public.tarefa_materiais tm where tm.tarefa_id = v_tid and tm.match_key = d.mkey);
  get diagnostics v_n = row_count; v_mudou := v_mudou + v_n;

  update public.tarefa_materiais tm set qtd_orcada = 0, atualizado_em = now()
   where tm.tarefa_id = v_tid and tm.origem = 'orcamento' and tm.qtd_levada > 0 and tm.qtd_orcada <> 0
     and not exists (select 1 from pg_temp._trilha_desejada d where d.mkey = tm.match_key);
  get diagnostics v_n = row_count; v_mudou := v_mudou + v_n;

  delete from public.tarefa_materiais tm
   where tm.tarefa_id = v_tid and tm.origem = 'orcamento' and tm.qtd_levada = 0
     and not exists (select 1 from pg_temp._trilha_desejada d where d.mkey = tm.match_key);
  get diagnostics v_n = row_count; v_mudou := v_mudou + v_n;

  if v_mudou > 0 then
    -- evento e mutação na MESMA transação: falha aqui desfaz a ressincronização
    insert into public.trilha_comercial_eventos
      (orcamento_id, orcamento_numero, evento, tarefa_id, tarefa_numero, justificativa, ator)
    values (p_orcamento, (select o.numero from public.orcamentos o where o.id = p_orcamento),
            'tarefa_resincronizada', v_tid, v_tnum,
            nullif(trim(coalesce(p_motivo, '')), ''), p_ator);
  end if;
  return jsonb_build_object('acao','resincronizada','alterou', v_mudou > 0,
    'alteracoes', v_mudou, 'tarefa_id', v_tid, 'tarefa_numero', v_tnum, 'materiais', v_materiais);
end $$;
revoke all on function public.sincronizar_tarefa_orcamento(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sincronizar_tarefa_orcamento(uuid,uuid,text) to service_role;

-- ───── 10 · RPC única de reabertura: remove a Tarefa (evento no MESMO delete) ─────
-- A edge reabrir-orcamento chama SÓ esta RPC: desvínculo legado + delete + evento
-- (via trg_trilha_tarefa_del) numa única transação. Revalida a regra de RAT
-- atomicamente (fecha a corrida entre o check da edge e o delete).
create or replace function public.remover_tarefa_orcamento(
  p_orcamento uuid, p_ator uuid, p_motivo text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tid uuid; v_tnum int;
begin
  perform 1 from public.orcamentos o where o.id = p_orcamento for update;
  if not found then raise exception 'ORCAMENTO_INEXISTENTE'; end if;
  select t.id, t.numero into v_tid, v_tnum from public.tarefas t where t.orcamento_id = p_orcamento;
  if v_tid is null then
    return jsonb_build_object('removida', false);  -- retry idempotente: nada a remover, nenhum evento
  end if;
  if exists (select 1 from public.rats r where r.tarefa_id = v_tid) then
    raise exception 'TAREFA_COM_RAT: a Tarefa (OS) No % ja tem RAT/execucao iniciada', v_tnum;
  end if;
  perform set_config('sr.trilha_ator', coalesce(p_ator::text, ''), true);
  perform set_config('sr.trilha_motivo', coalesce(p_motivo, ''), true);
  update public.orcamentos set tarefa_id = null where id = p_orcamento;  -- elo legado, mesma transação
  delete from public.tarefas where id = v_tid;  -- trg_trilha_tarefa_del grava tarefa_removida nesta transação
  perform set_config('sr.trilha_ator', '', true);
  perform set_config('sr.trilha_motivo', '', true);
  return jsonb_build_object('removida', true, 'tarefa_numero', v_tnum);
end $$;
revoke all on function public.remover_tarefa_orcamento(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.remover_tarefa_orcamento(uuid,uuid,text) to service_role;
