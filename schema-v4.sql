-- =====================================================================
--  SERVICE REPORT — Schema v4
--  Mudanças desde o v3:
--   + clientes e produtos passam a vir do OMIE (fonte da verdade dos cadastros)
--   + nova tabela produtos (catálogo)
--   + materiais agora referenciam o catálogo de produtos
--
--  Origem dos dados:
--   OMIE   -> clientes, produtos, OS (material levado)
--   NATIVO -> tarefas/RATs criadas no próprio sistema (sem integração com a Auvo)
--   (origem_registro mantém 'auvo' apenas para importação histórica, se necessário)
-- =====================================================================


-- =====================================================================
--  NÚCLEO COMPARTILHADO
-- =====================================================================

-- 1. CLIENTES  (fonte: Omie)
create table if not exists clientes (
  id                uuid primary key default gen_random_uuid(),
  omie_cliente_id   text unique,            -- fonte da verdade (Omie)
  auvo_customer_id  text,                   -- opcional, p/ casar tarefas vindas da Auvo
  nome              text not null,
  documento         text,                   -- CNPJ/CPF
  endereco          text,
  criado_em         timestamptz default now()
);

-- 2. PRODUTOS  (catálogo — fonte: Omie)
create table if not exists produtos (
  id              uuid primary key default gen_random_uuid(),
  omie_produto_id text unique,
  codigo          text,
  descricao       text,
  unidade         text,
  ativo           boolean default true,
  criado_em       timestamptz default now()
);
create index if not exists idx_produtos_codigo on produtos (codigo);

-- 3. EQUIPAMENTOS  (cada UNIDADE física)
create table if not exists equipamentos (
  id            uuid primary key default gen_random_uuid(),
  tipo          text,                        -- camera, switch, cancela, monitor, servidor...
  modelo        text,
  numero_serie  text unique,
  status        text default 'estoque'
                  check (status in ('estoque','locado','manutencao','baixado')),
  criado_em     timestamptz default now()
);

-- 4. TÉCNICOS
create table if not exists tecnicos (
  id            uuid primary key default gen_random_uuid(),
  auvo_user_id  text unique,
  nome          text not null,
  email         text,
  ativo         boolean default true,
  criado_em     timestamptz default now()
);

-- 5. CONTRATOS  (locação — enxuto, cresce depois)
create table if not exists contratos (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid references clientes(id),
  numero      text,
  inicio      date,
  fim         date,
  status      text default 'ativo' check (status in ('ativo','encerrado','suspenso')),
  criado_em   timestamptz default now()
);

create table if not exists contrato_itens (
  id             uuid primary key default gen_random_uuid(),
  contrato_id    uuid references contratos(id) on delete cascade,
  equipamento_id uuid references equipamentos(id),
  inicio         date,
  fim            date
);

-- 6. TIPOS DE SERVIÇO  (CONFIGURÁVEL — cadastro editável pela tela)
create table if not exists tipos_servico (
  id                 uuid primary key default gen_random_uuid(),
  nome               text not null,
  formulario_id      uuid,                    -- FK definida após formulario_modelos
  efeito_inventario  text default 'nenhum'
                       check (efeito_inventario in
                       ('nenhum','marcar_locado','devolver_estoque','marcar_manutencao')),
  ativo              boolean default true,
  criado_em          timestamptz default now()
);


-- =====================================================================
--  MÓDULO SERVIÇO / RAT
-- =====================================================================

-- 7. MODELOS DE FORMULÁRIO / QUESTIONÁRIOS  (inclui checklists vindos do Axis Inventory)
--    campos = jsonb: [{ "id","label","tipo":"texto|foto|selecao|assinatura|numero","obrigatorio" }]
create table if not exists formulario_modelos (
  id           uuid primary key default gen_random_uuid(),
  nome         text not null,
  campos       jsonb not null default '[]'::jsonb,
  ativo        boolean default true,
  criado_em    timestamptz default now()
);

