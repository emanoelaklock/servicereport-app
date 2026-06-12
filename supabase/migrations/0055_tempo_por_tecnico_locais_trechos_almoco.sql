-- Pacote TEMPO POR TÉCNICO + DESLOCAMENTO POR TRECHOS — camada de dados (spec §8/§4.1).
-- (1) cliente_locais  — locais/sites de um cliente (destino de trecho; ex. WestRock Torre Paredão).
-- (2) rat_tecnicos    — participação por técnico na RAT com horário PRÓPRIO
--                       (inicio/fim null = herda o horário da RAT). Materializada por
--                       trigger a partir de rats.respostas: o app continua enviando só o JSONB.
-- (3) trechos         — o artefato Deslocamento (pernoite) vira viagem com N trechos
--                       ordenados + a bordo por trecho + turnos de direção (revezamento).
-- (4) almocos         — almoço é DA PESSOA no dia: UNIQUE (tecnico_id, dia), qualquer artefato.
--                       Segundo almoço no dia → mantém o 1º e registra em almoco_conflitos.
--                       origem 'ponto' fica RESERVADA para a futura integração Tangerino.

-- ───────────────────────── helpers (casts seguros) ─────────────────────────
create or replace function public.fn_time_ou_null(v text)
returns time language plpgsql immutable as $$
begin return nullif(trim(v), '')::time; exception when others then return null; end $$;

create or replace function public.fn_date_ou_null(v text)
returns date language plpgsql immutable as $$
begin return nullif(trim(v), '')::date; exception when others then return null; end $$;

-- ───────────────────────── (1) Locais do cliente ─────────────────────────
create table if not exists public.cliente_locais (
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  nome       text not null,
  cidade     text,
  uf         text,
  lat        double precision,
  lng        double precision,
  ativo      boolean not null default true,
  criado_em  timestamptz default now()
);
create index if not exists idx_cliente_locais_cli on public.cliente_locais (cliente_id);
alter table public.cliente_locais enable row level security;
drop policy if exists cloc_office_all on public.cliente_locais;
create policy cloc_office_all on public.cliente_locais
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists cloc_read on public.cliente_locais;
create policy cloc_read on public.cliente_locais
  for select using (app_role() = any (array['comercial','tecnico_campo']));

-- ─────────────────── (2) Participação por técnico na RAT ───────────────────
create table if not exists public.rat_tecnicos (
  rat_id     uuid not null references public.rats(id) on delete cascade,
  tecnico_id uuid not null references public.usuarios(id),
  inicio     time,   -- null = herda respostas.hora_inicio da RAT
  fim        time,   -- null = herda respostas.hora_termino da RAT
  primary key (rat_id, tecnico_id)
);
create index if not exists idx_rat_tecnicos_tec on public.rat_tecnicos (tecnico_id);
alter table public.rat_tecnicos enable row level security;
drop policy if exists rt_office_all on public.rat_tecnicos;
create policy rt_office_all on public.rat_tecnicos
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists rt_tecnico_read on public.rat_tecnicos;
create policy rt_tecnico_read on public.rat_tecnicos
  for select using (
    tecnico_id = auth.uid()
    or exists (select 1 from public.rats r where r.id = rat_id and r.tecnico_id = auth.uid())
  );

-- ───────────────── (4) Almoço por pessoa/dia (antes do trigger da RAT) ─────────────────
create table if not exists public.almocos (
  id            uuid primary key default gen_random_uuid(),
  tecnico_id    uuid not null references public.usuarios(id),
  dia           date not null,
  inicio        time not null,
  fim           time not null,
  origem        text not null default 'manual' check (origem in ('manual','ponto')),
  artefato_tipo text check (artefato_tipo in ('rat','deslocamento')),
  artefato_id   uuid,
  criado_em     timestamptz default now(),
  atualizado_em timestamptz not null default now(),
  unique (tecnico_id, dia)
);
create index if not exists idx_almocos_dia on public.almocos (dia);
drop trigger if exists trg_upd_almocos on public.almocos;
create trigger trg_upd_almocos before update on public.almocos
  for each row execute function public.tg_set_atualizado_em();
alter table public.almocos enable row level security;
drop policy if exists alm_office_all on public.almocos;
create policy alm_office_all on public.almocos
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists alm_read on public.almocos;
create policy alm_read on public.almocos
  for select using (app_role() is not null);   -- estado "já almoçou hoje" é visível à equipe

