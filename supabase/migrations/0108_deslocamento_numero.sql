-- 0108 — Nº oficial da VIAGEM (deslocamento): "V-0231"
-- Motivação: a gestão precisa de um identificador curto pra falar de uma viagem
-- ("dá uma olhada na V-231"), sem pegar emprestada a sequência da Tarefa/RAT —
-- viagem referencia tarefa (N:N via deslocamento_tarefas), não é filha dela.
-- Princípio do projeto: identidade offline = uuid do aparelho; número OFICIAL
-- nasce no SERVIDOR (default nextval no insert), nunca no cliente, nunca reutilizado.

create sequence if not exists public.deslocamento_numero_seq;

alter table public.deslocamentos add column if not exists numero integer;

-- Backfill das viagens existentes na ordem de criação (desempate por id).
-- Não altera nenhum dado existente — só preenche a coluna nova.
with ord as (
  select id, row_number() over (order by criado_em, id) as rn
  from public.deslocamentos
  where numero is null
)
update public.deslocamentos d set numero = ord.rn from ord where d.id = ord.id;

select setval('public.deslocamento_numero_seq',
              coalesce((select max(numero) from public.deslocamentos), 0) + 1,
              false);

alter table public.deslocamentos alter column numero set default nextval('public.deslocamento_numero_seq');
alter table public.deslocamentos alter column numero set not null;
alter table public.deslocamentos add constraint deslocamentos_numero_key unique (numero);
alter sequence public.deslocamento_numero_seq owned by public.deslocamentos.numero;

comment on column public.deslocamentos.numero is
  'Nº oficial da viagem (exibido como V-0231). Atribuído pelo servidor no insert; sequência própria, nunca reutilizada. Identidade offline segue sendo o uuid.';
