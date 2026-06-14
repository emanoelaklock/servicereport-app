# Robustez — pós go-live (fluxo do técnico)

> Backlog de endurecimento levantado no **double-check do fluxo do técnico** (2026-06-14).
> **Nada aqui trava o técnico no app** — são lacunas de integridade/robustez a fechar
> **depois** do go-live de segunda. O bug visível (F1 — `data_tarefa` em UTC) já foi
> corrigido à parte. Severidade: 🟠 suja dado · ⚪ cosmético · 🔓 trava só no app (burlável por API direta).

## Pacote principal (fechar primeiro depois do go-live)

### F2 — Travas de negócio só existem no app (burláveis no servidor) 🟠🔓
- **Onde:** o sync escreve direto na tabela com o JWT do técnico (`js/sync.js:73`); não há Edge/trigger/CHECK validando conteúdo de `rats`/`tarefas`. As travas vivem só em JS: concluir exige RAT `registrado` + sem passagem aberta (`js/tecnico.js:657-680`), tempo improdutiva (`:2999`), cronologia (`:2744-2768`), término-futuro (`:2729-2737`), passagem falta+levar (`:2930-2933`).
- **Risco:** por API direta dá pra marcar tarefa `concluida` **sem nenhuma RAT**, ou subir RAT com horários incoerentes. No app está tudo travado (e os botões somem) — o risco é cliente malicioso/bug de integração, não o técnico.
- **Correção:** `trigger validar_rat() BEFORE INSERT/UPDATE on rats` (cobre tempo/cronologia/passagem, replicando o tratamento de rollover/dia-anterior do app pra não rejeitar RAT de madrugada) + `trigger validar_conclusao_tarefa() BEFORE UPDATE on tarefas` (exige RAT `registrado`/`concluida*` e barra passagem aberta, **com isenção via `app_role()`** pro admin forçar com ciência). **Migration em prod — revisar antes, com as duas provas (positiva/negativa), no padrão de sempre.**

### F3 — Sem identidade determinística de RAT + sem unique (tarefa, dia) 🟠
- **Onde:** `js/db-local.js:149` gera `client_uuid` **aleatório** (não o UUIDv5 de `(tarefa_id, dia)` que o CLAUDE.md prevê). No servidor o único unique é `(tarefa_id, rat_seq)` (migration 0045) — **não** `(tarefa_id, dia)`.
- **Risco:** a deduplicação "uma RAT por (tarefa, dia)" depende 100% do `ratDoDiaDe` no app; dois aparelhos/coautores (ou uma corrida) criam dois `client_uuid` diferentes pro mesmo dia → duas RATs. É a raiz das RATs duplicadas.
- **Correção:** gerar `client_uuid = UUIDv5(namespace, "${tarefa_id}|${diaISO}")` na criação da RAT, pros aparelhos convergirem no upsert por `client_uuid`; + índice único `(tarefa_id, dia)` no servidor como rede. Atenção à migração de RATs já existentes.

### F4 — (faz parte do F2) validação de RAT no servidor
Coberto pela `validar_rat()` do F2. Mantido aqui só como lembrete de que tempo improdutiva / cronologia / término-futuro / passagem precisam do equivalente server-side.

### F5 — `ratDoDiaDe` não reusa rascunho não salvo 🟠 (baixo)
- **Onde:** `js/tecnico.js:498` exige `status === 'em_andamento' || 'registrado'`; mas `novoRat` (`js/db-local.js:148`) nasce com `status` indefinido e `iniciarRatDaTarefa` (`:809`) não injeta status. O comentário em `:496` ("reusa inclusive RASCUNHO") **diverge** do código.
- **Risco:** tocar "Iniciar RAT" 2x sem salvar cria 2 rascunhos; `seqNova` (`:814`) conta RATs e infla o `/NN`. `limparRascunhosVazios` só limpa vazios na abertura do app.
- **Correção:** no `ratDoDiaDe`, casar também o rascunho do dia (ex.: `sync_status === RASCUNHO` da mesma tarefa) **ou** `iniciarRatDaTarefa` setar `status:'em_andamento'` na criação. Alinhar o comentário.

## Cauda (cosmético / baixo — quando sobrar)

- **F6 ⚪ — `js/tecnico.js:28** `T_STATUS` não lista `devolvida`/`aprovada_faturamento`/`faturada` (mitigado por `ref.status` do servidor). Acrescentar as 3 chaves.
- **F7 🟠 (baixo) — `js/sync.js:67`** upsert pula campos `null` → uma RAT improdutiva que vira produtiva não apaga `motivo_improdutiva` no servidor (já mitigado p/ `atendimento_executado` via `true`). Enviar nulls explícitos das colunas "limpáveis".
- **F8 🟠 (baixo) — migration 0062** trigger `rat_inicia_tarefa` é só `after insert`; editar RAT improdutiva→produtiva direto no portal não promove a Tarefa via banco. Adicionar `or update of atendimento_executado`.
- **F9 ⚪ — `js/db-local.js:207`** reabrir RAT `confirmado` é transição inválida que só gera `warn` e aplica mesmo assim (re-sobe; sem perda de dado). Bloquear o `put` ou documentar que reabrir-e-reenviar é intencional.
- **F10 ⚪ — `js/sync.js:48`** foto é marcada `enviada` antes do upsert da RAT → fica órfã no Storage até o retry (converge sozinho). Mover o `relatorio_fotos.upsert` pra logo após cada foto, ou aceitar.
- **F11 ⚪ — `js/tecnico.js:590`** `nt-data` (nova tarefa em campo) usa default `new Date().toISOString().slice(0,10)` (UTC). Trocar por `jorHoje()`.
- **Fora de escopo — `js/tecnico.js:3236`** `data: toISOString()` em **pré-orçamento** (orçamento migrou pro comercial-app; código legado no SR).

## Verificado e SÃO (não mexer)
- Invariante "RAT não conclui Tarefa": intacto (`js/sync.js:103` MAP só `→ em_execucao`; nenhum trigger/edge escreve `concluida` por RAT).
- `respostas.data` **é** gravado (template tem campo `data`, default `jorHoje()` local); `ratDoDiaDe` usa a chave certa. (Falso-positivo descartado conferindo no banco.)
- Idempotência offline por `client_uuid`; pull não sobrescreve local pendente; ordem foto→RAT→fotos/materiais correta.
