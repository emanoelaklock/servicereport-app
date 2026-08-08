-- 0147 — F2: travas de negócio no SERVIDOR (validar_rat + validar_conclusao_tarefa).
--
-- Até aqui as travas viviam só no JS do app (burláveis por API direta com o JWT do
-- técnico — risco: cliente malicioso/bug de integração, não o técnico). Este pacote
-- replica no Postgres o subconjunto CONSERVADOR das regras: só o que é impossível
-- de gerar pelo app, auto-curável no retry, ou erro grosseiro de dado — porque um
-- falso-reject aqui ENCALHA a RAT no aparelho (a pior falha possível no offline-first).
-- Réplica integral da cronologia fina do app (janela de pausa, deslocamento×execução)
-- fica CONSCIENTEMENTE de fora nesta fase — margem de falso-reject em edição de
-- legado pela gestão > valor marginal (o app já trava o técnico).
--
-- Varredura pré-apply (07-08/08): base 100% limpa nas 4 dimensões validadas
-- (0 improdutivas sem motivo, 0 horas ilegíveis, 0 ordem invertida real) — nenhuma
-- edição de dado existente será rejeitada pelos triggers.
--
-- validar_rat: SEM security definer (só examina NEW). Isenção para papéis de infra
-- (postgres/service_role/…): migração de dados e consolidação não podem travar
-- (precedente 0124/F22); o alvo da rede é o papel authenticated.
-- validar_conclusao_tarefa: INVOKER de propósito — DENTRO de função DEFINER o
-- current_user vira o DONO (postgres) e a isenção de infra dispararia pra TODO mundo
-- (pego na 1ª rodada do teste: N5 passou). Os agregados que precisam enxergar ALÉM
-- do RLS do chamador (regra da casa pós-F22: técnico só vê as próprias RATs; a
-- existência de RAT registrada é fato da TAREFA) vão a helpers DEFINER:
-- tarefa_status_alvo (já definer, 0130) + fn_tarefa_tem_rat_registrada (novo).
-- Admin/gestor é ISENTO (força com ciência — decisão do F2); infra idem.

-- ── 1) validar_rat: BEFORE INSERT/UPDATE em rats ──
create or replace function public.validar_rat()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  h_ini time; h_fim time; gap_min int;
  agora_min int; fim_min int;
begin
  -- infra (migração/consolidação/Edge service_role) não trava — rede mira 'authenticated'
  if current_user in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin') then
    return new;
  end if;

  -- (1) visita improdutiva exige motivo (radio OU texto) — impossível pelo app sem
  if (new.status = 'improdutiva' or new.atendimento_executado is false)
     and coalesce(nullif(new.motivo_improdutiva, ''), nullif(new.motivo_texto, '')) is null then
    raise exception 'SR_VALIDA: visita improdutiva exige o motivo.';
  end if;

  -- (2) horas presentes têm de ser legíveis (HH:MM) — dado sujo puro
  if nullif(new.respostas->>'hora_inicio', '') is not null
     and public.fn_time_ou_null(new.respostas->>'hora_inicio') is null then
    raise exception 'SR_VALIDA: Hora de Início ilegível (%).', new.respostas->>'hora_inicio';
  end if;
  if nullif(new.respostas->>'hora_termino', '') is not null
     and public.fn_time_ou_null(new.respostas->>'hora_termino') is null then
    raise exception 'SR_VALIDA: Hora de Término ilegível (%).', new.respostas->>'hora_termino';
  end if;

  h_ini := public.fn_time_ou_null(new.respostas->>'hora_inicio');
  h_fim := public.fn_time_ou_null(new.respostas->>'hora_termino');

  -- (3) ordem invertida REAL — mesma régua do app (erroCronologia): término antes do
  -- início com distância de relógio > 12h = o "+1 dia" silencioso. Madrugada legítima
  -- (fim<ini com distância ≤ 12h, ex.: 22:00→02:00) PASSA.
  if h_ini is not null and h_fim is not null and h_fim < h_ini then
    gap_min := mod(mod((extract(epoch from (h_fim - h_ini)) / 60)::int, 1440) + 1440, 1440);
    if gap_min > 720 then
      raise exception 'SR_VALIDA: Hora de Término (%) antes da Hora de Início (%) — ordem invertida.',
        new.respostas->>'hora_termino', new.respostas->>'hora_inicio';
    end if;
  end if;

  -- (4) término no futuro — SÓ RAT de HOJE no calendário BR (RAT de dia passado já está
  -- toda no passado, mesma régua do app), ignorando a virada (fim<ini). Tolerância de
  -- 15 min pra relógio de aparelho adiantado; auto-curável: o retry do sync passa
  -- sozinho quando o relógio alcança o horário. Comparação em MINUTOS (sem soma de
  -- interval em time, que daria a volta perto da meia-noite).
  if h_fim is not null
     and public.fn_date_ou_null(new.respostas->>'data') = (now() at time zone 'America/Sao_Paulo')::date
     and (h_ini is null or h_fim >= h_ini) then
    agora_min := (extract(epoch from (now() at time zone 'America/Sao_Paulo')::time) / 60)::int;
    fim_min   := (extract(epoch from h_fim) / 60)::int;
    if fim_min > agora_min + 15 then
      raise exception 'SR_VALIDA: Hora de Término (%) no futuro — confira o horário.', new.respostas->>'hora_termino';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_rats_valida on public.rats;
