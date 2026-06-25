-- 0084: conflito de material em RAT colaborativa — FASE 3 (detecção DERIVADA, sem trigger).
-- Conta autores DISTINTOS (created_by não-nulo) com material 'usado' por RAT. >=2 → conflito.
-- Sem trigger de propósito: gravar flag em rats dispararia rat_inicia_tarefa (poderia virar o
-- status da Tarefa) e um trigger em materiais recursionaria. Derivar é seguro e dá o mesmo gate.
-- Teste crítico: mesmo autor re-sincronizando = 1 autor distinto → NUNCA acusa conflito falso.
-- Legado (created_by NULL) é ignorado → sem conflito retroativo.
create or replace view public.vw_rat_material_conflito as
select m.rat_id,
       r.tarefa_id,
       count(distinct m.created_by) filter (where m.created_by is not null) as autores,
       (count(distinct m.created_by) filter (where m.created_by is not null) >= 2) as em_conflito
from public.materiais m
join public.rats r on r.id = m.rat_id
where m.origem = 'usado'
group by m.rat_id, r.tarefa_id;
