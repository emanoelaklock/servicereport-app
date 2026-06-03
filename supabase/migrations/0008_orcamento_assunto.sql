-- Assunto/título curto do orçamento (subtítulo no PDF, ex.:
-- "Instalação de infraestrutura de rede Cat6A para sistema de CFTV").
alter table public.orcamentos add column if not exists assunto text;
