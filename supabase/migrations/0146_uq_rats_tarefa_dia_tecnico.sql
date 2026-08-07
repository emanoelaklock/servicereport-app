-- 0146 — F3: rede no servidor contra RAT duplicada — UMA RAT por (tarefa, dia, TÉCNICO).
--
-- ⚠ ORDEM DE DEPLOY: aplicar SOMENTE depois do app com o tratamento do 23505 no ar
-- (sync.js marca `dupDiaRatsUpsert` → bloqueio nomeado sem loop, espelho do F19).
-- Aplicada antes, um app antigo que criasse duplicata entraria em retry infinito (F22-like).
--
-- O problema (F3, doc de robustez): a regra "uma RAT por tarefa/dia" vivia SÓ no app
-- (ratDoDiaDe). Dois aparelhos do mesmo técnico (2º offline, sem o pull topUpRats90)
-- criam client_uuid diferentes pro mesmo dia → duas RATs (caso 4852, consolidado na 0120).
--
-- DESVIOS do desenho original do doc, decididos no triple check de 07/08 (registrados lá):
-- · Escopo por TÉCNICO, não global (tarefa, dia): as policies de rats não dão a um técnico
--   visão nem escrita na RAT de outro dono (confirmado no F22) — um unique global
--   encalharia o trabalho do 2º técnico sem caminho de convergência (F19 sem saída).
--   Coexistência entre técnicos segue permitida e visível pro admin (F12/sobreposição).
-- · SEM client_uuid determinístico (UUIDv5): colidiria com o fluxo legítimo
--   "improdutiva fechada + nova RAT do dia" — o upsert por client_uuid ATUALIZARIA a
--   improdutiva em silêncio (perda de dado). A convergência online entre aparelhos do
--   mesmo técnico já existe (topUpRats90 hidrata o local; ratDoDiaDe reusa); o caso
--   offline é exatamente o que este índice intercepta (e o app trata sem loop).
--
-- Dia = a MESMA expressão imutável da família 0144/0145: Data declarada legível
-- (fn_date_ou_null, immutable desde a 0055) com fallback no carimbo em UTC.
-- Parcial: improdutiva FORA (visita fechada à parte + nova RAT do dia é fluxo legítimo);
-- status nulo (rascunho recém-criado) CONTA — `is distinct from` cobre.

create unique index if not exists uq_rats_tarefa_dia_tecnico
  on public.rats (tarefa_id, tecnico_id,
    coalesce(public.fn_date_ou_null(respostas->>'data'), (data_tarefa at time zone 'UTC')::date))
  where status is distinct from 'improdutiva'
    and tarefa_id is not null and tecnico_id is not null;

-- Guarda auto-abortante: índice presente, ÚNICO e parcial; e ZERO violações na base
-- (varredura pré-apply em 07/08: nenhuma — se algo entrou no meio, o CREATE acima já
-- teria falhado; esta guarda documenta e vigia a premissa).
do $$
declare n_idx int; n_dup int;
begin
  select count(*) into n_idx
    from pg_indexes
   where schemaname = 'public' and tablename = 'rats'
     and indexname = 'uq_rats_tarefa_dia_tecnico'
     and indexdef ilike 'create unique index%'
     and indexdef ilike '%where%';
  if n_idx <> 1 then raise exception '0146: índice ausente ou sem unique/parcial — abortando'; end if;

  select count(*) into n_dup from (
    select 1
      from public.rats
     where status is distinct from 'improdutiva'
       and tarefa_id is not null and tecnico_id is not null
     group by tarefa_id, tecnico_id,
              coalesce(public.fn_date_ou_null(respostas->>'data'), (data_tarefa at time zone 'UTC')::date)
    having count(*) > 1
  ) d;
  if n_dup > 0 then raise exception '0146: % grupo(s) duplicado(s) na base — abortando', n_dup; end if;
end $$;
