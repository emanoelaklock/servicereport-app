-- 0118 — Trilha comercial (C6): RPC de TIMELINE — leitura centralizada e
-- SOMENTE LEITURA dos eventos da trilha.
--
-- Regras (gate C6):
--   · Fonte ÚNICA dos acontecimentos: trilha_comercial_eventos. O estado atual
--     continua vindo dos FKs canônicos (RPCs da 0116); NADA é inferido aqui —
--     a timeline só lista o que foi registrado.
--   · UMA RPC central resolve a cadeia a partir de QUALQUER âncora
--     ('pre' | 'orcamento' | 'tarefa'), sempre pelos FKs canônicos
--     (tarefas.orcamento_id → orcamentos.pre_orcamento_id). Zero N+1: uma
--     chamada, um statement de agregação.
--   · AUTORIZAÇÃO NO SERVIDOR: espelho da policy da tabela (escritório do SR
--     ou acesso ao Gestão Comercial). Técnico de campo NÃO lê a timeline
--     (histórico interno com justificativas).
--   · Campos MÍNIMOS por evento: id (ordenação estável), em, evento, flag
--     historico (baseline), números de identificação, justificativa e nome do
--     ator. SEM snapshots, SEM valores, SEM observações de negócio.
--   · Eventos de baseline saem com historico=true — a UI os rotula "Vínculo
--     histórico consolidado" (registrados no backfill, não observados na data
--     original). Tipos desconhecidos passam adiante (a UI aplica fallback).
--   · Ordenação por data, precedência natural do ciclo (para eventos gravados
--     na MESMA transação, cujo em é idêntico — ex.: aprovação+remoção num
--     mesmo lote) e identificador estável (em, precedência, id).
--   · Eventos de orçamentos DELETADOS da mesma cadeia aparecem (referência
--     lógica por pre_old/pre_new — a trilha sobrevive a exclusões).
--   · Somente leitura: nenhuma escrita, nenhuma correção — interface de
--     correção de vínculos é gate futuro.
--
-- Rollback: drop function trilha_timeline(text, uuid).

create or replace function public.trilha_timeline(p_tipo text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_pre uuid; v_orc uuid; v_num_pre int;
begin
  -- coalesce OBRIGATÓRIO: app_role() NULL tornaria o IN três-valorado (NULL) e
  -- o NOT(NULL) nunca dispararia o raise — authenticated sem papel passaria
  if not (coalesce(public.app_role() in ('admin', 'gestor_axis', 'comercial'), false)
       or exists (select 1 from public.portal_acessos pa
                   where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial')) then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;
  if p_tipo not in ('pre', 'orcamento', 'tarefa') then
    raise exception 'TIPO_INVALIDO: %', p_tipo;
  end if;

  -- resolve a âncora SEMPRE pelos FKs canônicos (nunca inferência)
  if p_tipo = 'pre' then
    select p.id into v_pre from public.pre_orcamentos p where p.id = p_id;
    if v_pre is null then raise exception 'ANCORA_INEXISTENTE'; end if;
  elsif p_tipo = 'orcamento' then
    select o.id, o.pre_orcamento_id into v_orc, v_pre from public.orcamentos o where o.id = p_id;
    if v_orc is null then raise exception 'ANCORA_INEXISTENTE'; end if;
  else
    select o.id, o.pre_orcamento_id into v_orc, v_pre
      from public.tarefas t join public.orcamentos o on o.id = t.orcamento_id
     where t.id = p_id;
    if v_orc is null then
      if not exists (select 1 from public.tarefas where id = p_id) then
        raise exception 'ANCORA_INEXISTENTE';
      end if;
      return jsonb_build_object('pre', null, 'eventos', '[]'::jsonb);  -- tarefa sem vínculo comercial
    end if;
  end if;

  select numero into v_num_pre from public.pre_orcamentos where id = v_pre;

  select jsonb_build_object(
    'pre', case when v_pre is null then null
                else jsonb_build_object('id', v_pre, 'numero', v_num_pre) end,
    'eventos', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', e.id, 'em', e.em, 'evento', e.evento,
          'historico', (e.evento like 'baseline%'),
          'orcamento_numero', e.orcamento_numero,
          'pre_numero_old', e.pre_numero_old, 'pre_numero_new', e.pre_numero_new,
          'tarefa_numero', e.tarefa_numero,
          'justificativa', e.justificativa,
          'ator_nome', u.nome
        ) order by e.em,
          case e.evento   -- precedência do ciclo p/ eventos com em idêntico (mesma transação)
            when 'baseline_pre_orcamento' then 0 when 'orcamento_criado_de_pre' then 0
            when 'elo_corrigido' then 1 when 'elo_removido' then 1
            when 'tarefa_gerada' then 2
            when 'tarefa_resincronizada' then 3 when 'baseline_orcamento_tarefa' then 3
            when 'tarefa_removida' then 4
            else 5 end,
          e.id)
        from public.trilha_comercial_eventos e
        left join public.usuarios u on u.id = e.ator
       where (v_pre is not null and (
                e.pre_new = v_pre or e.pre_old = v_pre
                -- orçamentos da cadeia: os VIVOS (FK canônico) ∪ os DELETADOS
                -- conhecidos pela própria trilha (eventos de elo do mesmo pré) —
                -- assim os eventos de tarefa de um orçamento excluído não somem
                or e.orcamento_id in (
                     select o2.id from public.orcamentos o2 where o2.pre_orcamento_id = v_pre
                     union
                     select e2.orcamento_id from public.trilha_comercial_eventos e2
                      where e2.pre_new = v_pre or e2.pre_old = v_pre)))
          or (v_pre is null and e.orcamento_id = v_orc)
      ), '[]'::jsonb))
  into v;
  return v;
end $$;
revoke all on function public.trilha_timeline(text, uuid) from public, anon;
grant execute on function public.trilha_timeline(text, uuid) to authenticated;
