-- 0091: conflito de almoço não deve ficar órfão.
-- Bug observado (Jornada mostra "conflito de almoço resolvido" num dia sem duplicidade):
-- quando o almoço de um deslocamento era removido, fn_desloc_almoco_sync apagava a linha em
-- `almocos` mas deixava o log em `almoco_conflitos` → alerta âmbar falso pra sempre.
-- Nada aqui altera `almocos` (as horas): só remove LOGS de conflito que não representam mais
-- uma duplicidade real. Aditivo/idempotente.

-- (1) Ao REGISTRAR com sucesso (este artefato virou o almoço do dia), limpa qualquer conflito
--     anterior DELE — cobre o caso de o "vencedor" ter sido removido e este re-registrar sem conflito.
create or replace function public.fn_registrar_almoco(
  p_tecnico uuid, p_dia date, p_inicio time, p_fim time,
  p_origem text, p_artefato_tipo text, p_artefato_id uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_tecnico is null or p_dia is null or p_inicio is null or p_fim is null then return; end if;
  begin
    insert into almocos (tecnico_id, dia, inicio, fim, origem, artefato_tipo, artefato_id)
    values (p_tecnico, p_dia, p_inicio, p_fim, coalesce(p_origem, 'manual'), p_artefato_tipo, p_artefato_id);
    -- inseriu como O almoço do dia → este artefato não é mais "duplicado descartado"
    delete from almoco_conflitos
      where tecnico_id = p_tecnico and dia = p_dia
        and artefato_tipo is not distinct from p_artefato_tipo
        and artefato_id   is not distinct from p_artefato_id;
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

-- (2) Ao REMOVER o almoço de um deslocamento, limpar também o log de conflito dele.
create or replace function public.fn_desloc_almoco_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from almocos where artefato_tipo = 'deslocamento' and artefato_id = old.deslocamento_id
      and tecnico_id = old.tecnico_id and dia = old.dia;
    delete from almoco_conflitos where artefato_tipo = 'deslocamento' and artefato_id = old.deslocamento_id
      and tecnico_id = old.tecnico_id and dia = old.dia;
    return old;
  end if;
  perform fn_registrar_almoco(new.tecnico_id, new.dia, new.inicio, new.fim, 'manual', 'deslocamento', new.deslocamento_id);
  return new;
end $$;

-- (3) Limpeza única dos conflitos de deslocamento já órfãos (sem almoço vivo correspondente).
delete from public.almoco_conflitos c
 where c.artefato_tipo = 'deslocamento'
   and not exists (
     select 1 from public.deslocamento_almocos da
      where da.deslocamento_id = c.artefato_id and da.tecnico_id = c.tecnico_id and da.dia = c.dia
   );
