-- 0099 — Histórico de devoluções (estanca a perda: re-devolução sobrescrevia tudo)
-- Uma LINHA POR DEVOLUÇÃO com resolvida_em na própria linha:
--   reincidência = 2+ linhas na mesma tarefa · tempo de correção = resolvida_em − devolvida_em.
-- origem: 'ao_vivo' (trigger) × 'backfill' (reconstruída da última devolução conhecida —
-- série parcial NUNCA disfarçada de completa; lentes exibem com ressalva).
-- Trigger AFTER UPDATE OF status em tarefas: só INSERE/ATUALIZA em tarefa_devolucoes —
-- nenhuma escrita em tarefas/rats, sem recursão (mesmo padrão do 0095).

create table public.tarefa_devolucoes (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  devolvida_em timestamptz not null,
  cats text[],
  motivo text,
  detalhe text,
  devolvida_por uuid,
  resolvida_em timestamptz,
  resolvida_por uuid,
  origem text not null default 'ao_vivo' check (origem in ('ao_vivo','backfill'))
);
create index tarefa_devolucoes_tarefa_idx on public.tarefa_devolucoes (tarefa_id, devolvida_em);
alter table public.tarefa_devolucoes enable row level security;
create policy tdev_leitura_portal on public.tarefa_devolucoes
  for select using (public.app_role() in ('admin','gestor_axis'));
-- escrita: só o trigger (security definer); nenhum grant de insert/update pra clientes

create or replace function public.registra_devolucao_tarefa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- ENTROU em devolvida → nova linha (o motivo/cats/carimbo acabaram de ser gravados na tarefa)
  if new.status = 'devolvida' and old.status is distinct from 'devolvida' then
    insert into tarefa_devolucoes (tarefa_id, devolvida_em, cats, motivo, detalhe, devolvida_por)
    values (new.id, coalesce(new.devolvida_em, now()), new.motivo_devolucao_cats,
            new.motivo_devolucao, new.motivo_devolucao_detalhe, auth.uid());
  -- SAIU de devolvida → carimba a resolução na devolução aberta mais recente
  elsif old.status = 'devolvida' and new.status is distinct from 'devolvida' then
    update tarefa_devolucoes d set resolvida_em = now(), resolvida_por = auth.uid()
    where d.id = (select id from tarefa_devolucoes
                  where tarefa_id = new.id and resolvida_em is null
                  order by devolvida_em desc limit 1);
  end if;
  return new;
end $$;

drop trigger if exists trg_registra_devolucao on public.tarefas;
create trigger trg_registra_devolucao
  after update of status on public.tarefas
  for each row execute function public.registra_devolucao_tarefa();

-- BACKFILL (parcial e marcado): a última devolução conhecida de cada tarefa.
-- resolvida_em: desconhecida quando a tarefa já saiu de 'devolvida' → fica NULL
-- (a lente de tempo de correção IGNORA backfill; a de reincidência usa como piso).
insert into public.tarefa_devolucoes (tarefa_id, devolvida_em, cats, motivo, detalhe, origem)
select t.id, t.devolvida_em, t.motivo_devolucao_cats, t.motivo_devolucao, t.motivo_devolucao_detalhe, 'backfill'
from public.tarefas t
where t.devolvida_em is not null;
