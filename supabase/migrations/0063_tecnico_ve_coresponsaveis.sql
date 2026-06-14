-- Técnico de campo passa a enxergar os CO-RESPONSÁVEIS das tarefas onde ELE JÁ é responsável
-- (pra a RAT pré-preencher a equipe da tarefa, não só quem está logado).
--
-- ADITIVO e mínimo: mexe SÓ no SELECT do técnico em tarefa_tecnicos. Nada muda pra
-- admin/gestor (tt_office_all), nem pro INSERT do técnico (tt_tecnico_ins), nem em
-- qualquer outra tabela. O técnico continua SEM ver tarefas/linhas que não são dele.

-- Apoio: por que NÃO há recursão de RLS.
-- Se o EXISTS(select ... from tarefa_tecnicos ...) ficasse DIRETO no USING da política,
-- esse select interno seria submetido de novo à própria política de SELECT → que tem o
-- EXISTS de novo → recursão infinita (Postgres aborta com "infinite recursion in policy").
-- Aqui o EXISTS vive numa função SECURITY DEFINER: ela roda como o DONO da função (que é
-- dono da tabela e ignora RLS), então o select interno NÃO re-dispara a política. Sem loop.
-- 'stable' = mesmo resultado dentro do mesmo statement; 'set search_path' protege a função
-- SECURITY DEFINER contra sequestro de search_path.
create or replace function public.sou_responsavel_tarefa(p_tarefa uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tarefa_tecnicos tt
    where tt.tarefa_id = p_tarefa
      and tt.tecnico_id = auth.uid()
  )
$$;

grant execute on function public.sou_responsavel_tarefa(uuid) to authenticated;

-- Política nova de SELECT do técnico: a própria linha (como antes) OU as linhas de
-- tarefas onde ele já é responsável. Só isso é afrouxado.
drop policy if exists tt_tecnico_sel on public.tarefa_tecnicos;
create policy tt_tecnico_sel on public.tarefa_tecnicos
  for select
  using (
    app_role() = 'tecnico_campo'
    and (
      tecnico_id = auth.uid()
      or public.sou_responsavel_tarefa(tarefa_id)
    )
  );
