# Service Report — Brief de abertura (colar como 1ª mensagem no Claude Code)

> Acompanha este brief: `schema-v4.sql` (aplicar no Supabase).

## Contexto
Service Report é um sistema de **Relatório de Atendimento Técnico (RAT), faturamento e conciliação de material**. Faz parte de um ecossistema compartilhado com o sistema de inventário já existente da empresa (repo `axisinventory-app`). A empresa faz **locação + serviço** de equipamentos (câmeras, switches, cancelas, monitores, servidores). O sistema substitui gradualmente a Auvo.

## Stack (mesma do sistema de inventário existente)
- HTML + CSS + JS puro, **sem frameworks**
- Supabase (Postgres + Auth + Storage)
- Deploy na Vercel
- Design system **Bold** (`theme.css`, fonte Space Grotesk, sidebar `#1a1814`) — **copiar do repo de inventário** (`theme.css`, `sidebar.js`, `auth.js`) e reaproveitar
- App do técnico = **PWA** (precisa funcionar offline)
- Repo novo sugerido: `service-report-app`

## Decisões de arquitetura (já fechadas — não relitigar)
1. **Núcleo compartilhado + módulos.** Núcleo: `clientes`, `produtos`, `equipamentos`, `tecnicos`, `contratos`, `tipos_servico`. Módulo de serviço: `tarefas` (RAT), `formulario_modelos`, `relatorio_fotos`, `materiais`. O sistema de inventário e o de locação são outros módulos sobre o mesmo núcleo.
2. **Nativo desde já — SEM integração com a Auvo** (seria trabalho descartável). Na transição, roda em paralelo à Auvo até os técnicos confiarem; depois corta. Histórico da Auvo, se preciso, entra por **exportação CSV única**, não integração viva.
3. **Única integração externa: Omie** (origem de `clientes`, `produtos` e das OS / material levado).
4. **Faturamento é controlado SÓ neste sistema** (campos `faturado`, `data_faturamento`, `numero_nota` na tarefa). Auvo/Omie não mandam nesse status.
5. **RAT: cliente é a âncora; equipamento e contrato são OPCIONAIS** (atende serviço avulso / em equipamento locado / em equipamento do cliente).
6. **`tipos_servico` e `formulario_modelos` são cadastros configuráveis.** Cada tipo amarra um formulário/questionário + um efeito no inventário (`nenhum` / `marcar_locado` / `devolver_estoque` / `marcar_manutencao`). Os checklists do sistema de inventário entram aqui como formulários compartilhados.

## Modelo de sincronização offline (parte crítica — resolve o "salvei / não chegou")
- Cada RAT nasce com um `client_uuid` gerado **no aparelho** (idempotência: reenvio não duplica).
- `sync_status`: `rascunho → salvo_local → na_fila → enviando → confirmado` (só vira `confirmado` depois que o **servidor carimba** `recebido_em`) | `erro`.
- Salva **local primeiro** (IndexedDB), com as fotos; sobe quando há conexão; retry automático; nada some sozinho.
- `sync_eventos` grava cada transição (`device_id` + hora) = **trilha de auditoria imutável**.
- O técnico vê o status por RAT na própria tela; o painel mostra pendências de envio por técnico.

## PRIMEIRA FATIA VERTICAL (construir AGORA)
Objetivo: provar o fluxo de ponta a ponta **sem Auvo**.

1. **Formulário de RAT (técnico):** seleciona cliente + tipo de serviço (carrega o formulário daquele tipo), preenche o questionário, anexa ≥1 foto, captura assinatura. Equipamento e material são opcionais.
2. **Salvar local-first** com `client_uuid` e status visível → sincroniza pro Supabase (`tarefas` + `relatorio_fotos` + Storage para as imagens) → marca `confirmado` no ACK do servidor → grava `sync_eventos`.
3. **Painel diário:** contadores (tarefas hoje, relatórios com pendência, a faturar).
4. **Tela Relatórios:** lista com preenchimento + `sync_status` + botão **Faturar** (grava `faturado` / `data_faturamento` / `numero_nota`).

**Critérios de aceite:**
- Criar uma RAT **offline**, fechar o app, reabrir → ela continua lá como `salvo_local`.
- Voltar a conexão → vira `confirmado` e aparece no painel.
- Marcar como faturada persiste no banco e some da lista "a faturar".

**Fora desta fatia (próximas):** integração Omie (clientes/produtos/OS), conciliação na tela, efeitos de inventário por tipo de serviço, robustez offline avançada (background sync), projetos, contratos completos, polimento do app.

## Telas (visual Bold — há um mockup de referência das 4 telas de back-office)
Painel diário · Relatórios · Conciliação · Configurações · + Formulário do técnico (PWA).

## Como começar
Antes de codar: confirme o entendimento da fatia 1, proponha a **estrutura de arquivos do repo** (páginas `.html`, `theme.css`, `sidebar.js`, `auth.js`, service worker da PWA, módulo de sincronização) e o passo a passo. Depois implemente incremental, com commit por etapa.
