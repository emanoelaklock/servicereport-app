-- 0083: conflito de material em RAT colaborativa — FASE 1 (schema).
-- Princípio (§8): material é da RAT, lançado UMA vez. Quando 2+ autores/aparelhos lançam material
-- na MESMA RAT (offline-concorrente), o servidor NÃO soma em silêncio — vai marcar conflito e tirar
-- do faturamento até o admin resolver. Aqui só o esquema; a DETECÇÃO (trigger), o GATE de
-- faturamento e a RESOLUÇÃO (editor de RAT) vêm nas fases 3/4/5.
--
-- Aditivo e seguro: colunas novas com default; nada apagado. created_by NULL = legado (autor
-- desconhecido) → NÃO dispara conflito retroativo (a detecção conta só autores não-nulos distintos).

alter table public.materiais
  add column if not exists created_by uuid,     -- técnico que lançou a linha (carimbado no enviarRat — fase 2)
  add column if not exists device_id  uuid,     -- aparelho de origem (diagnóstico)
  add column if not exists conflito   boolean not null default false;  -- linha marcada na detecção (fase 3)

alter table public.rats
  add column if not exists material_conflito boolean not null default false;  -- sinal p/ UI/gate (fase 3/4)

-- A detecção e a hidratação filtram materiais por rat_id; hoje não há índice nessa coluna.
create index if not exists materiais_rat_idx on public.materiais(rat_id);

-- DOWN:
-- drop index public.materiais_rat_idx;
-- alter table public.materiais drop column created_by, drop column device_id, drop column conflito;
-- alter table public.rats drop column material_conflito;
