-- teste_0129_c2_encerramento.sql — auto-abortante (padrão teste_0124/0128):
-- aplica a DDL da 0129 DENTRO da transação, prova os gates e termina em RAISE EXCEPTION
-- ('0129 OK ...') → rollback TOTAL. Nada persiste — nem fixtures, nem eventos, nem DDL.
--
-- Gates do dropdown/auditoria de vínculos:
--  G1  RPC sem papel (sem JWT) → 0 linhas
--  G2  usuário ATIVO SEM acesso ao portal aparece no dropdown (tem_acesso=false)
--  G3  usuário INATIVO vem com ativo=false (flag do filtro "histórico" da tela)
--  G4  técnico: RPC → 0 linhas e SELECT no map → 0 linhas
--  G5  ação pelo portal (JWT admin) → evento origem_execucao='portal', ator=admin
--  G6  operação administrativa (service, GUC) → 'sql_assistido', ator NULL, aprovado_por ok
--  G7  rotina sem GUC → 'sistema'
--  G8  evento compensatório 'regularizacao' com evento_ref, idempotente
--  G9  eventos de vínculo imutáveis p/ papel de app (update/delete → 0 linhas, conteúdo intacto)
--  G10 gestor consulta a RPC mas NÃO vincula (insert → 42501)
--  G11 nenhum vínculo pré-existente alterado
--  G12 ponto_marcacoes continua com 0 linhas
-- Gates do tangerino_elegivel:
--  E1  default FALSE (catálogo) e usuário sem vínculo permanece false após o backfill
--  E2  backfill: TODO usuário com vínculo ativo vira elegível; nenhum true fora deles
--  E3  ativo SEM acesso pode ser elegível e aparece no dropdown com os dois flags
--  E4  usuário COM acesso pode permanecer não elegível (flag false na RPC — a tela
--      não o oferece para novo vínculo)
--  E5  desmarcar usuário VINCULADO é bloqueado (exceção; exige desvínculo prévio)
--  E6  marcar o checkbox NÃO cria vínculo
--  E7  papel de app (gestor/técnico/admin via REST) NÃO altera o campo (0 linhas, valor intacto)
--  E8  alterações auditadas em ponto_elegivel_eventos (anterior, novo, origem, data/hora);
--      setter oficial sr_set_tangerino_elegivel audita origem='portal' com ator verificado
--  E9  authenticated não executa o setter (grant só service_role)
--  E10 trilha ponto_elegivel_eventos imutável p/ papel de app
--  E11 backfill auditado como 'sistema' (1 evento por vinculado)
do $$
declare
  v_adm uuid; v_tec1 uuid; v_tec2 uuid; v_livre1 uuid; v_livre2 uuid; v_vinc uuid; v_acesso_livre uuid;
  v_map_ini int; v_n_vinc int; v_n int; v_raised boolean;
  v_row record; v_ev_id uuid; v_ev_em timestamptz; v_ev_detalhe text; v_ref uuid;
