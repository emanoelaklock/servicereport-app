-- 0141: Revisão de "envios presos" — triagem persistida; o card sai do Painel.
-- Mesmo desenho da 0140 (sobreposicao_revisoes), agora para a vw_alerta_rat_fotos_orfas
-- (F23/0139): o admin confere com o técnico ("trabalho perdido/abandonado/recuperado à mão"),
-- marca Revisado e a pasta órfã sai do Painel — sem apagar nada do Storage.
--
-- Decisões:
--  · Chave = rat_client_uuid (a pasta órfã). Guarda quem/quando revisou + nota opcional.
--  · Validade da revisão é POR ESTADO: o cliente só esconde a pasta se nada chegou nela
--    depois da revisão (ultimo_envio <= revisado_em). Novas fotos = o aparelho voltou a
--    tentar = reaparece pra nova triagem.
--  · Se a RAT pousar no banco, a pasta some da view sozinha (a revisão vira inócua).
--  · View 0139 INTACTA; quem filtra é o consumidor (painel).
--  · RLS: só admin/gestor_axis; técnico/anon nada. Reversível: `drop table`.
create table if not exists public.envio_preso_revisoes (
  rat_client_uuid uuid primary key,
  tecnico_id      uuid,
  revisado_por    uuid,
  revisado_nome   text,
  revisado_em     timestamptz not null default now(),
  nota            text
);

alter table public.envio_preso_revisoes enable row level security;

drop policy if exists envpreso_admin_all on public.envio_preso_revisoes;
create policy envpreso_admin_all on public.envio_preso_revisoes
  for all
  using (public.app_role() = any (array['admin', 'gestor_axis']))
  with check (public.app_role() = any (array['admin', 'gestor_axis']));

revoke all on public.envio_preso_revisoes from anon;

-- Guarda auto-abortante: RLS ligado e anon sem privilégio, senão rollback.
do $$
begin
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.envio_preso_revisoes'::regclass and c.relrowsecurity
  ) then
    raise exception '0141: tabela sem RLS — abortando';
  end if;
  if has_table_privilege('anon', 'public.envio_preso_revisoes', 'select') then
    raise exception '0141: anon com SELECT — abortando';
  end if;
end $$;
