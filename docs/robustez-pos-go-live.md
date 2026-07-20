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

### F5 — `ratDoDiaDe` não reusa rascunho não salvo ✅ RESOLVIDO (2026-07-20)
- **Era:** `ratDoDiaDe` exigia `status === 'em_andamento' || 'registrado'`; `novoRat` nasce sem status e o rascunho do dia ficava invisível pro dedup — 2º toque no card criava RAT duplicada. **Materializou em produção na Tarefa 4852** (2 RATs no dia 14/07, horas sobrepostas; dados consolidados nas migrações 0120/0121).
- **Fix:** commit `c3272e7` (SW v666) — status ausente conta como `em_andamento` (`r.status || 'em_andamento'`); comentário alinhado. Improdutiva/concluída seguem fora do reuso. Verificado com teste do predicado real (8 cenários).

### F12 — Alerta de integridade "Concluída sem RAT registrada" (portal admin) 🟠
- **Motivo:** hoje a trava de "exige RAT registrada pra concluir" só roda no **momento** de concluir (e o app esconde o botão). Não há **alerta retroativo**: se uma tarefa ficar concluída/concluida_pendencia com **0 RAT registrada** (burla de API — ver F2 —, "admin força", ou churn de dados), nada aponta. É o irmão retroativo do F2.
- **Correção:** no portal admin (`js/tarefa.js`), ao renderizar a tarefa, se `status ∈ (concluida, concluida_pendencia, aprovada_faturamento, faturada)` **e** nº de RATs com `status ∈ (registrado, concluida, concluida_pendencia)` = 0 → badge "Concluída sem RAT registrada — verificar". Leitura pura (o portal já carrega `cur.rats`), **sem migration**. Pode espelhar na tela de **Conciliação**.
- **Nota:** levantado a partir da 04757, que na verdade **tinha** a `/02 registrado` no servidor — o "sem RAT" era view local (ver F13). O alerta vale pro caso de órfã real.

### F13 — Lista de RATs do técnico lê só o aparelho (local-only) 🟠 (baixo)
- **Onde:** `js/tecnico.js:787` `renderRatsDaTarefa` usa `D().listarRats()` (IndexedDB) e esconde a seção se vazia (`:789`). O técnico **não vê** RATs que estão só no servidor (de coautor, ou após excluir a cópia local) — mesmo o gate de concluir já consultar o servidor (autoritativo). Tela fica enganosa ("parece sem RAT").
- **Correção:** `renderRatsDaTarefa` buscar também do servidor (merge com o local por `client_uuid`), como o bloco de conclusão já faz. Mudança de comportamento no app — testar offline (cair pro local quando sem rede).

### F15 — Estado de erro nas demais listas do portal (erro != vazio) 🟠 (baixo)
- **Motivo:** mesma "mentira silenciosa" do F14 (já corrigido p/ RATs): `lista = error ? [] : data` + render de vazio idêntico a "deu erro". Um erro transitório (rede/RLS/versão) some como "nada aqui".
- **Onde (todos mudos — sem toast/aviso):**
  - `js/tarefa.js:572` `carregarEquip` → "Nenhum equipamento vinculado."
  - `js/tarefa.js:603` `carregarAnexos` → "Nenhum anexo." (**também alimenta o card Situação "Anexos: Nenhum"** — mente no resumo, como o RATs mentia).
  - `js/tarefa.js:1345` `carregarTimeline` → "Sem eventos registrados ainda."
  - `js/painel.js:39` `renderRecentes` (dashboard) → "Nenhuma RAT ainda."
- **Já OK (não mexer):** `js/tarefa.js:646` `carregarLinhas` (conciliação) já dá `toast('Erro ao carregar conciliação…')` (`:648`).
- **Correção:** mesmo padrão do F14 — flag de erro por lista, render "Erro ao carregar — recarregue" em vez do vazio (e card Situação dos Anexos idem). Só frontend, sem migration.
- **Prioridade interna:** anexos > painel/recentes > equipamentos > timeline.

## Cauda (cosmético / baixo — quando sobrar)

