-- 0130 — Vínculo Tangerino gerenciado pelo cadastro de usuário do Hub (portal-usuarios).
--
-- O fluxo principal de vínculo passa a viver no cadastro/edição de usuário do Portal. A Edge
-- portal-usuarios (admin-only, service_role) chama estas RPCs. NENHUMA escrita direta do
-- navegador nas tabelas ponto_* — as RPCs são grant SÓ service_role. Auditoria automática
-- (ponto_vinculo_eventos, via triggers 0128/0129) sai com origem 'portal' + ator verificado,
-- porque as RPCs setam os GUCs app.ponto_origem / app.ponto_ator (padrão sr_set_tangerino_elegivel).
--
-- Regras já garantidas pelo schema (as RPCs só traduzem violações em mensagem clara):
--   · PK tecnico_id → um usuário SR tem no máximo um vínculo;
--   · unique(tangerino_employee_id) → um colaborador em no máximo um usuário;
--   · trigger tg_ponto_map_valida_escopo → colaborador fora do escopo não pode ser vinculado;
--   · trigger tg_usuarios_tangerino_elegivel (0129) → desmarcar elegível com vínculo ativo é barrado.
-- Regra reforçada AQUI: só vincula usuário com tangerino_elegivel = true.

-- ── (0) auditoria do map: capturar o ATOR verificado também no fluxo service_role ──
-- O trigger da 0129 usava ator = auth.uid() puro (null quando a escrita vem por service_role,
-- como no fluxo do Hub). Passa a usar o MESMO fallback de GUC do trigger de elegibilidade:
-- coalesce(auth.uid(), app.ponto_ator). Não remascara service_role como o usuário da LINHA
-- (era esse o risco da 0129) — usa o ator verificado que a RPC seta explicitamente.
-- Comportamento pelo fluxo da tela SR (JWT do admin) fica idêntico: auth.uid() já é o admin.
create or replace function public.tg_ponto_map_evento()
returns trigger language plpgsql security definer set search_path = public as $$
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
      values (new.tecnico_id, new.tangerino_employee_id, 'alterado', new.origem_sugestao, v_ator, v_origem, new.vinculado_por,
              'employee ' || old.tangerino_employee_id || ' → ' || new.tangerino_employee_id ||
              case when new.ativo is distinct from old.ativo then ' · ativo ' || old.ativo || '→' || new.ativo else '' end);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.ponto_vinculo_eventos
      (tecnico_id, tangerino_employee_id, acao, origem_sugestao, ator, origem_execucao, aprovado_por)
    values (old.tecnico_id, old.tangerino_employee_id, 'desvinculado', old.origem_sugestao, v_ator, v_origem, old.vinculado_por);
    return old;
  end if;
  return null;
end $$;

-- ── (1) vincular ──
create or replace function public.sr_vincular_colaborador(
  p_usuario uuid, p_employee_id bigint, p_external_id text, p_origem text, p_ator uuid)
returns void language plpgsql security definer set search_path = public as $$
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
  exception
    when unique_violation then
      -- pode ser PK (usuário já vinculado) ou unique (colaborador já vinculado a outro)
      if exists (select 1 from public.ponto_colaboradores_map where tecnico_id = p_usuario) then
        raise exception 'este usuário já possui um vínculo com o Tangerino' using errcode = 'P0001';
      else
        raise exception 'este colaborador já está vinculado a outro usuário' using errcode = 'P0001';
      end if;
  end;
  perform set_config('app.ponto_origem', '', true);
  perform set_config('app.ponto_ator', '', true);
end $$;
revoke all on function public.sr_vincular_colaborador(uuid, bigint, text, text, uuid) from public, anon, authenticated;
grant execute on function public.sr_vincular_colaborador(uuid, bigint, text, text, uuid) to service_role;

-- ── (2) desvincular ──
create or replace function public.sr_desvincular_colaborador(p_usuario uuid, p_ator uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform set_config('app.ponto_origem', 'portal', true);
  perform set_config('app.ponto_ator', coalesce(p_ator::text, ''), true);
  delete from public.ponto_colaboradores_map where tecnico_id = p_usuario;
  get diagnostics v_n = row_count;
  perform set_config('app.ponto_origem', '', true);
  perform set_config('app.ponto_ator', '', true);
  if v_n = 0 then raise exception 'este usuário não possui vínculo ativo' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.sr_desvincular_colaborador(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sr_desvincular_colaborador(uuid, uuid) to service_role;

-- ── (3) status do vínculo de um usuário (para pré-carregar a edição) ──
create or replace function public.sr_status_vinculo_usuario(p_usuario uuid)
returns table(tangerino_elegivel boolean, employee_id bigint, external_id text, vinculado_em timestamptz)
language sql stable security definer set search_path = public as $$
  select u.tangerino_elegivel, m.tangerino_employee_id, m.tangerino_external_id, m.vinculado_em
  from public.usuarios u
  left join public.ponto_colaboradores_map m on m.tecnico_id = u.id and m.ativo
  where u.id = p_usuario;
$$;
revoke all on function public.sr_status_vinculo_usuario(uuid) from public, anon, authenticated;
grant execute on function public.sr_status_vinculo_usuario(uuid) to service_role;
