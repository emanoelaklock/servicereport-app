-- 0120 — Consolidação das RATs duplicadas da Tarefa 4852 (dia 14/07/2026, WESTROCK - FLO).
-- Contexto: o dedup client-side `ratDoDiaDe` não enxergava RAT rascunho sem `status`
-- (novoRat nasce sem o campo; só o 1º "Salvar e continuar" o define), então o 2º check-in
-- do dia (15:26, após liberação da PT) criou a RAT /02 no MESMO aparelho com a /01 aberta.
-- As duas descrevem o mesmo dia: /01 14:38–17:30 (preventiva + espera da PT) e /02
-- 15:26–17:30 (serviço pós-PT, preenchida no dia 15 durante o retorno) — 2h04 duplicadas
-- por técnico nas participações. Fix do app na sequência (tecnico.js, fallback de status).
--
-- Decisão de gestão (Emanoela Klock, 20/07/2026):
--   * manter a /01 (14:38–17:30) como única RAT do dia;
--   * consolidar nela o serviço executado da /02 (conteúdo exclusivo) e as 16 fotos;
--   * observações da /02 descartadas por duplicidade semântica com a /01 (mesmo aviso
--     sobre limpeza acima de 1,5 m / restrição de escada — preservadas no backup);
--   * excluir a /02 com trilha em rat_edicoes + auditoria.
--
-- Backup (ANTES desta migração): tabela public.backup_0120_rats_4852 (rats, rat_tecnicos,
-- relatorio_fotos, sync_eventos — linhas jsonb íntegras) + cópia JSON externa da gestão.
--
-- O que pode dar errado e como está mitigado:
--   * FK cascade apagaria as fotos da /02 no delete → fotos movidas ANTES do delete;
--   * trigger 0095 (audita_sync_pos_ajuste) atribuiria a edição ao técnico → o merge de
--     respostas e ajustada_gestao=true vão no MESMO update (old.ajustada_gestao=false →
--     trigger sai cedo e nada é logado como 'sync_app');
--   * re-envio pelo aparelho → a /02 está `confirmado` no device; o delete dispara
--     trg_tomb_rats (tombstone por client_uuid) e o pull remove a cópia local (0039/0040);
--   * trigger rat_inicia_tarefa no update da /01 → alvo 'em_execucao' = status atual (no-op);
--   * materiais/sync_eventos têm FK NO ACTION e bloqueariam o delete → removidos antes,
--     espelhando a RPC oficial admin_excluir_rat (0024); sync_eventos preservados no backup;
--   * qualquer estado inesperado → exception → rollback TOTAL (nada é aplicado pela metade).

create table if not exists public.backup_0120_rats_4852 (
  tabela   text not null,
  dados    jsonb not null,
  salvo_em timestamptz not null default now()
);
alter table public.backup_0120_rats_4852 enable row level security;

do $$
declare
  RAT1   constant uuid := '4a654967-86b1-4933-af9d-38583aeacee8';  -- 4852/01 (permanece)
  RAT2   constant uuid := 'b51c8b22-d245-42ef-87bd-0d54c2215318';  -- 4852/02 (consolidada e excluída)
  CU2    constant uuid := '1be85ebc-2fc9-45ed-8d3f-ed8c8f055feb';  -- client_uuid da /02 (tombstone)
  TAREFA constant uuid := '809fff59-7998-4bc5-a0c1-2be686c6f9a0';  -- Tarefa 4852
  ATOR   constant uuid := '3a5ad908-b609-4000-9235-0d616a3f2a9b';  -- Emanoela Klock (gestão)
  v_serv1  text; v_serv2 text; v_merged text;
  v_obs2   text; v_ts2 jsonb; v_n int;