create trigger trg_rats_valida
before insert or update on public.rats
for each row execute function public.validar_rat();

-- ── 2) validar_conclusao_tarefa: BEFORE UPDATE OF status em tarefas ──
-- Helper DEFINER: "a tarefa tem RAT registrada?" é fato da TAREFA — enxerga além do
-- RLS do chamador (técnico só vê as próprias RATs). Só devolve boolean; zero exposição.
create or replace function public.fn_tarefa_tem_rat_registrada(p_tarefa uuid)
returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.rats r
                  where r.tarefa_id = p_tarefa
                    and r.status in ('registrado', 'concluida', 'concluida_pendencia'));
$$;

create or replace function public.validar_conclusao_tarefa()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin') then
    return new;   -- infra e triggers definer (rat_inicia_tarefa) não travam
  end if;
  if public.app_role() = any (array['admin', 'gestor_axis']) then
    return new;   -- admin força com ciência (decisão F2; o alerta F12 segue apontando)
  end if;
  -- transição PARA concluída (de status não-terminal): exige o que o app exige
  if new.status in ('concluida', 'concluida_pendencia')
     and old.status is distinct from new.status
     and coalesce(old.status, '') not in ('concluida', 'concluida_pendencia', 'aprovada_faturamento', 'faturada') then
    if not public.fn_tarefa_tem_rat_registrada(new.id) then
      raise exception 'SR_VALIDA: concluir o serviço exige ao menos uma RAT registrada nesta tarefa.';
    end if;
    if public.tarefa_status_alvo(new.id) = 'em_pausa' then
      raise exception 'SR_VALIDA: há retorno em aberto ("volto depois") nesta tarefa — conclua o retorno antes de fechar o serviço.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_tarefa_valida_conclusao on public.tarefas;
create trigger trg_tarefa_valida_conclusao
before update of status on public.tarefas
for each row execute function public.validar_conclusao_tarefa();

-- ── Guarda auto-abortante ──
do $$
declare ok_def boolean; ok_path boolean; n_trg int;
begin
  -- helper do agregado: DEFINER + search_path travado (enxerga além do RLS — regra F22)
  select p.prosecdef, coalesce(p.proconfig::text like '%search_path=%', false)
    into ok_def, ok_path
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_tarefa_tem_rat_registrada';
  if not ok_def  then raise exception '0147: fn_tarefa_tem_rat_registrada NÃO ficou security definer — abortando'; end if;
  if not ok_path then raise exception '0147: fn_tarefa_tem_rat_registrada sem search_path travado — abortando'; end if;

  -- trigger de conclusão: INVOKER de propósito (definer viraria isenção universal — ver cabeçalho)
  select p.prosecdef into ok_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'validar_conclusao_tarefa';
  if ok_def then raise exception '0147: validar_conclusao_tarefa ficou DEFINER — isenção de infra valeria pra todos, abortando'; end if;

  select count(*) into n_trg from pg_trigger t
   where t.tgrelid = 'public.rats'::regclass and t.tgfoid = 'public.validar_rat'::regproc and not t.tgisinternal;
  if n_trg < 1 then raise exception '0147: trigger de rats não aponta pra validar_rat — abortando'; end if;

  select count(*) into n_trg from pg_trigger t
   where t.tgrelid = 'public.tarefas'::regclass and t.tgfoid = 'public.validar_conclusao_tarefa'::regproc and not t.tgisinternal;
  if n_trg < 1 then raise exception '0147: trigger de tarefas não aponta pra validar_conclusao_tarefa — abortando'; end if;
end $$;
