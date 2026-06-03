-- #4.2 — Pré-orçamento: carimbo de ACK no servidor.
-- pre_orcamentos.numero é GENERATED ALWAYS AS IDENTITY (o banco atribui; o
-- cliente nunca envia numero no payload). Este trigger carimba recebido_em no
-- INSERT e mantém atualizado_em — espelha trg_tarefas_recebido_* de rats, que é
-- como o sync.js confirma (salvo_local → ... → confirmado quando recebido_em volta).
--
-- O schema base (#4.1: pre_orcamentos / pre_orcamento_itens / RLS por papel,
-- relatorio_fotos.pre_orcamento_id) foi aplicado direto no projeto Supabase.

create or replace function public.fn_pre_orc_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.recebido_em is null then
    new.recebido_em := now();
  end if;
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists trg_pre_orc_before_ins on public.pre_orcamentos;
create trigger trg_pre_orc_before_ins
  before insert on public.pre_orcamentos
  for each row execute function public.fn_pre_orc_before();

drop trigger if exists trg_pre_orc_before_upd on public.pre_orcamentos;
create trigger trg_pre_orc_before_upd
  before update on public.pre_orcamentos
  for each row execute function public.fn_pre_orc_before();
