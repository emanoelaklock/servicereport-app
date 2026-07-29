-- 0137 — Realtime: publica rats, pre_orcamentos e tarefa_tecnicos
--
-- O app (sync.js/startRealtime) assina postgres_changes de TODAS as tabelas do
-- SYNC_MAP (rats, pre_orcamentos, deslocamentos, jornada_segmentos), mas a
-- publication supabase_realtime só continha deslocamentos, jornada_segmentos,
-- sync_tombstones e tarefas — o sinal de RAT/pré-orçamento nunca chegava e a
-- atualização entre aparelhos caía na rede de segurança de 2 minutos do pull.
--
-- tarefa_tecnicos entra junto: mudança de responsável feita no portal não passa
-- pelo SYNC_MAP (comentário em tecnico.js/bind), e era exatamente a "melhoria
-- futura" anotada lá. Com o sinal, a Home/lista re-busca na hora.
--
-- Idempotente: só adiciona o que ainda não está na publication.
-- RLS continua valendo: o Realtime só entrega eventos de linhas que o assinante
-- pode ler (WALRUS) — técnico não recebe sinal de RAT/tarefa de outro técnico.
do $$
declare t text;
begin
  foreach t in array array['rats', 'pre_orcamentos', 'tarefa_tecnicos'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