alter table tipos_servico drop constraint if exists fk_tiposervico_formulario;
alter table tipos_servico add constraint fk_tiposervico_formulario
  foreign key (formulario_id) references formulario_modelos(id);

-- 8. TAREFAS  (RAT — cliente é âncora; equipamento e contrato OPCIONAIS)
create table if not exists tarefas (
  id                 uuid primary key default gen_random_uuid(),
  client_uuid        uuid unique,             -- gerado no aparelho (idempotência)
  origem_registro    text not null default 'auvo'
                       check (origem_registro in ('auvo','nativo')),
  auvo_task_id       text unique,

  cliente_id         uuid references clientes(id),       -- obrigatório na prática
  tecnico_id         uuid references tecnicos(id),
  equipamento_id     uuid references equipamentos(id),   -- OPCIONAL
  contrato_id        uuid references contratos(id),      -- OPCIONAL
  tipo_servico_id    uuid references tipos_servico(id),
  formulario_id      uuid references formulario_modelos(id),

  cliente_nome       text,
  tecnico_nome       text,

  data_tarefa        timestamptz,
  status             text default 'aberta',
  valor              numeric(12,2) default 0,

  checkin_lat        numeric,
  checkin_lng        numeric,
  assinatura_url     text,
  respostas          jsonb,

  tem_foto           boolean default false,
  tem_assinatura     boolean default false,
  questionario_ok    boolean default false,
  relatorio_completo boolean generated always as
                       (tem_foto and tem_assinatura and questionario_ok) stored,
  pendencias         text,

  sync_status        text default 'confirmado'
                       check (sync_status in
                       ('rascunho','salvo_local','na_fila','enviando','confirmado','erro')),
  device_id          text,
  recebido_em        timestamptz,

  os_omie            text,
  faturado           boolean default false,
  data_faturamento   timestamptz,
  numero_nota        text,
  observacoes        text,

  criado_em          timestamptz default now(),
  atualizado_em      timestamptz default now()
);

create index if not exists idx_tarefas_data     on tarefas (data_tarefa);
create index if not exists idx_tarefas_faturado on tarefas (faturado);
create index if not exists idx_tarefas_os       on tarefas (os_omie);
create index if not exists idx_tarefas_sync     on tarefas (sync_status);
create index if not exists idx_tarefas_equip    on tarefas (equipamento_id);
create index if not exists idx_tarefas_contrato on tarefas (contrato_id);

-- 9. FOTOS DO RELATÓRIO
create table if not exists relatorio_fotos (
  id          uuid primary key default gen_random_uuid(),
  tarefa_id   uuid references tarefas(id) on delete cascade,
  url         text not null,
  legenda     text,
  criado_em   timestamptz default now()
);
create index if not exists idx_fotos_tarefa on relatorio_fotos (tarefa_id);

-- 10. MATERIAIS  (usado = Auvo/nativo · levado = Omie) — agora ligado ao catálogo
create table if not exists materiais (
  id              uuid primary key default gen_random_uuid(),
  origem          text not null check (origem in ('usado','levado')),
  tarefa_id       uuid references tarefas(id),
  produto_id      uuid references produtos(id),   -- liga ao catálogo (Omie)
  os_omie         text,
  codigo_produto  text,                            -- mantido p/ resiliência no match
  descricao       text,
  quantidade      numeric(12,3) default 0,
  criado_em       timestamptz default now()
);
create index if not exists idx_materiais_os      on materiais (os_omie);
create index if not exists idx_materiais_codigo  on materiais (codigo_produto);
create index if not exists idx_materiais_produto on materiais (produto_id);

-- 11. VIEW DE CONCILIAÇÃO
create or replace view vw_conciliacao as
select
  coalesce(l.os_omie, u.os_omie)               as os_omie,
  coalesce(l.codigo_produto, u.codigo_produto) as codigo_produto,
  coalesce(l.descricao, u.descricao)           as descricao,
  coalesce(l.qtd, 0)                           as qtd_levado,
  coalesce(u.qtd, 0)                           as qtd_usado,
  coalesce(l.qtd, 0) - coalesce(u.qtd, 0)      as diferenca,
  case
    when coalesce(l.qtd,0) = coalesce(u.qtd,0)  then 'ok'
    when coalesce(u.qtd,0) >  coalesce(l.qtd,0) then 'usou_mais'
    else 'sobrou'
  end as situacao
