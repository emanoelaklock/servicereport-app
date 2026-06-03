-- #4.3 — Orçamento (portal do comercial): condição de pagamento + touch de atualizado_em.
-- orcamentos.numero é IDENTITY ALWAYS; orcamento_itens.subtotal é GENERATED
-- ALWAYS round(quantidade*preco_unitario,2). Cliente nunca envia esses dois.
-- RLS office-only (admin/gestor_axis/comercial) já aplicada no #4.1.

alter table public.orcamentos add column if not exists condicao_pagamento text;

create or replace function public.fn_orcamento_touch()
returns trigger language plpgsql as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists trg_orcamento_touch on public.orcamentos;
create trigger trg_orcamento_touch
  before update on public.orcamentos
  for each row execute function public.fn_orcamento_touch();
