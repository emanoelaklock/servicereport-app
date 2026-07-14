-- 0104 — Remove a janela de instabilidade 30/06→06/07 (decisão da gestão, 14/07)
-- Veredito operacional: o app NÃO estava instável pra equipe após os hotfixes de 30/06
-- (v559/v560) — 17 das 25 RATs escondidas pela janela foram encerradas em D+0.
-- As 8 restantes (5 do Pablo, encerradas em mutirão em 09/07) passam a contar como
-- atrasadas reais: a gestão decidiu não dar o benefício da janela.
-- O MECANISMO (app_instabilidade_janelas + faixa 'fora_janela_bug') fica intacto
-- para incidentes futuros; só a linha semeada na 0098 sai.
delete from app_instabilidade_janelas
 where inicio = date '2026-06-30' and fim = date '2026-07-06';

-- Recarimbo do snapshot de julho/2026: o retrato oficial de pré-lançamento tinha sido
-- carimbado COM a janela (14/07 13:56 — registrado no spec como primeira calibragem);
-- sem ela os números mudam, então a base de decisão é recarimbada agora.
-- (Direto no SQL porque gerar_snapshot_desempenho exige painel ligado — gate intacto.)
delete from desempenho_snapshots where mes = '2026-07';
insert into desempenho_snapshots (mes, tecnico_id, dados, nota)
select mes, tecnico_id, to_jsonb(v.*), nota
  from vw_desempenho_mensal v
 where mes = '2026-07';
