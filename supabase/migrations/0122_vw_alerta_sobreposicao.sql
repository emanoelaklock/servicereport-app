-- 0122: View de CONFERÊNCIA (leitura) — "sobreposição de horários do técnico entre RATs".
-- Fase 1 do redesenho "passagem de bastão" (decisão de gestão 20/07/2026): SÓ a rede de
-- segurança. Sem ledger, sem encerramento automático, sem modal, sem editor de horário
-- individual — os dados mostraram que 5 das 7 sobreposições históricas são legítimas
-- ("saiu e voltou"), então alteração automática teria mais risco que benefício.
--
-- É só leitura — NÃO trava o técnico, NÃO altera horários, NÃO entra em desempenho nem
-- faturamento. Reversível: `drop view`.
--
-- Decisões (registro, no molde da 0065/vw_alerta_desloc_sem_volta):
--  · SÓ dias encerrados (`dia < hoje` em America/Sao_Paulo) — sem falso positivo no meio do dia.
--  · "Dia" = o mesmo da vw_participacoes_dia: coalesce(respostas.data, data_tarefa::date).
--  · Só artefato RAT (deslocamento/pré-orçamento ficam fora do escopo da Fase 1).
--  · Par a par, por TÉCNICO × DIA: cada linha = duas RATs cujos horários daquele técnico se
--    cruzam, com o intervalo conflitante calculado (greatest/least). Encostar (fim = início,
--    ex.: 14:36 → 14:36) NÃO é sobreposição.
--  · Horário do técnico = o da vw_participacoes_dia (individual quando houver, senão o da RAT).
--  · Intervalo inválido ou aberto (fim nulo ou fim <= início, ex. virada de meia-noite) fica
--    fora — é dado pra outra conferência, não par de sobreposição.
--  · rat_a é sempre a participação que COMEÇA primeiro (desempate por id) — cada par sai 1 vez.
--  · security_invoker = true + filtro app_role() in ('admin','gestor_axis') NA PRÓPRIA view:
--    o invoker sozinho NÃO basta aqui, porque a vw_participacoes_dia interna é definer e fura
--    o RLS de rats (anon/técnico leriam tudo pela API). O filtro espelha o PAGE_ALLOWED da
--    Jornada; para anon/técnico/service_role a view devolve 0 linhas (app_role() = null/outro).
--    Consequência operacional: consulta administrativa direta (SQL como postgres) também vê 0
--    linhas sem claims — simular claims de um admin ao inspecionar (ver o teste).
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
   and public.app_role() = any (array['admin', 'gestor_axis']);
