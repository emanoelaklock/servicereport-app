-- 0080: edição de RAT pelo admin — AUDITORIA (rat_edicoes) + marca de ajuste na RAT.
-- A edição em si é feita pela Edge Function `rat-editar` (admin-only, service role); aqui só o
-- esquema. Cada alteração vira uma linha (com valor_antigo p/ RESTAURAR); o motivo é 1 por LOTE
-- de salvamento (gravado igual em todas as linhas daquele save). Base do índice de assertividade:
-- rats.tecnico_id (titular) + motivo.

create table if not exists public.rat_edicoes (
  id           uuid primary key default gen_random_uuid(),
  rat_id       uuid not null references public.rats(id) on delete cascade,
  tarefa_id    uuid,                      -- desnormalizado p/ relatório/índice por técnico
  alvo         text not null,             -- 'campo' | 'tecnico' | 'produto' | 'foto'
  operacao     text not null,             -- 'update' | 'insert' | 'delete' | 'restore'
  chave        text,                      -- id do item (tecnico_id / materiais.id / foto) ou id do campo
  campo        text,                      -- nome do campo (quando alvo='campo')
  valor_antigo jsonb,                     -- estado anterior (restaurar; em delete = a linha inteira)
  valor_novo   jsonb,                     -- novo estado (null em delete)
  motivo       text not null,             -- 1 por lote (ver CHECK)
  ator         uuid not null,
  ator_nome    text,
  em           timestamptz not null default now(),
  constraint rat_edicoes_motivo_chk check (motivo in
    ('esquecimento_tecnico','completacao','mudanca_processo','pedido_cliente','outro'))
);
create index if not exists rat_edicoes_rat_idx    on public.rat_edicoes(rat_id, em desc);
create index if not exists rat_edicoes_tarefa_idx on public.rat_edicoes(tarefa_id);

-- Marca a RAT como ajustada pela gestão (base do índice; selo no detalhe).
alter table public.rats
  add column if not exists ajustada_gestao boolean not null default false,
  add column if not exists ajustada_por uuid,
  add column if not exists ajustada_em  timestamptz;

-- RLS: o escritório (admin/gestor) LÊ o histórico no portal; a ESCRITA é só via service role
-- (Edge Function rat-editar) — sem policy de insert/update/delete, então nenhum cliente grava.
alter table public.rat_edicoes enable row level security;
create policy rat_edicoes_office_read on public.rat_edicoes
  for select using (app_role() = any (array['admin'::text, 'gestor_axis'::text]));

-- DOWN:
-- drop table public.rat_edicoes;
-- alter table public.rats drop column ajustada_gestao, drop column ajustada_por, drop column ajustada_em;
