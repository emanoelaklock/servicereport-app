-- 0131: correção de dados — RAT 04853/01 (28/07), Tarefa 6a2c41a4.
--
-- O que aconteceu (auditoria de 29/07): o técnico resolveu a "pausa esquecida" com
-- "volto depois" às 07:42 (fluxo aplicarResolucaoPausa gravou volta_amanha='Não' +
-- passagem_motivo='volto_depois' — prova: o trigger pôs a Tarefa em Em Pausa às 10:42Z).
-- Às 07:59 a RAT registrada foi reaberta no app e o AUTOSAVE substituiu `respostas`
-- inteiro pelo que o formulário coleta — apagando volta_amanha/passagem_* (bug corrigido
-- no app junto deste pacote: mesclarRespostas em tecnico.js).
--
-- Esta migração restaura os campos apagados e marca a pendência que o fluxo de pausa
-- esquecida deixou invisível: a RAT fechou SEM hora de término (única da base) e as horas
-- de 28/07 dos dois técnicos estão zeradas — a gestão precisa ajustar via edição da RAT.
-- Não inventa horário (princípio do fluxo): só devolve o que existia e sinaliza.
--
-- Efeito colateral seguro: o UPDATE dispara rat_inicia_tarefa → derivação do conjunto
-- (0130) — a RAT mais recente é a de 29/07, então o status da Tarefa não muda por aqui.

update public.rats
   set respostas = respostas || jsonb_build_object(
         'volta_amanha', 'Não',
         'passagem_motivo', 'volto_depois',
         'passagem_falta', 'Atendimento interrompido — pausa não encerrada no dia anterior'),
       pendencias = 'Dia encerrado por pausa esquecida, sem hora de término — horas de 28/07 dos técnicos precisam de ajuste da gestão.'
 where id = '7f7a0cfa-39ce-46d2-9529-3b5898cab902'
   and status = 'registrado'
   and (respostas->>'volta_amanha') is null;   -- idempotente: só aplica se ainda estiver faltando
