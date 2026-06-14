# Smoke test — Fluxo do técnico (branch `feat/fluxo-tecnico`)

> Cobertura: Fila/Pegar · RAT registra o dia → conclusão na Tarefa (2 passos) ·
> checkpoint de passagem · RAT improdutiva · nova tarefa da pendência + pushes ·
> **offline** · **caminhos negativos das validações**.
> Marque um a um. Se algum passo falhar, anote o código (ex.: `H3`) pra corrigir antes do merge.

## Pré-requisitos
- [ ] Abrir o **preview** da branch (`servicereport-app-git-feat-fluxo-…vercel.app`), **não** produção.
- [ ] **Recarregar** uma vez pra pegar o **SW v360** (ou superior).
- [ ] Duas sessões: **Técnico** (ex.: Pablo, no celular/PWA) e **Admin** (no portal desktop).
- [ ] No aparelho do **admin**, ativar **notificações push** (o remetente nunca recebe o próprio push — o push precisa ser visto num usuário ≠ do técnico).

## A. Fila + Pegar
- [ ] **A1** Admin cria uma tarefa **sem responsável** (status "Aguardando"). → Tarefa criada.
- [ ] **A2** Técnico → **Home** → seção **"Fila — tarefas abertas"** mostra a tarefa com botão **Pegar**.
- [ ] **A3** (auto-refresh) Com a Home aberta, admin **remove o responsável** de outra tarefa → em ≤60s (ou ao sair/voltar da aba) ela **aparece na Fila** sozinha.
- [ ] **A4** Técnico toca **Pegar** → vira responsável; a tarefa **sai da Fila** e entra em **"Minhas tarefas de hoje"**; abre a RAT do dia.

## B. RAT registra o DIA (passo 1 de 2)
> No card **Situação** não há mais o toggle "Sim/Não" — **execução é o padrão**. A visita improdutiva é um **checkbox discreto** ("Não consegui executar"). No fluxo normal (checkbox desmarcado), o rodapé tem **dois botões**: **Salvar e continuar** (secundário) e **Encerrar a RAT do dia** (primário).
- [ ] **B1** Na RAT, preencher os obrigatórios; usar o timer **Iniciar/Encerrar atendimento** (preenche Hora de Início/Término).
- [ ] **B2** Em **Situação**, deixe o checkbox **"Não consegui executar"** **desmarcado** (= execução). No rodapé aparecem **"Salvar e continuar"** + **"Encerrar a RAT do dia"**.
- [ ] **B2b** (salvar parcial) Tocar **"Salvar e continuar"** → toast "RAT salva no aparelho"; a RAT fica **"Em andamento"** e segue editável (sem exigir obrigatórios nem checkpoint).
- [ ] **B3** Tocar **"Encerrar a RAT do dia"** → surge o checkpoint **"Volta amanhã?"**; responder **Sim** e tocar **"Encerrar a RAT do dia"** de novo → toast **"RAT do dia registrada"**; volta pra lista.
- [ ] **B4** A RAT aparece como **"Registrada"** (não "Concluída"); a **Tarefa continua "Em execução / Atendimento continua"** (não concluída).
- [ ] **B5** Admin recebe push **"RAT registrada"** (tarefa · cliente).

## C. Concluir o SERVIÇO na Tarefa (passo 2 de 2)
- [ ] **C1** Técnico abre a **Tarefa** (detalhe) → botão **"Concluir serviço"** → confirma → toast "Serviço concluído"; status **Concluída**.
- [ ] **C2** (variante) **"Concluir c/ pendência"** → abre modal, digita o texto, confirma → status **Concluída com pendência**; **não** existe "criar tarefa de retorno" no app do técnico.
- [ ] **C3** Admin recebe push **"Concluída com pendência — reagendar"** (tarefa · cliente · texto).

## D. Nova tarefa da pendência (admin) + flip
- [ ] **D1** Admin no portal abre a tarefa **concluída com pendência** → **"Nova tarefa da pendência"** → escolhe tipo → cria.
- [ ] **D2** A tarefa de **retorno** nasce **na fila** (sem responsável) com orientação = a pendência, e **observações = "Gerada da pendência da Tarefa Nº X"**.
- [ ] **D3** A tarefa **original** passa de "concluída c/ pendência" → **"concluída"** automaticamente (não precisa reconcluir).

## E. Checkpoint de passagem (handoff)
- [ ] **E1** Nova RAT → tocar **"Encerrar a RAT do dia"** (surge o checkpoint) → "Volta amanhã? **Não**" → aparece **"Por quê?"**.
- [ ] **E2** Escolher **"Terminei o serviço"** → **não** pede o que falta/levar → registra. **Confirme que a Tarefa NÃO ficou concluída** (continua "Em execução") — "Terminei" só dispensa o checkpoint.
- [ ] **E3** Outra RAT → "Não" → **"Vou voltar depois pra terminar"** → preenche **o que falta** e **o que levar** → registra.
- [ ] **E4** No portal, abrir essa RAT → mostra a seção **"Passagem — volta depois pra terminar"** com o que falta / o que levar.

