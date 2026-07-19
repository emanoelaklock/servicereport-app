-- ═══════════════════════════════════════════════════════════════════════════
-- TRILHA COMERCIAL — script de INTEGRIDADE (C8) · SOMENTE LEITURA
-- Rode inteiro no SQL Editor a qualquer momento (nenhuma escrita, nenhum lock
-- além de leituras). Cada linha da grade sai como OK ou FALHA; qualquer FALHA
-- merece investigação antes de nova janela de mudança.
-- Referência: docs/trilha-comercial.md
-- ═══════════════════════════════════════════════════════════════════════════
select item, situacao, detalhe from (

-- i01 · todo orçamento com pré tem snapshot
select 'i01_snapshot_completo' as item,
  case when count(*) = 0 then 'OK' else 'FALHA' end as situacao,
  count(*)::text || ' orcamento(s) com pre e snapshot nulo' as detalhe, 1 as ord
from orcamentos where pre_orcamento_id is not null and levantamento_snapshot is null

union all
-- i02 · marcas de origem consistentes (backfill tem consolidado_em; correção tem corrigido_em)
select 'i02_marcas_consistentes',
  case when count(*) = 0 then 'OK' else 'FALHA' end,
  count(*)::text || ' snapshot(s) com marca inconsistente', 2
from orcamentos
where (levantamento_snapshot->>'origem_captura' = 'backfill_historico' and not levantamento_snapshot ? 'consolidado_em')
   or (levantamento_snapshot->>'origem_captura' = 'correcao_manual' and not levantamento_snapshot ? 'corrigido_em')
   or (levantamento_snapshot ? 'origem_captura'
       and levantamento_snapshot->>'origem_captura' not in ('backfill_historico', 'correcao_manual'))

union all
-- i03 · censo de snapshots por origem (informativo)
select 'i03_censo_snapshots', 'OK',
  'normal=' || count(*) filter (where levantamento_snapshot is not null and not levantamento_snapshot ? 'origem_captura')
  || ' backfill=' || count(*) filter (where levantamento_snapshot->>'origem_captura' = 'backfill_historico')
  || ' correcao=' || count(*) filter (where levantamento_snapshot->>'origem_captura' = 'correcao_manual'), 3
from orcamentos

union all
-- i04 · todo vínculo pré→orçamento tem evento de criação OU baseline
select 'i04_evento_por_vinculo_pre',
  case when count(*) = 0 then 'OK' else 'FALHA' end,
  count(*)::text || ' orcamento(s) com pre sem evento de criacao/baseline', 4
from orcamentos o
where o.pre_orcamento_id is not null
  and not exists (select 1 from trilha_comercial_eventos e
                   where e.orcamento_id = o.id
                     and e.evento in ('orcamento_criado_de_pre', 'baseline_pre_orcamento', 'elo_corrigido'))

union all
-- i05 · toda tarefa com orçamento tem tarefa_gerada OU baseline
select 'i05_evento_por_tarefa',
  case when count(*) = 0 then 'OK' else 'FALHA' end,
  count(*)::text || ' tarefa(s) de orcamento sem evento', 5
from tarefas t
where t.orcamento_id is not null
  and not exists (select 1 from trilha_comercial_eventos e
                   where e.tarefa_id = t.id
                     and e.evento in ('tarefa_gerada', 'baseline_orcamento_tarefa'))

union all
-- i06 · cliente coerente em todo vínculo vivo
select 'i06_cliente_coerente',
  case when count(*) = 0 then 'OK' else 'FALHA' end,
  count(*)::text || ' vinculo(s) com cliente divergente', 6
from orcamentos o join pre_orcamentos p on p.id = o.pre_orcamento_id
where p.cliente_id is distinct from o.cliente_id

union all
-- i07 · imutabilidade dos eventos (trigger presente e habilitado)
select 'i07_eventos_imutaveis',
  case when count(*) = 1 then 'OK' else 'FALHA' end,
  'trg_tce_imutavel habilitado: ' || count(*)::text, 7
from pg_trigger where tgname = 'trg_tce_imutavel' and tgenabled = 'O'

union all
-- i08 · triggers da trilha presentes e habilitados (6)
select 'i08_triggers_trilha',
  case when count(*) = 6 then 'OK' else 'FALHA' end,
  count(*)::text || '/6 habilitados', 8
from pg_trigger
where tgname in ('trg_trilha_orc_valida', 'trg_trilha_orc_evento', 'trg_trilha_pre_cliente',
                 'trg_tce_imutavel', 'trg_trilha_tarefa_ins', 'trg_trilha_tarefa_del')
  and tgenabled = 'O'

union all
-- i09 · RPCs da trilha presentes; assinatura antiga do corrigir AUSENTE
select 'i09_rpcs',
  case when count(*) filter (where pronargs_ok) = 7
        and count(*) filter (where proname = 'corrigir_elo_pre_orcamento' and pronargs = 3) = 0
       then 'OK' else 'FALHA' end,
  count(*) filter (where pronargs_ok)::text || '/7 presentes; v3 corrigir='
  || count(*) filter (where proname = 'corrigir_elo_pre_orcamento' and pronargs = 3)::text, 9
from (select p.proname, p.pronargs,
        (p.proname, p.pronargs) in (values
          ('trilha_snapshot_pre', 1), ('sincronizar_tarefa_orcamento', 3),
          ('remover_tarefa_orcamento', 3), ('trilha_da_tarefa', 1), ('trilha_do_pre', 1),
          ('trilha_timeline', 2), ('corrigir_elo_pre_orcamento', 4)) as pronargs_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('trilha_snapshot_pre', 'sincronizar_tarefa_orcamento',
         'remover_tarefa_orcamento', 'trilha_da_tarefa', 'trilha_do_pre',
         'trilha_timeline', 'corrigir_elo_pre_orcamento')) x

union all
-- i10 · superfície de permissão: anon NUNCA executa RPC da trilha; eventos sem
--       escrita para anon/authenticated (INSERT/UPDATE/DELETE)
select 'i10_permissoes',
  case when not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('sincronizar_tarefa_orcamento', 'remover_tarefa_orcamento',
         'trilha_da_tarefa', 'trilha_do_pre', 'trilha_timeline',
         'corrigir_elo_pre_orcamento', 'corrigir_elo_candidatos')
       and (has_function_privilege('anon', p.oid, 'execute')))
   and not exists (
    select 1 from (values ('anon'), ('authenticated')) r(rol), (values ('INSERT'), ('UPDATE'), ('DELETE')) pr(p)
     where has_table_privilege(r.rol, 'trilha_comercial_eventos', pr.p))
  then 'OK' else 'FALHA' end,
  'anon sem execute; eventos sem escrita p/ anon/authenticated', 10

union all
-- i11 · eventos órfãos (orçamento excluído) — INFORMATIVO, esperado e legítimo
select 'i11_eventos_orfaos', 'OK',
  count(*)::text || ' evento(s) de orcamentos excluidos (referencia logica preservada)', 11
from trilha_comercial_eventos e
where not exists (select 1 from orcamentos o where o.id = e.orcamento_id)

union all
-- i12 · censo de eventos por tipo (informativo)
select 'i12_censo_eventos', 'OK',
  (select string_agg(evento || '=' || n, ' · ' order by evento)
     from (select evento, count(*) as n from trilha_comercial_eventos group by evento) c), 12

) g order by ord;