begin
  -- ── baseline + perfis reais (alterações revertem no rollback) ──
  select count(*) into v_map_ini from public.ponto_colaboradores_map;
  select count(distinct m.tecnico_id) into v_n_vinc from public.ponto_colaboradores_map m where m.ativo;
  select pa.usuario_id into v_adm from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='admin' limit 1;
  select pa.usuario_id into v_tec1 from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  select pa.usuario_id into v_tec2 from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' and pa.usuario_id <> v_tec1 limit 1;
  if v_adm is null or v_tec1 is null or v_tec2 is null then raise exception '0129: faltam perfis'; end if;
  -- dois usuários SEM linha no map (recebem vínculos de teste sem conflitar com a PK)
  select u.id into v_livre1 from usuarios u
   where not exists (select 1 from ponto_colaboradores_map m where m.tecnico_id = u.id) limit 1;
  select u.id into v_livre2 from usuarios u
   where not exists (select 1 from ponto_colaboradores_map m where m.tecnico_id = u.id)
     and u.id <> v_livre1 limit 1;
  if v_livre1 is null or v_livre2 is null then raise exception '0129: faltam usuários livres'; end if;
  -- um usuário vinculado real (p/ o bloqueio E5) e um COM acesso e sem vínculo (E4)
  select m.tecnico_id into v_vinc from public.ponto_colaboradores_map m where m.ativo limit 1;
  select pa.usuario_id into v_acesso_livre from portal_acessos pa
   where pa.app_chave='service_report'
     and not exists (select 1 from ponto_colaboradores_map m where m.tecnico_id = pa.usuario_id)
     and pa.usuario_id not in (v_livre1, v_livre2, v_tec1, v_tec2)   -- não pode receber vínculo de
     -- teste (990001/990002) nem ser o fixture que perde acesso (G2) ou muda de papel (G10)
   limit 1;
  if v_vinc is null or v_acesso_livre is null then raise exception '0129: fixtures E ausentes'; end if;

  -- ── aplica a DDL da 0129 (mesmo conteúdo da migration) ──
  execute 'alter table public.usuarios add column if not exists tangerino_elegivel boolean not null default false';
  execute $D$ create table if not exists public.ponto_elegivel_eventos (
      id uuid primary key default gen_random_uuid(),
      usuario_id uuid not null, valor_anterior boolean, valor_novo boolean not null,
      ator uuid, origem_execucao text check (origem_execucao in ('portal','sql_assistido','sistema')),
      em timestamptz not null default now()) $D$;
  execute 'alter table public.ponto_elegivel_eventos enable row level security';
  execute 'drop policy if exists pelev_office_sel on public.ponto_elegivel_eventos';
  execute $P$ create policy pelev_office_sel on public.ponto_elegivel_eventos
    for select using (app_role() = any (array['admin','gestor_axis'])) $P$;
  execute 'revoke all on table public.ponto_elegivel_eventos from anon';
  execute $D$ create or replace function public.tg_ponto_eleg_ev_imutavel()
    returns trigger language plpgsql as $F$
    begin
      if current_user in ('service_role','postgres','supabase_admin') then return coalesce(new, old); end if;
      raise exception 'ponto_elegivel_eventos é imutável (histórico de auditoria)' using errcode = '42501';
    end $F$ $D$;
  execute 'drop trigger if exists trg_ponto_eleg_ev_imutavel on public.ponto_elegivel_eventos';
  execute $D$ create trigger trg_ponto_eleg_ev_imutavel before update or delete on public.ponto_elegivel_eventos
    for each row execute function public.tg_ponto_eleg_ev_imutavel() $D$;
  execute $D$ create or replace function public.ponto_origem_execucao()
    returns text language sql stable as $F$
      select case
        when auth.uid() is not null then 'portal'
        when current_setting('app.ponto_origem', true) in ('portal','sql_assistido')
          then current_setting('app.ponto_origem', true)
        else 'sistema'
      end;
    $F$ $D$;
  execute $D$ create or replace function public.tg_usuarios_tangerino_elegivel()
    returns trigger language plpgsql as $F$
    begin
      if new.tangerino_elegivel is distinct from old.tangerino_elegivel then
        if current_user not in ('service_role','postgres','supabase_admin','supabase_auth_admin') then
          raise exception 'tangerino_elegivel: alteração somente pelo backend (admin via portal)'
            using errcode = '42501';
        end if;
        if old.tangerino_elegivel and not new.tangerino_elegivel
           and exists (select 1 from public.ponto_colaboradores_map m
                        where m.tecnico_id = new.id and m.ativo) then
          raise exception 'usuário possui vínculo ativo com o Tangerino — desvincule primeiro (fluxo auditado)';
        end if;
      end if;
      return new;
    end $F$ $D$;
  execute 'drop trigger if exists trg_usuarios_tangerino_elegivel on public.usuarios';
  execute $D$ create trigger trg_usuarios_tangerino_elegivel before update on public.usuarios
    for each row execute function public.tg_usuarios_tangerino_elegivel() $D$;
  execute $D$ create or replace function public.tg_usuarios_eleg_evento()
    returns trigger language plpgsql security definer set search_path = public as $F$
    begin
      if new.tangerino_elegivel is distinct from old.tangerino_elegivel then
        insert into public.ponto_elegivel_eventos (usuario_id, valor_anterior, valor_novo, ator, origem_execucao)
        values (new.id, old.tangerino_elegivel, new.tangerino_elegivel,
                coalesce(auth.uid(), nullif(current_setting('app.ponto_ator', true), '')::uuid),
                public.ponto_origem_execucao());
      end if;
      return new;
    end $F$ $D$;
  execute 'drop trigger if exists trg_usuarios_eleg_evento on public.usuarios';
  execute $D$ create trigger trg_usuarios_eleg_evento after update on public.usuarios
    for each row execute function public.tg_usuarios_eleg_evento() $D$;
  execute $D$ create or replace function public.sr_set_tangerino_elegivel(p_usuario uuid, p_valor boolean, p_ator uuid)
    returns void language plpgsql security definer set search_path = public as $F$
    begin
      perform set_config('app.ponto_origem', 'portal', true);
      perform set_config('app.ponto_ator', coalesce(p_ator::text, ''), true);
      update public.usuarios set tangerino_elegivel = p_valor where id = p_usuario;
      if not found then raise exception 'usuário não encontrado'; end if;
      perform set_config('app.ponto_origem', '', true);
      perform set_config('app.ponto_ator', '', true);
    end $F$ $D$;
  execute 'revoke all on function public.sr_set_tangerino_elegivel(uuid, boolean, uuid) from public, anon, authenticated';
  execute 'grant execute on function public.sr_set_tangerino_elegivel(uuid, boolean, uuid) to service_role';
  execute $D$ update public.usuarios u set tangerino_elegivel = true
     where exists (select 1 from public.ponto_colaboradores_map m
                    where m.tecnico_id = u.id and m.ativo)
       and u.tangerino_elegivel = false $D$;
  execute 'drop function if exists public.sr_usuarios_vinculo()';
  execute $D$ create or replace function public.sr_usuarios_vinculo()
    returns table(id uuid, nome text, ativo boolean, tem_acesso boolean, tangerino_elegivel boolean)
    language sql stable security definer set search_path = public as $F$
      select u.id, u.nome, u.ativo,
             exists (select 1 from public.portal_acessos pa
                      where pa.usuario_id = u.id and pa.app_chave = 'service_report') as tem_acesso,
             u.tangerino_elegivel
      from public.usuarios u
      where public.app_role() = any (array['admin','gestor_axis'])
      order by u.nome;
    $F$ $D$;
  execute 'revoke all on function public.sr_usuarios_vinculo() from public, anon';
  execute 'grant execute on function public.sr_usuarios_vinculo() to authenticated';
  execute $D$ alter table public.ponto_vinculo_eventos
    add column if not exists origem_execucao text
      check (origem_execucao in ('portal','sql_assistido','sistema')),
    add column if not exists aprovado_por uuid,
    add column if not exists evento_ref uuid $D$;
  execute 'alter table public.ponto_vinculo_eventos drop constraint if exists ponto_vinculo_eventos_acao_check';
  execute $D$ alter table public.ponto_vinculo_eventos add constraint ponto_vinculo_eventos_acao_check
    check (acao in ('vinculado','alterado','desvinculado','fora_escopo','retorno_escopo','regularizacao')) $D$;
  execute $D$ create or replace function public.tg_ponto_map_evento()
    returns trigger language plpgsql security definer set search_path = public as $F$
    declare
      v_ator   uuid := auth.uid();
      v_origem text := public.ponto_origem_execucao();
    begin
      if tg_op = 'INSERT' then
        insert into public.ponto_vinculo_eventos
          (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por)
        values (new.tecnico_id, new.tangerino_employee_id, 'vinculado', new.origem_sugestao, v_ator, v_origem, new.vinculado_por);
        return new;
      elsif tg_op = 'UPDATE' then
        if new.tangerino_employee_id is distinct from old.tangerino_employee_id
           or new.ativo is distinct from old.ativo then
          insert into public.ponto_vinculo_eventos
            (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por, detalhe)
          values (new.tecnico_id, new.tangerino_employee_id, 'alterado', new.origem_sugestao, v_ator, v_origem, new.vinculado_por,
                  'employee ' || old.tangerino_employee_id || ' -> ' || new.tangerino_employee_id ||
                  case when new.ativo is distinct from old.ativo then ' · ativo ' || old.ativo || '->' || new.ativo else '' end);
        end if;
        return new;
      elsif tg_op = 'DELETE' then
        insert into public.ponto_vinculo_eventos
          (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por)
        values (old.tecnico_id, old.tangerino_employee_id, 'desvinculado', old.origem_sugestao, v_ator, v_origem, old.vinculado_por);
        return old;
      end if;
      return null;
    end $F$ $D$;
  execute $D$ create or replace function public.tg_ponto_fe_evento()
    returns trigger language plpgsql security definer set search_path = public as $F$
    declare
      v_ator   uuid := auth.uid();
      v_origem text := public.ponto_origem_execucao();
    begin
      if tg_op = 'INSERT' then
        insert into public.ponto_vinculo_eventos
          (tecnico_id, tangerino_employee_id, acao, ator, origem_execucao, aprovado_por, detalhe)
        values (null, new.tangerino_employee_id, 'fora_escopo', v_ator, v_origem, new.decidido_por, new.motivo);
        return new;
      elsif tg_op = 'DELETE' then
        insert into public.ponto_vinculo_eventos
          (tecnico_id, tangerino_employee_id, acao, ator, origem_execucao, aprovado_por, detalhe)
        values (null, old.tangerino_employee_id, 'retorno_escopo', v_ator, v_origem, old.decidido_por,
                'reversão (motivo original: ' || old.motivo || ')');
        return old;
      end if;
      return null;
    end $F$ $D$;

  -- ── (E1) default false + sem-vínculo permanece false após backfill ──
  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='usuarios'
     and column_name='tangerino_elegivel' and column_default like 'false%';
  if v_n <> 1 then raise exception '0129 E1: default do campo não é false'; end if;
  if (select tangerino_elegivel from usuarios where id = v_livre1) then
    raise exception '0129 E1: usuário sem vínculo virou elegível no backfill';
  end if;

  -- ── (E2) backfill exato: elegíveis == vinculados ativos ──
  select count(*) into v_n from usuarios where tangerino_elegivel;
  if v_n <> v_n_vinc then raise exception '0129 E2: elegíveis=% (esperado %)', v_n, v_n_vinc; end if;
  if exists (select 1 from usuarios u where u.tangerino_elegivel
              and not exists (select 1 from ponto_colaboradores_map m where m.tecnico_id=u.id and m.ativo)) then
    raise exception '0129 E2: elegível sem vínculo após backfill';
  end if;

  -- ── (E11) backfill auditado como 'sistema' ──
  select count(*) into v_n from ponto_elegivel_eventos
   where origem_execucao='sistema' and valor_novo and valor_anterior = false;
  if v_n <> v_n_vinc then raise exception '0129 E11: eventos do backfill=% (esperado %)', v_n, v_n_vinc; end if;

  -- ── (G1) sem papel (sem JWT, postgres): RPC → 0 linhas ──
  perform set_config('request.jwt.claims', json_build_object('role','postgres')::text, true);
  select count(*) into v_n from public.sr_usuarios_vinculo();
  if v_n <> 0 then raise exception '0129 G1: RPC sem papel devolveu % linhas', v_n; end if;

  -- ── (E3+G2) ativo SEM acesso pode ser elegível e aparece no dropdown ──
  delete from portal_acessos where usuario_id = v_tec1 and app_chave = 'service_report';  -- rollback desfaz
  update usuarios set ativo = true where id = v_tec1;
  update usuarios set tangerino_elegivel = true where id = v_tec1;   -- via backend (postgres)
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select * into v_row from public.sr_usuarios_vinculo() f where f.id = v_tec1;
  if v_row.id is null then raise exception '0129 G2: usuário sem acesso NÃO apareceu no dropdown'; end if;
  if v_row.tem_acesso then raise exception '0129 G2: tem_acesso deveria ser false'; end if;
  if not v_row.ativo then raise exception '0129 G2: fixture deveria estar ativo'; end if;
  if not v_row.tangerino_elegivel then raise exception '0129 E3: elegível sem acesso não veio com flag true'; end if;

  -- ── (E4) usuário COM acesso pode permanecer NÃO elegível (a tela não o oferece) ──
  select * into v_row from public.sr_usuarios_vinculo() f where f.id = v_acesso_livre;
  if v_row.id is null then raise exception '0129 E4: usuário com acesso sumiu da RPC'; end if;
  if v_row.tangerino_elegivel then raise exception '0129 E4: deveria permanecer não elegível'; end if;
  if not v_row.tem_acesso then raise exception '0129 E4: tem_acesso deveria ser true'; end if;

  -- ── (G3) inativo vem com ativo=false (a tela só o exibe com o filtro histórico) ──
  perform set_config('role', 'postgres', true);
  update usuarios set ativo = false where id = v_tec1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select * into v_row from public.sr_usuarios_vinculo() f where f.id = v_tec1;
  if v_row.id is null or v_row.ativo then raise exception '0129 G3: inativo sem flag ativo=false'; end if;

  -- ── (G4) técnico: RPC 0 linhas; SELECT no map 0 linhas ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.sr_usuarios_vinculo();
  if v_n <> 0 then raise exception '0129 G4: técnico viu % linhas na RPC', v_n; end if;
  select count(*) into v_n from public.ponto_colaboradores_map;
  if v_n <> 0 then raise exception '0129 G4: técnico leu % linhas do map', v_n; end if;

  -- ── (G5) ação pelo portal → origem 'portal', ator = admin ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por, origem_sugestao)
  values (v_livre1, 990001, v_adm, 'manual');
  select * into v_row from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 990001 and e.acao = 'vinculado';
  if v_row.origem_execucao is distinct from 'portal' then raise exception '0129 G5: origem % (esperado portal)', v_row.origem_execucao; end if;
  if v_row.ator is distinct from v_adm then raise exception '0129 G5: ator não é o admin autenticado'; end if;

  -- ── (G6) operação administrativa assistida por SQL → 'sql_assistido', ator NULL ──
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('role','postgres')::text, true);
  perform set_config('app.ponto_origem', 'sql_assistido', true);
  insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por, origem_sugestao)
  values (v_livre2, 990002, v_adm, 'cpf');
  select * into v_row from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 990002 and e.acao = 'vinculado';
  if v_row.origem_execucao is distinct from 'sql_assistido' then raise exception '0129 G6: origem % (esperado sql_assistido)', v_row.origem_execucao; end if;
  if v_row.ator is not null then raise exception '0129 G6: operação SQL foi atribuída a um usuário (ator=%)', v_row.ator; end if;
  if v_row.aprovado_por is distinct from v_adm then raise exception '0129 G6: aprovado_por ausente'; end if;

  -- ── (G7) rotina sem GUC → 'sistema' ──
  perform set_config('app.ponto_origem', '', true);
  insert into public.ponto_fora_escopo (tangerino_employee_id, motivo, decidido_por)
  values (990003, 'fixture 0129 — teste de origem sistema', v_adm);
  select * into v_row from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 990003 and e.acao = 'fora_escopo';
  if v_row.origem_execucao is distinct from 'sistema' then raise exception '0129 G7: origem % (esperado sistema)', v_row.origem_execucao; end if;
  if v_row.ator is not null then raise exception '0129 G7: ator deveria ser NULL'; end if;

  -- ── (E5) desmarcar usuário VINCULADO é bloqueado (mesmo pelo backend) ──
  v_raised := false;
  begin
    update usuarios set tangerino_elegivel = false where id = v_vinc;
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0129 E5: desmarcou usuário vinculado sem desvínculo prévio'; end if;
  if not (select tangerino_elegivel from usuarios where id = v_vinc) then
    raise exception '0129 E5: valor mudou apesar do bloqueio';
  end if;

  -- ── (E6) marcar o checkbox NÃO cria vínculo ──
  select count(*) into v_n from public.ponto_colaboradores_map;
  update usuarios set tangerino_elegivel = true where id = v_acesso_livre;
  if (select count(*) from public.ponto_colaboradores_map) <> v_n then
    raise exception '0129 E6: marcar o checkbox criou/removeu vínculo';
  end if;

  -- ── (E8) auditoria: alteração comum ('sistema') e setter oficial ('portal' + ator) ──
  -- (em = now() é congelado na transação → desambiguar por valor_novo, nunca por ordem)
  select * into v_row from ponto_elegivel_eventos
   where usuario_id = v_acesso_livre and valor_novo = true;
  if v_row.id is null or v_row.valor_anterior
     or v_row.origem_execucao is distinct from 'sistema' then
    raise exception '0129 E8: evento da alteração comum incorreto';
  end if;
  perform public.sr_set_tangerino_elegivel(v_acesso_livre, false, v_adm);   -- sem vínculo → pode desmarcar
  select * into v_row from ponto_elegivel_eventos
   where usuario_id = v_acesso_livre and valor_novo = false;
  if v_row.origem_execucao is distinct from 'portal' then raise exception '0129 E8: setter não marcou origem portal (%)', v_row.origem_execucao; end if;
  if v_row.ator is distinct from v_adm then raise exception '0129 E8: setter não registrou o ator verificado'; end if;
  if v_row.valor_novo then raise exception '0129 E8: valor_novo incorreto'; end if;

  -- ── (E7) papel de app não altera o campo (RLS: 0 linhas; valor intacto) ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update usuarios set tangerino_elegivel = true where id = v_acesso_livre;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0129 E7: técnico alterou o campo (% linhas)', v_n; end if;
  perform set_config('role', 'postgres', true);
  if (select tangerino_elegivel from usuarios where id = v_acesso_livre) then
    raise exception '0129 E7: valor mudou por papel de app';
  end if;

  -- ── (E9) authenticated NÃO executa o setter (grant só service_role) ──
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.sr_set_tangerino_elegivel(v_acesso_livre, true, v_adm);
  exception when insufficient_privilege then v_raised := true; end;
  perform set_config('role', 'postgres', true);
  if not v_raised then raise exception '0129 E9: authenticated executou o setter'; end if;

  -- ── (E10) trilha do checkbox imutável p/ papel de app ──
  select e.id into v_ev_id from ponto_elegivel_eventos e limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update ponto_elegivel_eventos set valor_novo = not valor_novo where id = v_ev_id;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0129 E10: admin alterou evento do checkbox'; end if;
  delete from ponto_elegivel_eventos where id = v_ev_id;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0129 E10: admin apagou evento do checkbox'; end if;
  perform set_config('role', 'postgres', true);

  -- ── (G8) evento compensatório: criado com evento_ref e IDEMPOTENTE ──
  for v_n in 1..2 loop
    if not exists (select 1 from public.ponto_vinculo_eventos e
                    where e.tangerino_employee_id = 990002 and e.acao = 'regularizacao') then
      insert into public.ponto_vinculo_eventos
        (tecnico_id, tangerino_employee_id, acao, ator, origem_execucao, aprovado_por, evento_ref, detalhe)
      select e.tecnico_id, 990002, 'regularizacao', null, 'sql_assistido', e.aprovado_por, e.id,
             'regularização de teste — evento original preservado'
      from public.ponto_vinculo_eventos e
      where e.tangerino_employee_id = 990002 and e.acao = 'vinculado' limit 1;
    end if;
  end loop;
  select count(*) into v_n from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 990002 and e.acao = 'regularizacao';
  if v_n <> 1 then raise exception '0129 G8: regularizacao duplicada ou ausente (%)', v_n; end if;
  select e.evento_ref into v_ref from public.ponto_vinculo_eventos e
   where e.tangerino_employee_id = 990002 and e.acao = 'regularizacao';
  if v_ref is null then raise exception '0129 G8: evento_ref ausente'; end if;

  -- ── (G9) eventos de vínculo continuam imutáveis para papel de app ──
  select e.id, e.em, e.detalhe into v_ev_id, v_ev_em, v_ev_detalhe
    from public.ponto_vinculo_eventos e where e.tangerino_employee_id = 990001 limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.ponto_vinculo_eventos set detalhe = 'ADULTERADO' where id = v_ev_id;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0129 G9: admin conseguiu alterar evento (%)', v_n; end if;
  delete from public.ponto_vinculo_eventos where id = v_ev_id;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0129 G9: admin conseguiu apagar evento'; end if;
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.ponto_vinculo_eventos e
              where e.id = v_ev_id and (e.detalhe is distinct from v_ev_detalhe or e.em is distinct from v_ev_em)) then
    raise exception '0129 G9: conteúdo do evento mudou';
  end if;

  -- ── (G10) gestor consulta mas NÃO vincula ──
  update portal_acessos set role_chave='gestor_axis'
   where usuario_id = v_tec2 and app_chave='service_report';   -- rollback desfaz
  perform set_config('request.jwt.claims', json_build_object('sub', v_tec2, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.sr_usuarios_vinculo();
  if v_n = 0 then raise exception '0129 G10: gestor deveria consultar a RPC'; end if;
  v_raised := false;
  begin
    insert into public.ponto_colaboradores_map (tecnico_id, tangerino_employee_id, vinculado_por)
    values (v_tec2, 990004, v_tec2);
  exception when insufficient_privilege then v_raised := true; end;
  if not v_raised then raise exception '0129 G10: gestor conseguiu vincular'; end if;
  -- gestor também não altera o checkbox
  update usuarios set tangerino_elegivel = true where id = v_acesso_livre;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception '0129 E7: gestor alterou o campo'; end if;
  perform set_config('role', 'postgres', true);

  -- ── (G11) nenhum vínculo pré-existente alterado ──
  select count(*) into v_n from public.ponto_colaboradores_map
   where tangerino_employee_id not in (990001, 990002);
  if v_n <> v_map_ini then raise exception '0129 G11: vínculos pré-existentes mudaram (% × %)', v_n, v_map_ini; end if;
  select count(*) into v_n from public.ponto_vinculo_eventos
   where acao in ('alterado','desvinculado') and tangerino_employee_id not in (990001, 990002, 990003)
     and origem_execucao is not null;   -- só eventos gerados nesta transação
  if v_n <> 0 then raise exception '0129 G11: houve alteração/desvinculação fora das fixtures'; end if;

  -- ── (G12) espelho de marcações segue vazio ──
  select count(*) into v_n from public.ponto_marcacoes;
  if v_n <> 0 then raise exception '0129 G12: ponto_marcacoes tem % linhas', v_n; end if;

  raise exception '0129 OK: G1–G12 + E1–E11 verdes — rollback total (nada persistiu)';
end $$;
