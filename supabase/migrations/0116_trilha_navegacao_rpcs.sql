-- 0116 — Trilha comercial (C4): RPCs de NAVEGAÇÃO — a cadeia mínima por tela.
-- Escopo RESTRITO (gate C4): somente leitura da cadeia para as telas de detalhe
-- do pré-orçamento e da tarefa no SR. Nada de timeline completa, nada de
-- navegação no Comercial, nada de backfill.
--
-- Regras que estas RPCs materializam:
--   · Vínculos CANÔNICOS apenas: orcamentos.pre_orcamento_id e
--     tarefas.orcamento_id. NUNCA orcamentos.tarefa_id (legado); nunca
--     inferência por texto, número ou data.
--   · TOTALMENTE SEPARADO da F1 (origem operacional): não lê origem_tipo,
--     tarefa_origem_id, rat_origem_id nem tarefa_origem_eventos.
--   · UMA chamada por tela; cada RPC resolve a cadeia inteira em UM statement
--     (zero N+1 no app).
--   · AUTORIZAÇÃO NO SERVIDOR: security definer + checagem de papel aqui
--     dentro (SR via app_role() — admin/tecnico_campo — OU acesso ao app
--     gestao_comercial). O cliente manda SÓ o id da âncora; nenhum cliente_id
--     ou filtro vindo do frontend é usado.
--   · Exposição MÍNIMA: números, status e datas de identificação. SEM snapshot,
--     SEM valores, SEM observações, SEM nada destinado ao cliente. O id do
--     orçamento é incluído EXCLUSIVAMENTE para a geração de rota no cliente
--     (C4b — urlOrcamento no helper central); a interface nunca o exibe.
--   · "Removida" SÓ com evento: ausência de tarefa vira tarefa_removida=true
--     apenas quando existe evento 'tarefa_removida' em trilha_comercial_eventos.
--
-- Rollback: drop function trilha_da_tarefa(uuid), trilha_do_pre(uuid).

-- ───── 1 · Cadeia da TAREFA: tarefa → orçamento → pré (+ árvore do pré) ─────
-- Orçamento sem pré aparece (pre=null, orcamentos=[]). Quando há pré, o campo
-- 'orcamentos' traz TODOS os orçamentos daquele pré (um pré pode ter vários) —
-- é o que permite navegar da OS atual para as OS irmãs; a tela NUNCA linka a
-- própria tarefa (regra do gate — decisão de UI, e o id da atual está no topo).
create or replace function public.trilha_da_tarefa(p_tarefa uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not ((public.app_role() is not null)
       or exists (select 1 from public.portal_acessos pa
                   where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial')) then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'tarefa', jsonb_build_object('id', t.id, 'numero', t.numero),
    'orcamento', case when o.id is null then null else jsonb_build_object(
      'id', o.id, 'numero', o.numero, 'status', o.status, 'data', o.criado_em::date) end,
    'pre', case when p.id is null then null else jsonb_build_object(
      'id', p.id, 'numero', p.numero, 'data', p.data) end,
    'orcamentos', case when p.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', o2.id, 'numero', o2.numero, 'status', o2.status, 'data', o2.criado_em::date,
          'tarefa', case when t2.id is null then null else jsonb_build_object(
            'id', t2.id, 'numero', t2.numero, 'status', t2.status) end,
          'tarefa_removida', (t2.id is null and exists (
            select 1 from public.trilha_comercial_eventos e
             where e.orcamento_id = o2.id and e.evento = 'tarefa_removida'))
        ) order by o2.numero desc)
        from public.orcamentos o2
        left join public.tarefas t2 on t2.orcamento_id = o2.id
       where o2.pre_orcamento_id = p.id), '[]'::jsonb) end)
  into v
  from public.tarefas t
  left join public.orcamentos o on o.id = t.orcamento_id
  left join public.pre_orcamentos p on p.id = o.pre_orcamento_id
  where t.id = p_tarefa;

  if v is null then raise exception 'TAREFA_INEXISTENTE'; end if;
  return v;
end $$;
revoke all on function public.trilha_da_tarefa(uuid) from public, anon;
grant execute on function public.trilha_da_tarefa(uuid) to authenticated;

-- ───── 2 · Cadeia do PRÉ: pré → TODOS os orçamentos → tarefa de cada um ─────
-- Um pré pode ter vários orçamentos (regra do gate); cada um traz a tarefa
-- (quando existe) OU o flag tarefa_removida (só com evento na trilha).
create or replace function public.trilha_do_pre(p_pre uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not ((public.app_role() is not null)
       or exists (select 1 from public.portal_acessos pa
                   where pa.usuario_id = auth.uid() and pa.app_chave = 'gestao_comercial')) then
    raise exception 'SEM_PERMISSAO' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'pre', jsonb_build_object('id', p.id, 'numero', p.numero, 'data', p.data),
    'orcamentos', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', o.id, 'numero', o.numero, 'status', o.status, 'data', o.criado_em::date,
          'tarefa', case when t.id is null then null else jsonb_build_object(
            'id', t.id, 'numero', t.numero, 'status', t.status) end,
          'tarefa_removida', (t.id is null and exists (
            select 1 from public.trilha_comercial_eventos e
             where e.orcamento_id = o.id and e.evento = 'tarefa_removida'))
        ) order by o.numero desc)
        from public.orcamentos o
        left join public.tarefas t on t.orcamento_id = o.id
       where o.pre_orcamento_id = p.id), '[]'::jsonb))
  into v
  from public.pre_orcamentos p
  where p.id = p_pre;

  if v is null then raise exception 'PRE_INEXISTENTE'; end if;
  return v;
end $$;
revoke all on function public.trilha_do_pre(uuid) from public, anon;
grant execute on function public.trilha_do_pre(uuid) to authenticated;
