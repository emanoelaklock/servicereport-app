-- 0138 — tg_rat_seq: numeração da RAT calculada POR CIMA do RLS de quem insere (F22, caso Pablo/4949).
--
-- O bug: o trigger atribuía rat_seq = max(rat_seq)+1 rodando SOB O RLS DO TÉCNICO que insere.
-- A policy de SELECT de rats só mostra ao técnico as PRÓPRIAS linhas (nunca houve visão de
-- coautor em rats — a 0063 afrouxou só tarefa_tecnicos). Primeiro técnico a abrir RAT numa
-- tarefa onde OUTRO técnico já tem RAT: max visível = 0 → seq 1 → colide com a RAT invisível
-- ("duplicate key uq_rats_tarefa_seq") — determinístico, retry infinito no sync. Caso real:
-- Pablo/4949 em 05/08 (2 itens em loop; Marcelo tinha 4949/1 e 4949/2).
--
-- O fix: SECURITY DEFINER (dono = postgres ⇒ o max enxerga TODAS as linhas da tarefa) — a
-- numeração é um fato da TAREFA, não de quem insere. Precedente da casa: sou_responsavel_tarefa
-- (0063). search_path travado (função definer nunca herda o search_path do chamador). O
-- advisory lock por tarefa permanece (serializa inserts concorrentes da mesma tarefa).
-- Exposição adicional ao chamador: nenhuma — a função só devolve NEW com o seq preenchido.

create or replace function public.tg_rat_seq()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.tarefa_id is not null and new.rat_seq is null then
    -- bloqueia outras transações que inserem RAT para a MESMA tarefa até esta confirmar
    perform pg_advisory_xact_lock(hashtextextended(new.tarefa_id::text, 0));
    new.rat_seq := coalesce((select max(rat_seq) from public.rats where tarefa_id = new.tarefa_id), 0) + 1;
  end if;
  return new;
end $$;

-- Guarda auto-abortante: a função tem que estar DEFINER com search_path travado e o trigger
-- de rats tem que continuar apontando pra ela — senão a migração inteira reverte.
do $$
declare
  ok_def boolean; ok_path boolean; n_trg int;
begin
  select p.prosecdef,
         coalesce(p.proconfig::text like '%search_path=%', false)
    into ok_def, ok_path
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_rat_seq';
  if not ok_def  then raise exception '0138: tg_rat_seq NÃO ficou security definer — abortando'; end if;
  if not ok_path then raise exception '0138: tg_rat_seq sem search_path travado — abortando'; end if;

  select count(*) into n_trg
    from pg_trigger t
   where t.tgrelid = 'public.rats'::regclass
     and t.tgfoid = 'public.tg_rat_seq'::regproc
     and not t.tgisinternal;
  if n_trg < 1 then raise exception '0138: nenhum trigger de rats aponta pra tg_rat_seq — abortando'; end if;
end $$;