create table if not exists public.almoco_conflitos (
  id            uuid primary key default gen_random_uuid(),
  tecnico_id    uuid not null references public.usuarios(id),
  dia           date not null,
  inicio        time,
  fim           time,
  artefato_tipo text,
  artefato_id   uuid,
  motivo        text,
  criado_em     timestamptz default now(),
  unique (tecnico_id, dia, artefato_tipo, artefato_id)
);
alter table public.almoco_conflitos enable row level security;
drop policy if exists almc_office_all on public.almoco_conflitos;
create policy almc_office_all on public.almoco_conflitos
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));

-- Registra o almoço de UMA pessoa num dia. Se já existe (qualquer artefato),
-- mantém o 1º e loga o conflito — nunca desconta duas vezes.
create or replace function public.fn_registrar_almoco(
  p_tecnico uuid, p_dia date, p_inicio time, p_fim time,
  p_origem text, p_artefato_tipo text, p_artefato_id uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_tecnico is null or p_dia is null or p_inicio is null or p_fim is null then return; end if;
  begin
    insert into almocos (tecnico_id, dia, inicio, fim, origem, artefato_tipo, artefato_id)
    values (p_tecnico, p_dia, p_inicio, p_fim, coalesce(p_origem, 'manual'), p_artefato_tipo, p_artefato_id);
  exception when unique_violation then
    -- mesmo artefato re-sincronizando → atualiza horários; outro artefato → conflito
    update almocos set inicio = p_inicio, fim = p_fim
      where tecnico_id = p_tecnico and dia = p_dia
        and artefato_tipo is not distinct from p_artefato_tipo
        and artefato_id   is not distinct from p_artefato_id
        and origem = 'manual';
    if not found then
      insert into almoco_conflitos (tecnico_id, dia, inicio, fim, artefato_tipo, artefato_id, motivo)
      select p_tecnico, p_dia, p_inicio, p_fim, p_artefato_tipo, p_artefato_id,
             'Almoço duplicado no dia — mantido o registro de ' || coalesce(a.artefato_tipo, a.origem)
        from almocos a where a.tecnico_id = p_tecnico and a.dia = p_dia
      on conflict (tecnico_id, dia, artefato_tipo, artefato_id) do nothing;
    end if;
  end;
end $$;

-- ── Trigger: RAT sincronizou → materializa rat_tecnicos + almoço por pessoa ──
-- Lê de rats.respostas:
--   tecnicos_responsaveis : "Nome A, Nome B" (formato atual do app — nomes)
--   tecnicos_part         : { "Nome A": {"inicio":"10:30","fim":"17:00"} } (só exceções)
--   almoco/almoco_inicio/almoco_termino : pergunta Sim/Não + horários (formato atual)
create or replace function public.fn_rat_sync_tempo()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_part    jsonb;
  v_rat_ini time; v_rat_fim time;
  v_alm_ini time; v_alm_fim time;
  v_dia     date;
  r         record;
begin
  v_part    := coalesce(new.respostas->'tecnicos_part', '{}'::jsonb);
  v_rat_ini := fn_time_ou_null(new.respostas->>'hora_inicio');
  v_rat_fim := fn_time_ou_null(new.respostas->>'hora_termino');

  -- (a) participações: nomes → usuarios (case-insensitive); horário próprio só nas exceções
  delete from rat_tecnicos where rat_id = new.id;
  for r in
    select distinct on (u.id) u.id as tecnico_id, trim(t.nome_raw) as nome
      from unnest(string_to_array(coalesce(new.respostas->>'tecnicos_responsaveis', ''), ',')) as t(nome_raw)
      join usuarios u on lower(trim(u.nome)) = lower(trim(t.nome_raw))
     where trim(t.nome_raw) <> ''
  loop
    insert into rat_tecnicos (rat_id, tecnico_id, inicio, fim)
    values (new.id, r.tecnico_id,
            fn_time_ou_null(v_part->r.nome->>'inicio'),
            fn_time_ou_null(v_part->r.nome->>'fim'))
    on conflict (rat_id, tecnico_id) do nothing;
  end loop;

  -- (b) almoço da pessoa no dia (deriva da RAT p/ quem tem participação cobrindo o horário)
  begin
    delete from almocos where artefato_tipo = 'rat' and artefato_id = new.id;
    if coalesce(new.respostas->>'almoco', '') = 'Sim' then
      v_alm_ini := fn_time_ou_null(new.respostas->>'almoco_inicio');
      v_alm_fim := fn_time_ou_null(new.respostas->>'almoco_termino');
      v_dia     := coalesce(fn_date_ou_null(new.respostas->>'data'), new.data_tarefa::date, current_date);
      if v_alm_ini is not null and v_alm_fim is not null then
        for r in
          select rt.tecnico_id,
                 coalesce(rt.inicio, v_rat_ini) as p_ini,
                 coalesce(rt.fim,   v_rat_fim) as p_fim
            from rat_tecnicos rt where rt.rat_id = new.id
        loop
          if r.p_ini is null or r.p_fim is null
             or (v_alm_ini >= r.p_ini and v_alm_ini < r.p_fim) then
            perform fn_registrar_almoco(r.tecnico_id, v_dia, v_alm_ini, v_alm_fim, 'manual', 'rat', new.id);
          end if;
        end loop;
      end if;
    end if;
  exception when others then null;   -- derivação de almoço nunca pode travar o sync da RAT
  end;
  return new;
end $$;

drop trigger if exists trg_rat_sync_tempo on public.rats;
create trigger trg_rat_sync_tempo after insert or update of respostas on public.rats
  for each row execute function public.fn_rat_sync_tempo();

-- ─────────────── (3) Deslocamento (pernoite) por TRECHOS ───────────────
create table if not exists public.deslocamento_trechos (
  id               uuid primary key default gen_random_uuid(),
  deslocamento_id  uuid not null references public.deslocamentos(id) on delete cascade,
  ordem            int  not null,
  origem           text,                                            -- texto livre ou nome do local
  destino          text,                                            -- texto livre quando sem local
  destino_local_id uuid references public.cliente_locais(id),
  data             date,
  saida_em         timestamptz,
  chegada_em       timestamptz,
  saida_lat        double precision, saida_lng double precision, saida_precisao numeric,
  chegada_lat      double precision, chegada_lng double precision, chegada_precisao numeric,
  veiculo_id       uuid references public.veiculos(id),
  nota_transporte  text,                                            -- curto: "carona", "avião"…
  espelho_legado   boolean not null default false,                  -- criado pelo espelho de app antigo
  criado_em        timestamptz default now(),
  atualizado_em    timestamptz not null default now(),
  unique (deslocamento_id, ordem)
);
create index if not exists idx_trechos_desloc on public.deslocamento_trechos (deslocamento_id);
drop trigger if exists trg_upd_trechos on public.deslocamento_trechos;
create trigger trg_upd_trechos before update on public.deslocamento_trechos
  for each row execute function public.tg_set_atualizado_em();

create table if not exists public.trecho_tecnicos (
  trecho_id  uuid not null references public.deslocamento_trechos(id) on delete cascade,
  tecnico_id uuid not null references public.usuarios(id),
  primary key (trecho_id, tecnico_id)
);
create index if not exists idx_trecho_tec on public.trecho_tecnicos (tecnico_id);

create table if not exists public.trecho_direcao (
  id         uuid primary key default gen_random_uuid(),
  trecho_id  uuid not null references public.deslocamento_trechos(id) on delete cascade,
  tecnico_id uuid not null references public.usuarios(id),
  hora_de    time,   -- null no 1º turno = desde a saída
  hora_ate   time,   -- null no último = até a chegada ("trecho todo" = ambos null)
  criado_em  timestamptz default now()
);
create index if not exists idx_trecho_dir on public.trecho_direcao (trecho_id);

-- Almoço na estrada: registro POR PESSOA por dia de viagem, dentro do artefato.
-- A materialização em `almocos` (com dedup) é feita por trigger.
create table if not exists public.deslocamento_almocos (
  deslocamento_id uuid not null references public.deslocamentos(id) on delete cascade,
  tecnico_id      uuid not null references public.usuarios(id),
  dia             date not null,
  inicio          time not null,
  fim             time not null,
  primary key (deslocamento_id, tecnico_id, dia)
);

-- RLS dos filhos: espelha as políticas de deslocamentos via o pai
-- (a leitura "a bordo" usa deslocamento_tecnicos — o agregado no nível do pai —
--  para não criar recursão entre trechos e trecho_tecnicos; cf. 0037).
alter table public.deslocamento_trechos enable row level security;
drop policy if exists dtr_office_all on public.deslocamento_trechos;
create policy dtr_office_all on public.deslocamento_trechos
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists dtr_comercial_read on public.deslocamento_trechos;
create policy dtr_comercial_read on public.deslocamento_trechos
  for select using (app_role() = 'comercial');
drop policy if exists dtr_tecnico_own on public.deslocamento_trechos;
create policy dtr_tecnico_own on public.deslocamento_trechos
  for all using (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()))
  with check (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()));
