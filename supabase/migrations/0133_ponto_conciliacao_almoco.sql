-- 0133 — Conciliação READ-ONLY do almoço SR × Tangerino por técnico/dia (view p/ jornada.html).
--
-- SÓ LÊ dados já importados no SR: cruza `almocos` (declarado no SR) com o intervalo de almoço
-- INFERIDO do ponto oficial (`ponto_marcacoes`). Não altera nada. Âncora: pessoa-dia com
-- atividade em `vw_participacoes_dia` (sem atividade no SR → o dia nem aparece; ponto ignorado
-- sem gerar divergência). Só colaboradores vinculados; não-vinculado → status 'sem_vinculo'.
--
-- Inferência do almoço (do PONTO): períodos pareados (entrada/saída) do dia, em hora LOCAL do
-- colaborador (tz_origem → IANA); o almoço é o intervalo ENTRE períodos que cai na janela de
-- almoço (ponto_config.janela_almoco_ini/fim) e dura >= gap_minimo_almoco_min. NÃO se assume que
-- toda pausa é almoço. Inconclusivo (→ 'incompleto', preservando a evidência): batida aberta
-- (dateOut null), pendente, excluída, períodos sobrepostos, virada de dia, ou >1 gap candidato.
--
-- Tolerâncias de início/término/duração vêm de `ponto_config` (SEPARADAS). NÃO se fixa ±10 em
-- silêncio: se alguma tolerância for NULL (não calibrada), o par casado fica 'incompleto' com
-- motivo 'tolerâncias não configuradas (calibrar)'. Nenhuma correção/desconto/compensação.
--
-- Segurança: view com security_invoker=true → a RLS das tabelas-base vale para quem consulta
-- (admin/gestor leem; técnico não tem SELECT em ponto_marcacoes → não vê dados de terceiros).
-- Sem token, sem payload bruto, sem chamada ao Tangerino. anon revogado.

