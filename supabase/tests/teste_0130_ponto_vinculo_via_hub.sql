-- teste_0130_ponto_vinculo_via_hub.sql — auto-abortante (padrão teste_0128/0129):
-- aplica a DDL da 0130 DENTRO da transação, prova os gates e termina em RAISE EXCEPTION
-- ('0130 OK …') → rollback TOTAL. Nada persiste (RPC/trigger revertem).
-- Gates:
--  G1  vincular via service_role → linha no map + evento 'vinculado' origem 'portal' + ator=admin (aprovado_por=admin)
--  G2  authenticated NÃO executa a RPC (grant só service_role → insufficient_privilege)
--  G3  action de vínculo repetida (mesmo usuário) → erro claro, SEM novo evento (não duplica)
--  G4  colaborador já vinculado a outro usuário → erro claro (dedup no outro sentido)
--  G5  vincular exige tangerino_elegivel=true (mensagem clara)
--  G6  colaborador fora do escopo é barrado
--  G7  sr_status_vinculo_usuario reflete o vínculo atual
--  G8  desvincular via RPC → evento 'desvinculado' origem 'portal' + ator=admin
--  G9  desmarcar elegível com vínculo ativo é barrado (interação 0129)
--  G10 vínculos pré-existentes intactos; ponto_marcacoes = 0
do $$
declare
  v_adm uuid; v_tec2 uuid; v_livre1 uuid; v_livre2 uuid; v_vinc uuid;
  v_map_ini int; v_ev_ini int; v_n int; v_raised boolean; v_msg text;
  v_row record;
