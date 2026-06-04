-- Cláusulas padrão do orçamento, armazenadas como chaves estáveis (horario/estoque/escopo).
alter table public.orcamentos
  add column if not exists clausulas text[] not null default '{}'::text[];

-- Migra a cláusula de horário que hoje vive embutida no texto de observacoes.
update public.orcamentos
set clausulas = array['horario']::text[],
    observacoes = nullif(btrim(replace(observacoes,
      'Serviço executado em horário comercial (segunda a sexta, das 7h às 17h).', '')), '')
where coalesce(observacoes,'') like '%Serviço executado em horário comercial%'
  and not ('horario' = any(clausulas));
