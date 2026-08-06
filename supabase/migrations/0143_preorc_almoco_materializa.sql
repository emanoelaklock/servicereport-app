-- 0143: Almoço do PRÉ-ORÇAMENTO materializa em `almocos` — some o furo da Jornada.
-- Caso real (Pré-orç Nº 16, Pablo, 29/07): o levantamento gravou almoço 12:25–13:25 em
-- respostas, mas a Jornada mostrava "sem registro" e não descontava do total. Motivo: só a
-- RAT tinha trigger de almoço (fn_rat_sync_tempo → fn_registrar_almoco); pré-orçamento
-- nunca materializava. Regra de arquitetura (§almoço): almoço é POR PESSOA/DIA, contado
-- UMA vez, dedup NO SERVIDOR — então o conserto é trigger no servidor, não filtro no cliente.
--
-- Desenho (espelho do bloco de almoço da fn_rat_sync_tempo):
--  · alvos = dono (tecnico_id) + respostas.tecnicos[] (objetos {id,nome} ou uuids crus);
--  · dia   = respostas.data (se houver) senão `data` em America/Sao_Paulo;
--  · janela = respostas.almoco_inicio/termino (fn_time_ou_null tolera lixo; o pré-orç
--    não tem a chave 'almoco'='Sim' da RAT — a presença da janela é o sinal);
--  · re-materialização idempotente: delete dos registros deste artefato + re-registro;
--    remover o almoço no app remove da jornada;
--  · dedup/conflito ficam na fn_registrar_almoco: se a pessoa já tem almoço no dia por
--    OUTRO artefato com janela diferente → vira linha em almoco_conflitos (visível no
--    banner da Jornada), NUNCA soma em silêncio;
--  · SECURITY DEFINER com search_path travado (regra da casa F22: derivação em trigger
--    sobre tabela com RLS) e exception-swallow no bloco (almoço nunca derruba o sync);
--  · backfill único dos pré-orçamentos já existentes ao final.
alter table public.almocos drop constraint if exists almocos_artefato_tipo_check;
alter table public.almocos add constraint almocos_artefato_tipo_check
  check (artefato_tipo = any (array['rat'::text, 'deslocamento'::text, 'pre_orcamento'::text]));

create or replace function public.fn_preorc_sync_almoco()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ini time; v_fim time; v_dia date; v_tec uuid;
begin
  begin
    delete from almocos where artefato_tipo = 'pre_orcamento' and artefato_id = new.id;
    v_ini := fn_time_ou_null(new.respostas->>'almoco_inicio');
    v_fim := fn_time_ou_null(new.respostas->>'almoco_termino');
    if v_ini is null or v_fim is null or v_fim <= v_ini then return new; end if;
    v_dia := coalesce(fn_date_ou_null(new.respostas->>'data'),
                      (new.data at time zone 'America/Sao_Paulo')::date, current_date);
    for v_tec in
      select distinct tid from (
        select new.tecnico_id as tid
        union
        select coalesce((t.e->>'id')::uuid, nullif(t.e #>> '{}', '')::uuid)
          from jsonb_array_elements(coalesce(new.respostas->'tecnicos', '[]'::jsonb)) as t(e)
      ) x where tid is not null
    loop
      perform fn_registrar_almoco(v_tec, v_dia, v_ini, v_fim, 'manual', 'pre_orcamento', new.id);
    end loop;
  exception when others then null;   -- almoço nunca derruba o upsert do pré-orçamento
  end;
  return new;
end $function$;

drop trigger if exists trg_preorc_sync_almoco on public.pre_orcamentos;
create trigger trg_preorc_sync_almoco
  after insert or update of respostas on public.pre_orcamentos
  for each row execute function public.fn_preorc_sync_almoco();

-- Backfill único: materializa o almoço dos pré-orçamentos que já estão no banco
-- (mesma lógica do trigger; fn_registrar_almoco resolve dedup/conflito por pessoa/dia).
do $$
declare p record; v_tec uuid; v_dia date;
begin
  for p in
    select id, tecnico_id, data, respostas,
           fn_time_ou_null(respostas->>'almoco_inicio')  as a_ini,
           fn_time_ou_null(respostas->>'almoco_termino') as a_fim
      from pre_orcamentos
     where fn_time_ou_null(respostas->>'almoco_inicio') is not null
       and fn_time_ou_null(respostas->>'almoco_termino') is not null
       and fn_time_ou_null(respostas->>'almoco_termino') > fn_time_ou_null(respostas->>'almoco_inicio')
  loop
    v_dia := coalesce(fn_date_ou_null(p.respostas->>'data'),
                      (p.data at time zone 'America/Sao_Paulo')::date, current_date);
    for v_tec in
      select distinct tid from (
        select p.tecnico_id as tid
        union
        select coalesce((t.e->>'id')::uuid, nullif(t.e #>> '{}', '')::uuid)
          from jsonb_array_elements(coalesce(p.respostas->'tecnicos', '[]'::jsonb)) as t(e)
      ) x where tid is not null
    loop
      perform fn_registrar_almoco(v_tec, v_dia, p.a_ini, p.a_fim, 'manual', 'pre_orcamento', p.id);
    end loop;
  end loop;
end $$;

-- Guarda auto-abortante: trigger no lugar, função DEFINER com search_path, constraint aceita
-- o tipo novo — senão rollback (inclusive do backfill).
do $$
begin
  if not exists (
    select 1 from pg_trigger t where t.tgrelid = 'public.pre_orcamentos'::regclass
       and t.tgname = 'trg_preorc_sync_almoco' and not t.tgisinternal
  ) then
    raise exception '0143: trigger trg_preorc_sync_almoco ausente — abortando';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_preorc_sync_almoco'
       and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception '0143: fn_preorc_sync_almoco sem DEFINER/search_path — abortando';
  end if;
  if not exists (
    select 1 from pg_constraint c where c.conrelid = 'public.almocos'::regclass
       and c.conname = 'almocos_artefato_tipo_check'
       and pg_get_constraintdef(c.oid) like '%pre_orcamento%'
  ) then
    raise exception '0143: constraint de artefato_tipo não aceita pre_orcamento — abortando';
  end if;
end $$;