begin
  select count(*) into v_map_ini from public.ponto_colaboradores_map;
  select count(*) into v_ev_ini  from public.ponto_vinculo_eventos;
  select pa.usuario_id into v_adm from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='admin' limit 1;
  select pa.usuario_id into v_tec2 from portal_acessos pa
   where pa.app_chave='service_report' and pa.role_chave='tecnico_campo' limit 1;
  if v_adm is null or v_tec2 is null then raise exception '0130: faltam perfis'; end if;
  select u.id into v_livre1 from usuarios u
   where not exists (select 1 from ponto_colaboradores_map m where m.tecnico_id = u.id) limit 1;
  select u.id into v_livre2 from usuarios u
   where not exists (select 1 from ponto_colaboradores_map m where m.tecnico_id = u.id)
     and u.id <> v_livre1 limit 1;
  select m.tecnico_id into v_vinc from ponto_colaboradores_map m where m.ativo limit 1;
  if v_livre1 is null or v_livre2 is null or v_vinc is null then raise exception '0130: faltam fixtures'; end if;

  -- ── aplica a DDL da 0130 (mesmo conteúdo da migration) ──
  execute $D$ create or replace function public.tg_ponto_map_evento()
    returns trigger language plpgsql security definer set search_path = public as $F$
    declare
      v_ator   uuid := coalesce(auth.uid(), nullif(current_setting('app.ponto_ator', true), '')::uuid);
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
          values (new.tecnico_id, new.tangerino_employee_id, 'alterado', new.origem_sugestao, v_ator, v_origem, new.vinculado_por, 'x');
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
  execute $D$ create or replace function public.sr_vincular_colaborador(
      p_usuario uuid, p_employee_id bigint, p_external_id text, p_origem text, p_ator uuid)
    returns void language plpgsql security definer set search_path = public as $F$
    declare v_elegivel boolean;
    begin
      select tangerino_elegivel into v_elegivel from public.usuarios where id = p_usuario;
      if not found then raise exception 'usuário não encontrado' using errcode = 'P0002'; end if;
      if not coalesce(v_elegivel, false) then
        raise exception 'usuário não está marcado como elegível para o Tangerino' using errcode = 'P0001';
      end if;
      if p_origem is null or p_origem not in ('externalId','cpf','manual') then
        raise exception 'origem de vínculo inválida' using errcode = 'P0001';
      end if;
      perform set_config('app.ponto_origem', 'portal', true);
      perform set_config('app.ponto_ator', coalesce(p_ator::text, ''), true);
      begin
        insert into public.ponto_colaboradores_map
          (tecnico_id, tangerino_employee_id, tangerino_external_id, vinculado_por, origem_sugestao, ativo)
        values (p_usuario, p_employee_id, p_external_id, p_ator, p_origem, true);
      exception when unique_violation then
        if exists (select 1 from public.ponto_colaboradores_map where tecnico_id = p_usuario) then
          raise exception 'este usuário já possui um vínculo com o Tangerino' using errcode = 'P0001';
        else
          raise exception 'este colaborador já está vinculado a outro usuário' using errcode = 'P0001';
        end if;
      end;
      perform set_config('app.ponto_origem', '', true);
      perform set_config('app.ponto_ator', '', true);
    end $F$ $D$;
  execute 'revoke all on function public.sr_vincular_colaborador(uuid, bigint, text, text, uuid) from public, anon, authenticated';
  execute 'grant execute on function public.sr_vincular_colaborador(uuid, bigint, text, text, uuid) to service_role';
  execute $D$ create or replace function public.sr_desvincular_colaborador(p_usuario uuid, p_ator uuid)
    returns void language plpgsql security definer set search_path = public as $F$
    declare v_n int;
    begin
      perform set_config('app.ponto_origem', 'portal', true);
      perform set_config('app.ponto_ator', coalesce(p_ator::text, ''), true);
      delete from public.ponto_colaboradores_map where tecnico_id = p_usuario;
      get diagnostics v_n = row_count;
      perform set_config('app.ponto_origem', '', true);
      perform set_config('app.ponto_ator', '', true);
      if v_n = 0 then raise exception 'este usuário não possui vínculo ativo' using errcode = 'P0001'; end if;
    end $F$ $D$;
  execute 'revoke all on function public.sr_desvincular_colaborador(uuid, uuid) from public, anon, authenticated';
  execute 'grant execute on function public.sr_desvincular_colaborador(uuid, uuid) to service_role';
  execute $D$ create or replace function public.sr_status_vinculo_usuario(p_usuario uuid)
    returns table(tangerino_elegivel boolean, employee_id bigint, external_id text, vinculado_em timestamptz)
    language sql stable security definer set search_path = public as $F$
      select u.tangerino_elegivel, m.tangerino_employee_id, m.tangerino_external_id, m.vinculado_em
      from public.usuarios u
      left join public.ponto_colaboradores_map m on m.tecnico_id = u.id and m.ativo
      where u.id = p_usuario;
    $F$ $D$;
  execute 'revoke all on function public.sr_status_vinculo_usuario(uuid) from public, anon, authenticated';
  execute 'grant execute on function public.sr_status_vinculo_usuario(uuid) to service_role';

  update usuarios set tangerino_elegivel = true where id in (v_livre1, v_livre2);

  -- G1
  set local role service_role;
  perform public.sr_vincular_colaborador(v_livre1, 990001, 'ext-1', 'cpf', v_adm);
  reset role;
  if not exists (select 1 from ponto_colaboradores_map where tecnico_id=v_livre1 and tangerino_employee_id=990001) then
    raise exception '0130 G1: vínculo não gravado'; end if;
  select * into v_row from ponto_vinculo_eventos
   where tecnico_id=v_livre1 and tangerino_employee_id=990001 and acao='vinculado';
  if v_row.origem_execucao is distinct from 'portal' then raise exception '0130 G1: origem % (esperado portal)', v_row.origem_execucao; end if;
  if v_row.ator is distinct from v_adm then raise exception '0130 G1: ator não é o admin (%)', v_row.ator; end if;
  if v_row.aprovado_por is distinct from v_adm then raise exception '0130 G1: aprovado_por ausente'; end if;

  -- G2
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role','authenticated')::text, true);
    set local role authenticated;
    perform public.sr_vincular_colaborador(v_livre2, 990002, 'x', 'manual', v_adm);
  exception when insufficient_privilege then v_raised := true; end;
  reset role;
  if not v_raised then raise exception '0130 G2: authenticated executou a RPC de vínculo'; end if;

  -- G3
  set local role service_role;
  v_raised := false;
  begin perform public.sr_vincular_colaborador(v_livre1, 990009, 'y', 'manual', v_adm);
  exception when others then v_raised := true; v_msg := sqlerrm; end;
  reset role;
  if not v_raised then raise exception '0130 G3: segundo vínculo do mesmo usuário passou'; end if;
  if v_msg not like '%já possui um vínculo%' then raise exception '0130 G3: mensagem não-clara: %', v_msg; end if;
  select count(*) into v_n from ponto_vinculo_eventos where tecnico_id=v_livre1 and acao='vinculado';
  if v_n <> 1 then raise exception '0130 G3: evento duplicado (% eventos vinculado)', v_n; end if;

  -- G4
  set local role service_role;
  v_raised := false;
  begin perform public.sr_vincular_colaborador(v_livre2, 990001, 'z', 'manual', v_adm);
  exception when others then v_raised := true; v_msg := sqlerrm; end;
  reset role;
  if not v_raised or v_msg not like '%já está vinculado a outro%' then
    raise exception '0130 G4: dedup colaborador falhou: %', v_msg; end if;

  -- G5
  update usuarios set tangerino_elegivel = false where id = v_livre2;
  set local role service_role;
  v_raised := false;
  begin perform public.sr_vincular_colaborador(v_livre2, 990003, 'w', 'manual', v_adm);
  exception when others then v_raised := true; v_msg := sqlerrm; end;
  reset role;
  if not v_raised or v_msg not like '%elegível%' then raise exception '0130 G5: não-elegível passou: %', v_msg; end if;
  update usuarios set tangerino_elegivel = true where id = v_livre2;

  -- G6
  insert into ponto_fora_escopo (tangerino_employee_id, motivo, decidido_por)
  values (990050, 'fixture 0130 fora escopo', v_adm);
  set local role service_role;
  v_raised := false;
  begin perform public.sr_vincular_colaborador(v_livre2, 990050, 'k', 'manual', v_adm);
  exception when others then v_raised := true; v_msg := sqlerrm; end;
  reset role;
  if not v_raised then raise exception '0130 G6: fora do escopo foi vinculado'; end if;

  -- G7
  set local role service_role;
  select * into v_row from public.sr_status_vinculo_usuario(v_livre1);
  reset role;
  if v_row.employee_id is distinct from 990001 or not v_row.tangerino_elegivel then
    raise exception '0130 G7: status incorreto'; end if;

  -- G8
  set local role service_role;
  perform public.sr_desvincular_colaborador(v_livre1, v_adm);
  reset role;
  if exists (select 1 from ponto_colaboradores_map where tecnico_id=v_livre1) then
    raise exception '0130 G8: vínculo não removido'; end if;
  select * into v_row from ponto_vinculo_eventos
   where tecnico_id=v_livre1 and acao='desvinculado' order by em desc limit 1;
  if v_row.origem_execucao is distinct from 'portal' or v_row.ator is distinct from v_adm then
    raise exception '0130 G8: auditoria do desvínculo incorreta'; end if;

  -- G9
  v_raised := false;
  begin update usuarios set tangerino_elegivel = false where id = v_vinc;
  exception when others then v_raised := true; end;
  if not v_raised then raise exception '0130 G9: desmarcou elegível com vínculo ativo'; end if;

  -- G10
  select count(*) into v_n from ponto_colaboradores_map where tecnico_id <> v_livre2;
  if v_n <> v_map_ini then raise exception '0130 G10: vínculos pré-existentes mudaram (% x %)', v_n, v_map_ini; end if;
  select count(*) into v_n from ponto_marcacoes;
  if v_n <> 0 then raise exception '0130 G10: ponto_marcacoes tem % linhas', v_n; end if;

  raise exception '0130 OK: G1–G10 verdes — rollback total (nada persistiu)';
end $$;
