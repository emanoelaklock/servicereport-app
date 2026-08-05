-- 0140: Revisão de sobreposições — "conferi, é legítimo" persistido; o par sai do Painel.
-- Pedido da gestão (05/08/2026): a vw_alerta_sobreposicao (0122) é calculada na hora e não
-- tinha onde registrar a conferência — o alerta era eterno, mesmo depois de verificado
-- ("saiu e voltou" legítimo). Esta tabela guarda o veredito por PAR DE RATs.
--
-- Decisões:
--  · Chave = o PAR (rat_menor, rat_maior), ordenado (check) — o mesmo par aparece na view
--    uma vez POR TÉCNICO (ex.: dupla nas duas RATs = 2 linhas); revisar o par limpa todas,
--    porque o fato conferido é um só (aquelas duas RATs se cruzam naquele dia).
--  · Grava a JANELA do conflito no momento da revisão (conflito_inicio/fim): se os horários
--    forem editados depois e o cruzamento MUDAR, o cliente mostra o par de novo (revisão
--    não vale para horários que ninguém conferiu). Comparação no cliente, HH:MM.
--  · A view 0122 fica INTACTA (fonte única do cálculo); quem filtra é o consumidor
--    (painel esconde revisadas; Jornada mostra em seção própria com "Reabrir" = delete).
--  · RLS: só admin/gestor_axis (mesmo gate da view); técnico/anon nem leem nem escrevem.
--    revisado_por/nome seguem o padrão ator/ator_nome de rat_edicoes.
--  · Reversível: `drop table` (só se perde o histórico de conferências).
create table if not exists public.sobreposicao_revisoes (
  rat_menor       uuid not null,
  rat_maior       uuid not null,
  dia             date,
  conflito_inicio time,
  conflito_fim    time,
  revisado_por    uuid,
  revisado_nome   text,
  revisado_em     timestamptz not null default now(),
  nota            text,
  primary key (rat_menor, rat_maior),
  constraint sobrev_ordem_par check (rat_menor < rat_maior)
);

alter table public.sobreposicao_revisoes enable row level security;

drop policy if exists sobrev_admin_all on public.sobreposicao_revisoes;
create policy sobrev_admin_all on public.sobreposicao_revisoes
  for all
  using (public.app_role() = any (array['admin', 'gestor_axis']))
  with check (public.app_role() = any (array['admin', 'gestor_axis']));

revoke all on public.sobreposicao_revisoes from anon;

-- Guarda auto-abortante: RLS ligado e anon sem privilégio, senão rollback.
do $$
begin
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.sobreposicao_revisoes'::regclass and c.relrowsecurity
  ) then
    raise exception '0140: tabela sem RLS — abortando';
  end if;
  if has_table_privilege('anon', 'public.sobreposicao_revisoes', 'select') then
    raise exception '0140: anon com SELECT — abortando';
  end if;
end $$;