begin
  -- ── Guards: o banco precisa estar exatamente no estado esperado ──
  select respostas->>'servico_executado' into v_serv1 from rats
   where id = RAT1 and tarefa_id = TAREFA and rat_seq = 1 and status = 'registrado'
     and respostas->>'hora_inicio' = '14:38' and respostas->>'hora_termino' = '17:30';
  if v_serv1 is null then raise exception '0120: RAT /01 fora do estado esperado'; end if;
  if v_serv1 like '%Abertura de PT%' then raise exception '0120: /01 já consolidada — abortando'; end if;

  select respostas->>'servico_executado', respostas->>'observacoes', respostas_ts->'servico_executado'
    into v_serv2, v_obs2, v_ts2
    from rats
   where id = RAT2 and tarefa_id = TAREFA and rat_seq = 2 and client_uuid = CU2
     and status = 'registrado' and faturado = false;
  if v_serv2 is null or v_serv2 not like '%Abertura de PT%' then
    raise exception '0120: RAT /02 fora do estado esperado';
  end if;

  select count(*) into v_n from relatorio_fotos where rat_id = RAT2;
  if v_n <> 16 then raise exception '0120: esperava 16 fotos na /02, achei %', v_n; end if;
  select count(*) into v_n from materiais where rat_id in (RAT1, RAT2);
  if v_n <> 0 then raise exception '0120: materiais inesperados nas RATs (%)', v_n; end if;
  select count(*) into v_n from backup_0120_rats_4852;
  if v_n < 58 then raise exception '0120: backup ausente/incompleto (% linhas) — rode o backup antes', v_n; end if;

  -- ── 1) Fotos da /02 passam a pertencer à /01 (antes do delete: FK é cascade) ──
  -- Os arquivos no Storage não mudam de pasta; relatorio_fotos.url segue válido.
  update relatorio_fotos set rat_id = RAT1 where rat_id = RAT2;
  get diagnostics v_n = row_count;
  if v_n <> 16 then raise exception '0120: moveu % fotos (esperava 16)', v_n; end if;

  -- ── 2) Consolida o serviço executado na /01 + marca ajuste de gestão ──
  -- Texto do técnico preservado verbatim (inclusive grafia). O carimbo local do campo
  -- passa a ser o da digitação da parte nova (15/07 14:38 local, vindo da /02) — é quando
  -- o conteúdo final foi realmente escrito. ajustada_gestao no MESMO update (ver cabeçalho).
  v_merged := v_serv1 || E'\n' || v_serv2;
  update rats set
    respostas    = jsonb_set(respostas, '{servico_executado}', to_jsonb(v_merged)),
    respostas_ts = jsonb_set(coalesce(respostas_ts, '{}'::jsonb), '{servico_executado}', coalesce(v_ts2, 'null'::jsonb)),
    ajustada_gestao = true, ajustada_por = ATOR, ajustada_em = now()
  where id = RAT1;

  -- ── 3) Trilha de edição da /01 (mesmo formato da Edge rat-editar) ──
  insert into rat_edicoes (rat_id, tarefa_id, alvo, operacao, campo, valor_antigo, valor_novo,
                           motivo, motivo_detalhe, ator, ator_nome)
  values (RAT1, TAREFA, 'campo', 'update', 'servico_executado',
          to_jsonb(v_serv1), to_jsonb(v_merged), 'outro',
          'Consolidação da RAT 4852/02 (duplicada no dia 14/07 pelo bug do dedup por status ausente). '
          || 'Fotos (16) movidas para a /01; observações da /02 descartadas por duplicidade; '
          || 'backup em backup_0120_rats_4852.',
          ATOR, public._ator_nome(ATOR));

  -- ── 4) Auditoria (o trigger audit_rats não cobre edição de respostas nem delete) ──
  insert into auditoria (tarefa_id, entidade, entidade_id, acao, detalhe, ator, ator_nome) values
    (TAREFA, 'rat', RAT1, 'rat_consolidada',
     'RAT 4852/01 recebeu o serviço executado e as 16 fotos da 4852/02 (mesmo dia 14/07). Migração 0120.',
     ATOR, public._ator_nome(ATOR)),
    (TAREFA, 'rat', RAT2, 'rat_excluida',
     'RAT 4852/02 (client_uuid ' || CU2 || ', 15:26–17:30 de 14/07) excluída após consolidação na /01 — '
     || 'horas 15:26–17:30 estavam duplicadas para Charles Tomio e Max Macedo. Backup em backup_0120_rats_4852. Migração 0120.',
     ATOR, public._ator_nome(ATOR));

  -- ── 5) Exclui a /02 (espelha admin_excluir_rat/0024; delete gera tombstone via trg_tomb_rats) ──
  delete from materiais    where rat_id = RAT2;   -- 0 linhas hoje (guard acima)
  delete from sync_eventos where rat_id = RAT2;   -- 16 linhas, preservadas no backup
  delete from rats         where id = RAT2;       -- cascade: rat_tecnicos; tombstone: client_uuid

  -- ── 6) Validações finais (falhou → rollback de tudo) ──
  select count(*) into v_n from rats where tarefa_id = TAREFA and respostas->>'data' = '2026-07-14';
  if v_n <> 1 then raise exception '0120: dia 14/07 deveria ter 1 RAT, tem %', v_n; end if;

  select count(*) into v_n from relatorio_fotos where rat_id = RAT1;
  if v_n <> 26 then raise exception '0120: /01 deveria ter 26 fotos, tem %', v_n; end if;

  select count(*) into v_n from rat_tecnicos where rat_id = RAT1;
  if v_n <> 2 then raise exception '0120: /01 deveria ter 2 participações, tem %', v_n; end if;

  select (select count(*) from relatorio_fotos where rat_id = RAT2)
       + (select count(*) from rat_tecnicos    where rat_id = RAT2)
       + (select count(*) from rat_edicoes     where rat_id = RAT2)
       + (select count(*) from materiais       where rat_id = RAT2)
       + (select count(*) from sync_eventos    where rat_id = RAT2)
       + (select count(*) from almocos         where artefato_tipo = 'rat' and artefato_id = RAT2)
       + (select count(*) from almoco_conflitos where artefato_tipo = 'rat' and artefato_id = RAT2)
       + (select count(*) from tarefas         where rat_origem_id = RAT2)
    into v_n;
  if v_n <> 0 then raise exception '0120: % referências órfãs à /02 restaram', v_n; end if;

  if not exists (select 1 from sync_tombstones where tabela = 'rats' and registro_id = CU2::text) then
    raise exception '0120: tombstone da /02 não foi criado';
  end if;

  select count(*) into v_n from vw_participacoes_dia
   where dia = '2026-07-14' and artefato_tipo = 'rat' and artefato_id = RAT1;
  if v_n <> 2 then raise exception '0120: participações do dia 14 na /01 deveriam ser 2, são %', v_n; end if;
  if exists (select 1 from vw_participacoes_dia where artefato_id = RAT2) then
    raise exception '0120: /02 ainda aparece nas participações';
  end if;

  if (select status from tarefas where id = TAREFA) <> 'em_execucao' then
    raise exception '0120: status da tarefa mudou indevidamente';
  end if;
end $$;
