-- 0117 — Trilha comercial (C5a): BACKFILL CONTROLADO — snapshots históricos e
-- eventos de BASELINE. Aplicar o ARQUIVO INTEIRO numa única transação.
--
-- Regras (gate C5a):
--   · Atua SOMENTE sobre vínculos canônicos JÁ EXISTENTES
--     (orcamentos.pre_orcamento_id e tarefas.orcamento_id). NUNCA cria nem
--     corrige vínculo; ZERO inferência por texto, número ou data.
--   · Snapshot histórico = estado ATUAL do pré (trilha_snapshot_pre), marcado
--     obrigatoriamente com origem_captura='backfill_historico',
--     consolidado_em=now() (data real da consolidação) e nota explícita de que
--     os dados refletem o estado DISPONÍVEL no backfill, não necessariamente o
--     estado original da criação. Snapshots normais (capturados no INSERT)
--     não têm origem_captura e permanecem intocados (guarda: snapshot IS NULL).
--   · Eventos PRÓPRIOS de baseline — 'baseline_pre_orcamento' (pré→orçamento)
--     e 'baseline_orcamento_tarefa' (orçamento→tarefa) — DIFERENTES dos
--     operacionais (orcamento_criado_de_pre / tarefa_gerada / tarefa_removida /
--     tarefa_resincronizada): não inventamos operações passadas, registramos a
--     consolidação retroativa de um vínculo pré-existente. ator=null (nenhum
--     usuário operou).
--   · IDEMPOTENTE: snapshot só onde IS NULL; eventos com guarda not-exists
--     (contra os operacionais E contra os próprios baselines). Segunda
--     execução = zero escritas.
--   · LOCK EXCLUSIVO em pre_orcamentos/orcamentos/tarefas: congela escritas
--     concorrentes durante a consolidação (leituras seguem).
--   · ABORTA diante de inconsistência: pré inexistente, cliente divergente,
--     snapshot do builder nulo, ou contagem estrutural divergente (cada
--     snapshot novo exige exatamente um baseline pré→orçamento novo). A
--     validação da 0115 (trg_trilha_orc_valida) roda nos UPDATEs como rede de
--     segurança adicional (TRILHA_CLIENTE_DIVERGENTE).
--   · NENHUMA função/bypass persiste: tudo em DO block anônimo; a
--     justificativa exigida pela 0115 é GUC transacional (morre no commit).
--   · MANIFESTO: os eventos de baseline são o registro durável; o último
--     statement devolve o manifesto completo (linhas afetadas + totais).
--
-- Esperado no estado atual (2026-07-19): 7 snapshots · 7 baseline_pre_orcamento
-- · 5 baseline_orcamento_tarefa · zero vínculos alterados. (As contagens NÃO
-- são hard-coded — o alvo é "todo histórico pendente"; a janela valida os
-- totais no manifesto.)

lock table public.pre_orcamentos, public.orcamentos, public.tarefas in exclusive mode;

do $bf$
declare
  r record; v_snap jsonb; v_n_snap int := 0; v_n_pre int := 0; v_n_tar int := 0;
