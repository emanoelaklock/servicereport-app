-- 0121 — Dedup por CONTEÚDO das fotos da RAT 4852/01 (complemento da 0120).
-- A checagem por hash (storage.objects.metadata eTag/MD5 + size) revelou que as 16 fotos
-- vindas da /02 incluíam re-upload byte-idêntico das 10 fotos originais da /01 (duas delas
-- em dobro): conteúdo único real = 14 (10 originais da /01 + 4 exclusivas da /02).
-- Remove as 12 linhas redundantes de relatorio_fotos, mantendo sempre a cópia mais antiga
-- de cada conteúdo. Os ARQUIVOS no Storage não são tocados (ficam órfãos inofensivos,
-- ~1,4 MB, referenciados no backup). Backup: as 26 linhas estão em backup_0120_rats_4852.
-- Falhou qualquer validação → exception → rollback total.

do $$
declare
  RAT1   constant uuid := '4a654967-86b1-4933-af9d-38583aeacee8';  -- 4852/01
  TAREFA constant uuid := '809fff59-7998-4bc5-a0c1-2be686c6f9a0';  -- Tarefa 4852
  ATOR   constant uuid := '3a5ad908-b609-4000-9235-0d616a3f2a9b';  -- Emanoela Klock (gestão)
  v_total int; v_unicos int; v_n int;
begin
  -- ── Guard: estado esperado (pós-0120: 26 fotos, 14 conteúdos distintos) ──
  select count(*), count(distinct (o.metadata->>'eTag') || ':' || (o.metadata->>'size'))
    into v_total, v_unicos
    from relatorio_fotos f
    join storage.objects o on o.bucket_id = 'rat-anexos' and o.name = f.url
   where f.rat_id = RAT1;
  if v_total <> 26 or v_unicos <> 14 then
    raise exception '0121: esperava 26 fotos / 14 conteúdos na /01, achei % / %', v_total, v_unicos;
  end if;

  -- ── Seleciona as redundantes: toda foto com irmã de MESMO conteúdo mais antiga ──
  -- (empate de criado_em desempata por id — garante exatamente 1 sobrevivente por conteúdo)
  create temp table tmp_0121_dup on commit drop as
  select f.id, f.url, f.legenda, f.criado_em
    from relatorio_fotos f
    join storage.objects o on o.bucket_id = 'rat-anexos' and o.name = f.url
   where f.rat_id = RAT1
     and exists (
       select 1
         from relatorio_fotos g
         join storage.objects og on og.bucket_id = 'rat-anexos' and og.name = g.url
        where g.rat_id = RAT1 and g.id <> f.id
          and og.metadata->>'eTag' = o.metadata->>'eTag'
          and og.metadata->>'size' = o.metadata->>'size'
          and (g.criado_em < f.criado_em or (g.criado_em = f.criado_em and g.id < f.id))
     );
  select count(*) into v_n from tmp_0121_dup;
  if v_n <> 12 then raise exception '0121: esperava 12 duplicadas, achei %', v_n; end if;
  -- todas as redundantes devem ser do lote re-enviado (pasta da /02); nenhuma original da /01
  select count(*) into v_n from tmp_0121_dup where url like '%752e6565%';
  if v_n <> 0 then raise exception '0121: % originais da /01 marcadas como duplicadas', v_n; end if;

  -- ── Trilha: uma linha de rat_edicoes por foto removida (formato da Edge rat-editar) ──
  insert into rat_edicoes (rat_id, tarefa_id, alvo, operacao, chave, valor_antigo,
                           motivo, motivo_detalhe, ator, ator_nome)
  select RAT1, TAREFA, 'foto', 'delete', d.id::text,
         jsonb_build_object('id', d.id, 'url', d.url, 'legenda', d.legenda),
         'outro',
         'Dedup por hash (0121): cópia byte-idêntica (mesmo eTag/tamanho no Storage) de foto '
         || 'já presente na RAT — re-upload do sync ao consolidar a 4852/02. Linha íntegra em backup_0120_rats_4852.',
         ATOR, public._ator_nome(ATOR)
    from tmp_0121_dup d;

  insert into auditoria (tarefa_id, entidade, entidade_id, acao, detalhe, ator, ator_nome)
  values (TAREFA, 'rat', RAT1, 'rat_consolidada',
          'Dedup por conteúdo (hash) das fotos da 4852/01: 12 cópias re-enviadas removidas; '
          || 'ficam 14 fotos únicas (10 originais + 4 exclusivas da ex-/02). Migração 0121.',
          ATOR, public._ator_nome(ATOR));

  -- ── Remove as redundantes (só as linhas; arquivos do Storage ficam) ──
  delete from relatorio_fotos where id in (select id from tmp_0121_dup);

  -- ── Validações finais ──
  select count(*), count(distinct (o.metadata->>'eTag') || ':' || (o.metadata->>'size'))
    into v_total, v_unicos
    from relatorio_fotos f
    join storage.objects o on o.bucket_id = 'rat-anexos' and o.name = f.url
   where f.rat_id = RAT1;
  if v_total <> 14 or v_unicos <> 14 then
    raise exception '0121: resultado % fotos / % conteúdos (esperava 14/14)', v_total, v_unicos;
  end if;
  -- as 10 originais da /01 continuam lá
  select count(*) into v_n from relatorio_fotos where rat_id = RAT1 and url like '%752e6565%';
  if v_n <> 10 then raise exception '0121: originais da /01 = % (esperava 10)', v_n; end if;
  -- as 4 exclusivas da ex-/02 continuam lá
  select count(*) into v_n from relatorio_fotos
   where rat_id = RAT1 and id in ('c201dc51-c96b-4faa-a8be-9bda20086ee7','f4c6a8bb-0d53-4757-8d9d-560c6be9574c',
                                  '54558dc3-cc69-4698-8a66-23f8a5122bb2','990d5cae-21a4-40b2-b74b-fadfb276302e');
  if v_n <> 4 then raise exception '0121: exclusivas da /02 = % (esperava 4)', v_n; end if;
  -- nada fora da /01 foi tocado nesta migração (escopo era rat_id = RAT1)
  if (select tem_foto from rats where id = RAT1) is not true then
    raise exception '0121: tem_foto da /01 deveria seguir true';
  end if;
end $$;
