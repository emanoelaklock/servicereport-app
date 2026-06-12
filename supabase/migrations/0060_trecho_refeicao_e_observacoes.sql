-- Refeição (almoço) passa a ser DO TRECHO: horários no próprio trecho,
-- descontados do tempo daquele trecho. deslocamento_almocos segue como
-- derivado por pessoa/dia (a dedup de um almoço por técnico/dia continua).
alter table public.deslocamento_trechos
  add column if not exists almoco_inicio time,
  add column if not exists almoco_fim    time;

-- Observações da viagem (campo livre, no final do formulário)
alter table public.deslocamentos
  add column if not exists observacoes text;
