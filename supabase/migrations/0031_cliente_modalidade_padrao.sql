-- §10.1 fase 2: modalidade padrão no nível do cliente/obra → deriva p/ a tarefa.
-- (No cadastro Omie os clientes já são por obra: ex. "WestRock - FBTB".)
alter table public.clientes
  add column if not exists modalidade_padrao text
    check (modalidade_padrao in ('por_hora','projeto_fechado','contrato','nao_faturavel')),
  add column if not exists valor_hora_padrao numeric,
  add column if not exists dia_continuo boolean not null default false;
