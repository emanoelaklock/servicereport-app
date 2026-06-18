-- 0064: Deslocamento da RAT vira IDA e RETORNO independentes.
--
-- Hoje há UMA pergunta `deslocamento` (Sim/Não) e os 4 campos de hora
-- (ida inicial/final, retorno inicial/final) são todos condicionados a ela.
-- Passa a haver DUAS perguntas independentes:
--   · `desloc_ida`     → revela desloc_inicial_ida / desloc_final_ida
--   · `desloc_retorno` → revela desloc_inicial_retorno / desloc_final_retorno
-- `hora_inicio espelha desloc_final_ida` e `hora_termino espelha desloc_inicial_retorno`
-- continuam valendo (pré-preenchimento).
--
-- A pergunta `deslocamento` (id) é RENOMEADA para `desloc_ida` (preserva tipo/opções/
-- obrigatoriedade) e um novo toggle `desloc_retorno` é inserido imediatamente antes do
-- bloco de retorno. Os campos de hora têm o `cond.regras[0].campo` recondicionado.
--
-- IDEMPOTENTE: só age em formulários que ainda contêm o campo `deslocamento`
-- (depois de rodar, ele some → reexecução é no-op).
--
-- ⚠ ACOPLAMENTO COM DEPLOY: o app de produção (sem este pacote) só conhece a chave
-- `deslocamento`. Aplicar esta migration ANTES de publicar o front quebraria o
-- formulário dos técnicos em campo. Rodar SOMENTE junto/depois do deploy do front.
--
-- DOWN (reverter, se necessário) — bloco comentado no fim.

do $$
declare
  f record;
  novo jsonb;
begin
  for f in
    select id, campos from formulario_modelos
    where campos @> '[{"id":"deslocamento"}]'::jsonb
  loop
    select jsonb_agg(elem order by ord) into novo
    from (
      -- transforma os elementos existentes
      select e.ord::numeric as ord,
        case
          when e.campo->>'id' = 'deslocamento'
            then (e.campo - 'id') || jsonb_build_object('id', 'desloc_ida', 'label', 'Deslocamento de ida')
          when e.campo->>'id' in ('desloc_inicial_ida', 'desloc_final_ida')
            then jsonb_set(e.campo, '{cond,regras,0,campo}', '"desloc_ida"')
          when e.campo->>'id' in ('desloc_inicial_retorno', 'desloc_final_retorno')
            then jsonb_set(e.campo, '{cond,regras,0,campo}', '"desloc_retorno"')
          else e.campo
        end as elem
      from jsonb_array_elements(f.campos) with ordinality as e(campo, ord)

      union all

      -- insere o toggle de retorno logo ANTES do desloc_inicial_retorno
      select (e.ord - 0.5)::numeric as ord,
             jsonb_build_object(
               'id', 'desloc_retorno', 'tipo', 'selecao', 'label', 'Deslocamento de retorno',
               'opcoes', jsonb_build_array('Sim', 'Não'), 'obrigatorio', true
             ) as elem
      from jsonb_array_elements(f.campos) with ordinality as e(campo, ord)
      where e.campo->>'id' = 'desloc_inicial_retorno'
    ) s;

    update formulario_modelos set campos = novo where id = f.id;
  end loop;
end $$;

-- ───────────────────────── DOWN (reverter) ─────────────────────────
-- do $$
-- declare f record; novo jsonb;
-- begin
--   for f in select id, campos from formulario_modelos where campos @> '[{"id":"desloc_ida"}]'::jsonb loop
--     select jsonb_agg(elem order by ord) into novo from (
--       select e.ord::numeric as ord,
--         case
--           when e.campo->>'id' = 'desloc_ida'
--             then (e.campo - 'id') || jsonb_build_object('id','deslocamento','label','Deslocamento')
--           when e.campo->>'id' in ('desloc_inicial_ida','desloc_final_ida','desloc_inicial_retorno','desloc_final_retorno')
--             then jsonb_set(e.campo, '{cond,regras,0,campo}', '"deslocamento"')
--           else e.campo
--         end as elem
--       from jsonb_array_elements(f.campos) with ordinality as e(campo, ord)
--       where e.campo->>'id' <> 'desloc_retorno'
--     ) s;
--     update formulario_modelos set campos = novo where id = f.id;
--   end loop;
-- end $$;
