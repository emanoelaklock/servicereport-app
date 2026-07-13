-- 0088: carimbo de QUANDO a tarefa entrou em 'devolvida' — base do lembrete "sem retorno há +1 dia".
-- Hoje só existe o status atual; sem um timestamp não dá pra medir a idade da devolução.
-- Aditiva: coluna nullable, nada reescrito. O portal (tarefa.js) grava now() a cada vez que a
-- tarefa entra em 'devolvida'; quando ela sai de 'devolvida' (técnico retornou), o lembrete some
-- sozinho pela condição de status — não precisa limpar a coluna.
--
-- Condição do lembrete (Painel/gestão, banner/app, push):
--   status = 'devolvida' AND devolvida_em < now() - interval '24 hours'
--
-- Backfill: NÃO. As tarefas hoje em 'devolvida' ficam com devolvida_em = null e só entram no radar
-- ao serem re-devolvidas (decisão: dado limpo em vez de estimativa pelo atualizado_em).

alter table public.tarefas
  add column if not exists devolvida_em timestamptz;

-- DOWN:
-- alter table public.tarefas drop column if exists devolvida_em;
