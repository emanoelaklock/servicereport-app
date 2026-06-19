-- 0068: novo status de Tarefa "Em pausa" (caso "volto depois" — interrompido sem previsão).
-- Distingue "continuidade imediata" (segue em_execucao) de "interrompido sem previsão" (em_pausa).
--
-- Caminho B: SÓ ADICIONA o 'em_pausa'. NÃO toca em nenhum status existente (zero UPDATE).
-- 'em_espera_produtos' permanece intacto no #D63384 (já está em uso em produção).
-- sistema=true (tem automação amarrada — ver 0069). ordem=25 (logo após em_execucao=20).
-- A pílula usa corTextoLegivel() sobre fundo tintado (cor+1A) — ver checagem ao escolher o hex.

insert into public.status_tarefa (chave, label, cor, ordem, sistema, ativo)
values ('em_pausa', 'Em pausa', '#0FA3A3', 25, true, true)
on conflict (chave) do nothing;

-- DOWN:
--   delete from public.status_tarefa where chave = 'em_pausa';
