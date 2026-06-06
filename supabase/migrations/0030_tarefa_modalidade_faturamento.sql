-- §10.1 Modalidade de faturamento (1a fatia: no nível da Tarefa; admin classifica).
-- null = pendente de classificação. Entidade contrato/obra (derivação) vem depois.
alter table public.tarefas
  add column if not exists modalidade text
    check (modalidade in ('por_hora','projeto_fechado','contrato','nao_faturavel')),
  add column if not exists valor_hora numeric;
