-- 0070: campo "Pendência do atendimento" na pausa do MESMO DIA (Houve pausa? = Sim).
-- É um campo de CONFIG (formulario_modelos.campos) — o renderizador genérico do app já o
-- exibe no modal Pausa, salva em respostas e mostra no portal/PDF. NÃO mexe em status
-- (decisão (b): pausa de mesmo dia não flipa a Tarefa). Opcional (obrigatorio=false) pra
-- não travar pausa de almoço/café. Inserido logo após 'pausa_motivo', condicional a pausa=Sim.
-- Idempotente: só insere se ainda não existir o campo 'pausa_pendencia' no modelo.

update public.formulario_modelos m
set campos = (
  select jsonb_agg(val order by ord)
  from (
    select val, ord::numeric as ord
      from jsonb_array_elements(m.campos) with ordinality e(val, ord)
    union all
    select jsonb_build_object(
             'id', 'pausa_pendencia',
             'tipo', 'texto',
             'label', 'Pendência do atendimento',
             'cond', jsonb_build_object('logica','E','regras',
                       jsonb_build_array(jsonb_build_object('op','igual','campo','pausa','valor','Sim'))),
             'obrigatorio', false
           ),
           (select (ord)::numeric + 0.5
              from jsonb_array_elements(m.campos) with ordinality e2(val, ord)
             where val->>'id' = 'pausa_motivo')
  ) s
)
where m.nome = 'Relatório de Atendimento Técnico'
  and not exists (
    select 1 from jsonb_array_elements(m.campos) c where c->>'id' = 'pausa_pendencia'
  );

-- DOWN:
--   update public.formulario_modelos m
--   set campos = (select jsonb_agg(val) from jsonb_array_elements(m.campos) val
--                 where val->>'id' <> 'pausa_pendencia')
--   where m.nome = 'Relatório de Atendimento Técnico';
