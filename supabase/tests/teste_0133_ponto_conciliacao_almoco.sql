-- teste_0133_ponto_conciliacao_almoco.sql — auto-abortante: cria a view da 0133, seta
-- tolerâncias na transação, roda cenários com fixtures sintéticas num pessoa-dia real (âncora
-- de vw_participacoes_dia), valida status/sub-tipo e termina em RAISE → rollback TOTAL.
-- NADA persiste em almocos/ponto_marcacoes (a view é read-only por construção).
-- Gates:
--  A conciliado dentro das tolerâncias
--  B divergência de início/término
--  C almoço no SR sem intervalo no ponto
--  D intervalo no ponto sem almoço no SR
--  E ponto aberto/incompleto → incompleto
--  F múltiplas pausas → incompleto
--  G par casado com tolerância NULA → incompleto (não fixa ±10 em silêncio)
--  H técnico (RLS security_invoker) não vê nada
-- (a DDL da view repete a da migration 0133, com o mapa de tz reduzido ao necessário do teste)
do $$
declare v_tec uuid; v_dia date; v_tec2 uuid; v_row record; v_n int;
begin
  select v.tecnico_id, v.dia into v_tec, v_dia
  from (select distinct tecnico_id, dia from vw_participacoes_dia) v
  join ponto_colaboradores_map m on m.tecnico_id=v.tecnico_id and m.ativo
  where not exists (select 1 from ponto_marcacoes pm where pm.tecnico_id=v.tecnico_id and pm.dia=v.dia)
    and not exists (select 1 from almocos al where al.tecnico_id=v.tecnico_id and al.dia=v.dia)
  order by v.dia desc limit 1;
  select pa.usuario_id into v_tec2 from portal_acessos pa where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  if v_tec is null or v_tec2 is null then raise exception '0133: fixtures ausentes'; end if;

  execute $v$ create or replace view public.vw_ponto_conciliacao_almoco with (security_invoker = true) as
    with cfg as (select * from public.ponto_config where id=1),
    ativos as (select distinct tecnico_id, dia from public.vw_participacoes_dia),
    vinc as (select tecnico_id from public.ponto_colaboradores_map where ativo),
    marc as (select m.tecnico_id, m.dia, m.entrada, m.saida, (m.saida is null) aberta, m.excluido_origem,
        (m.pendente_metade is not null) pendente,
        case m.tz_origem when 'SAO_PAULO' then 'America/Sao_Paulo' when 'MANAUS' then 'America/Manaus' else null end iana
      from public.ponto_marcacoes m),
    per as (select tecnico_id, dia, iana, aberta, excluido_origem, pendente,
        (entrada at time zone iana) ent_loc, (saida at time zone iana) sai_loc from marc where iana is not null),
    per_ord as (select p.*, lag(sai_loc) over w prev_sai from per p window w as (partition by tecnico_id,dia order by ent_loc)),
    agg as (select tecnico_id, dia, count(*) n_per, bool_or(aberta) tem_aberta, bool_or(excluido_origem) tem_excluido,
        bool_or(pendente) tem_pendente, bool_or(prev_sai is not null and ent_loc<prev_sai) tem_overlap,
        bool_or(sai_loc::date<>ent_loc::date) tem_virada from per_ord group by tecnico_id,dia),
    gaps as (select po.tecnico_id, po.dia, po.prev_sai::time g_ini, po.ent_loc::time g_fim from per_ord po cross join cfg
        where po.prev_sai is not null and po.prev_sai::time>=cfg.janela_almoco_ini and po.ent_loc::time<=cfg.janela_almoco_fim
        and extract(epoch from (po.ent_loc-po.prev_sai))/60.0>=cfg.gap_minimo_almoco_min),
    gaps_agg as (select tecnico_id, dia, count(*) n_gap, min(g_ini) p_ini, max(g_fim) p_fim,
        extract(epoch from (max(g_fim)-min(g_ini)))/60.0 p_dur from gaps group by tecnico_id,dia),
    alm as (select tecnico_id, dia, min(inicio) sr_ini, max(fim) sr_fim, extract(epoch from (max(fim)-min(inicio)))/60.0 sr_dur
        from public.almocos group by tecnico_id,dia),
    base as (select a.tecnico_id, a.dia, (a.tecnico_id in (select tecnico_id from vinc)) vinculado, ag.n_per,
        coalesce(ag.tem_aberta,false) tem_aberta, coalesce(ag.tem_excluido,false) tem_excluido, coalesce(ag.tem_pendente,false) tem_pendente,
        coalesce(ag.tem_overlap,false) tem_overlap, coalesce(ag.tem_virada,false) tem_virada,
        ga.n_gap, ga.p_ini ponto_inicio, ga.p_fim ponto_fim, ga.p_dur ponto_duracao_min,
        al.sr_ini sr_inicio, al.sr_fim sr_fim, al.sr_dur sr_duracao_min,
        cfg.tolerancia_inicio_min ti, cfg.tolerancia_termino_min tt, cfg.tolerancia_duracao_min td
      from ativos a cross join cfg
      left join agg ag on ag.tecnico_id=a.tecnico_id and ag.dia=a.dia
      left join gaps_agg ga on ga.tecnico_id=a.tecnico_id and ga.dia=a.dia
      left join alm al on al.tecnico_id=a.tecnico_id and al.dia=a.dia),
    calc as (select b.*,
        case when sr_inicio is not null and ponto_inicio is not null then round((extract(epoch from (ponto_inicio-sr_inicio))/60.0)::numeric,1) end delta_inicio_min,
        case when sr_fim is not null and ponto_fim is not null then round((extract(epoch from (ponto_fim-sr_fim))/60.0)::numeric,1) end delta_termino_min,
        case when sr_duracao_min is not null and ponto_duracao_min is not null then round((ponto_duracao_min-sr_duracao_min)::numeric,1) end delta_duracao_min,
        (tem_aberta or tem_excluido or tem_pendente or tem_overlap or tem_virada or coalesce(n_gap,0)>1) ponto_inconclusivo from base b)
    select tecnico_id, dia, vinculado, sr_inicio, sr_fim, sr_duracao_min, ponto_inicio, ponto_fim, ponto_duracao_min,
      delta_inicio_min, delta_termino_min, delta_duracao_min, n_per ponto_periodos, n_gap ponto_gaps_candidatos,
      tem_aberta, tem_excluido, tem_pendente, tem_overlap, tem_virada,
      case when not vinculado then 'sem_vinculo'
        when n_per is null then (case when sr_inicio is not null then 'divergente' else 'incompleto' end)
        when ponto_inconclusivo then 'incompleto'
        when sr_inicio is not null and n_gap=1 then (case when ti is null or tt is null or td is null then 'incompleto'
          when abs(delta_inicio_min)<=ti and abs(delta_termino_min)<=tt and abs(delta_duracao_min)<=td then 'conciliado' else 'divergente' end)
        when sr_inicio is not null and coalesce(n_gap,0)=0 then 'divergente'
        when sr_inicio is null and n_gap=1 then 'divergente' else 'conciliado' end status,
      case when n_per is not null and not ponto_inconclusivo and sr_inicio is not null and coalesce(n_gap,0)=0 then 'almoco_sr_sem_ponto'
        when n_per is null and sr_inicio is not null then 'almoco_sr_sem_ponto'
        when n_per is not null and not ponto_inconclusivo and sr_inicio is null and n_gap=1 then 'ponto_sem_almoco_sr'
        when n_per is not null and not ponto_inconclusivo and sr_inicio is not null and n_gap=1 and (ti is not null and tt is not null and td is not null)
             and (abs(delta_inicio_min)>ti or abs(delta_termino_min)>tt or abs(delta_duracao_min)>td)
          then nullif(trim(both ',' from (case when abs(delta_inicio_min)>ti then 'inicio,' else '' end)||
             (case when abs(delta_termino_min)>tt then 'termino,' else '' end)||(case when abs(delta_duracao_min)>td then 'duracao,' else '' end)),'')
        else null end divergencia_tipo
    from calc $v$;

  update ponto_config set tolerancia_inicio_min=10, tolerancia_termino_min=10, tolerancia_duracao_min=10 where id=1;

  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, tz_origem) values
    (9995001, v_tec, v_dia, (v_dia||' 08:00-03')::timestamptz, (v_dia||' 12:00-03')::timestamptz, 'APPROVED','SAO_PAULO'),
    (9995002, v_tec, v_dia, (v_dia||' 13:00-03')::timestamptz, (v_dia||' 17:00-03')::timestamptz, 'APPROVED','SAO_PAULO');
  insert into almocos (tecnico_id, dia, inicio, fim, origem) values (v_tec, v_dia, '12:00','13:00','manual');
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'conciliado' then raise exception '0133 A: veio %', v_row.status; end if;

  update almocos set inicio='11:30', fim='12:30' where tecnico_id=v_tec and dia=v_dia;
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'divergente' or v_row.divergencia_tipo not like '%inicio%' then raise exception '0133 B: % / %', v_row.status, v_row.divergencia_tipo; end if;

  delete from ponto_marcacoes where tecnico_id=v_tec and dia=v_dia;
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, tz_origem) values
    (9995003, v_tec, v_dia, (v_dia||' 08:00-03')::timestamptz, (v_dia||' 17:00-03')::timestamptz, 'APPROVED','SAO_PAULO');
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'divergente' or v_row.divergencia_tipo <> 'almoco_sr_sem_ponto' then raise exception '0133 C: % / %', v_row.status, v_row.divergencia_tipo; end if;

  delete from almocos where tecnico_id=v_tec and dia=v_dia;
  delete from ponto_marcacoes where tecnico_id=v_tec and dia=v_dia;
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, tz_origem) values
    (9995004, v_tec, v_dia, (v_dia||' 08:00-03')::timestamptz, (v_dia||' 12:00-03')::timestamptz, 'APPROVED','SAO_PAULO'),
    (9995005, v_tec, v_dia, (v_dia||' 13:00-03')::timestamptz, (v_dia||' 17:00-03')::timestamptz, 'APPROVED','SAO_PAULO');
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'divergente' or v_row.divergencia_tipo <> 'ponto_sem_almoco_sr' then raise exception '0133 D: % / %', v_row.status, v_row.divergencia_tipo; end if;

  delete from ponto_marcacoes where tecnico_id=v_tec and dia=v_dia;
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, tz_origem, pendente_metade) values
    (9995006, v_tec, v_dia, (v_dia||' 08:00-03')::timestamptz, null, 'PENDING','SAO_PAULO','SAIDA');
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'incompleto' or not v_row.tem_aberta then raise exception '0133 E: %', v_row.status; end if;

  delete from ponto_marcacoes where tecnico_id=v_tec and dia=v_dia;
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, tz_origem) values
    (9995007, v_tec, v_dia, (v_dia||' 08:00-03')::timestamptz, (v_dia||' 11:00-03')::timestamptz, 'APPROVED','SAO_PAULO'),
    (9995008, v_tec, v_dia, (v_dia||' 11:30-03')::timestamptz, (v_dia||' 13:00-03')::timestamptz, 'APPROVED','SAO_PAULO'),
    (9995009, v_tec, v_dia, (v_dia||' 14:00-03')::timestamptz, (v_dia||' 17:00-03')::timestamptz, 'APPROVED','SAO_PAULO');
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'incompleto' then raise exception '0133 F: % (gaps=%)', v_row.status, v_row.ponto_gaps_candidatos; end if;

  delete from ponto_marcacoes where tecnico_id=v_tec and dia=v_dia;
  insert into ponto_marcacoes (tangerino_punch_id, tecnico_id, dia, entrada, saida, status_origem, tz_origem) values
    (9995010, v_tec, v_dia, (v_dia||' 08:00-03')::timestamptz, (v_dia||' 12:00-03')::timestamptz, 'APPROVED','SAO_PAULO'),
    (9995011, v_tec, v_dia, (v_dia||' 13:00-03')::timestamptz, (v_dia||' 17:00-03')::timestamptz, 'APPROVED','SAO_PAULO');
  insert into almocos (tecnico_id, dia, inicio, fim, origem) values (v_tec, v_dia, '12:00','13:00','manual');
  update ponto_config set tolerancia_inicio_min=null where id=1;
  select * into v_row from vw_ponto_conciliacao_almoco where tecnico_id=v_tec and dia=v_dia;
  if v_row.status <> 'incompleto' then raise exception '0133 G: %', v_row.status; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from vw_ponto_conciliacao_almoco;
  reset role;
  if v_n <> 0 then raise exception '0133 H: tecnico viu % linhas', v_n; end if;

  raise exception '0133 OK: A-H verdes — rollback total';
end $$;
