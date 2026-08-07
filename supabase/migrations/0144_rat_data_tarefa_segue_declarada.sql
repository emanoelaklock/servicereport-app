-- 0144 — data_tarefa SEGUE a Data declarada da RAT (respostas.data) — caso 4959/01.
--
-- O bug: o calendário de RATs do portal BUSCA o mês por data_tarefa e POSICIONA o chip
-- pela Data declarada (respostas.data). data_tarefa é fixado na criação (dia local do
-- aparelho — F1/cc9d849) e NÃO acompanhava a Data declarada; RAT criada retroativamente
-- em outro mês ficava invisível nos DOIS meses (julho não a busca, agosto não tem a
-- célula). Caso real: 4959/01 (criada 05/08, serviço 28/07) — corrigida à mão antes
-- desta migração; a base tinha mais 7 divergências de DIA (mesmo mês), todas o mesmo
-- padrão de RAT retroativa, cobertas pelo backfill abaixo.
--
-- O fix: a Data declarada é a fonte (decisão 07/08/2026 — "a data da RAT, não a da
-- criação"). Trigger BEFORE INSERT/UPDATE re-deriva data_tarefa = meia-noite UTC da
-- Data declarada (a MESMA convenção já gravada pelo app: jorHoje() → timestamptz vira
-- 00:00Z; documentada em js/rat-calendario.js). Interpretação da Data declarada pelo
-- fn_date_ou_null (0055) — o MESMO parser da vw_participacoes_dia/0055, então todos os
-- consumidores convergem. Data declarada ausente/ilegível: mantém o data_tarefa que
-- veio (fallback continua sendo o dia da criação; nunca bloqueia um save).
-- Sem SECURITY DEFINER: a função só escreve em NEW (nada de SELECT em tabela com RLS).

create or replace function public.tg_rat_data_declarada()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare d date;
begin
  d := public.fn_date_ou_null(new.respostas->>'data');
  if d is not null then
    new.data_tarefa := (d::text || 'T00:00:00Z')::timestamptz;
  end if;
  return new;
end $$;

drop trigger if exists trg_rat_data_declarada on public.rats;
create trigger trg_rat_data_declarada
before insert or update of respostas, data_tarefa on public.rats
for each row execute function public.tg_rat_data_declarada();

-- Backfill: alinha o legado divergente (7 RATs no apply; a 4959/01 já tinha sido
-- corrigida à mão). Só toca linhas cuja Data declarada é legível E difere do carimbo.
-- O que se perde: o data_tarefa antigo dessas linhas (= dia da criação) — que continua
-- recuperável por criado_em; a Data declarada (fonte) fica intacta.
update public.rats
   set data_tarefa = (public.fn_date_ou_null(respostas->>'data')::text || 'T00:00:00Z')::timestamptz
 where public.fn_date_ou_null(respostas->>'data') is not null
   and public.fn_date_ou_null(respostas->>'data')::text
       is distinct from to_char(data_tarefa at time zone 'UTC', 'YYYY-MM-DD');

-- Guarda auto-abortante: trigger apontando pra função + ZERO divergências restantes.
do $$
declare n_trg int; n_div int;
begin
  select count(*) into n_trg
    from pg_trigger t
   where t.tgrelid = 'public.rats'::regclass
     and t.tgfoid = 'public.tg_rat_data_declarada'::regproc
     and not t.tgisinternal;
  if n_trg < 1 then raise exception '0144: trigger de rats não aponta pra tg_rat_data_declarada — abortando'; end if;

  select count(*) into n_div
    from public.rats
   where public.fn_date_ou_null(respostas->>'data') is not null
     and public.fn_date_ou_null(respostas->>'data')::text
         is distinct from to_char(data_tarefa at time zone 'UTC', 'YYYY-MM-DD');
  if n_div > 0 then raise exception '0144: % RAT(s) ainda com data_tarefa divergente da declarada — abortando', n_div; end if;
end $$;
