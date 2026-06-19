-- 0073: "Em pausa" passa a PINK (#D63384, mais destacado) e "Em Espera (Produtos)" assume o
-- TEAL (#0FA3A3) que a pausa liberou — troca limpa, sem duas pílulas iguais. Só rótulos de cor
-- (chaves intactas). O front do técnico usa --sr-pausa-* (pink agora); o portal usa status_tarefa.cor.
update public.status_tarefa set cor = '#D63384' where chave = 'em_pausa';
update public.status_tarefa set cor = '#0FA3A3' where chave = 'em_espera_produtos';

-- DOWN: inverte (em_pausa -> #0FA3A3 ; em_espera_produtos -> #D63384).
