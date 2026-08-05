-- 0142: vw_alerta_sobreposicao — pausa declarada explica o cruzamento; par nem alerta.
-- Decisão de gestão (05/08/2026, refinando a Fase 1 de 20/07): quando o intervalo de
-- cruzamento entre as duas RATs está INTEIRAMENTE dentro da pausa declarada de uma delas,
-- não é período em dobro — é o técnico usando a pausa de um serviço pra registrar o outro
-- (caso real 4841/02, pausa 15:00–15:20 × 4846/01 15:00–15:20). Cobertura PARCIAL continua
-- alertando; sobreposição sem pausa (caso "foi a Campinas no meio do serviço") continua
-- alertando — pra essas existe o "Revisado" (0140).
--
-- Pausa no dado real: UMA janela por RAT, em respostas.pausa='Sim' + pausa_inicio/termino
-- ('HH:MM'; fn_time_ou_null tolera lixo). A exclusão olha as DUAS RATs do par.
-- Mesmas decisões da 0122 no resto (uma linha por técnico×dia, dia encerrado, gate admin).
-- REGRA DA CASA (F17/0123): todo replace de view REDECLARA o security_invoker.
create or replace view vw_alerta_sobreposicao
with (security_invoker = true) as
with part as (
  select pd.tecnico_id, pd.dia, pd.artefato_id, pd.referencia, pd.rat_seq,
         pd.cliente_id, pd.inicio, pd.fim
    from vw_participacoes_dia pd
   where pd.artefato_tipo = 'rat'
     and pd.inicio is not null and pd.fim is not null
     and pd.fim > pd.inicio
)
select a.tecnico_id,
       u.nome as tecnico_nome,
       a.dia,
       greatest(a.inicio, b.inicio) as conflito_inicio,
       least(a.fim, b.fim)          as conflito_fim,
       jsonb_build_object('rat_id', a.artefato_id, 'numero', a.referencia, 'rat_seq', a.rat_seq,
                          'cliente', ca.nome, 'inicio', a.inicio, 'fim', a.fim) as rat_a,
       jsonb_build_object('rat_id', b.artefato_id, 'numero', b.referencia, 'rat_seq', b.rat_seq,
                          'cliente', cb.nome, 'inicio', b.inicio, 'fim', b.fim) as rat_b
  from part a
  join part b
    on b.tecnico_id = a.tecnico_id and b.dia = a.dia
   and (a.inicio, a.artefato_id) < (b.inicio, b.artefato_id)
   and greatest(a.inicio, b.inicio) < least(a.fim, b.fim)
  left join usuarios u  on u.id  = a.tecnico_id
  left join clientes ca on ca.id = a.cliente_id
  left join clientes cb on cb.id = b.cliente_id
 where a.dia < (now() at time zone 'America/Sao_Paulo')::date
   and public.app_role() = any (array['admin', 'gestor_axis'])
   and not exists (
     select 1 from rats rp
      where rp.id in (a.artefato_id, b.artefato_id)
        and rp.respostas->>'pausa' = 'Sim'
        and public.fn_time_ou_null(rp.respostas->>'pausa_inicio')  is not null
        and public.fn_time_ou_null(rp.respostas->>'pausa_termino') is not null
        and public.fn_time_ou_null(rp.respostas->>'pausa_inicio')  <= greatest(a.inicio, b.inicio)
        and public.fn_time_ou_null(rp.respostas->>'pausa_termino') >= least(a.fim, b.fim)
   );

-- Higiene que a guarda pegou no 1º apply: a view AINDA tinha SELECT de anon (default
-- privileges da época da 0122 — inócuo na prática, o gate app_role() devolve 0 linhas pra
-- anon, mas contra a regra da casa/F17). Revoga aqui.
revoke all on public.vw_alerta_sobreposicao from anon;

-- Guarda auto-abortante: invoker redeclarado e anon sem SELECT, senão rollback.
do $$
begin
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.vw_alerta_sobreposicao'::regclass
       and c.reloptions @> array['security_invoker=true']
  ) then
    raise exception '0142: view sem security_invoker=true — abortando';
  end if;
  if has_table_privilege('anon', 'public.vw_alerta_sobreposicao', 'select') then
    raise exception '0142: anon com SELECT na view — abortando';
  end if;
end $$;