drop policy if exists dtr_tecnico_aboard_read on public.deslocamento_trechos;
create policy dtr_tecnico_aboard_read on public.deslocamento_trechos
  for select using (exists (select 1 from public.deslocamento_tecnicos dt
                            where dt.deslocamento_id = deslocamento_trechos.deslocamento_id
                              and dt.tecnico_id = auth.uid()));

alter table public.trecho_tecnicos enable row level security;
drop policy if exists ttec_office_all on public.trecho_tecnicos;
create policy ttec_office_all on public.trecho_tecnicos
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists ttec_comercial_read on public.trecho_tecnicos;
create policy ttec_comercial_read on public.trecho_tecnicos
  for select using (app_role() = 'comercial');
drop policy if exists ttec_self_read on public.trecho_tecnicos;
create policy ttec_self_read on public.trecho_tecnicos
  for select using (tecnico_id = auth.uid());
drop policy if exists ttec_tecnico_own on public.trecho_tecnicos;
create policy ttec_tecnico_own on public.trecho_tecnicos
  for all using (exists (select 1 from public.deslocamento_trechos t
                           join public.deslocamentos d on d.id = t.deslocamento_id
                          where t.id = trecho_id and d.criado_por = auth.uid()))
  with check (exists (select 1 from public.deslocamento_trechos t
                        join public.deslocamentos d on d.id = t.deslocamento_id
                       where t.id = trecho_id and d.criado_por = auth.uid()));

