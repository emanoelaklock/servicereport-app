-- Teste de regressão da 0128 (vínculos C2) — SEGURO EM PRODUÇÃO (padrão auto-abortante):
-- aplica o DDL na transação, prova os gates e levanta exceção final → rollback total.
--   'TESTES_OK …' = passou · '0128: …' = qual gate falhou.
-- Gates: vínculo válido gera evento · colaborador duplicado bloqueado · usuário duplicado
-- bloqueado · técnico sem acesso · gestor lê e NÃO escreve · desvincular audita e preserva
-- histórico · evento imutável p/ papel de app · correção (update) audita 'alterado'.
do $MIG$
declare
  v_n int; v_tec1 uuid; v_tec2 uuid; v_adm uuid; v_raised boolean;
  v_claims text;
begin
  -- ── aplica o DDL da 0128 (idempotente; corpo espelhado do arquivo da migração) ──
  execute $D$ alter table public.ponto_colaboradores_map
    add column if not exists origem_sugestao text not null default 'manual'
      check (origem_sugestao in ('externalId','cpf','manual')) $D$;
  execute $D$ create table if not exists public.ponto_vinculo_eventos (
    id uuid primary key default gen_random_uuid(),
    tecnico_id uuid, tangerino_employee_id bigint not null,
    acao text not null check (acao in ('vinculado','alterado','desvinculado','fora_escopo','retorno_escopo')),
    origem_sugestao text, ator uuid, em timestamptz not null default now(), detalhe text) $D$;
  execute 'alter table public.ponto_vinculo_eventos enable row level security';
  execute 'drop policy if exists pvev_office_sel on public.ponto_vinculo_eventos';
  execute $P$ create policy pvev_office_sel on public.ponto_vinculo_eventos
    for select using (app_role() = any (array['admin','gestor_axis'])) $P$;
  execute 'revoke all on table public.ponto_vinculo_eventos from anon';
  execute $D$ create or replace function public.tg_ponto_vinculo_ev_imutavel()
    returns trigger language plpgsql as $F$
    begin
      if current_user in ('service_role','postgres','supabase_admin') then return coalesce(new, old); end if;
      raise exception 'ponto_vinculo_eventos é imutável (histórico de auditoria)' using errcode = '42501';
    end $F$ $D$;
  execute 'drop trigger if exists trg_ponto_vinc_ev_imutavel on public.ponto_vinculo_eventos';
  execute $D$ create trigger trg_ponto_vinc_ev_imutavel before update or delete on public.ponto_vinculo_eventos
    for each row execute function public.tg_ponto_vinculo_ev_imutavel() $D$;
  execute $D$ create or replace function public.tg_ponto_map_evento()
    returns trigger language plpgsql security definer set search_path = public as $F$
    declare v_ator uuid := auth.uid();
    begin
      if tg_op = 'INSERT' then
        insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator)
        values (new.tecnico_id, new.tangerino_employee_id, 'vinculado', new.origem_sugestao, coalesce(v_ator, new.vinculado_por));
        return new;
      elsif tg_op = 'UPDATE' then
        if new.tangerino_employee_id is distinct from old.tangerino_employee_id
           or new.ativo is distinct from old.ativo then
          insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, detalhe)
          values (new.tecnico_id, new.tangerino_employee_id, 'alterado', new.origem_sugestao, coalesce(v_ator, new.vinculado_por),
                  'employee ' || old.tangerino_employee_id || ' → ' || new.tangerino_employee_id ||
                  case when new.ativo is distinct from old.ativo then ' · ativo ' || old.ativo || '→' || new.ativo else '' end);
        end if;
        return new;
      elsif tg_op = 'DELETE' then
        insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator)
        values (old.tecnico_id, old.tangerino_employee_id, 'desvinculado', old.origem_sugestao, coalesce(v_ator, old.vinculado_por));
        return old;
      end if;
      return null;
    end $F$ $D$;
  execute 'drop trigger if exists trg_ponto_map_evento on public.ponto_colaboradores_map';
  execute $D$ create trigger trg_ponto_map_evento after insert or update or delete on public.ponto_colaboradores_map
    for each row execute function public.tg_ponto_map_evento() $D$;
  execute $D$ create table if not exists public.ponto_fora_escopo (
    tangerino_employee_id bigint primary key,
    motivo text not null check (length(btrim(motivo)) >= 3),
    decidido_por uuid not null references public.usuarios(id),
    decidido_em timestamptz not null default now()) $D$;
  execute 'alter table public.ponto_fora_escopo enable row level security';
  execute 'drop policy if exists pfe_read on public.ponto_fora_escopo';
  execute $P$ create policy pfe_read on public.ponto_fora_escopo
    for select using (app_role() = any (array['admin','gestor_axis'])) $P$;
  execute 'drop policy if exists pfe_admin_ins on public.ponto_fora_escopo';
  execute $P$ create policy pfe_admin_ins on public.ponto_fora_escopo
    for insert with check (app_role() = 'admin') $P$;
  execute 'drop policy if exists pfe_admin_del on public.ponto_fora_escopo';
  execute $P$ create policy pfe_admin_del on public.ponto_fora_escopo
    for delete using (app_role() = 'admin') $P$;
  execute 'revoke all on table public.ponto_fora_escopo from anon';
  execute $D$ create or replace function public.tg_ponto_fe_valida()
    returns trigger language plpgsql as $F$
    begin
      if exists (select 1 from public.ponto_colaboradores_map m
                  where m.tangerino_employee_id = new.tangerino_employee_id) then
        raise exception 'colaborador está VINCULADO — desvincule antes de marcar fora do escopo';
      end if;
      return new;
    end $F$ $D$;
  execute 'drop trigger if exists trg_ponto_fe_valida on public.ponto_fora_escopo';
  execute $D$ create trigger trg_ponto_fe_valida before insert on public.ponto_fora_escopo
    for each row execute function public.tg_ponto_fe_valida() $D$;
  execute $D$ create or replace function public.tg_ponto_map_valida_escopo()
    returns trigger language plpgsql as $F$
    begin
      if exists (select 1 from public.ponto_fora_escopo f
                  where f.tangerino_employee_id = new.tangerino_employee_id) then
        raise exception 'colaborador está FORA DO ESCOPO — retorne-o ao escopo antes de vincular';
      end if;
      return new;
    end $F$ $D$;
  execute 'drop trigger if exists trg_ponto_map_valida_escopo on public.ponto_colaboradores_map';
  execute $D$ create trigger trg_ponto_map_valida_escopo before insert or update of tangerino_employee_id
    on public.ponto_colaboradores_map
    for each row execute function public.tg_ponto_map_valida_escopo() $D$;
  execute $D$ create or replace function public.tg_ponto_fe_evento()
    returns trigger language plpgsql security definer set search_path = public as $F$
    declare v_ator uuid := auth.uid();
    begin
      if tg_op = 'INSERT' then
        insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, ator, detalhe)
        values (null, new.tangerino_employee_id, 'fora_escopo', coalesce(v_ator, new.decidido_por), new.motivo);
        return new;
      elsif tg_op = 'DELETE' then
        insert into public.ponto_vinculo_eventos (tecnico_id, tangerino_employee_id, acao, ator, detalhe)
        values (null, old.tangerino_employee_id, 'retorno_escopo', coalesce(v_ator, old.decidido_por),
                'reversão (motivo original: ' || old.motivo || ')');
        return old;
      end if;
      return null;
    end $F$ $D$;
  execute 'drop trigger if exists trg_ponto_fe_evento on public.ponto_fora_escopo';
  execute $D$ create trigger trg_ponto_fe_evento after insert or delete on public.ponto_fora_escopo
    for each row execute function public.tg_ponto_fe_evento() $D$;
  execute 'alter table public.ponto_sync_execucoes rename column descartadas_sem_vinculo to pendentes_sem_vinculo';
  execute 'alter table public.ponto_sync_execucoes add column if not exists ignoradas_fora_escopo int not null default 0';
  execute 'alter table public.ponto_sync_execucoes add column if not exists invalidas int not null default 0';

  execute 'drop policy if exists pmap_office_all on public.ponto_colaboradores_map';
  execute 'drop policy if exists pmap_read on public.ponto_colaboradores_map';
  execute $P$ create policy pmap_read on public.ponto_colaboradores_map
    for select using (app_role() = any (array['admin','gestor_axis'])) $P$;
  execute 'drop policy if exists pmap_admin_ins on public.ponto_colaboradores_map';
  execute $P$ create policy pmap_admin_ins on public.ponto_colaboradores_map
    for insert with check (app_role() = 'admin') $P$;
  execute 'drop policy if exists pmap_admin_upd on public.ponto_colaboradores_map';
  execute $P$ create policy pmap_admin_upd on public.ponto_colaboradores_map
    for update using (app_role() = 'admin') with check (app_role() = 'admin') $P$;
  execute 'drop policy if exists pmap_admin_del on public.ponto_colaboradores_map';
  execute $P$ create policy pmap_admin_del on public.ponto_colaboradores_map
    for delete using (app_role() = 'admin') $P$;

  -- ── perfis: 2 técnicos + 1 admin; 1 técnico vira GESTOR só dentro desta transação ──
  select pa.usuario_id into v_tec1 from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  select pa.usuario_id into v_tec2 from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' and pa.usuario_id <> v_tec1 limit 1;
  select pa.usuario_id into v_adm from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='admin' limit 1;
  if v_tec1 is null or v_tec2 is null or v_adm is null then raise exception '0128: faltam perfis'; end if;
  update portal_acessos set role_chave='gestor_axis'
   where usuario_id=v_tec2 and app_chave='service_report';   -- rollback desfaz

  -- ── (G1) admin vincula → linha + evento 'vinculado' ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por, origem_sugestao)
  values (v_tec1, 888801, v_adm, 'cpf');
  select count(*) into v_n from public.ponto_vinculo_eventos where tecnico_id=v_tec1 and acao='vinculado';
  if v_n <> 1 then raise exception '0128: evento vinculado ausente (%)', v_n; end if;

  -- ── (G2) colaborador duplicado (mesmo employee, outro técnico) → bloqueado ──
  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_adm, 888801, v_adm);
  exception when unique_violation then v_raised := true; end;
  if not v_raised then raise exception '0128: colaborador duplicado passou'; end if;

  -- ── (G3) usuário duplicado (mesmo técnico, outro employee) → bloqueado (PK) ──
  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_tec1, 888802, v_adm);
  exception when unique_violation then v_raised := true; end;
  if not v_raised then raise exception '0128: usuário duplicado passou'; end if;

  -- ── (G4) correção via update → evento 'alterado' ──
  update public.ponto_colaboradores_map set tangerino_employee_id = 888803 where tecnico_id = v_tec1;
  select count(*) into v_n from public.ponto_vinculo_eventos where tecnico_id=v_tec1 and acao='alterado';
  if v_n <> 1 then raise exception '0128: evento alterado ausente'; end if;

  -- ── (G5) técnico: não lê e não escreve ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec1, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.ponto_colaboradores_map;
  if v_n <> 0 then raise exception '0128: técnico leu o map (%)', v_n; end if;
  select count(*) into v_n from public.ponto_vinculo_eventos;
  if v_n <> 0 then raise exception '0128: técnico leu eventos (%)', v_n; end if;
  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_tec1, 888804, v_tec1);
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0128: técnico escreveu no map'; end if;

  -- ── (G6) gestor: lê, mas NÃO escreve nem apaga ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.ponto_colaboradores_map;
  if v_n < 1 then raise exception '0128: gestor não leu o map'; end if;
  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_tec2, 888805, v_tec2);
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0128: gestor escreveu no map'; end if;
  delete from public.ponto_colaboradores_map where tecnico_id = v_tec1;   -- RLS: delete de gestor não atinge linhas
  select count(*) into v_n from public.ponto_colaboradores_map where tecnico_id = v_tec1;
  if v_n <> 1 then raise exception '0128: gestor conseguiu apagar vínculo'; end if;

  -- ── (G7) evento imutável para papel de app ──
  -- Sem policy de UPDATE/DELETE, o RLS faz o comando atingir 0 LINHAS (sem exceção) —
  -- a prova correta é: nenhuma linha afetada E dado intacto. (O trigger de imutabilidade
  -- cobre o caminho privilegiado que ignora RLS.)
  update public.ponto_vinculo_eventos set detalhe = 'adulterado' where tecnico_id = v_tec1;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0128: papel de app conseguiu tocar % evento(s)', v_n; end if;
  perform set_config('role', 'postgres', true);
  select count(*) into v_n from public.ponto_vinculo_eventos where detalhe = 'adulterado';
  if v_n <> 0 then raise exception '0128: evento adulterado persistiu'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role', 'authenticated')::text, true);

  -- ── (G8) admin desvincula → evento 'desvinculado'; histórico preservado ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  delete from public.ponto_colaboradores_map where tecnico_id = v_tec1;
  select count(*) into v_n from public.ponto_vinculo_eventos where tecnico_id=v_tec1 and acao='desvinculado';
  if v_n <> 1 then raise exception '0128: evento desvinculado ausente'; end if;
  select count(*) into v_n from public.ponto_vinculo_eventos where tecnico_id=v_tec1;
  if v_n < 3 then raise exception '0128: histórico não preservado após desvincular (%)', v_n; end if;

  -- ── (G9) fora do escopo EXIGE motivo ──
  v_raised := false;
  begin
    insert into public.ponto_fora_escopo (tangerino_employee_id, motivo, decidido_por)
    values (888810, '  ', v_adm);
  exception when check_violation then v_raised := true; end;
  if not v_raised then raise exception '0128: fora_escopo sem motivo passou'; end if;

  -- ── (G10) admin marca fora do escopo → evento com motivo ──
  insert into public.ponto_fora_escopo (tangerino_employee_id, motivo, decidido_por)
  values (888810, 'administrativo — não atua em campo', v_adm);
  select count(*) into v_n from public.ponto_vinculo_eventos
   where tangerino_employee_id = 888810 and acao = 'fora_escopo' and detalhe like 'administrativo%';
  if v_n <> 1 then raise exception '0128: evento fora_escopo ausente'; end if;

  -- ── (G11) conflito bidirecional vínculo × fora_escopo ──
  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_tec1, 888810, v_adm);   -- vincular quem está fora do escopo
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0128: vinculou colaborador fora do escopo'; end if;
  insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
  values (v_tec1, 888811, v_adm);
  v_raised := false;
  begin
    insert into public.ponto_fora_escopo (tangerino_employee_id, motivo, decidido_por)
    values (888811, 'tentativa com vínculo ativo', v_adm);   -- marcar FE quem está vinculado
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0128: marcou fora do escopo colaborador vinculado'; end if;

  -- ── (G12) gestor NÃO marca fora do escopo (nem reverte) ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.ponto_fora_escopo;
  if v_n < 1 then raise exception '0128: gestor não leu fora_escopo'; end if;
  v_raised := false;
  begin
    insert into public.ponto_fora_escopo (tangerino_employee_id, motivo, decidido_por)
    values (888812, 'gestor tentando', v_tec2);
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0128: gestor marcou fora do escopo'; end if;
  delete from public.ponto_fora_escopo where tangerino_employee_id = 888810;
  select count(*) into v_n from public.ponto_fora_escopo where tangerino_employee_id = 888810;
  if v_n <> 1 then raise exception '0128: gestor reverteu fora_escopo'; end if;

  -- ── (G13) reversão pelo admin → evento retorno_escopo; histórico preservado ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  delete from public.ponto_fora_escopo where tangerino_employee_id = 888810;
  select count(*) into v_n from public.ponto_vinculo_eventos
   where tangerino_employee_id = 888810 and acao = 'retorno_escopo';
  if v_n <> 1 then raise exception '0128: evento retorno_escopo ausente'; end if;
  select count(*) into v_n from public.ponto_vinculo_eventos where tangerino_employee_id = 888810;
  if v_n <> 2 then raise exception '0128: histórico de escopo não preservado (%)', v_n; end if;

  perform set_config('role', 'postgres', true);
  raise exception 'TESTES_OK 0128v2 — vínculos + fora_escopo validados (rollback total desta transação)';
end $MIG$;