create or replace view public.vw_ponto_conciliacao_almoco
with (security_invoker = true) as
with cfg as (select * from public.ponto_config where id = 1),
ativos as (select distinct tecnico_id, dia from public.vw_participacoes_dia),
vinc as (select tecnico_id from public.ponto_colaboradores_map where ativo),
marc as (
  select m.tecnico_id, m.dia, m.entrada, m.saida,
    (m.saida is null) as aberta, m.excluido_origem, (m.pendente_metade is not null) as pendente,
    case m.tz_origem
      when 'SAO_PAULO' then 'America/Sao_Paulo' when 'BAHIA' then 'America/Bahia'
      when 'BELEM' then 'America/Belem' when 'FORTALEZA' then 'America/Fortaleza'
      when 'RECIVE' then 'America/Recife' when 'RECIFE' then 'America/Recife'
      when 'MACEIO' then 'America/Maceio' when 'MANAUS' then 'America/Manaus'
      when 'CUIABA' then 'America/Cuiaba' when 'CAMPO_GRANDE' then 'America/Campo_Grande'
      when 'PORTO_VELHO' then 'America/Porto_Velho' when 'RIO_BRANCO' then 'America/Rio_Branco'
      when 'BOA_VISTA' then 'America/Boa_Vista' when 'NORONHA' then 'America/Noronha'
      else null end as iana
  from public.ponto_marcacoes m
),
per as (
  select tecnico_id, dia, iana, aberta, excluido_origem, pendente,
    (entrada at time zone iana) as ent_loc, (saida at time zone iana) as sai_loc
  from marc where iana is not null
),
per_ord as (
  select p.*, lag(sai_loc) over w as prev_sai
  from per p window w as (partition by tecnico_id, dia order by ent_loc)
),
agg as (
  select tecnico_id, dia, count(*) as n_per,
    bool_or(aberta) as tem_aberta, bool_or(excluido_origem) as tem_excluido, bool_or(pendente) as tem_pendente,
    bool_or(prev_sai is not null and ent_loc < prev_sai) as tem_overlap,
    bool_or(sai_loc::date <> ent_loc::date) as tem_virada,
    bool_or(iana is null) as tem_tz_desconhecido,
    -- extensão do bloco trabalhado no dia (primeira entrada → última saída, hora local)
    extract(epoch from (max(sai_loc) - min(ent_loc)))/3600.0 as span_horas
  from per_ord group by tecnico_id, dia
),
gaps as (
  select po.tecnico_id, po.dia, po.prev_sai::time as g_ini, po.ent_loc::time as g_fim
  from per_ord po cross join cfg
  where po.prev_sai is not null
    and po.prev_sai::time >= cfg.janela_almoco_ini and po.ent_loc::time <= cfg.janela_almoco_fim
    and extract(epoch from (po.ent_loc - po.prev_sai))/60.0 >= cfg.gap_minimo_almoco_min
),
gaps_agg as (
  select tecnico_id, dia, count(*) as n_gap, min(g_ini) as p_ini, max(g_fim) as p_fim,
    extract(epoch from (max(g_fim) - min(g_ini)))/60.0 as p_dur
  from gaps group by tecnico_id, dia
),
alm as (
  select tecnico_id, dia, min(inicio) as sr_ini, max(fim) as sr_fim,
    extract(epoch from (max(fim) - min(inicio)))/60.0 as sr_dur
  from public.almocos group by tecnico_id, dia
),
base as (
  select a.tecnico_id, a.dia,
    (a.tecnico_id in (select tecnico_id from vinc)) as vinculado,
    ag.n_per,
    coalesce(ag.tem_aberta,false) as tem_aberta, coalesce(ag.tem_excluido,false) as tem_excluido,
    coalesce(ag.tem_pendente,false) as tem_pendente, coalesce(ag.tem_overlap,false) as tem_overlap,
    coalesce(ag.tem_virada,false) as tem_virada,
    ag.span_horas,
    ga.n_gap, ga.p_ini as ponto_inicio, ga.p_fim as ponto_fim, ga.p_dur as ponto_duracao_min,
    al.sr_ini as sr_inicio, al.sr_fim as sr_fim, al.sr_dur as sr_duracao_min,
    cfg.tolerancia_inicio_min as ti, cfg.tolerancia_termino_min as tt, cfg.tolerancia_duracao_min as td
  from ativos a cross join cfg
  left join agg ag on ag.tecnico_id = a.tecnico_id and ag.dia = a.dia
  left join gaps_agg ga on ga.tecnico_id = a.tecnico_id and ga.dia = a.dia
  left join alm al on al.tecnico_id = a.tecnico_id and al.dia = a.dia
),
calc as (
  select b.*,
    case when sr_inicio is not null and ponto_inicio is not null
      then round((extract(epoch from (ponto_inicio - sr_inicio))/60.0)::numeric, 1) end as delta_inicio_min,
    case when sr_fim is not null and ponto_fim is not null
      then round((extract(epoch from (ponto_fim - sr_fim))/60.0)::numeric, 1) end as delta_termino_min,
    case when sr_duracao_min is not null and ponto_duracao_min is not null
      then round((ponto_duracao_min - sr_duracao_min)::numeric, 1) end as delta_duracao_min,
    (tem_aberta or tem_excluido or tem_pendente or tem_overlap or tem_virada or coalesce(n_gap,0) > 1) as ponto_inconclusivo
  from base b
)
select
  tecnico_id, dia, vinculado,
  sr_inicio, sr_fim, sr_duracao_min,
  ponto_inicio, ponto_fim, ponto_duracao_min,
  delta_inicio_min, delta_termino_min, delta_duracao_min,
  -- evidências (explicam a regra usada / a inconclusão)
  n_per as ponto_periodos, n_gap as ponto_gaps_candidatos,
  round(span_horas::numeric, 1) as ponto_span_horas,
  tem_aberta, tem_excluido, tem_pendente, tem_overlap, tem_virada,
  -- STATUS
  case
    when not vinculado then 'sem_vinculo'
    when n_per is null then (case when sr_inicio is not null then 'divergente' else 'incompleto' end)
    when ponto_inconclusivo then 'incompleto'
    when sr_inicio is not null and n_gap = 1 then
      (case when ti is null or tt is null or td is null then 'incompleto'
            when abs(delta_inicio_min) <= ti and abs(delta_termino_min) <= tt and abs(delta_duracao_min) <= td
              then 'conciliado' else 'divergente' end)
    when sr_inicio is not null and coalesce(n_gap,0) = 0 then 'divergente'
    when sr_inicio is null and n_gap = 1 then 'divergente'
    -- bloco único de ponto sem intervalo e sem almoço no SR:
    -- até 6h de jornada → conciliado; acima de 6h → incompleto (regra operacional, não afirma infração)
    when coalesce(span_horas, 0) > 6 then 'incompleto'
    else 'conciliado'
  end as status,
  -- SUB-TIPO da divergência (null quando não é 'divergente')
  case
    when not vinculado then null
    when n_per is not null and not ponto_inconclusivo and sr_inicio is not null and coalesce(n_gap,0) = 0 then 'almoco_sr_sem_ponto'
    when n_per is not null and not ponto_inconclusivo and sr_inicio is null and n_gap = 1 then 'ponto_sem_almoco_sr'
    when n_per is null and sr_inicio is not null then 'almoco_sr_sem_ponto'
    when n_per is not null and not ponto_inconclusivo and sr_inicio is not null and n_gap = 1
         and (ti is not null and tt is not null and td is not null)
         and (abs(delta_inicio_min) > ti or abs(delta_termino_min) > tt or abs(delta_duracao_min) > td)
      then nullif(trim(both ',' from
             (case when abs(delta_inicio_min) > ti then 'inicio,' else '' end) ||
             (case when abs(delta_termino_min) > tt then 'termino,' else '' end) ||
             (case when abs(delta_duracao_min) > td then 'duracao,' else '' end)), '')
    else null
  end as divergencia_tipo,
  -- MOTIVO / regra usada (texto curto, sem dado pessoal)
  case
    when not vinculado then 'colaborador não vinculado ao Tangerino'
    when n_per is null then (case when sr_inicio is not null then 'almoço declarado no SR sem marcações de ponto no dia'
                                  else 'sem marcações de ponto no dia' end)
    when ponto_inconclusivo then 'ponto inconclusivo: ' || nullif(trim(both ', ' from
             (case when tem_aberta then 'batida aberta, ' else '' end) ||
             (case when tem_pendente then 'batida pendente, ' else '' end) ||
             (case when tem_excluido then 'marcação excluída na origem, ' else '' end) ||
             (case when tem_overlap then 'períodos sobrepostos, ' else '' end) ||
             (case when tem_virada then 'virada de dia, ' else '' end) ||
             (case when coalesce(n_gap,0) > 1 then 'múltiplas pausas, ' else '' end)), '')
    when sr_inicio is not null and n_gap = 1 and (ti is null or tt is null or td is null)
      then 'par casado, mas tolerâncias não configuradas (calibrar em ponto_config)'
    when sr_inicio is not null and n_gap = 1 then 'almoço SR × intervalo do ponto comparados pelas tolerâncias'
    when sr_inicio is not null and coalesce(n_gap,0) = 0 then 'almoço declarado no SR sem intervalo correspondente no ponto'
    when sr_inicio is null and n_gap = 1 then 'intervalo de almoço no ponto sem almoço declarado no SR'
    when coalesce(span_horas, 0) > 6 then 'jornada longa sem marcação de intervalo'
    else 'sem almoço no SR nem intervalo no ponto'
  end as motivo
from calc;

comment on view public.vw_ponto_conciliacao_almoco is
  'Conciliação read-only do almoço SR x Tangerino por tecnico/dia (0133). Nunca escreve; '
  'inferência do ponto por gap entre períodos na janela de almoço; tolerâncias de ponto_config '
  '(NULL = não calibrado → incompleto). security_invoker=true.';

revoke all on public.vw_ponto_conciliacao_almoco from anon;
grant select on public.vw_ponto_conciliacao_almoco to authenticated;