alter table public.trecho_direcao enable row level security;
drop policy if exists tdir_office_all on public.trecho_direcao;
create policy tdir_office_all on public.trecho_direcao
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists tdir_comercial_read on public.trecho_direcao;
create policy tdir_comercial_read on public.trecho_direcao
  for select using (app_role() = 'comercial');
drop policy if exists tdir_self_read on public.trecho_direcao;
create policy tdir_self_read on public.trecho_direcao
  for select using (tecnico_id = auth.uid());
drop policy if exists tdir_tecnico_own on public.trecho_direcao;
create policy tdir_tecnico_own on public.trecho_direcao
  for all using (exists (select 1 from public.deslocamento_trechos t
                           join public.deslocamentos d on d.id = t.deslocamento_id
                          where t.id = trecho_id and d.criado_por = auth.uid()))
  with check (exists (select 1 from public.deslocamento_trechos t
                        join public.deslocamentos d on d.id = t.deslocamento_id
                       where t.id = trecho_id and d.criado_por = auth.uid()));

alter table public.deslocamento_almocos enable row level security;
drop policy if exists dalm_office_all on public.deslocamento_almocos;
create policy dalm_office_all on public.deslocamento_almocos
  for all using (app_role() = any (array['admin','gestor_axis']))
  with check (app_role() = any (array['admin','gestor_axis']));
drop policy if exists dalm_tecnico_own on public.deslocamento_almocos;
create policy dalm_tecnico_own on public.deslocamento_almocos
  for all using (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()))
  with check (exists (select 1 from public.deslocamentos d where d.id = deslocamento_id and d.criado_por = auth.uid()));
drop policy if exists dalm_self_read on public.deslocamento_almocos;
create policy dalm_self_read on public.deslocamento_almocos
  for select using (tecnico_id = auth.uid());

-- Trigger: almoço na estrada → almocos (mesma dedup da RAT)
create or replace function public.fn_desloc_almoco_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from almocos where artefato_tipo = 'deslocamento' and artefato_id = old.deslocamento_id
      and tecnico_id = old.tecnico_id and dia = old.dia;
    return old;
  end if;
  perform fn_registrar_almoco(new.tecnico_id, new.dia, new.inicio, new.fim, 'manual', 'deslocamento', new.deslocamento_id);
  return new;
