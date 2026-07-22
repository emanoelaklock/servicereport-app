-- 0126 — Fundação da integração de ponto (Sólides/Tangerino) — Fase C, PR-C1.
-- Desenho aprovado: docs/ponto-fase-c-desenho.md (§3). O SR SOMENTE LÊ o ponto:
-- estas tabelas são side-car — nada do fluxo vivo (rats/almocos/tarefas) depende delas.
-- Escrita: apenas a Edge `ponto-sync` (service_role, que ignora RLS). Leitura: admin/gestor_axis.
-- Técnico NÃO lê nada na Fase C (a Fase B, se vier, acrescenta policy própria em outro PR).
-- Rollback: drop das 4 tabelas (nenhuma FK de fora aponta para cá).

-- ───────────────── (1) Vínculo técnico SR ↔ colaborador Tangerino ─────────────────
-- Confirmação é humana e carimbada (CPF é só sugestão na tela de vínculo — nunca gravado aqui).
create table if not exists public.ponto_colaboradores_map (
  tecnico_id             uuid primary key references public.usuarios(id),
  tangerino_employee_id  bigint not null unique,
  tangerino_external_id  text,
  vinculado_por          uuid not null references public.usuarios(id),
  vinculado_em           timestamptz not null default now(),
  ativo                  boolean not null default true,
  observacao             text
);
alter table public.ponto_colaboradores_map enable row level security;
drop policy if exists pmap_office_all on public.ponto_colaboradores_map;
create policy pmap_office_all on public.ponto_colaboradores_map
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));

-- ───────────────── (2) Espelho imutável-por-humanos das marcações ─────────────────
-- Cada linha = UM registro Punch da API (par entrada/saída já pareado pela Sólides).
-- Minimização LGPD (desenho §3): sem GPS, foto, NSR, CPF/PIS, e-mail, device.
-- `entrada_raw`/`saida_raw` guardam a string crua da API para auditar o parser de fuso (R1).
create table if not exists public.ponto_marcacoes (
  id                    uuid primary key default gen_random_uuid(),
  tangerino_punch_id    bigint not null unique,           -- Punch.id — chave de dedup/upsert
  tecnico_id            uuid not null references public.usuarios(id),
  dia                   date not null,                     -- dia LOCAL da entrada (regra R1)
  entrada               timestamptz,
  saida                 timestamptz,
  entrada_raw           text,
  saida_raw             text,
  status_origem         text not null check (status_origem in ('APPROVED','PENDING','REPROVED')),
  excluido_origem       boolean not null default false,    -- Punch.excluded (semântica: R2)
  editado_origem        boolean not null default false,    -- Punch.edited/adjust (qualquer flag)
  pendente_metade       text check (pendente_metade in ('ENTRADA','SAIDA','AMBOS')),
  tz_origem             text not null,                     -- enum Tangerino usado na normalização
  origem_modificado_em  timestamptz,                       -- Punch.lastModifiedDate (cursor R3)
  importado_em          timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);
create index if not exists idx_ponto_marc_tec_dia on public.ponto_marcacoes (tecnico_id, dia);
create index if not exists idx_ponto_marc_dia on public.ponto_marcacoes (dia);
drop trigger if exists trg_upd_ponto_marcacoes on public.ponto_marcacoes;
create trigger trg_upd_ponto_marcacoes before update on public.ponto_marcacoes
  for each row execute function public.tg_set_atualizado_em();
alter table public.ponto_marcacoes enable row level security;
drop policy if exists pmar_office_sel on public.ponto_marcacoes;
create policy pmar_office_sel on public.ponto_marcacoes
  for select using (app_role() = any (array['admin','gestor_axis']));
-- (sem policy de escrita de propósito: só a Edge/service_role escreve)

-- ───────────────── (3) Trilha das execuções do sync ─────────────────
create table if not exists public.ponto_sync_execucoes (
  id                       uuid primary key default gen_random_uuid(),
  iniciado_em              timestamptz not null default now(),
  terminado_em             timestamptz,
  tipo                     text not null check (tipo in ('delta','janela7d','carga_historica','reconhecimento')),
  cursor_anterior          bigint,                         -- lastUpdate em millis
  cursor_novo              bigint,
  paginas                  int not null default 0,
  novas                    int not null default 0,
  atualizadas              int not null default 0,
  descartadas_sem_vinculo  int not null default 0,
  status                   text not null default 'ok' check (status in ('ok','erro','parcial')),
  erro_sanitizado          text                             -- NUNCA token/URL com credencial/dado pessoal
);
create index if not exists idx_ponto_exec_ini on public.ponto_sync_execucoes (iniciado_em desc);
alter table public.ponto_sync_execucoes enable row level security;
drop policy if exists pexe_office_sel on public.ponto_sync_execucoes;
create policy pexe_office_sel on public.ponto_sync_execucoes
  for select using (app_role() = any (array['admin','gestor_axis']));

-- ───────────────── (4) Config ajustável sem deploy (linha única) ─────────────────
-- Tolerâncias entram DEPOIS da calibração (gate C3) — nascem nulas de propósito.
create table if not exists public.ponto_config (
  id                     int primary key default 1 check (id = 1),
  tolerancia_inicio_min  int,                               -- calibração C3
  tolerancia_termino_min int,
  tolerancia_duracao_min int,
  janela_almoco_ini      time not null default '10:00',
  janela_almoco_fim      time not null default '15:00',
  gap_minimo_almoco_min  int not null default 15,
  transicao_max_min      int not null default 5,            -- Fase D (§4 do estudo D)
  retencao_meses         int not null default 12,           -- purga entra em PR futuro, não no C1
  atualizado_em          timestamptz not null default now()
);
drop trigger if exists trg_upd_ponto_config on public.ponto_config;
create trigger trg_upd_ponto_config before update on public.ponto_config
  for each row execute function public.tg_set_atualizado_em();
insert into public.ponto_config (id) values (1) on conflict (id) do nothing;
alter table public.ponto_config enable row level security;
drop policy if exists pcfg_office_all on public.ponto_config;
create policy pcfg_office_all on public.ponto_config
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
