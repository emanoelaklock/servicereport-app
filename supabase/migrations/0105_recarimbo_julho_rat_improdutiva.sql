-- 0105 — Recarimbo do snapshot de julho/2026 após a reclassificação auditada da
-- RAT 04817/01 (02/07) para VISITA IMPRODUTIVA (feita pela gestão via UI nova do
-- rat-editar, alvo 'status' — rastro em rat_edicoes). A RAT era um "registrado"
-- vazio criado pelo resolvedor de pausa esquecida; a passagem provava impedimento
-- do cliente (andaime). Improdutiva sai da régua → o retrato oficial muda.
delete from desempenho_snapshots where mes = '2026-07';
insert into desempenho_snapshots (mes, tecnico_id, dados, nota)
select mes, tecnico_id, to_jsonb(v.*), nota
  from vw_desempenho_mensal v
 where mes = '2026-07';
