-- 0082: remove o off-by-one de fuso no FALLBACK de data_tarefa em dois objetos.
-- data_tarefa é timestamptz guardada como meia-noite UTC; aplicar AT TIME ZONE 'America/Sao_Paulo'
-- e ::date derruba o dia (23/06 00:00+00 → 22/06). O correto (igual à vw_participacoes_dia/0081)
-- é r.data_tarefa::date (sem conversão), usado só quando respostas.data está vazio.
-- Impacto atual: ZERO (toda RAT tem respostas.data hoje); correção preventiva/consistência.

-- 1) Lista/busca de RATs: dia_rat
create or replace view public.vw_rats_busca as
 select r.id, r.rat_seq, r.data_tarefa, r.status as rat_status, r.cliente_nome,
    coalesce(nullif(r.respostas ->> 'data'::text, ''::text), r.data_tarefa::date::text) as dia_rat,
    t.id as tarefa_id, t.numero as tarefa_numero, t.status as tarefa_status, t.pedido_compra,
    o.numero as orcamento_numero, t.orientacao, tn.nomes as colaboradores,
    lower(concat_ws(' '::text, lpad(t.numero::text, 5, '0'::text),
      (coalesce(t.numero::text, ''::text) || '/'::text) || lpad(coalesce(r.rat_seq, 0)::text, 2, '0'::text),
      r.cliente_nome, tn.nomes, t.pedido_compra, o.numero::text, t.orientacao, r.respostas::text)) as busca
   from rats r
     left join tarefas t on t.id = r.tarefa_id
     left join orcamentos o on o.id = t.orcamento_id
     left join lateral ( select string_agg(distinct s.nome, ' · '::text order by s.nome) as nomes
           from ( select r.tecnico_nome as nome where r.tecnico_nome is not null
                  union
                  select u.nome from rat_tecnicos rt join usuarios u on u.id = rt.tecnico_id where rt.rat_id = r.id) s(nome)) tn on true;

-- 2) Trigger de status da tarefa: desempate "RAT mais recente" no ORDER BY
create or replace function public.rat_inicia_tarefa()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_target text; v_latest uuid; v_pausa_ativa boolean;
begin
  if new.tarefa_id is null then return new; end if;

  v_pausa_ativa := (new.status = 'em_andamento'
                    and new.respostas->>'pausa' = 'Sim'
                    and nullif(new.respostas->>'pausa_inicio', '') is not null
                    and nullif(new.respostas->>'pausa_termino', '') is null);

  if v_pausa_ativa then
    v_target := 'em_pausa';
  elsif new.status = 'registrado'
        and new.respostas->>'volta_amanha' = 'Não'
        and new.respostas->>'passagem_motivo' = 'volto_depois' then
    select r.id into v_latest from public.rats r
      where r.tarefa_id = new.tarefa_id
      order by coalesce(nullif(r.respostas->>'data','')::date, r.data_tarefa::date) desc nulls last,
               r.criado_em desc
      limit 1;
    v_target := case when v_latest = new.id then 'em_pausa' else null end;
  elsif coalesce(new.atendimento_executado, true) then
    v_target := 'em_execucao';
  else
    v_target := null;
  end if;

  if v_target is not null then
    update public.tarefas set status = v_target
     where id = new.tarefa_id
       and status in ('aguardando_execucao','em_execucao','em_pausa')
       and status <> v_target;
  end if;
  return new;
end $function$;
