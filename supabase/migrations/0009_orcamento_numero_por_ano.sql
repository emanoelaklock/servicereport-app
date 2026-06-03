-- Numeração do orçamento com prefixo do ano: AA*10000 + sequência por ano.
-- 2026 -> 260001, 260002, …  |  2027 (a partir de 01/01) -> 270001, …
-- Vira do ano pelo fuso America/Sao_Paulo. Contador por ano em orcamento_seq
-- (à prova de colisão; não reaproveita números após exclusão).
-- numero deixa de ser GENERATED ALWAYS AS IDENTITY: o trigger atribui.
create table if not exists public.orcamento_seq (
  ano int primary key,
  ultimo int not null default 0
);
alter table public.orcamento_seq enable row level security;  -- sem policies: só a função SECURITY DEFINER escreve

create or replace function public.fn_orcamento_numero()
returns trigger language plpgsql security definer set search_path = public as $$
declare y int; seq int;
begin
  if new.numero is null then
    y := extract(year from (now() at time zone 'America/Sao_Paulo'))::int;
    insert into public.orcamento_seq(ano, ultimo) values (y, 1)
      on conflict (ano) do update set ultimo = public.orcamento_seq.ultimo + 1
      returning ultimo into seq;
    new.numero := (y % 100) * 10000 + seq;   -- ex.: 26*10000 + 1 = 260001
  end if;
  return new;
end $$;

drop trigger if exists trg_orcamento_numero on public.orcamentos;
create trigger trg_orcamento_numero
  before insert on public.orcamentos
  for each row execute function public.fn_orcamento_numero();

alter table public.orcamentos alter column numero drop identity if exists;
