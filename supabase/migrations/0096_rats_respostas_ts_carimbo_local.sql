-- 0096 — Carimbo local por campo (respostas_ts)
-- O app do técnico grava, a cada alteração de campo, o horário DO APARELHO em
-- respostas_ts[campo] (db-local.js/salvarRat) e o sync sobe junto (sync.js).
-- Uso futuro: métrica de preenchimento em tempo real v2 (quando o técnico
-- realmente preencheu, independente de quando o sync subiu — não pune o
-- offline-first) e proteção de campos por edição da gestão.
alter table public.rats add column if not exists respostas_ts jsonb;
comment on column public.rats.respostas_ts is 'Carimbo local por campo de respostas: {campo: timestamp ISO do aparelho no momento do preenchimento}. Gravado pelo app do técnico (0096).';