## F. RAT improdutiva
- [ ] **F1** Nova RAT → no card **Situação**, marcar **"Não consegui executar (visita improdutiva)"** → escolher **motivo** → preencher **Hora de Início / Hora de Término** (tempo no local) → **"Registrar visita"** → toast "Visita improdutiva registrada".
- [ ] **F2** A **Tarefa continua "Aguardando"** (não progride); a RAT fica **"Visita improdutiva"**.
- [ ] **F3** Admin recebe push **"Visita improdutiva — reagendar"** (tarefa · cliente · motivo).
- [ ] **F4** No portal, a RAT mostra **"Visita improdutiva"** + motivo + **"Tempo no local (início–término)"**.

## G. OFFLINE (obrigatório) 🛫
- [ ] **G1** Ativar **modo avião**. Home → a Fila mostra **"Sem conexão — a fila aparece quando houver internet."**
- [ ] **G2** Abrir uma tarefa já atribuída e fazer uma **RAT completa** (fotos, horários, serviço executado) → **Encerrar a RAT do dia** → toast "RAT do dia registrada". O cabeçalho mostra **"↑ N na fila"** (pendente de envio).
- [ ] **G3** (opcional) Criar uma **"Nova tarefa em campo"** offline → toast "será enviada quando houver internet".
- [ ] **G4** **Religar** a internet → o SyncEngine envia sozinho; o badge volta pra **"✓ sincronizado"**.
- [ ] **G5** **Sem perda:** a RAT enviada mantém respostas, fotos e tempo (confere no portal).
- [ ] **G6** **Sem duplicação:** no portal, a RAT aparece **uma única vez** (idempotência por `client_uuid`); a tarefa criada offline também aparece **uma só vez**.
- [ ] **G7** (bônus) Recarregar o app do técnico após o sync → a RAT continua lá como **confirmada** (não virou rascunho nem sumiu).
- [ ] **G8** (duplicação forçada) Depois do G4, clicar **"Sincronizar"** de novo manualmente → continua **1 RAT** no portal (não cria segunda).

## H. Caminho NEGATIVO das validações (obrigatório) — tem que BLOQUEAR ⛔
- [ ] **H1** Improdutiva **sem tempo no local**: marcar "Não consegui executar" + motivo, mas **Hora de Início/Término vazias** → "Registrar visita" → **bloqueia**: *"Informe Hora de Início e Hora de Término (tempo no local)."* (não salva)
- [ ] **H2** Improdutiva com **término < início** → **bloqueia**: *"A Hora de Término não pode ser antes da de Início."*
- [ ] **H3** **Hora de término no futuro** (improdutiva ou ao registrar o dia): pôr um horário maior que o relógio atual → **bloqueia**: *"A Hora de Término não pode ser depois do horário atual."*
- [ ] **H4** Checkpoint **"Vou voltar depois"** com **"o que falta" vazio** → **bloqueia**: *"Informe o que falta pra terminar."*
- [ ] **H5** Idem com **"o que levar" vazio** → **bloqueia**: *"Informe o que levar na próxima ida."*
- [ ] **H6** Tocar **"Encerrar a RAT do dia"** e, com o checkpoint aberto, tocar de novo **sem responder "Volta amanhã?"** → **bloqueia**: *"Responda se volta amanhã pra continuar."*
- [ ] **H7** "Volta amanhã? Não" **sem escolher o porquê** → **bloqueia**: *"Diga por que não volta amanhã."*
- [ ] **H8** Concluir c/ pendência **sem texto** → **bloqueia**: *"Descreva a pendência."*
- [ ] **H9** Improdutiva **sem motivo** → **bloqueia**: *"Escolha o motivo de não ter executado."* (e "Outro" sem texto → *"Descreva o motivo."*)
- [ ] **H10** **Deslocamento de ida depois do Início** (ex.: ida 10:00, Hora de Início 09:00) → ao encerrar → **bloqueia**: *"Deslocamento de ida não pode ser depois da Hora de Início da execução."*
- [ ] **H11** **Deslocamento de retorno antes do Término** (ex.: retorno 16:00, Hora de Término 17:00) → **bloqueia**: *"Deslocamento de retorno não pode ser antes da Hora de Término da execução."*
- [ ] **H12** **Pausa fora da janela ida→retorno** (ex.: pausa antes da ida) → **bloqueia**: *"A pausa tem de ficar entre o deslocamento de ida e o de retorno."*
- [ ] **H13** (rollover OK — NÃO pode bloquear) Dia que **vira a meia-noite** (ex.: Início 22:00, Término 02:00, retorno 03:00) → **encerra normalmente**, sem falso-bloqueio.

---

### Notas
- **Offline (G):** o objetivo é provar idempotência — `client_uuid` no aparelho garante 1 RAT mesmo com reenvio.
- **Negativos (H):** todos devem dar **toast vermelho e permanecer na tela** (nada gravado/enviado). Qualquer um que **deixe passar** = corrigir antes do merge (anotar o código H#).
- **Backend já em produção:** migrations `0061` (fila) e `0062` (improdutiva); Edge `notify-push` v4 (`rat_registrada` · `rat_improdutiva` · `tarefa_pendencia`). O frontend fica na branch até o merge.