- **F6 ⚪ — `js/tecnico.js:28** `T_STATUS` não lista `devolvida`/`aprovada_faturamento`/`faturada` (mitigado por `ref.status` do servidor). Acrescentar as 3 chaves.
- **F7 🟠 (baixo) — `js/sync.js:67`** upsert pula campos `null` → uma RAT improdutiva que vira produtiva não apaga `motivo_improdutiva` no servidor (já mitigado p/ `atendimento_executado` via `true`). Enviar nulls explícitos das colunas "limpáveis".
- **F8 🟠 (baixo) — migration 0062** trigger `rat_inicia_tarefa` é só `after insert`; editar RAT improdutiva→produtiva direto no portal não promove a Tarefa via banco. Adicionar `or update of atendimento_executado`.
- **F9 ⚪ — `js/db-local.js:207`** reabrir RAT `confirmado` é transição inválida que só gera `warn` e aplica mesmo assim (re-sobe; sem perda de dado). Bloquear o `put` ou documentar que reabrir-e-reenviar é intencional.
- **F10 ⚪ — `js/sync.js:48`** foto é marcada `enviada` antes do upsert da RAT → fica órfã no Storage até o retry (converge sozinho). Mover o `relatorio_fotos.upsert` pra logo após cada foto, ou aceitar.
- **F11 ⚪ — `js/tecnico.js:590`** `nt-data` (nova tarefa em campo) usa default `new Date().toISOString().slice(0,10)` (UTC). Trocar por `jorHoje()`.
- **Fora de escopo — `js/tecnico.js:3236`** `data: toISOString()` em **pré-orçamento** (orçamento migrou pro comercial-app; código legado no SR).
- **F16 ⚪ — `rat_seq` reutiliza o número de RAT excluída** (registrado 2026-07-20, caso 4852). `tg_rat_seq` atribui `max(rat_seq)+1` por tarefa (migration 0045): excluir a **última** RAT da tarefa libera o número — a próxima nasce com o mesmo `/NN` da excluída. Caso concreto: a 4852/02 foi excluída na consolidação (migração 0120); a próxima RAT da 4852 nascerá **"/02" de novo**, e trilhas antigas (auditoria/rat_edicoes/backup_0120) que citam "4852/02" passam a ser ambíguas se lidas só pelo número. Mitigação já praticada: as trilhas da 0120/0121 citam sempre `id`/`client_uuid` junto do número. Correção estrutural (se um dia doer): contador persistente por tarefa em vez de `max+1`, pra número de RAT nunca ser reutilizado. **Não bloqueante.**
- **F17 🟠 (baixo) — `vw_participacoes_dia` é definer e legível por `anon`** (registrado 2026-07-20, achado do check de autorização da 0122). A view (0055/0079) foi criada **sem** `security_invoker`, então roda com o dono (postgres) e **fura o RLS de `rats`/`rat_tecnicos`**: qualquer chamada com a anon key lê TODAS as participações (técnico, dia, horários, cliente) — verificado por simulação de papéis (anon = 254 linhas). Views que a consomem herdam o furo (a `vw_alerta_sobreposicao`/0122 se protegeu com filtro `app_role()` próprio; conferir `vw_rats_busca` e afins). Correção: `alter view ... set (security_invoker = true)` **+ testar as superfícies** (Jornada/relatórios rodam como authenticated office — devem continuar OK; o app do técnico não a consome hoje) ou filtro `app_role()` como na 0122. Dado pessoal de rotina exposto sem login → resolver no próximo pacote de segurança.

## Verificado e SÃO (não mexer)
- Invariante "RAT não conclui Tarefa": intacto (`js/sync.js:103` MAP só `→ em_execucao`; nenhum trigger/edge escreve `concluida` por RAT).
- `respostas.data` **é** gravado (template tem campo `data`, default `jorHoje()` local); `ratDoDiaDe` usa a chave certa. (Falso-positivo descartado conferindo no banco.)
- Idempotência offline por `client_uuid`; pull não sobrescreve local pendente; ordem foto→RAT→fotos/materiais correta.
