-- 0136: pausa manual da gestão DURÁVEL (desenho aprovado 29/07; sequela do caso 04778).
--
-- Problema: para o banco, um 'em_pausa' setado pela gestão no portal era indistinguível do
-- derivado das RATs — qualquer evento de RAT (edição, sync atrasado, backfill) rederivava o
-- alvo e atropelava a decisão humana (foi o que o backfill da 0130 fez com a 04778).
--
-- Modelo: MARCADOR na tarefa (não status novo; não escreve na RAT do técnico — o documento
-- é dele). O portal grava pausa_manual_em/por/motivo ao pausar; limpa ao escolher outro
-- status. O guard (ponto único — o UPDATE do trigger rat_inicia_tarefa passa por ele) segura
-- em_pausa→em_execucao enquanto o marcador viver, EXCETO:
--   a) despausa explícita: o mesmo UPDATE limpa pausa_manual_em (app antigo nunca envia a
--      coluna → escrita defasada continua bloqueada; portal novo envia null → gestão livre);
--   b) retomada REAL: existe RAT criada DEPOIS da pausa (criado_em > pausa_manual_em — separa
--      RAT nova de reabertura administrativa) E com dia declarado >= dia da pausa (separa
--      retomada de campo de documentação retroativa — caso 04790, registro tardio de trabalho
--      pré-pausa não derruba a pausa). Aí a regra do spec "nova RAT → Em execução" vence e o
--      marcador é limpo sozinho.
-- Status terminal/admin nunca é bloqueado e limpa o marcador (higiene).
-- Dias comparados no fuso da operação (America/Sao_Paulo) — pausa às 21h local não pode
-- virar "dia seguinte" pelo relógio UTC do banco.
--
-- Sem backfill: com a 0135 aplicada não há tarefa controlável com status <> alvo (dry-run
-- 29/07), logo nenhuma pausa vigente precisa de marcação retroativa.
-- Teste: supabase/tests/teste_0136_pausa_manual.sql (transação com rollback).

-- 1) Marcador (pausa_manual_por guarda o auth.uid() do portal; nome resolve via ref/auditoria).
alter table public.tarefas
  add column if not exists pausa_manual_em     timestamptz,
  add column if not exists pausa_manual_por    uuid,
  add column if not exists pausa_manual_motivo text;

-- 2) Guard estendido (substitui a versão 0130; regra da escrita defasada permanece).
create or replace function public.tarefa_status_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Pausa manual vigente: só retomada REAL derruba (RAT criada depois da pausa E com dia
  -- declarado >= dia da pausa). Despausa explícita = o mesmo UPDATE limpa o marcador.
  if old.pausa_manual_em is not null
     and new.status = 'em_execucao'
     and new.pausa_manual_em is not distinct from old.pausa_manual_em then
    if exists (
      select 1 from public.rats r
       where r.tarefa_id = new.id
         and r.criado_em > old.pausa_manual_em
         and coalesce(nullif(r.respostas->>'data','')::date, r.data_tarefa::date)
             >= (old.pausa_manual_em at time zone 'America/Sao_Paulo')::date) then
      -- retomada real: libera e limpa o marcador
      new.pausa_manual_em := null; new.pausa_manual_por := null; new.pausa_manual_motivo := null;
    else
      new.status := 'em_pausa';   -- segura a decisão da gestão
    end if;
  end if;
  -- Regra 0130: app antigo escreve 'em_execucao' com pausa (derivada) aberta → mantém em_pausa.
  if new.status = 'em_execucao'
     and old.status in ('aguardando_execucao','em_execucao','em_pausa')
     and public.tarefa_status_alvo(new.id) = 'em_pausa' then
    new.status := 'em_pausa';
  end if;
  -- Saiu do conjunto controlável (concluir/devolver/faturar/espera): marcador não faz sentido.
  if new.status not in ('aguardando_execucao','em_execucao','em_pausa') then
    new.pausa_manual_em := null; new.pausa_manual_por := null; new.pausa_manual_motivo := null;
  end if;
  return new;
end $$;
-- trg_tarefa_status_guard (BEFORE UPDATE OF status, da 0130) continua valendo.

-- 3) Auditoria: a linha de status_alterado da pausa manual ganha origem e motivo.
create or replace function public.audit_tarefas() returns trigger
language plpgsql security definer set search_path = public as $$
declare a uuid := auth.uid(); v_det text;
begin
  if (tg_op = 'INSERT') then
    insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
    values (new.id,'tarefa',new.id,'criada','Tarefa criada',coalesce(a,new.criado_por),public._ator_nome(coalesce(a,new.criado_por)));
    return new;
  elsif (tg_op = 'UPDATE') then
    if (new.status is distinct from old.status) then
      v_det := public._status_label(old.status)||' → '||public._status_label(new.status);
      -- pausa manual da gestão ENTRANDO neste update → anota origem + motivo (0136)
      if new.status = 'em_pausa' and new.pausa_manual_em is not null
         and new.pausa_manual_em is distinct from old.pausa_manual_em then
        v_det := v_det||' (manual da gestão'||coalesce(': '||new.pausa_manual_motivo,'')||')';
      end if;
      insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
      values (new.id,'tarefa',new.id,'status_alterado',v_det,a,public._ator_nome(a));
    end if;
    if (coalesce(new.faturado,false) is distinct from coalesce(old.faturado,false)) then
      insert into public.auditoria(tarefa_id,entidade,entidade_id,acao,detalhe,ator,ator_nome)
      values (new.id,'tarefa',new.id,
        case when new.faturado then 'faturada' else 'faturamento_desfeito' end,
        case when new.faturado then 'Tarefa faturada'||coalesce(' · Nota '||new.numero_nota,'') else 'Faturamento desfeito' end,
        a,public._ator_nome(a));
    end if;
    return new;
  end if;
  return null;
end $$;

-- DOWN: recriar tarefa_status_guard da 0130 e audit_tarefas anterior; as colunas podem ficar
--       (drop column perderia o histórico de quem pausou).
