-- 0119 — Trilha comercial (C7a): correção ASSISTIDA do elo pré↔orçamento.
-- Escopo RESTRITO (gate C7a): EXCLUSIVAMENTE orcamentos.pre_orcamento_id —
-- nada de tarefas.orcamento_id, nada de ferramenta genérica.
--
-- O que muda:
--   1) trilha_orc_valida: a recaptura de snapshot na TROCA DE ELO passa a
--      marcar origem_captura='correcao_manual' + corrigido_em=now(). Toda
--      troca de elo pós-0115 passa obrigatoriamente pela RPC justificada —
--      é, por definição, correção manual. O INSERT continua capturando
--      snapshot normal (sem marca); o backfill (0117) marcou
--      'backfill_historico'. Três estados distintos no bloco C3.
--   2) corrigir_elo_pre_orcamento ganha CONTROLE DE CONCORRÊNCIA pelo vínculo
--      atual esperado: nova assinatura (p_orcamento, p_novo_pre,
--      p_justificativa, p_pre_atual_esperado). A assinatura antiga de 3
--      argumentos é REMOVIDA (nenhum bypass sem o controle).
--      · (C7b) o vínculo ATUAL é validado contra o ESPERADO ANTES de qualquer
--        retorno: atual ≠ esperado → CONFLITO_VINCULO, MESMO quando o atual já
--        coincide com o destino solicitado (outra sessão pode ter chegado ao
--        mesmo estado por outro caminho — o operador precisa rever);
--      · atual == esperado == novo → sucesso idempotente (ja_aplicado), SEM
--        novo evento (reenvio com a tela já atualizada);
--      · senão → UPDATE dentro da mesma transação; os triggers da 0115 validam
--        cliente (FOR UPDATE no pré) e gravam EXATAMENTE UM evento imutável
--        com vínculo E snapshot anteriores preservados (old/new).
--   3) corrigir_elo_candidatos(p_orcamento): a busca de levantamentos parte do
--      orcamento_id, deriva o CLIENTE NO SERVIDOR e devolve SOMENTE os prés
--      do mesmo cliente — o frontend nunca envia cliente_id; nenhuma sugestão
--      por inferência (lista completa do cliente, campos mínimos).
--   O frontend NUNCA atualiza o FK diretamente (a RLS/trigger da 0115 já
--   barram troca sem justificativa; o caminho único é a RPC).
--
-- Rollback: recriar trilha_orc_valida da 0115; drop function
-- corrigir_elo_pre_orcamento(uuid,uuid,text,uuid), corrigir_elo_candidatos(uuid);
-- recriar corrigir_elo_pre_orcamento(uuid,uuid,text) da 0115.

-- ───── 1 · Recaptura na troca de elo marcada como correção manual ─────
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

  -- snapshot acompanha o elo (server-authoritative). INSERT: captura normal.
  -- TROCA DE ELO (C7a): recaptura MARCADA como correção manual — o único
  -- caminho legítimo de troca é a RPC justificada.
  if tg_op = 'INSERT' then
    new.levantamento_snapshot := case when new.pre_orcamento_id is null then null
      else public.trilha_snapshot_pre(new.pre_orcamento_id) end;
  elsif old.pre_orcamento_id is distinct from new.pre_orcamento_id then
    new.levantamento_snapshot := case when new.pre_orcamento_id is null then null
      else public.trilha_snapshot_pre(new.pre_orcamento_id)
           || jsonb_build_object('origem_captura', 'correcao_manual', 'corrigido_em', now()) end;
  end if;

  return new;
end $$;

-- ───── 2 · Correção com controle de concorrência (assinatura antiga REMOVIDA) ─────
drop function if exists public.corrigir_elo_pre_orcamento(uuid, uuid, text);

create or replace function public.corrigir_elo_pre_orcamento(
  p_orcamento uuid, p_novo_pre uuid, p_justificativa text, p_pre_atual_esperado uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ok boolean; v_atual uuid;
begin
  v_ok := coalesce(public.app_role() in ('admin', 'gestor_axis', 'comercial'), false)
       or exists (select 1 from public.portal_acessos pa
                   where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial'
                     and pa.role_chave in ('Administrador', 'Gestor', 'Comercial'));
  if not v_ok then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_justificativa), '')) < 5 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: informe o motivo da correcao (min. 5 caracteres)';
  end if;

  select pre_orcamento_id into v_atual from public.orcamentos
   where id = p_orcamento for update;   -- serializa correções concorrentes na linha
  if not found then raise exception 'ORCAMENTO_INEXISTENTE'; end if;

  -- C7b: concorrência PRIMEIRO — o vínculo atual precisa ser o que a tela viu,
  -- MESMO que o atual já coincida com o destino (outra sessão pode ter chegado
  -- lá por outro caminho; o operador precisa rever antes de qualquer decisão)
  if v_atual is distinct from p_pre_atual_esperado then
    raise exception 'CONFLITO_VINCULO: o vinculo atual nao e o esperado (alterado por outra sessao) — recarregue e revise';
  end if;
  -- reenvio com a tela já atualizada (esperado == atual == novo) → idempotente
  if v_atual is not distinct from p_novo_pre then
    return jsonb_build_object('ok', true, 'ja_aplicado', true);
  end if;

  perform set_config('sr.trilha_motivo', trim(p_justificativa), true);
  update public.orcamentos set pre_orcamento_id = p_novo_pre where id = p_orcamento;
  -- a justificativa nao pode vazar para outra escrita da transacao
  perform set_config('sr.trilha_motivo', '', true);
  return jsonb_build_object('ok', true, 'ja_aplicado', false);
end $$;
revoke all on function public.corrigir_elo_pre_orcamento(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.corrigir_elo_pre_orcamento(uuid, uuid, text, uuid) to authenticated;

-- ───── 3 · Busca de candidatos: cliente derivado NO SERVIDOR, campos mínimos ─────
create or replace function public.corrigir_elo_candidatos(p_orcamento uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ok boolean; v_cli uuid; v_atual uuid; v jsonb;
begin
  v_ok := coalesce(public.app_role() in ('admin', 'gestor_axis', 'comercial'), false)
       or exists (select 1 from public.portal_acessos pa
                   where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial'
                     and pa.role_chave in ('Administrador', 'Gestor', 'Comercial'));
  if not v_ok then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;

  select cliente_id, pre_orcamento_id into v_cli, v_atual
    from public.orcamentos where id = p_orcamento;
  if not found then raise exception 'ORCAMENTO_INEXISTENTE'; end if;

  select jsonb_build_object(
    'pre_atual', v_atual,
    'candidatos', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'numero', p.numero, 'data', p.data,
          'tecnico', p.tecnico_nome, 'status', p.status,
          'ja_orcado', p.orcamento_em is not null,
          'vinculo_atual', p.id = v_atual
        ) order by p.numero desc)
        from public.pre_orcamentos p
       where p.cliente_id = v_cli), '[]'::jsonb))
  into v;
  return v;
end $$;
revoke all on function public.corrigir_elo_candidatos(uuid) from public, anon;
grant execute on function public.corrigir_elo_candidatos(uuid) to authenticated;
