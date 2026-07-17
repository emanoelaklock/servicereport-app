-- 0112 — F1 commit 4: backfill dos 7 casos determinísticos (pendência → origem).
-- Vincula retroativamente as tarefas geradas de pendência às suas origens, parseando
-- o carimbo textual "Gerada da pendência da Tarefa Nº NNNNN." — SOMENTE a whitelist
-- fixa abaixo (dry-run conferido em produção antes do commit: 7/7 com nova_existe,
-- origem_existe, texto_confere e mesmo_cliente verdadeiros).
--
-- PRECONDIÇÕES RÍGIDAS (qualquer falha aborta a transação inteira — nada parcial):
--   · 0111 aplicada (colunas de origem + trigger de validação presentes)
--   · cada par da whitelist: nova e origem existem, o TEXTO real em observacoes
--     confirma o par, e os clientes são os mesmos
--   · estado aceito por par: sem vínculo (aplica) OU já com o vínculo EXATO esperado
--     (conta como feito); qualquer outro estado → aborta
-- IDEMPOTENTE: reexecutar retorna 0 aplicados / 7 já feitos, sem eventos novos.
-- AUDITORIA: os UPDATEs rodam com sr.origem_motivo/sr.origem_evento setados → o
--   trigger da 0111 grava 1 evento 'backfill' por vínculo, com justificativa.
-- rat_origem_id fica NULL: qual RAT registrou a pendência não é determinístico
--   retroativamente (decisão do plano — não se inventa vínculo).
--
-- A função FICA no banco (reexecutável para conferência; restrita a admin/gestor
-- quando chamada autenticada; a aplicação da migração roda como postgres).

create or replace function public.backfill_origem_pendencias()
returns table (o_aplicados int, o_ja_feitos int)
language plpgsql security definer set search_path = public as $$
declare
  par record; v_nova record; v_orig record;
  v_pend int := 0; v_done int := 0; v_upd int; v_role text;
begin
  -- chamada autenticada exige papel de gestão; aplicação via migração (sem JWT) passa
  if auth.uid() is not null then
    v_role := app_role();
    if v_role is null or v_role not in ('admin','gestor_axis') then
      raise exception 'SEM_PERMISSAO' using errcode = '42501';
    end if;
  end if;

  -- precondição: 0111 aplicada
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tarefas'
                   and column_name = 'tarefa_origem_id') then
    raise exception 'BACKFILL_PRECONDICAO: migracao 0111 nao aplicada (colunas de origem ausentes)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_tarefas_origem_valida') then
    raise exception 'BACKFILL_PRECONDICAO: trigger de validacao da origem ausente';
  end if;

  perform set_config('sr.origem_motivo',
    'backfill deterministico (0112): vinculo parseado do carimbo em observacoes', true);
  perform set_config('sr.origem_evento', 'backfill', true);

  for par in
    select * from (values
      (4777, 4762), (4826, 4792), (4830, 4794), (4835, 4817),
      (4843, 4837), (4858, 4793), (4860, 4828)
    ) as w(nova, origem)
  loop
    select t.id, t.cliente_id, t.origem_tipo, t.tarefa_origem_id, t.observacoes
      into v_nova from public.tarefas t where t.numero = par.nova;
    if v_nova.id is null then
      raise exception 'BACKFILL_PRECONDICAO: tarefa nova % inexistente', par.nova;
    end if;
    select t.id, t.cliente_id into v_orig from public.tarefas t where t.numero = par.origem;
    if v_orig.id is null then
      raise exception 'BACKFILL_PRECONDICAO: tarefa de origem % inexistente', par.origem;
    end if;
    -- o texto REAL precisa confirmar o par da whitelist (dupla checagem determinística)
    if coalesce(v_nova.observacoes, '') !~ ('Gerada da pendência da Tarefa Nº 0*' || par.origem || '\.') then
      raise exception 'BACKFILL_PRECONDICAO: observacoes da tarefa % nao confirma a origem % (texto: %)',
        par.nova, par.origem, left(coalesce(v_nova.observacoes, ''), 80);
    end if;
    if v_nova.cliente_id is distinct from v_orig.cliente_id then
      raise exception 'BACKFILL_PRECONDICAO: clientes divergem no par % -> %', par.nova, par.origem;
    end if;

    if v_nova.tarefa_origem_id is not null or v_nova.origem_tipo <> 'nova_solicitacao' then
      -- só aceita se for EXATAMENTE o vínculo esperado (reexecução idempotente)
      if v_nova.tarefa_origem_id = v_orig.id and v_nova.origem_tipo = 'continuacao_planejada' then
        v_done := v_done + 1;
        continue;
      end if;
      raise exception 'BACKFILL_PRECONDICAO: tarefa % ja tem origem diferente da esperada (tipo=%, origem=%)',
        par.nova, v_nova.origem_tipo, v_nova.tarefa_origem_id;
    end if;

    update public.tarefas
       set origem_tipo = 'continuacao_planejada', tarefa_origem_id = v_orig.id
     where id = v_nova.id and tarefa_origem_id is null and origem_tipo = 'nova_solicitacao';
    get diagnostics v_upd = row_count;
    if v_upd <> 1 then
      raise exception 'BACKFILL_FALHOU: update do par % -> % afetou % linhas', par.nova, par.origem, v_upd;
    end if;
    v_pend := v_pend + 1;
  end loop;

  -- limpa os GUCs: motivo/evento não podem vazar para outras escritas da transação
  perform set_config('sr.origem_motivo', '', true);
  perform set_config('sr.origem_evento', '', true);

  if v_pend + v_done <> 7 then
    raise exception 'BACKFILL_FALHOU: % aplicados + % ja feitos <> 7', v_pend, v_done;
  end if;
  return query select v_pend, v_done;
end $$;
revoke all on function public.backfill_origem_pendencias() from public;
grant execute on function public.backfill_origem_pendencias() to authenticated;

-- Executa o backfill (idempotente — reaplicar a migração é no-op: 0 aplicados / 7 já feitos)
select * from public.backfill_origem_pendencias();