end $$;
drop trigger if exists trg_desloc_almoco_sync on public.deslocamento_almocos;
create trigger trg_desloc_almoco_sync after insert or update or delete on public.deslocamento_almocos
  for each row execute function public.fn_desloc_almoco_sync();

-- ── Compatibilidade com app ANTIGO (1 registro = 1 perna, campos no pai) ──
-- Enquanto houver versão antiga em campo, o insert/update legado em `deslocamentos`
-- espelha um trecho 1; deslocamento_tecnicos legado vira a-bordo do trecho espelho.
create or replace function public.fn_desloc_espelha_trecho()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.saida_em is null then return new; end if;
  if exists (select 1 from deslocamento_trechos t where t.deslocamento_id = new.id and not t.espelho_legado) then
    return new;   -- registro já no modelo novo (app novo manda os trechos)
  end if;
  insert into deslocamento_trechos as t (deslocamento_id, ordem, origem, destino, data, saida_em, chegada_em,
    saida_lat, saida_lng, saida_precisao, chegada_lat, chegada_lng, chegada_precisao, veiculo_id, espelho_legado)
  values (new.id, 1, new.origem, new.destino, new.saida_em::date, new.saida_em, new.chegada_em,
    new.saida_lat, new.saida_lng, new.saida_precisao, new.chegada_lat, new.chegada_lng, new.chegada_precisao,
    new.veiculo_id, true)
  on conflict (deslocamento_id, ordem) do update
    set origem = excluded.origem, destino = excluded.destino, data = excluded.data,
        saida_em = excluded.saida_em, chegada_em = excluded.chegada_em,
        saida_lat = excluded.saida_lat, saida_lng = excluded.saida_lng, saida_precisao = excluded.saida_precisao,
        chegada_lat = excluded.chegada_lat, chegada_lng = excluded.chegada_lng, chegada_precisao = excluded.chegada_precisao,
        veiculo_id = excluded.veiculo_id
    where t.espelho_legado;
  return new;
end $$;
drop trigger if exists trg_desloc_espelha_trecho on public.deslocamentos;
create trigger trg_desloc_espelha_trecho after insert or update on public.deslocamentos
  for each row execute function public.fn_desloc_espelha_trecho();

create or replace function public.fn_desloc_tec_espelha()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into trecho_tecnicos (trecho_id, tecnico_id)
  select t.id, new.tecnico_id from deslocamento_trechos t
   where t.deslocamento_id = new.deslocamento_id and t.espelho_legado
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists trg_desloc_tec_espelha on public.deslocamento_tecnicos;
create trigger trg_desloc_tec_espelha after insert on public.deslocamento_tecnicos
  for each row execute function public.fn_desloc_tec_espelha();

-- ── Migração de dados: cada registro legado vira viagem com 1 trecho ──
-- (produção está com 0 registros em 12/06/2026; bloco mantido por segurança/idempotência
--  para registros que ainda cheguem de filas offline antigas — nada se perde)
insert into public.deslocamento_trechos (deslocamento_id, ordem, origem, destino, data, saida_em, chegada_em,
  saida_lat, saida_lng, saida_precisao, chegada_lat, chegada_lng, chegada_precisao, veiculo_id, espelho_legado)
select d.id, 1, d.origem, d.destino, d.saida_em::date, d.saida_em, d.chegada_em,
       d.saida_lat, d.saida_lng, d.saida_precisao, d.chegada_lat, d.chegada_lng, d.chegada_precisao,
       d.veiculo_id, true
  from public.deslocamentos d
 where d.saida_em is not null
   and not exists (select 1 from public.deslocamento_trechos t where t.deslocamento_id = d.id)
on conflict (deslocamento_id, ordem) do nothing;

insert into public.trecho_tecnicos (trecho_id, tecnico_id)
select t.id, dt.tecnico_id
  from public.deslocamento_tecnicos dt
  join public.deslocamento_trechos t on t.deslocamento_id = dt.deslocamento_id and t.espelho_legado
on conflict do nothing;

-- ── Backfill: materializa rat_tecnicos/almoços das RATs já existentes ──
update public.rats set respostas = respostas where respostas is not null;
