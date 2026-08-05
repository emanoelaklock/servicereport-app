-- 0139: Vigia "RAT presa no aparelho" — view de CONFERÊNCIA (leitura) sobre fotos órfãs.
-- Origem: caso Tarefa 4806 (03-04/08/2026, cauda do F22): o sync sobe FOTOS antes do upsert
-- da RAT (js/sync.js, ordem foto→RAT); quando o upsert falha, as fotos ficam no Storage e a
-- RAT fica só no aparelho — invisível pro portal por DOIS DIAS até alguém reclamar. A pasta
-- órfã no bucket é o único rastro servidor desse estado; esta view o torna visível.
--
-- Uma linha = pasta `{tecnico_id}/{rat_client_uuid}/…` no bucket rat-anexos SEM linha
-- correspondente em `rats` — ou seja, envio que morreu no meio (ou RAT excluída só localmente,
-- que nunca sincronizou). Exclui o que tem explicação legítima:
--  · rats.client_uuid existe        → RAT chegou (fotos não são órfãs);
--  · pre_orcamentos.client_uuid     → pasta de pré-orçamento (mesmo bucket, mesmo layout);
--  · sync_tombstones.registro_id    → RAT sincronizada e DEPOIS excluída (fotos ficam por
--    design — excluirRat não varre o Storage; tg_tombstone grava o client_uuid p/ rats);
--  · último upload há < 1h          → sync possivelmente ainda em andamento (sem falso
--    positivo durante fotos incrementais; caso real 04/08 espalhou uploads por 31 min).
--
-- Decisões (molde 0122/0065): só leitura, não trava nada, reversível com `drop view`.
--  · security_invoker = true (regra da casa: TODO replace redeclara) + filtro app_role()
--    NA view: técnico/anon recebem 0 linhas; admin/gestor enxergam o bucket inteiro via
--    policy rat_anexos_admin (SELECT em storage.objects), rats/pre_orcamentos via RLS admin.
--  · Pastas 'tarefas/…' e 'orcamentos/…' ficam fora (1º segmento não é uuid de técnico).
create or replace view vw_alerta_rat_fotos_orfas
with (security_invoker = true) as
with pastas as (
  select (storage.foldername(o.name))[1] as seg_tecnico,
         (storage.foldername(o.name))[2] as seg_rat,
         count(*)          as arquivos,
         min(o.created_at) as primeiro_envio,
         max(o.created_at) as ultimo_envio
    from storage.objects o
   where o.bucket_id = 'rat-anexos'
     and array_length(storage.foldername(o.name), 1) = 2
     and (storage.foldername(o.name))[1] ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     and (storage.foldername(o.name))[2] ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   group by 1, 2
)
select p.seg_rat::uuid     as rat_client_uuid,
       p.seg_tecnico::uuid as tecnico_id,
       u.nome              as tecnico_nome,
       p.arquivos,
       p.primeiro_envio,
       p.ultimo_envio
  from pastas p
  left join usuarios u on u.id = p.seg_tecnico::uuid
 where not exists (select 1 from rats r            where r.client_uuid  = p.seg_rat::uuid)
   and not exists (select 1 from pre_orcamentos po where po.client_uuid = p.seg_rat::uuid)
   and not exists (select 1 from sync_tombstones st where st.registro_id = p.seg_rat)
   and p.ultimo_envio < now() - interval '1 hour'
   and public.app_role() = any (array['admin', 'gestor_axis']);

-- Views de dados não levam SELECT para anon (regra da casa / F17).
revoke all on public.vw_alerta_rat_fotos_orfas from anon;

-- Guarda auto-abortante: invoker declarado e anon sem SELECT, senão rollback.
do $$
begin
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.vw_alerta_rat_fotos_orfas'::regclass
       and c.reloptions @> array['security_invoker=true']
  ) then
    raise exception '0139: view sem security_invoker=true — abortando';
  end if;
  if has_table_privilege('anon', 'public.vw_alerta_rat_fotos_orfas', 'select') then
    raise exception '0139: anon ainda com SELECT na view — abortando';
  end if;
end $$;
