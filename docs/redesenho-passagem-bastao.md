# Redesenho "passagem de bastão" — registro de decisão (20/07/2026)

> Contexto: caso da Tarefa 4852 (duas RATs no mesmo dia com horários sobrepostos — consolidado
> nas migrações 0120/0121; bug do dedup corrigido no app, SW v666). A proposta original era o
> servidor **encerrar automaticamente** a participação do técnico numa RAT ativa do mesmo dia
> quando ele fosse adicionado a uma RAT nova, usando o início da nova como saída.

## O que os dados mostraram (base de produção, levantamento de 20/07)

- Dias com 2+ RATs por técnico são a **norma** (46 de 80 técnico-dias), mas em **53 de 60**
  pares consecutivos o técnico já encerra a RAT anterior antes de abrir a próxima.
- Só existiam **7 sobreposições reais** na base inteira — e **5 delas são "saiu e voltou"**
  (RAT curta aninhada dentro de uma longa: o técnico atendeu um chamado rápido e retornou).
  Encerramento automático teria produzido dado **errado em 5 dos 7 casos**.
- Horário individual (`tecnicos_part` / `rat_tecnicos.inicio/fim`) **nunca foi usado** em
  produção (0 de 80 RATs; 0 de 140 participações).

## Decisão

**Executar somente a Fase 1 (rede de segurança, só leitura).** O motor automático teria risco
maior que o benefício. **Adiados deliberadamente** (não descartados): ledger `rat_passagens`,
encerramento automático server-side, modal "sair/manter também" no app, editor de horário
individual pela gestão, exibição "saída HH:MM · transferido para Tarefa N".

## Fase 1 — o que foi construído

- **`vw_alerta_sobreposicao`** (migração 0122, molde da `vw_alerta_desloc_sem_volta`):
  pares de RATs do mesmo técnico no mesmo dia **já encerrado** cujos horários se cruzam,
  com o intervalo conflitante. Só artefato RAT; encostar não conta; intervalo aberto/inválido
  fica fora; `security_invoker`.
- **Jornada**: banner âmbar de conferência (técnico · dia · as duas RATs com link e janela ·
  intervalo que se cruza). Aceita `?d=YYYY-MM-DD` para abrir direto num dia.
- **Painel**: card âmbar (janela de 14 dias, mesma régua da lista do técnico) linkando a
  Jornada do dia.
- **Garantias**: nenhuma alteração automática de horário, nenhum bloqueio ao técnico, nenhum
  impacto em desempenho (métricas usam `rat_tecnicos` só como membership) nem em faturamento
  (hora faturada = janela da RAT). Sobreposição pode ser legítima — o alerta é conferência.
- **Teste**: `supabase/tests/teste_0122_vw_alerta_sobreposicao.sql` — DO-block com rollback
  garantido (fixtures em dia de 2020 com técnicos reais; termina sempre em RAISE): sobreposição
  parcial, aninhada, sem conflito (encostam), pausas/almoço, técnico diferente, dia aberto,
  fim nulo. Validação adicional: a query da view sobre os dados reais devolve exatamente os
  7 pares históricos conhecidos.

## Fases futuras (referência — exigem nova decisão)

O levantamento completo (5 frentes de código + concorrência offline) fixou os pontos que
qualquer fase futura precisa respeitar:

1. **`rat_tecnicos` é cache descartável** — `fn_rat_sync_tempo` (0055) faz DELETE+rebuild a
   partir de `respostas` em todo sync. Horário individual durável tem que viver em
   `respostas.tecnicos_part` (o app preserva chaves extras) e/ou num ledger próprio com
   re-assert; escrita direta em `rat_tecnicos` morre no sync seguinte (a Edge `rat-editar`
   já sofre disso de forma latente).
2. **Ordem de chegada não é garantida** (dois aparelhos offline): a regra precisa ser
   recompute idempotente por (técnico, dia) com `pg_advisory_xact_lock`, nunca evento de
   chegada; trigger nomeado para ordenar DEPOIS de `trg_rat_sync_tempo`.
3. **Motivo em `rat_edicoes` é o único canal que pune técnico** (0107 conta
   `esquecimento_tecnico`/`completacao` contra a equipe TODA): evento de passagem exigiria
   motivo novo e neutro no CHECK.
4. **`rats.tecnico_id` (dono) nunca pode ser reatribuído** — RLS, pull e Storage dependem dele.
5. Exceção "manter também" deve viajar em `respostas` (offline-first); justificativa
   obrigatória segue o molde da improdutiva/0119.