begin
  -- ── consistência ANTES de qualquer escrita: qualquer elo inválido aborta tudo ──
  for r in
    select o.id, o.numero, o.cliente_id, o.pre_orcamento_id,
           p.id as pre_id, p.numero as pre_numero, p.cliente_id as pre_cliente
      from public.orcamentos o
      left join public.pre_orcamentos p on p.id = o.pre_orcamento_id
     where o.pre_orcamento_id is not null and o.levantamento_snapshot is null
  loop
    if r.pre_id is null then
      raise exception 'BACKFILL_INCONSISTENTE: orcamento % aponta para pre inexistente', r.numero;
    end if;
    if r.pre_cliente is distinct from r.cliente_id then
      raise exception 'BACKFILL_INCONSISTENTE: cliente divergente entre orcamento % e pre %', r.numero, r.pre_numero;
    end if;
  end loop;

  -- justificativa transacional exigida pela 0115 para escrever snapshot sem troca de elo
  perform set_config('sr.trilha_motivo',
    'backfill historico C5a: consolidacao retroativa do snapshot (estado disponivel no backfill)', true);

  -- ── 1 · snapshots históricos + baseline pré→orçamento (mesma varredura) ──
  for r in
    select o.id, o.numero, o.pre_orcamento_id, p.numero as pre_numero
      from public.orcamentos o
      join public.pre_orcamentos p on p.id = o.pre_orcamento_id
     where o.pre_orcamento_id is not null and o.levantamento_snapshot is null
     order by o.numero
  loop
    v_snap := public.trilha_snapshot_pre(r.pre_orcamento_id);
    if v_snap is null then
      raise exception 'BACKFILL_INCONSISTENTE: builder devolveu snapshot nulo para pre % (orcamento %)', r.pre_numero, r.numero;
    end if;
    v_snap := v_snap || jsonb_build_object(
      'origem_captura', 'backfill_historico',
      'consolidado_em', now(),
      'nota_backfill', 'Dados refletem o estado do pre-orcamento disponivel no momento do backfill, nao necessariamente o estado original da criacao.');
    update public.orcamentos set levantamento_snapshot = v_snap where id = r.id;
    v_n_snap := v_n_snap + 1;

    if not exists (select 1 from public.trilha_comercial_eventos e
                    where e.orcamento_id = r.id
                      and e.evento in ('orcamento_criado_de_pre', 'baseline_pre_orcamento')) then
      insert into public.trilha_comercial_eventos
        (orcamento_id, orcamento_numero, evento, pre_new, pre_numero_new, snapshot_new, justificativa, ator)
      values (r.id, r.numero, 'baseline_pre_orcamento', r.pre_orcamento_id, r.pre_numero, v_snap,
              'Baseline historico (C5a): vinculo canonico pre->orcamento pre-existente, consolidado retroativamente', null);
      v_n_pre := v_n_pre + 1;
    end if;
  end loop;

  -- a justificativa não pode vazar para outras escritas da transação
  perform set_config('sr.trilha_motivo', '', true);

  -- estrutural: cada snapshot novo exige exatamente um baseline pré→orçamento novo
  if v_n_snap <> v_n_pre then
    raise exception 'BACKFILL_INCONSISTENTE: snapshots preenchidos (%) != baselines pre->orcamento (%)', v_n_snap, v_n_pre;
  end if;

  -- ── 2 · baseline orçamento→tarefa (tarefas históricas sem evento operacional) ──
  for r in
    select t.id as tarefa_id, t.numero as tarefa_numero, o.id as orc_id, o.numero as orc_numero
      from public.tarefas t
      join public.orcamentos o on o.id = t.orcamento_id
     where t.orcamento_id is not null
       and not exists (select 1 from public.trilha_comercial_eventos e
                        where e.tarefa_id = t.id
                          and e.evento in ('tarefa_gerada', 'baseline_orcamento_tarefa'))
     order by t.numero
  loop
    insert into public.trilha_comercial_eventos
      (orcamento_id, orcamento_numero, evento, tarefa_id, tarefa_numero, justificativa, ator)
    values (r.orc_id, r.orc_numero, 'baseline_orcamento_tarefa', r.tarefa_id, r.tarefa_numero,
            'Baseline historico (C5a): vinculo canonico orcamento->tarefa pre-existente, consolidado retroativamente', null);
    v_n_tar := v_n_tar + 1;
  end loop;

  raise notice 'BACKFILL C5a: snapshots=% · baseline_pre_orcamento=% · baseline_orcamento_tarefa=%',
    v_n_snap, v_n_pre, v_n_tar;
end $bf$;

-- ── MANIFESTO COMPLETO (último statement — visível na aplicação; os eventos
--    de baseline são o registro durável e imutável) ──
select acao, orcamento_numero, pre_numero, tarefa_numero, em
from (
  select 'snapshot+baseline_pre_orcamento' as acao, e.orcamento_numero,
         e.pre_numero_new as pre_numero, null::int as tarefa_numero, e.em
    from public.trilha_comercial_eventos e where e.evento = 'baseline_pre_orcamento'
  union all
  select 'baseline_orcamento_tarefa', e.orcamento_numero, null, e.tarefa_numero, e.em
    from public.trilha_comercial_eventos e where e.evento = 'baseline_orcamento_tarefa'
  union all
  select 'TOTAIS', null, null, null, now()
) m
order by (acao = 'TOTAIS'), acao, orcamento_numero;