from
  (select os_omie, codigo_produto, max(descricao) descricao, sum(quantidade) qtd
     from materiais where origem='levado' group by os_omie, codigo_produto) l
full outer join
  (select os_omie, codigo_produto, max(descricao) descricao, sum(quantidade) qtd
     from materiais where origem='usado'  group by os_omie, codigo_produto) u
  on l.os_omie = u.os_omie and l.codigo_produto = u.codigo_produto;

-- 12. SYNC_EVENTOS  (trilha de auditoria imutável)
create table if not exists sync_eventos (
  id           uuid primary key default gen_random_uuid(),
  client_uuid  uuid,
  tarefa_id    uuid references tarefas(id),
  device_id    text,
  evento       text,
  detalhe      text,
  em           timestamptz default now()
);
create index if not exists idx_eventos_clientuuid on sync_eventos (client_uuid);

-- 13. SYNC_LOG  (rodadas de integração)
create table if not exists sync_log (
  id         uuid primary key default gen_random_uuid(),
  fonte      text,                       -- 'auvo' / 'omie'
  inicio     timestamptz default now(),
  fim        timestamptz,
  registros  int default 0,
  status     text,
  detalhe    text
);


-- =====================================================================
--  SEED — tipos de serviço (edite/expanda pela tela)
-- =====================================================================
insert into tipos_servico (nome, efeito_inventario) values
  ('Manutenção corretiva',     'nenhum'),
  ('Manutenção preventiva',    'nenhum'),
  ('Contrato',                 'nenhum'),
  ('Spot',                     'nenhum'),
  ('Orçamento',                'nenhum'),
  ('Instalação nova',          'marcar_locado'),
  ('Retirada / desinstalação', 'devolver_estoque')
on conflict do nothing;


-- =====================================================================
--  RLS  (habilite e refine por perfil)
-- =====================================================================
alter table clientes           enable row level security;
alter table produtos           enable row level security;
alter table equipamentos       enable row level security;
alter table tecnicos           enable row level security;
alter table contratos          enable row level security;
alter table contrato_itens     enable row level security;
alter table tipos_servico      enable row level security;
alter table formulario_modelos enable row level security;
alter table tarefas            enable row level security;
alter table relatorio_fotos    enable row level security;
alter table materiais          enable row level security;
alter table sync_eventos       enable row level security;
alter table sync_log           enable row level security;

create policy "auth_all_clientes"  on clientes           for all to authenticated using (true) with check (true);
create policy "auth_all_produtos"  on produtos           for all to authenticated using (true) with check (true);
create policy "auth_all_equip"     on equipamentos       for all to authenticated using (true) with check (true);
create policy "auth_all_tecnicos"  on tecnicos           for all to authenticated using (true) with check (true);
create policy "auth_all_contratos" on contratos          for all to authenticated using (true) with check (true);
create policy "auth_all_citens"    on contrato_itens     for all to authenticated using (true) with check (true);
create policy "auth_all_tiposvc"   on tipos_servico      for all to authenticated using (true) with check (true);
create policy "auth_all_forms"     on formulario_modelos for all to authenticated using (true) with check (true);
create policy "auth_all_tarefas"   on tarefas            for all to authenticated using (true) with check (true);
create policy "auth_all_fotos"     on relatorio_fotos    for all to authenticated using (true) with check (true);
create policy "auth_all_materiais" on materiais          for all to authenticated using (true) with check (true);
create policy "auth_all_eventos"   on sync_eventos       for all to authenticated using (true) with check (true);
create policy "auth_read_synclog"  on sync_log           for select to authenticated using (true);
