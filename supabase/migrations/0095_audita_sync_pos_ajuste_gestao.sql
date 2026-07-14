-- 0095 — Auditoria do sync sobre RAT ajustada pela gestão
-- Problema (Tarefa 04828/RAT 02, 07/26): a gestão edita uma RAT pelo editor
-- auditado (Edge rat-editar → rat_edicoes), e depois o técnico reabre a MESMA
-- RAT no app ("edição pós-confirmação"); o próximo sync faz upsert da RAT
-- inteira (js/sync.js) e sobrescreve o ajuste da gestão SEM rastro — o
-- histórico passa a mentir. Princípio do spec: conflito é marcado, nunca
-- resolvido em silêncio.
--
-- Solução: trigger AFTER UPDATE em rats que, quando a RAT já foi ajustada
-- pela gestão (ajustada_gestao = true) e uma escrita NÃO-service-role muda
-- `respostas`, grava o diff campo a campo em rat_edicoes com motivo
-- 'sync_app' e ator = usuário autenticado do sync (o técnico). Não bloqueia
-- nada: a última palavra continua sendo de quem editou por último — mas fica
-- visível e restaurável no histórico.
--
-- Por que trigger aqui é seguro (≠ decisão do conflito de material, 0084):
-- este trigger SÓ INSERE em rat_edicoes (tabela sem triggers) — não faz
-- UPDATE em rats nem em tarefas, então não há recursão nem risco de virar o
-- status da Tarefa via rat_inicia_tarefa.

-- 1) 'sync_app' entra no vocabulário de motivos.
alter table public.rat_edicoes drop constraint if exists rat_edicoes_motivo_chk;
alter table public.rat_edicoes add constraint rat_edicoes_motivo_chk
  check (motivo in ('esquecimento_tecnico','completacao','mudanca_processo','pedido_cliente','outro','sync_app'));

-- 2) Função de auditoria (SECURITY DEFINER: rat_edicoes tem RLS sem escrita p/ clientes).
create or replace function public.audita_sync_pos_ajuste()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_role text := coalesce(claims->>'role', current_user);
  v_uid  uuid;
  v_nome text;
  o jsonb := coalesce(old.respostas, '{}'::jsonb);
  n jsonb := coalesce(new.respostas, '{}'::jsonb);
  k text;
begin
  -- Só interessa depois que a gestão ajustou a RAT.
  if old.ajustada_gestao is not true then return new; end if;
  -- Edge Functions (rat-editar/restore) rodam como service_role e já auditam
  -- a si mesmas — não duplicar.
  if v_role = 'service_role' then return new; end if;
  if o is not distinct from n then return new; end if;

  v_uid := coalesce((claims->>'sub')::uuid, new.tecnico_id, old.tecnico_id);
  if v_uid is null then return new; end if;   -- sem ator identificável: não trava o sync
  select nome into v_nome from public.usuarios where id = v_uid;

  for k in (select jsonb_object_keys(o) union select jsonb_object_keys(n)) loop
    if (o->k) is distinct from (n->k) then
      insert into public.rat_edicoes (rat_id, tarefa_id, alvo, operacao, campo, valor_antigo, valor_novo, motivo, ator, ator_nome)
      values (new.id, new.tarefa_id, 'campo', 'update', k, o->k, n->k, 'sync_app',
              v_uid, coalesce(v_nome, new.tecnico_nome, old.tecnico_nome));
    end if;
  end loop;
  return new;
end $$;

-- 3) Trigger — AFTER UPDATE, não altera NEW nem outras linhas de rats.
drop trigger if exists trg_audita_sync_pos_ajuste on public.rats;
create trigger trg_audita_sync_pos_ajuste
  after update of respostas on public.rats
  for each row execute function public.audita_sync_pos_ajuste();
