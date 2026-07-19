-- 0114 — Pré-orçamento: sinal "virou orçamento" + trava de edição do técnico.
-- Habilita (junto do pull no app, commit 2) reabrir pré-orçamentos em qualquer
-- aparelho e travá-los como somente-leitura depois que o comercial os converte.
--
-- O que cria:
--   · pre_orcamentos.orcamento_em timestamptz (nulo = não convertido). É o sinal
--     materializado na própria linha — o pull já traz o estado de trava de graça,
--     sem o app baixar a tabela orcamentos.
--   · trigger em orcamentos (insert/update/delete de pre_orcamento_id): stampa
--     orcamento_em quando o 1º orçamento aponta pro pré-orçamento; LIMPA quando
--     nenhum orçamento aponta mais (destrava). Bumpa atualizado_em pra propagar.
--   · trigger BEFORE UPDATE em pre_orcamentos: rejeita edição do TÉCNICO quando já
--     convertido (app_role()='tecnico_campo' + orcamento_em setado) → PREORC_JA_ORCADO.
--     Gestão/comercial seguem podendo editar. É a trava de verdade (server-side).
--
-- Guarda de escopo: não toca desempenho, RATs, nem o whitelist de sync do pré-
-- orçamento (orcamento_em é server-managed; o app só LÊ). RLS inalterada.
--
-- Rollback: drop trigger trg_orcamento_marca_preorc on orcamentos; drop trigger
-- trg_preorc_trava_orcado on pre_orcamentos; drop das 2 funções; alter table
-- pre_orcamentos drop column orcamento_em.

-- ───────────────────────── 1 · Coluna do sinal ─────────────────────────
alter table public.pre_orcamentos
  add column if not exists orcamento_em timestamptz;

-- ───── 2 · Backfill: pré-orçamentos que JÁ viraram orçamento (menor criado_em) ─────
update public.pre_orcamentos p
   set orcamento_em = sub.em
  from (select o.pre_orcamento_id, min(o.criado_em) as em
          from public.orcamentos o
         where o.pre_orcamento_id is not null
         group by o.pre_orcamento_id) sub
 where sub.pre_orcamento_id = p.id
   and p.orcamento_em is null;

-- ───── 3 · orcamentos → marca/desmarca o pré-orçamento de origem ─────
-- SECURITY DEFINER: escreve em pre_orcamentos por cima da RLS (o comercial que cria
-- o orçamento não tem policy de UPDATE lá). Destrava só quando NENHUM orçamento
-- referencia mais o pré-orçamento (um pré-orçamento pode ter vários orçamentos).
create or replace function public.orcamento_marca_preorc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.pre_orcamento_id is not null then
    update public.pre_orcamentos
       set orcamento_em = coalesce(orcamento_em, now()), atualizado_em = now()
     where id = new.pre_orcamento_id and orcamento_em is null;
  end if;
  if (tg_op = 'DELETE' or tg_op = 'UPDATE') and old.pre_orcamento_id is not null
     and (tg_op = 'DELETE' or new.pre_orcamento_id is distinct from old.pre_orcamento_id) then
    if not exists (select 1 from public.orcamentos o
                    where o.pre_orcamento_id = old.pre_orcamento_id and o.id <> old.id) then
      update public.pre_orcamentos
         set orcamento_em = null, atualizado_em = now()
       where id = old.pre_orcamento_id;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_orcamento_marca_preorc on public.orcamentos;
create trigger trg_orcamento_marca_preorc
  after insert or delete or update of pre_orcamento_id on public.orcamentos
  for each row execute function public.orcamento_marca_preorc();

-- ───── 4 · Trava: técnico não edita pré-orçamento já convertido ─────
-- BEFORE UPDATE: o carimbo automático (marca_preorc) sempre sai de orcamento_em
-- nulo, então nunca é barrado; a limpeza (destrava) roda no contexto do comercial/
-- gestão (não técnico). Só a edição de conteúdo do técnico sobre um já-convertido cai.
create or replace function public.preorc_trava_orcado() returns trigger
language plpgsql as $$
begin
  if old.orcamento_em is not null and app_role() = 'tecnico_campo' then
    raise exception 'PREORC_JA_ORCADO: pre-orcamento ja virou orcamento; edicao bloqueada para o tecnico';
  end if;
  return new;
end $$;
drop trigger if exists trg_preorc_trava_orcado on public.pre_orcamentos;
create trigger trg_preorc_trava_orcado
  before update on public.pre_orcamentos
  for each row execute function public.preorc_trava_orcado();
