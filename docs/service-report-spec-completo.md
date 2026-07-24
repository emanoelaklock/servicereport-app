# Service Report + Módulo Comercial — Especificação Consolidada

> Documento vivo. Reúne tudo que foi desenhado até aqui. Serve de referência única para a construção (Claude Code) e para revisão do time. Ao lembrar de algo novo, acrescenta-se aqui — não precisa segurar nada de cabeça.
>
> **Última atualização: 23/06/2026** (incorpora o trabalho de 09–11/06: re-skin do admin, reorganização da RAT do técnico, timers reabríveis, IA "Melhorar escrita", pernoite, paleta oficial — **+ decisões de design de 12/06:** tempo por técnico + Tangerino (§8) · Remessa/Container (§9) · decimais com teto na Tarefa (§9) · Viagem como referência futura (§4.1) — **+ junho/26:** push de atribuição/reagendamento, telas de RAT/Deslocamento no portal, rótulo "Atendimento Realizado", sync resiliente, e **finalização colaborativa da viagem** — qualquer um a bordo finaliza, merge por união com conflito marcado pro admin (§4.1 / §12)).

---

## 1. Visão geral

Plataforma interna da **Traders Service (TSRV)** para substituir gradualmente o Auvo e integrar com o Omie. Vive no portal **"Traders Apps"** (Supabase, projeto `iwufrqmzcvaiyzynodkg`), como mais um módulo ao lado do AxisInventory.

**Stack:** HTML/CSS/JS puro + Supabase + Vercel. Design system "Bold" (navy `#1B2A4A`). Backend único compartilhado.

**Paleta oficial (implementada em 09/06):** azul · verde (`--green #179A47`) · roxo · vermelho · laranja · amarelo, com tints translúcidos para fundos. Rótulos em **sentence case** (sem CAIXA ALTA). Ícones **SVG de linha** (sem emojis) em todas as superfícies — admin e app do técnico.

**O funil completo, de ponta a ponta:**

```
pré-orçamento → orçamento → status → APROVADO → Tarefa (OS interna)
   → RATs → conciliação → revisão do admin
   → OS no Omie ("a Faturar") → FATURADO
```

Dois grandes blocos:
- **Módulo Comercial** (o "começo"): pré-orçamento e orçamento.
- **Service Report / Execução** (o "meio pra frente"): Tarefa, RATs, conciliação, faturamento.

**App de campo (técnico):** PWA offline-first, acessado direto (URL própria, instalável). O **portal** é para escritório (comercial/administrativo). Mesmo backend, rotas por papel.

---

## 2. Papéis

Três papéis: **comercial / administrativo / técnico.**

| Papel | Faz |
|------|-----|
| **Comercial** | Dono do orçamento até o aprovado. Marca o status (cliente respondeu). |
| **Administrativo** | Revisa Tarefas concluídas, gerencia material levado, aprova para faturar, marca faturado. |
| **Técnico** | Cria pré-orçamento e preenche RATs em campo. Só vê o que é dele. |

Mapeamento com o que já existe no banco: `tecnico_campo` = técnico; `admin`/`gestor_axis` = administrativo; **`comercial` é novo** (adicionar ao conjunto de roles).

---

## 3. Núcleo compartilhado

- **clientes** — origem **Omie** (read-only). `omie_cliente_id`.
- **produtos** — catálogo, origem **Omie** (read-only). **Precisa incluir o campo de preço** (sincronizado do Omie) para o orçamento. `omie_produto_id`.
- **usuarios** — já existe; ganha o papel `comercial`.

**Serviços transversais (construir uma vez, reusar):**
- **Geração de PDF** — usada em pré-orçamento, orçamento e RAT.
- **E-mail ao finalizar** — usada só onde faz sentido (ver §11).
- **Bloco de controle de tempo** — deslocamento + início/fim + pausa + almoço + cálculo de tempo trabalhado. **Idêntico** em pré-orçamento e RAT.
- **Infra offline-first** — captura local (IndexedDB), fila de sincronização, modelo de accountability (ver §10).

---

## 4. Pré-orçamento

Levantamento técnico em campo, para o comercial depois precificar.

- **Quem cria:** só o **técnico**, no celular, na visita. **Offline-first** (mesma infra da RAT).
- **Dono único (NÃO é colaborativo, diferente da RAT):** o pré-orçamento pertence a **um** técnico — `pre_orcamentos.tecnico_id` (o criador). **Não há tabela de junção** (`pre_orcamento_tecnicos` não existe) nem RLS de co-dono: só o dono **envia**, **recebe no pull** (`preorc_tec_sel`: `tecnico_id = auth.uid()`) e **edita**. Compartilhar de verdade com uma equipe (como a RAT faz via `rat_tecnicos`) seria mudança de escopo (junção + RLS + sync) — é dono único **de propósito** (ver a regra "1 técnico" abaixo).
- **Campos:** cliente (catálogo Omie) · descrição do que precisa ser feito (o levantamento) · **materiais necessários** (itens do catálogo, com quantidade) · fotos · **deslocamento** (Sim/Não + horários) · **início/fim do levantamento** · **almoço/pausa** · **técnico do levantamento** (1 só — o criador, fixo) · **data realizada** (dia do levantamento).
- **`data` = data REALIZADA, fixada na criação (v681):** o campo `data` do pré-orçamento é o **dia em que o técnico fez o levantamento** — gravado **uma vez** no `novoPreorc` e **nunca recarimbado** no salvar/concluir/sync. *(Bug corrigido em 24/07: antes `data: new Date()` era reescrito a cada salvar/concluir — `tecnico.js` `poMontarPayload`/`concluirPreorc` — então concluir/sincronizar dias depois escorregava a data para o dia do sync. Caso real: pré-orçamento Nº 14 do Maicon, feito 22/07, apareceu 24/07 no PDF e na jornada porque foi re-sincronizado nesse dia na recuperação do bug de envio.)* **Início/fim da visita alimentam a jornada do técnico** (`respostas.visita_inicio`/`visita_termino` lidos ao vivo com `pre_orcamentos.data` — sem view/segmento materializado), então a data errada contamina o tempo do dia; por isso ela tem que ser imutável.
- **Regra: pré-orçamento = 1 técnico (SW v657).** Levantamento é trabalho de uma pessoa (olhar o local, medir, fotografar, anotar); o outro técnico segue na atividade em execução, ninguém para pra acompanhar. O app **força**: a seção "O Levantamento" mostra só o criador, **sem "+ Adicionar técnico"** e sem remover — não há como incluir um segundo. *(Histórico: entre 26/06 e 19/07 o app teve um seletor de equipe — commit `2dad0ec`, v526 — que era só documental, nunca co-dono; removido na v657 pra bater com a orientação ao campo. Os poucos pré-orçamentos antigos com 2+ técnicos anotados são cosméticos — só aparecem no PDF, não afetam métrica: o relatório de deslocamento por técnico e o tempo usam `tecnico_id`, o dono.)*
- **Controle de tempo:** completo (deslocamento, início/fim, pausa, almoço) → tempo de trabalho do técnico.
- **Ao finalizar:** gera **PDF** + dispara **e-mail para comercial@tsrv.com.br** + **aparece no painel do administrativo** como "pré-orçamento".

> Pré-orçamento e RAT são o **mesmo tipo de artefato** (visita de campo) com o mesmo esqueleto. Diferem só no propósito/alguns campos: pré-orçamento = *materiais necessários* + levantamento; RAT = *materiais usados* + serviço executado/checklist.

**Baixar de volta + trava após virar orçamento (migração 0114, PR #106):** o pré-orçamento passou a ser **baixado** para o aparelho, não só subir — antes vivia só no celular que o criou (se a cópia local sumia, o técnico não reabria). Agora `pre_orcamentos` entra no pull (junto com itens e fotos, filtrado pela RLS do dono `tecnico_id = auth.uid()`), então o técnico **reabre em qualquer aparelho**. O merge é o mesmo das RATs (`aplicarDoServidor`): trabalho local pendente **vence** o servidor.
- **Sinal "virou orçamento":** `pre_orcamentos.orcamento_em` (timestamp; nulo = não convertido), **materializado na linha** por um trigger em `orcamentos` (carimba no 1º orçamento que aponta pro pré-orçamento; **limpa** quando nenhum orçamento referencia mais — um pré-orçamento pode ter vários). Desce no pull, então o app sabe travar sem baixar a tabela `orcamentos`.
- **Read-only após virar orçamento (total):** no app, um pré-orçamento convertido abre **somente leitura** (campos desabilitados, some Salvar/Enviar, aviso "já virou orçamento"; na lista, badge **"Orçado"** e sem excluir). A trava é **também no servidor** (trigger `BEFORE UPDATE` rejeita edição do técnico quando `orcamento_em` está setado → `PREORC_JA_ORCADO`); gestão/comercial seguem editando.

**Envio offline do pré-orçamento — foto robusta + fila visível (23/07, FASE 1 em produção + FASE 2 no PR #132):** origem foi um caso real (iPhone, Maicon, "WESTROCK - BLU"): pré-orçamento salvo no aparelho, toast "1 item com erro de envio", mas o badge global dizia **"✓ sincronizado"** e o dado **nunca chegou ao servidor** (sem linha em `pre_orcamentos`, sem objeto novo no Storage, sem 4xx nos logs). Diagnóstico e correções:
- **O badge não mente mais (FASE 1 — SW v677, na `main`):** o indicador global (`pintarRede`, `tecnico.html`) e o card "na fila" da Home (`renderHome`, `tecnico.js`) somavam só RATs + tarefas locais + deslocamentos — **pré-orçamento não entrava em contagem alguma**, então um preso (erro/na_fila/salvo_local) ficava invisível. Agora somam `listarPreorc().filter(PEND)` nos dois pontos. *(Nota: para RAT o estado `erro` já contava; o bug era pré-orçamento fora da conta, não "erro ignorado".)*
- **Erro exato persistido e visível (FASE 1):** a falha de envio do pré-orçamento só ia pra `console.warn` (diagnóstico cego). Agora o `syncAll` grava `sync_erro` (name+message) no item e a lista mostra badge vermelho **"Erro ao enviar" + a razão** — antes o estado `erro` se disfarçava de **"na fila ↑"**.
- **Causa raiz — bug do iOS Safari (corpo vazio no upload):** a foto do pré-orçamento era guardada como `File` **cru** (do `<input>`) e subia como body do `fetch`; o iOS manda **corpo vazio** quando o body é um `Blob` *file-backed* vindo do IndexedDB (erro real `StorageApiError: No content provided`), **mesmo o blob tendo conteúdo** — o `<img>` da miniatura lê em memória e renderiza, o upload manda vazio. A RAT nunca sofreu porque guarda o blob do **canvas** (memória), não `File` cru.
- **Fix de envio (FASE 2):** antes do upload, `blob.arrayBuffer()` → `new Blob([buf])` **fresco em memória** → sobe. Corpo correto **e recupera as fotos já enfileiradas sem re-anexar**. E `poAddFotos` passa a reencodar via `comprimirFoto` (canvas → Blob fresco, leve) no *add* — imuniza fotos novas na origem, igual à RAT.
- **Envio resiliente (FASE 2, princípio §12 "trabalho não se apaga"):** uma foto que ainda assim falhe **não derruba** o pré-orçamento — texto + itens + fotos boas **sobem**; foto com falha de leitura vira `falha_permanente` (pulada depois, **nunca apagada**, sinalizada na miniatura "remova e re-anexe"). Envio **parcial** não confirma "verde limpo" e **segura o e-mail/PDF ao comercial** até resolver (converge quando a foto sobe); marca `erro` com mensagem amigável **sem contar no toast** (sem spam a cada sync), segue vermelho no badge/lista. Mesmo padrão do bloqueio de RLS da RAT (§12).
- **Log server-side do erro — decisão:** **não** se mexeu na RLS de `sync_eventos` (escopada por RAT: evento com `rat_id` nulo é rejeitado, e o item travado nem tem linha no servidor pra ancorar). A visibilidade remota vem do próprio envio resiliente (a linha do pré-orçamento pousa no servidor).
- **Órfão em `enviando` (24/07, SW v680):** provado no aparelho do Maicon após a v678 — o pré-orçamento subiu para `enviando`, o iOS matou o PWA no meio do upload, e o item ficou **preso em `enviando`**: a coleta do sync e o badge só olhavam `[salvo_local, na_fila, erro]`, então `enviando` obsoleto ficava **invisível e sem retry** (Home dizia "0 na fila / sincronizado", lista mostrava "na fila ↑", servidor sem nada). Vale para RAT e pré-orçamento. Fix: `enviando` entra na coleta do `syncAll` (`sync.js` — como o guard `syncing` garante 1 round por vez, todo `enviando` visto ali é obsoleto → reenvia, upsert idempotente) e no badge (`pintarRede`/`renderHome`); transição `enviando → na_fila` liberada (retry de envio interrompido). Auto-recupera no próximo sync.
- **Varredura de outros uploads (23/07):** auditados todos os caminhos que sobem arquivo lido do IndexedDB, nos dois apps. **`comercial-app`: não aplicável** (não usa IndexedDB; upload único é `File` fresco do `<input>`). **service-report-app:** a **assinatura da RAT** é segura (dataURL → `dataURLparaBlob` → `new Blob` fresco, `sync.js`); anexos de tarefa/orçamento/RAT-adm do **portal** sobem `File` direto do `<input>` sem passar pelo IndexedDB (seguros). **Achado real: fotos da RAT** (`enviarRat`) compartilhavam o furo — `comprimirFoto` devolve o `File` **original** quando o canvas não reduz o tamanho, e o upload subia `f.blob` cru. Corrigido com a mesma materialização (`arrayBuffer()`→`Blob` fresco) — SW v679.

### 4.1 Deslocamento (pernoite) — artefato à parte

Artefato **próprio** do técnico (não é um campo dentro da RAT — esse é o bloco de deslocamento/tempo). Registra **viagens com pernoite**. **Continua valendo** (decisão confirmada).

**Implementado (11/06):** acessível em **Home > Deslocamento** no app do técnico. Blocos de **Ida** e **Volta** (com ícones SVG) e **técnicos a bordo** selecionados em cards (mesmo padrão visual da RAT).

> Não confundir com o **deslocamento do dia**, que mora dentro da RAT (botão "Deslocamento" no grid de registros — **toggles independentes de ida e retorno** (Sim/Não), cada um com início/fim carimbados). Pernoite é viagem; deslocamento do dia é o trajeto da visita.

**Reformulação aprovada (12/06) — trechos dinâmicos** *(referência visual: `docs/mockups/mockup-deslocamento-tempo.html`; construir junto com o pacote tempo-por-técnico, §8)*:
- **Trechos:** o deslocamento vira lista ordenada de trechos (origem → destino, data, saída/chegada). **Nasce só com a ida** (origem = base) — volta e demais trechos entram por "+ Adicionar trecho" *(decisão 07/26; antes nascia com ida e volta, mas a volta vazia pré-criada não era o esperado)*. Trecho novo **herda veículo, direção e passageiros** do anterior.
- **Locais do cliente (cadastro novo):** Cliente → Locais (nome · cidade/UF · lat/long opcional) — caso WestRock-FBTB com sites espalhados (Torre Paredão/Calmon, Rio Negrinho, fazendas). Destino do trecho = local cadastrado ou texto livre.
- **Veículo por trecho:** lista da empresa · "sem veículo/carona" · alugado; avião = sem veículo + nota curta (`nota_transporte`). **Veículo da empresa exige direção.**
- **Direção com revezamento:** turnos contíguos dentro do trecho (motorista + de/até; "+ Revezamento" = quem assumiu e a hora) — **multa atribuída por horário** de quem dirigia.
- **A bordo por trecho** (componente de colaborador **com foto** das RATs/Tarefas); a participação de cada técnico na viagem é **derivada** dos trechos.
- **Finalização colaborativa:** qualquer um a bordo finaliza a viagem (não só quem criou); a escrita mescla por união no servidor e marca conflito de horas pro admin — detalhe técnico em §12 ("Finalização colaborativa da viagem").
- **Pernoite sugerido e derivado:** entre trechos de dias diferentes, o app sugere "Pernoite · [cidade do local]"; **noites por pessoa derivadas da participação** (ex.: Pablo 3 noites, Arian/Charles 4 — ninguém digita).
- **GPS pontual automático** ao iniciar/encerrar trecho (sem botão; offline salva "sem GPS"); com lat/long do local, **validação de proximidade** ("chegada a 280 m de Torre Paredão"). Sem rastreamento contínuo, **sem km/odômetro**.
- **Almoço na estrada por pessoa/dia** com a mesma deduplicação da RAT (§8). Tempo dos trechos = **segmentos de deslocamento da jornada** (§10.1) por participante.
- **Fora (de propósito):** km · rastreamento contínuo · despesas de viagem · trechos multimodais (nota resolve) · ícones emoji (SVG de linha sempre).

**Nº oficial da viagem (15/07 — migração 0108):** cada viagem tem um **número próprio sequencial**, exibido como **`V-0231`** (padStart 4). Motivação: a gestão precisava de um identificador curto pra se referir a uma viagem em conversa ("dá uma olhada na V-231"). Regras:
- **Atribuído pelo servidor** (`deslocamentos.numero`, `DEFAULT nextval` de sequence própria) no insert — segue o princípio do projeto: identidade offline é o uuid do aparelho, número oficial nasce no servidor. Nunca reutilizado; buracos por exclusão são normais.
- **Sequência própria da viagem** — deliberadamente **não** compartilha numeração com Tarefa nem com RAT (`{tarefa}/{seq}`): viagem referencia tarefa (N:N via `deslocamento_tarefas`, pode ter várias ou nenhuma), não é filha dela; intercalar tipos num contador destruiria o significado da sequência da RAT.
- **Onde aparece (portal):** calendário de deslocamentos (subtítulo do modal Detalhe da viagem), lista de deslocamentos (linha, detalhe e título do Editar viagem). Backfill das viagens existentes na ordem de `criado_em`.

**Guarda de duração anômala (15/07):** trecho com **chegada − saída > 24h** é quase certamente carimbo com a data errada (caso real: V-0003, saída gravada no dia da ida com o trecho datado da volta → "101h14min"). O portal **não exibe a duração absurda**: mostra **"⚠ conferir horários (saída DD/MM, chegada DD/MM)"** na família warn — no modal do calendário (meta do trecho), na lista (junto do Tempo da linha e do detalhe) e no trecho do detalhe. O "Tempo" agregado continua sendo a soma dos carimbos (não mascara o dado); o aviso diz que o número não é confiável até corrigir. Correção: pelo editor do portal (a re-ancoragem de horários na troca de data é automática nos dois editores — app `tecnico.js` e portal `deslocamentos.js`).

**Robustez do sync de viagem (15/07 — pacote `fix/deslocamento-sync-hardening`):**
- **Auto-save do "Marcar agora" grava SÓ o carimbo** (data-âncora + hora + GPS) sobre o roteiro como carregado — edição estrutural (remover/alterar trecho) só sobe no **Salvar** explícito; Cancelar não perde nem apaga nada (princípio: trabalho não se apaga sem ação explícita). Trecho novo carimbado sobe aditivo.
- **Limpeza explícita propaga** (`t._limpar`): "Sem tarefa", "sem veículo (nota)", destino livre e refeição apagada zeram o campo no servidor; `null` sem a marca segue sendo "não mexi" (união preenche vazio).
- **Trecho pode ficar sem técnicos**: herança de a-bordo só na criação do trecho; remoção é explícita (`t._tec_remover`) e propaga (re-adicionado vence); o pai `deslocamento_tecnicos` é podado pra refletir a participação derivada dos trechos.
- **Merge aceita re-ancoragem**: divergência de timestamp com a mesma hora de relógio caindo no dia do trecho (chegada aceita dia+1 — madrugada) é correção, não disputa (caso real V-0003). Divergência de hora de verdade segue: mantém servidor + conflito.
- **Conflitos sem duplicata**: retry do aparelho não re-empilha a mesma divergência (caso real V-0007, 4 cópias) nem re-derruba a revisão.
- **Madrugada nunca nasce em silêncio**: "Marcar agora" pede confirmação ao marcar chegada antes da saída (virada real) e ao marcar saída com chegada já registrada (fora de ordem); mesmo minuto = trecho de 0 min, não +24h (app e portal).
- **Menores**: fallback de dia usa dia LOCAL (não UTC); data do trecho não pode ser limpa e o Salvar a exige; almoço por pessoa/dia não é sobrescrito em silêncio no merge (divergência → conflito `almoco_pessoa_dia`); payload com trecho de outra viagem é rejeitado (400).

**Fuso do portal (15/07 — regra da casa, pacote `fix/portal-fuso-brasilia`):** *o portal SEMPRE exibe e interpreta horários em America/Sao_Paulo, independente do fuso do operador — operação é no Brasil; o fuso do navegador nunca é fonte de verdade.* Bug real: operadora em UTC-4 via horários −1h e teria gravado +1h pelo editor. Implementação: helpers únicos no `utils.js` (`hhSP`/`diaSP`/`ddmmSP` via Intl com TZ fixo; `isoDeSP` interpreta o digitado como relógio de Brasília com offset fixo −03 — Brasil sem DST desde 2019, mesma premissa do `viagem-merge`). Superfícies corrigidas: editor da viagem e do trajeto antigo (ler E gravar), Tempo da lista/detalhe (janela de refeição), guardas "⚠ conferir horários", Jornada inteira (linha do tempo, pernoites, relatório, fronteira de "hoje"), Desempenho e prazos de Tarefa. Sufixo "(horário de Brasília)" nos dois editores, no detalhe e nos headers da Jornada. Verificação: harness em **TZ dupla** (America/New_York = condição do bug; America/Sao_Paulo = controle) com **controle negativo** (a implementação antiga comprovadamente falha fora do Brasil). **O app do técnico segue no fuso do APARELHO, por decisão** — o carimbo "agora" é o relógio de quem registra e a operação é no Brasil.

**Salvar do portal normaliza e resolve (15/07):** ao salvar a viagem no editor do portal, (a) **todo timestamp é re-ancorado na Data do trecho** ("o que se vê é o que grava" — a Data do trecho é a única fonte de data; saída/chegada são só hora; madrugada soma 1 dia como no editor), o que corrige âncora legada invisível no formulário só de abrir e salvar; e (b) **`conflito` é limpo** — o admin acabou de conferir os valores no editor, salvar é o ato de resolução (antes o selo "⚠ conflito — revisar" ficava pra sempre).

**Relatório "Deslocamento por técnico (período)" (15/07 — fase 1, na página Jornada):** horas em trânsito por técnico num período, com **colunas por fonte** — A `desloc_dia` (RAT) · B `deslocamento` (trechos de viagem por pessoa) · C pré-orçamento (`ida→retorno`, coluna própria sempre) — e **Total = união** das fontes − janela de almoço do dia (sobreposição entre fontes conta uma vez; o total é o teto). Decisões de spec:
- **Sobreposição com RAT nunca subtrai em silêncio**: vira sinalização na linha ("⚠ sobrepõe RAT NNNN") — sobreposição física é dado inconsistente, expõe pra corrigir.
- **Madrugada divide nos dois dias** (a view rebaixa pra hora; fim < início = virou o dia) — recorte por período exato, inclusive a parte pós-meia-noite de trecho da véspera do período.
- **Registro sem duração** (trecho aberto/horário incompleto) **não conta no total** e é declarado na linha ("⏱ N sem duração — horas parciais") e no rodapé (contagem global) — total honesto declara o que não conseguiu contar.
- **Drill-down rastreável** por técnico/dia: viagem com nº oficial (V-0231, link), RAT Ida/Retorno (link), pré-orçamento com nº (sem link — não há visualizador).
- **Exportação CSV** da tabela (`;` + BOM). PDF fora por ora.
- Arquitetura: reusa `vw_participacoes_dia` filtrada por tipo + `almocos` + `pre_orcamentos` (sem view nova), mesmo motor de união (`uniaoMin`) da tabela Horas do dia. Fonte C fora da view de propósito (não poluir consumo futuro de faturamento).
- **Consistência entre telas (regra):** o número do relatório usa a MESMA regra da tabela Horas do dia — união de intervalos − janela de almoço da pessoa (validado por amostragem: V-0006 do Pablo, 8h26 do trecho − 1h de almoço = 07h26 nas duas contas). Divergência entre as telas é bug, não interpretação.
- **Acesso (decisão, não omissão):** o relatório é **só gestão** — `admin` + `gestor_axis`, herdado do `PAGE_ALLOWED` da página Jornada. O **técnico** vê as **próprias viagens** no app (Home > Deslocamento: lista com trechos, horas e total da viagem), mas **não tem visão agregada** de horas em trânsito; se essa necessidade surgir, nasce como card no app de campo — não se abre o portal pro técnico.

**Conferência "sobreposição de horários entre RATs" (20/07 — Fase 1 do redesenho "passagem de bastão", `docs/redesenho-passagem-bastao.md`):** a `vw_alerta_sobreposicao` (migração 0122, molde da `vw_alerta_desloc_sem_volta`) lista **pares de RATs do MESMO técnico no MESMO dia já encerrado** cujos horários se cruzam, com o intervalo conflitante calculado. Banner âmbar na **Jornada** (com link pras duas RATs e a janela de cada uma) e card âmbar no **Painel** (janela de 14 dias; o item abre a Jornada do dia via `?d=`). Decisões: **só leitura** — não trava o técnico, não altera horário, não entra em desempenho nem faturamento; encostar (fim = início) **não** é sobreposição; intervalo aberto/inválido fica fora; sobreposição **pode ser legítima** ("saiu e voltou" — 5 dos 7 casos históricos), por isso alerta de conferência, nunca correção automática. O encerramento automático de participação (ledger/motor server-side, modal "manter também", editor de horário individual) foi **deliberadamente adiado** — decisão de 20/07 registrada no doc do redesenho.

> O **módulo "Viagem" rico** (máquina de estados, tela "em andamento" com próximo destino, portal nativo) segue **estacionado** como referência — reavaliar após a jornada contínua; os trechos acima já absorvem a parte útil dele.

---

## 5. Orçamento

> **Onde vive (decisão de 09/06):** o orçamento migrou para um app próprio, **"Gestão Comercial" (`comercial-app`)** — o menu Orçamentos saiu da sidebar do Service Report. Mesmo backend Supabase; as regras abaixo continuam valendo.

- **Quem cria:** **comercial**. Pode ser **transformado de um pré-orçamento** ou **criado novo** (`pre_orcamento_id` opcional).
- **Serviço:** **descrição livre (texto longo)** + **valor final** digitado na hora. **Sem quantidade, valor unitário ou valor total** (isso é só de materiais).
- **Material do catálogo:** itemizado (descrição, unidade, qtd, valor unit., total). Preço puxa do **Omie**, mas **editável**.
- **Item avulso:** itemizado, preço digitado na mão.
- **Ao finalizar:** gera **só o PDF** (sem e-mail automático). O comercial/admin envia ao cliente do jeito dele (e-mail próprio, WhatsApp…).
- **O técnico não vê preço** — nem do produto, nem do orçamento (ver regra de dados em §10).

### Layout do PDF (pré-orçamento e orçamento)

Referência visual: PDFs reais `Pré-orçamento_4698.pdf` e `Orçamento_4698.pdf`. **Mesmo template, dois modos** — a única diferença é o preço. Reusa o serviço de PDF compartilhado (§12).

Estrutura comum:
- **Cabeçalho:** dados da empresa (TSRV: CNPJ, IE, IM, endereço, telefone) + logo.
- **Título:** "Pré-Orçamento Nº X" ou "Orçamento Nº X".
- **Informações do Cliente:** nome, CNPJ, endereço, e-mail, telefone.
- **Lista de Serviços:** **descrição livre (texto longo)** + **valor final** (no orçamento). **Sem colunas de qtd/unitário/total.**
- **Lista de Produtos:** descrição + unidade + quantidade.
- **Rodapé:** "Gerado em DD/MM/AAAA às HH:MM por <usuário>".

Diferença **pré-orçamento → orçamento**:
- Orçamento **acrescenta**: o **valor** do serviço; colunas **Valor Unit./Total** nos materiais; **totais** (serviços, materiais, total geral em destaque); **condição de pagamento**; e **observações**.
- Pré-orçamento **não tem** valores nem condição de pagamento.

**Devem aparecer no PDF do orçamento (estavam faltando):** **observações** e **forma/condição de pagamento**.

**Layout final aprovado:** `mockup-orcamento-pdf.html`. Fonte **Inter**, acento **vermelho** (`#A61E22`; navy `#1B2A4A` é só trocar a variável), página **A4** (com CSS de impressão). Marca: selo "TS" + "Traders Service" + dados da empresa no cabeçalho.

Estrutura: título **"ORÇAMENTO Nº X"** + subtítulo (resumo curto do serviço) → metas (**Emissão · Validade · Prazo de execução**) → **Cliente** → **Escopo do serviço** (descrição livre **com bullets/markdown** + valor, exibido ao lado) → **Materiais** (tabela **com coluna Item**; material pode ser **"fornecimento pelo cliente"** → sem preço, exibido como "—" e **fora do subtotal**) → **Resumo financeiro** (Subtotal Serviços · Subtotal Materiais · **Total geral** em destaque) → **Condições comerciais** (Forma de pagamento · Vencimento) **ao lado** das **Observações** → rodapé (telefone · e-mail · site · página).
- Campos: **Prazo de execução** no topo. **Validade** só no topo (não repetir em Condições). **Observações** num bloco só. **Sem garantia.**

**Variantes (mesmo layout, seções condicionais — mostra só o que existe):**
- **Completo:** serviço + materiais.
- **Só serviço:** oculta a seção Materiais e o Subtotal · Materiais.
- **Só materiais:** oculta o Escopo do serviço e o Subtotal · Serviços.
- **Pré-orçamento:** sem valores nem condição de pagamento.
- No resumo, aparecem só os subtotais existentes; com um grupo só, vai direto ao **Total**. Orçamento exige **pelo menos um** (serviço ou material).

O PDF cru anterior (só tabelas) **não** é o alvo.

**Moeda (decisão atual):** orçamento **somente em R$** por enquanto.
*Futuro (já desenhado, é só plugar):* material poderá ter valor em **US$**, convertido por **PTAX venda** do último dia útil (busca na API pública do BCB/Olinda) + **spread %** opcional, com **PTAX + data + spread + taxa efetiva congelados ao aprovar**. No PDF, itens em US$ ganham uma marcação + nota citando a fonte (ex.: *"PTAX venda de 03/06/2026 · US$ 1,00 = R$ 5,40"*). Modelo previsto: material `moeda`·`valor_unit_origem`·`valor_unit_brl`; orçamento `cambio_ptax`·`cambio_data`·`cambio_spread`·`cambio_efetivo`.

**Removido do modelo do Omie** (não usar): "Local de Estoque", "Previsão de Faturamento", "Ordem de Serviço incluído em" e linha de **desconto**. PDF enxuto.

---

## 6. Status do orçamento

**Sem "rascunho".** Ao **salvar**, o orçamento já nasce **"Aguardando aprovação"**. O comercial marca Aprovado/Não aprovado quando o cliente responde.

| Status | O que acontece |
|--------|----------------|
| **Aguardando aprovação** | Estado inicial (ao salvar). Continua **editável/revisável**; pode gerar PDF e enviar ao cliente. |
| **Aprovado** | Gera a **OS/Tarefa** e **congela o orçado** (material e quantidades viram base imutável). Implementado via edge function `aprovar-orcamento`; **só gera Tarefa se o orçamento tiver serviço** (orçamento só-materiais não vira OS). A Tarefa gerada **nasce sem tipo de serviço** (o orçamento não carrega essa informação) — o Portal **exige o tipo ao salvar a Tarefa** (07/26, caso 04840). **Reabrir** um aprovado desfaz: a edge function `reabrir-orcamento` remove a Tarefa gerada. |
| **Não aprovado** | Sistema **avisa**; uma pessoa decide **excluir (arquivar) ou manter**. |
| **Arquivado** | Soft delete — some das listas ativas, mantém histórico. |
| **Sem retorno há 90 dias** | (orçamento ainda "Aguardando aprovação") Sistema **avisa** (nada automático); pessoa decide excluir (arquivar) ou manter. |

- **"Excluir" = arquivar (soft delete):** some das listas ativas, mantém o histórico (permite analisar orçamentos perdidos, taxa de aprovação, etc.). Nunca apaga de vez.
- Orçamento **não excluído** pode ser **revisado e reenviado** (nova versão do mesmo).

---

## 7. Tarefa (OS interna)

A **OS interna = a Tarefa**. É o nível "trabalho"; tem 1 ou várias RATs (uma por visita/dia).

**Origem (multi-origem, `orcamento_id` opcional):**
- do **orçamento aprovado**, ou
- criada pelo **administrativo**, ou
- criada pelo **técnico em campo**.

> Quando criada direto (sem orçamento), **não tem material "orçado"** — a conciliação começa só com levado/utilizado (suportado).

**Status inicial por quem cria:**
- **Admin cria** → *Aguardando execução* (ou com data agendada).
- **Técnico cria em campo** → já entra *Em execução*.

**Auto-promoção (implementada 10/06):** a Tarefa entra em **Em execução** automaticamente ao ganhar a **primeira RAT** — trigger no banco no insert da RAT + transição no cliente (cobre o caso offline).

### Status da OS — dois eixos

**Status durável:**
`Aguardando execução` (se houver data, a tela mostra "Agendada p/ DD/MM" — a data é um campo, não um status) · `Em execução` · `Em pausa` (interrompido **sem previsão** — ver abaixo) · `Concluída` · `Concluída com pendência` · `Devolvida` (admin retornou ao técnico) · `Aprovada p/ faturamento` (gerou OS no Omie "a Faturar") · `Faturada`. *(O mapa é configurável em `status_tarefa`; existe ainda `Em Espera (Produtos)`.)*

**Atividade atual do técnico** (só quando "Em execução", vem da RAT do dia):
`Trabalhando` · `Em pausa` · `Em almoço`.

Os dois eixos podem colorir o card. Pausa/almoço **do dia** são estados **momentâneos** da RAT, não se misturam com o ciclo de vida da OS.

**`Em pausa` — status durável (≠ pausa do dia)** *(implementado 19/06; migrações 0068/0069/0070).* Distingue **continuidade imediata** ("Em execução · Atendimento continua", volta amanhã) de **interrompido sem previsão** de retorno ("vou voltar depois pra terminar"). **Não confundir** com a pausa momentânea de almoço/café (eixo de atividade acima), que **não** muda o status durável.
- **Cor:** rosa `#D63384` (decisão de produto; **swap da migração 0073** — o teal `#0FA3A3` que a pausa usava passou pro `Em Espera (Produtos)`; pílula com contraste via `corTextoLegivel`).
- **Transições automáticas** (trigger `rat_inicia_tarefa` no banco, `INSERT`/`UPDATE` — cobre offline, acerta no sync):
  - RAT encerrada com **"Volta amanhã? = Não" + "vou voltar depois pra terminar"** → Tarefa **Em execução → Em pausa** (só dispara na RAT mais recente; nunca rebaixa status terminal/admin). O handoff **"o que falta / o que levar" segue obrigatório**.
  - **Nova RAT** numa Tarefa em pausa → **Em pausa → Em execução** (retomada; resolve o caso do técnico offline que abre RAT nova).
  - **"Volta amanhã? = Sim"** → permanece **Em execução** (sem mudança).
- **Campo "Pendência do atendimento"** na pausa do mesmo dia (`Houve pausa? = Sim`): texto **opcional** (campo de config do formulário) pra anotar o que ficou pendente; **não** flipa o status durável.
- **Fora do escopo (Parte B, futuro):** auto-encerramento da pausa na virada do dia (00:00).

### Regras de RAT dentro da OS
- **1 RAT por OS por dia** — não abre duas RATs pra mesma OS no mesmo dia. É na RAT do dia que se registra pausa, almoço, etc.
- O técnico pode ter **várias OS abertas no mesmo dia** (uma RAT por OS).
- **1 almoço por dia** — só uma RAT pode estar em "almoço" no dia (o almoço é do dia do técnico, descontado uma única vez do tempo, mesmo rodando várias OS). Pausa não tem esse limite.

→ Restrições no banco: RAT única por `(tarefa, dia)`; almoço único por `(técnico, dia)`; sequência da RAT única por `(tarefa, sequência)` — numeração definitiva atribuída pelo servidor (já implementado).

### Home do técnico — agenda do dia + fila

A tela inicial do app é a **agenda do dia**:
- **Minhas tarefas de hoje** — as que o escritório agendou e marcou o técnico como responsável.
- **Fila (tarefas abertas)** — quando ele **não tem tarefa atribuída**, vê as tarefas abertas e pode **pegar uma da fila** (vira responsável / abre a RAT do dia).
Cada item mostra o estado (aguardando · em execução · atendimento continua) e leva direto pra "RAT de hoje".

**Notificações push ao técnico (campo).** O técnico trabalha com o app fechado e não sabe quando entra serviço pra ele — por isso o portal o avisa por push (Web Push via `notify-push`). Dois gatilhos, disparados pelo portal no momento em que o admin salva a Tarefa, **endereçados só aos técnicos atribuídos** (responsável + co-responsáveis):

- **Atribuição → "Nova tarefa atribuída"** · corpo `Cliente · Data · Orientação` (orientação truncada se longa). Dispara quando um técnico **passa a ser atribuído** à Tarefa — na criação **ou** numa edição posterior (reatribuição). **Anti-spam:** só os técnicos **recém-atribuídos** recebem (diferença de conjunto); re-salvar com os mesmos técnicos não notifica. Tarefa que entra na **fila sem responsável não dispara** — só quando vira de alguém.
- **Reagendamento → "Tarefa reagendada"** · corpo `Cliente · nova data`. Dispara quando um técnico **que já estava atribuído** continua atribuído **e a `data_agendada` muda**. **Anti-spam:** **só a mudança de data** dispara; mudar orientação, pedido de compra, status ou qualquer outro campo **não** notifica.
- Os dois conjuntos (recém-atribuídos × já-eram) são **disjuntos** → ninguém recebe dois pushes no mesmo save. O push **não** chega ao usuário que disparou (o próprio admin). Fuso da data em `America/Sao_Paulo`, formatado das partes da string (sem `new Date`, evita o erro F1/UTC). Tocar o push **abre o app** (deep-link pra Tarefa específica fica pra depois).

### Criação de Tarefa em campo (emergencial)

Tanto o escritório quanto o **técnico em campo** podem criar Tarefa (serviço corretivo que surge na hora). No app: cliente (lista cacheada) + título/descrição + local opcional; nasce com `client_uuid`, **origem "Avulso/Sem orçamento"**, e o servidor atribui o número oficial no sync. Funciona offline. Duas criações da "mesma" tarefa por engano viram duas Tarefas → **admin junta depois** (não dá pra deduplicar automático; é raro).

### Tarefa de múltiplos dias (atividade contínua em campo)

Atividade que leva vários dias (ex.: serviço de ~10 dias). Trata-se com o modelo de dois níveis que **já existe** — nenhum conceito novo:

- **Uma Tarefa = o serviço inteiro** (guarda-chuva); **uma RAT por dia trabalhado** (filha), numeradas 04750/1 … 04750/N. Cada RAT diária é o **diário do dia**: trabalho feito, tempo por técnico, material usado, fotos.
- **O dia fecha, a Tarefa não.** Concluir a RAT do dia fecha **o dia**; a Tarefa permanece "Em execução" até o último dia (dois eixos de status). A Tarefa só é concluída de propósito, no encerramento (com/sem pendência) — o técnico nunca encerra o serviço sem querer ao fechar o atendimento do dia.
- **Encerrar a RAT ≠ concluir o serviço — níveis diferentes, nunca no mesmo botão.** Encerrar é **da RAT** (rotina diária); concluir é **da Tarefa** (deliberado, uma vez). Separar evita encerrar um serviço de vários dias sem querer.
- **Encerrar a RAT (na RAT):** o modal **aparece automaticamente** ao encerrar a **última atividade cronológica do dia** — fim da execução, ou fim do deslocamento de volta se houver (não é um passo manual avulso). Fecha a RAT → "registrado ✓" — **rótulo na tela: "Atendimento Realizado"** (renomeado em 06/26; antes "Registrada", que os técnicos achavam que indicava algo faltando. **Só o texto mudou**: o valor interno segue `registrado` e nenhuma lógica compara o rótulo). A Tarefa fica **automaticamente "Atendimento continua"**. Em pernoite não há volta no dia → fecha no fim da execução (a volta é o artefato Deslocamento separado).
- **Trocar de tarefa no meio do dia (A inacabada → B):** o técnico **pausa a execução de A** (cronômetro dele em A para; a RAT-A fica "Em execução · pausada", **não** encerrada) e **abre/retoma B** (cronômetro em B começa). Pode alternar quantas vezes precisar e manter **várias RATs em andamento no dia** (uma por tarefa). Volta pra A → retoma (novo trecho). Encerra a RAT-A só ao terminar A no dia; se sair sem encerrar, o app **varre no fim do dia** ("RAT 04750/A ainda aberta — encerrar?"). Usa os timers reabríveis que já existem.
- **Participação como TRECHOS (não par único):** pra o vai-e-volta entre tarefas computar certo (sem dobrar horas), a participação de cada técnico é uma **lista de trechos** (artefato · início · fim) — pausar/trocar fecha um trecho, retomar abre outro. Horas do técnico = Σ trechos − almoço único. É a **jornada contínua (§10.1) surgindo incrementalmente**. *(Ajusta o modelo do pacote §8: participação vira tabela-filha de trechos, não duas colunas inicio/fim.)*
- **Concluir o serviço (na Tarefa):** ação **deliberada e separada**, no nível da Tarefa (com/sem pendência), feita uma vez quando o trabalho realmente termina (pelo técnico em campo ou pelo admin); dispara o **documento consolidado**. **"Concluída" fica reservada ao serviço** — o dia nunca exibe "concluída". Botões na Tarefa: "RAT de hoje" (primário) e "Concluir serviço" (secundário). Referência visual: `docs/mockups/mockup-tarefa-multidia-app.html`.
- **Continuidade é da Tarefa, não da RAT.** Não se reabre a RAT do dia anterior: ao voltar (qualquer dia futuro, mesmo sem data definida), abre-se a Tarefa "Atendimento continua" e toca-se **"RAT de hoje"** → nova RAT filha. Cada dia é registro imutável (tempo e material corretos por dia).
- **"RAT de hoje":** na Tarefa em execução, um botão cria a RAT do dia **pré-preenchida** (cliente, equipe, local herdados do dia anterior); o técnico só registra o que muda. Mantém a regra 1 RAT por `(tarefa, dia)`.
- **Material e tempo somam no nível da Tarefa** (conciliação e horas por técnico já são agregadas) — material levado uma vez cobre os dias; liga com a Remessa/Container (§9).
- **Lacunas (fim de semana / dias sem ir):** simplesmente não há RAT; a sequência pula.

**Previsão e andamento:** a Tarefa ganha **previsão** (dias previstos OU data prevista de término) — opcional. O portal mostra o **andamento** ("dia 4 de ~10", barra de progresso); se passar do previsto, **sinaliza sem bloquear**. Ajuda a acompanhar serviços longos.

**Entregável = consolidado no encerramento (cliente NÃO assina RAT diária).** A RAT diária é registro **interno** de progresso — sem PDF nem assinatura por dia. No encerramento da Tarefa, o sistema gera **um documento consolidado no nível da Tarefa** (período de X a Y · resumo de cada dia · material conciliado total · horas · fotos de todos os dias) — é o que vai pro cliente (edge function de documentos).

### App do técnico (celular) — navegação e telas

> Referência visual: mockups `mockup-home-tecnico.html` e `mockup-os-para-hoje.html`. Estilo Bold (navy `#1B2A4A`).

**Home — hub de áreas** (cada card é só **navegação**; o "criar" mora **dentro** de cada área, **não** embutido no card):
- **OS para hoje** — abre a lista **só das OS de hoje**.
- **OS Pendentes** — as OS **devolvidas pelo administrativo** pra corrigir (status `Devolvida`). Card com destaque/contagem.
- **Agenda** — **tudo**: calendário com navegação por dia/mês e **todas** as OS do colaborador.
- **Pré Orçamento** — lista dos pré-orçamentos do técnico.
- **Deslocamento** — registro de viagens/pernoite do técnico (artefato à parte — ver §4.1).

Abaixo do hub, a **Agenda de hoje**: lista das OS do dia com **cores por status/atividade** + progresso do dia.

**Painel de sincronização (destaque no topo):** mostra o **estado real** — quantos itens **na fila**, **último envio confirmado**, **erros**. Só marca "sincronizado" quando o **servidor confirma** (não basta "salvei"). É o nosso diferencial sobre o Auvo.

**Sem valores (R$) em nenhuma tela do técnico** (ver regra de dados em §12).

**OS para hoje** (tela): só as OS de hoje (sem calendário — calendário é da Agenda), filtros por status com contagem, + Nova OS, Sincronizar, progresso e a lista (hora · status · nº da OS). **Sem marcador de prioridade e sem marcador de "N pendências".**

**Agenda** (tela separada): calendário (semana/mês), pontos nos dias que têm OS, e a lista filtrável — mostra **todas** as OS, não só hoje.

**Cores por status (sistema visual):**
`Aguardando execução` (cinza) · `Em execução` (azul) · `Em pausa` (**rosa** `#D63384`) · `Em almoço` (azul — atividade do dia) · `Concluída` (verde) · `Concluída c/ pendência` (vermelho) · `Em Espera (Produtos)` (teal). *(As cores moram em `status_tarefa`, configuráveis em Configurações — valores atuais; o swap pausa→rosa veio da migração 0073.)*

### Tela de detalhe da Tarefa (back-office / admin)

Referência visual: `docs/mockups/mockup-admin-tarefa-completa.html`. É o **hub da tarefa** pro admin/gestor — só apresentação e organização; os dados/abas/regras não mudam.

- **Cabeçalho rico:** nome do cliente, subtítulo (tipo), `Tarefa Nº` com copiar, **status geral**, data agendada, **responsável principal** (avatar), e ações **Exportar (PDF)** + menu.
- **Faixa "Situação da tarefa"** — radar de 6 mini-status que mostra a saúde inteira num relance, com cor: **Dados** (Preenchido) · **RATs** · **Produtos** (ex.: "95 m a devolver") · **Fora da proposta** (nº de itens) · **Faturamento** · **Anexos**. Verde = ok · âmbar = pendência · vermelho = fora da proposta.
- **Abas com indicador:** ✓ no que está ok e **contador** no que pede atenção (ex.: Produtos ② · Faturamento ①). Abas: Dados · RATs · **Deslocamento** · Produtos · Equipamentos · Faturamento · Anexos · **Histórico**.
  - **Aba "Deslocamento" (06/26):** lista as viagens/deslocamentos vinculados à tarefa e abre o **editor** (`deslocamentos.html?editar=`) — o admin revisa ali mesmo (inclusive marcar **"Revisado"** por um checkbox no rodapé do editor, com carimbo de quem/quando).
- **Resumo operacional** (coluna lateral) — apoio à decisão, tudo de dado real: **Horas registradas** (Σ das RATs) · **Valor utilizado** (conciliação) · **A devolver** · **Itens fora da proposta**.
- **Próxima ação recomendada** — motor de regras simples sobre os gates de faturamento:
  - RAT não confirmada → "aguardar sincronização";
  - `a devolver > 0` **ou** item fora da proposta → "conferir devolução de materiais antes do faturamento";
  - tudo ok e não faturado → "liberar faturamento";
  - já faturado → sem ação.
- **Linha do tempo da tarefa** — trilha de eventos (criada → responsáveis → RAT → produtos → pendência → concluída). É a leitura da **trilha de auditoria (`sync_eventos`, §12)**, não um dado novo.
- "Dados da tarefa" no radar usa **"Preenchido"** (não "Concluído" — dados não concluem).
- **Tipo de tarefa é obrigatório ao salvar (07/26):** o formulário da RAT deriva do tipo de serviço — tarefa sem tipo abre no app do técnico **sem campos** ("peça ao administrativo") e trava o atendimento (caso 04840). O modal Dados **bloqueia salvar/criar sem tipo**; tarefa nascida de orçamento aprovado chega sem tipo e é o Portal quem completa. Os fluxos de pendência e o app do técnico já exigiam o tipo.
- Em tela menor, as duas colunas, a faixa de situação e a timeline **empilham**.
- **Abrir em nova aba (06/26):** nas listas e calendários do portal (Tarefas, RATs, Deslocamentos) dá pra abrir um item em **nova aba** — ícone dedicado e **Ctrl/Cmd-clique** no chip/linha (os chips viraram links nativos). O **título do top bar** no detalhe mostra **`Tarefa Nº NNNNN`** (não só "Tarefa").
- **Ordenação por cabeçalho (06/26):** clicar no cabeçalho de qualquer coluna ordena a tabela (em todas as listas do portal).
- **Visual do detalhe da RAT (07/26):** só aparência, mesma estrutura/dados/fluxos — CSS compartilhado `css/rat-detalhe.css` (aba RATs da Tarefa + rat.html). Cabeçalho com **nº da RAT em destaque** (data · técnico · duração na mesma linha + badge de status); campos com **ícones SVG em chips**; "RAT — dados do atendimento" em cartão único com divisórias; **Orientação e Serviço executado com bullets** (linha iniciada por `-`/`*` vira lista, `*` aninhado sob `-`); **"Fotos (n)"** com miniaturas 148px uniformes. **Cores = famílias semânticas oficiais do `css/tokens.css`, usadas direto** (sem hex local, sem color-mix). Regra: **a cor identifica a SEÇÃO** (fundo suave `--sr-*-bg` + filete lateral 4px `--sr-*-m` + título/ícone/rótulo `--sr-*-fg`); **valores e conteúdos ficam sempre em `--sr-ink`**, nunca coloridos por inteiro. Mapa: cabeçalho da RAT e OS/Orientação/Fotos/total de produtos na família **info**; **Passagem** e conflito na família **pend** (é pendência — filete vermelho, nunca âmbar/bege, card branco); dados do atendimento na família **exec**; pausas na família **warn** (faixa compacta na largura da seção, conteúdo em `--sr-on-warn`); **Serviço executado** na família **jrny**; Observações neutra (caixa branca, filete `--sr-aguard-m`); corpo da tabela de produtos neutro; badges de status com as famílias completas; ações do card por papel (Editar azul primário, PDF azul secundário, Nova tarefa da pendência em pend). *(Pegadinha registrada: "asterisco-barra" dentro de comentário CSS fecha o comentário no meio e derruba a regra seguinte.)*

### PDF da Tarefa — "Gerar PDF" vetorial (07/26)

O documento da Tarefa (capa + todas as RATs) é gerado **no navegador, 100% vetorial**, via **pdfmake vendorizado** (`js/vendor/`, sem CDN — precacheado pelo SW, funciona **offline**; só as fotos exigem rede). Texto selecionável/pesquisável, fonte **Roboto embutida** (subset, PT-BR completo), download direto — sem aba nova nem diálogo de impressão. Módulo `js/pdf-tarefa.js`; a tela monta o modelo (`montarModeloPdf` em `tarefa.js`).

- **UI:** botão azul único **"Gerar PDF"** + dropdown com **"PDF para o cliente"** e **"PDF interno"** (descrição em cada opção). Enquanto gera: "Gerando PDF…" + botão desabilitado. Erro → toast *"Não foi possível gerar o PDF. Tente novamente."*. Menu fecha em Esc/clique-fora. Arquivo: `Tarefa_NNNNN_Cliente.pdf` / `Tarefa_NNNNN_Interno.pdf`.
- **Perfis:** *Cliente* = sem valores, sem conciliação, sem campos internos (modalidade/faturamento/observações internas/pendências/obs. conciliação) **nem informação operacional da RAT** — a seção "Passagem — volta depois pra terminar" (o que falta/levar) e o campo **"Observações" da RAT** ficam só no Interno (07/26, caso 04753). *Interno* = tudo. Overrides finos pela URL (`?valores=1/0`, `?conciliacao=1/0`, `?zerados=1/0`); Cliente com valores ganha selo "versão com valores" no rodapé.
- **Produtos por RAT = só o utilizado (qtd>0) nos DOIS perfis (07/26):** item zerado (lançado e não usado) mora na **conciliação geral** — não se repete por RAT com R$ 0,00; RAT sem item utilizado fica sem a tabela. `?zerados=1` força mostrar tudo (debug).
- **Orientação repetida (07/26):** quando a orientação da RAT é idêntica à orientação geral da tarefa (que já está na capa), a RAT mostra só *"Conforme orientação geral da tarefa."*; o texto completo aparece quando difere — e sempre na RAT avulsa (sem capa).
- **Badge de status (capa):** deriva do **flag real `tarefas.faturado`**, não do rótulo do status. Cliente: tarefa encerrada → sempre **FINALIZADA** (faturamento é informação interna). Interno: **FATURADA/FINALIZADA** só com `faturado=true`; encerrada sem faturar → **FINALIZADA**. Demais status seguem rótulo/cor de `status_tarefa`.
- **Layout (aprovado na PoC da Tarefa 04826):** cabeçalho em faixa navy com nº da Tarefa em todas as páginas; capa (hero + dados + cards de resumo + RATs resumo + conciliação/equipamentos/anexos no interno) fluindo direto pra 1ª RAT; cada RAT com faixa própria (nº, técnico, badge, tempo); seções com barra azul; tabelas zebradas; "Serviço Executado" em caixa; seções de **visita improdutiva** e **passagem** quando existirem; assinatura ao fim.
- **Quebras de página (07/26, caso 04753):** nenhum título/rótulo/valor fica órfão — cada **par rótulo+valor** é indivisível; título de seção preso à 1ª linha do conteúdo; **faixa da RAT + "Dados da OS"** descem juntas quando não cabem; "RAT — dados do atendimento", "Pausas e almoço", "Passagem" e "Visita improdutiva" são blocos inteiros; texto longo (Serviço Executado) move com o título. **Tabelas longas** (conciliação e produtos por RAT) continuam em página nova com **título "… — continuação" + cabeçalho de colunas repetido** — mecânica de medição real de layout (2 passes com imagem 1×1; o pdfmake não chama `pageBreakBefore` pra nó com `pageBreak` explícito, e células de cabeçalho precisam ser objetos novos por tabela).
- **Fotos:** grade adaptável à quantidade (1→1 col grande, 2→2, 3→3, **4→2×2**, 5+→3 colunas), moldura fina + legenda **só abaixo** da imagem; título "Fotos" indivisível com a 1ª linha; página nova ganha **"Fotos — continuação"** (nunca imagem sem indicação de seção; o título de continuação só aparece em mudança REAL de página).
- **Canvas só para imagem** (regra dura): fotos/anexos são cortados em 4:3 e reduzidos a **1600px JPEG q0.85** (assinatura 700px, proporção mantida), **uma imagem por vez** (memória controlada). O relatório em si **nunca é rasterizado**.
- **Escopo:** todos os documentos de atendimento saem deste motor (07/26): documento da **Tarefa** (capa + RATs), **RAT avulsa** (modal da Tarefa e rat.html — header "RAT Nº NNNNN/SS", cliente na faixa da RAT, arquivo `RAT_NNNNN_SS.pdf`) e **"PDF unificado"** da aba RATs (header "Tarefa Nº NNNNN · RATs", arquivo `Tarefa_NNNNN_RATs.pdf`). Nos documentos sem capa, o cliente aparece na faixa de cada RAT. O gerador HTML antigo (`RatView.gerarPdf`) foi removido; o PDF de orçamento/pré-orçamento tem gerador próprio (§5) e é candidato futuro ao mesmo motor.

**Visões de RAT e Deslocamento no portal (06/26).** Além da aba dentro da Tarefa, o portal tem páginas próprias:
- **RATs** — alterna **Calendário** (visão mensal, agrupa pela **data da RAT**) e **Lista** (busca no banco inteiro). Filtros: cliente (combobox), técnicos (multi, mostra co-responsáveis), busca livre. O chip mostra o **Nº da RAT** `{tarefa}/{seq}`. Atalho direto pra aba RATs da Tarefa.
- **Deslocamentos** — **Calendário** com **1 chip por TRECHO** no dia do trecho (origem→destino; a **base** Joinville aparece como "Traders"); clicar na linha/chip abre o **detalhe (leitura)** ou o editor. Conferência: alerta de **"deslocamento de ida sem volta"** no dia.

---

## 8. RAT (Relatório de Atendimento Técnico)

Cada RAT = uma visita/dia dentro de uma Tarefa. Offline-first.

- **Cabeçalho (nível Tarefa):** cliente, OS, tipo de tarefa, orientação/serviço solicitado.
- **Corpo (nível RAT, preenchido pelo técnico):** deslocamento (Sim/Não + horários — "Não" esconde os campos de deslocamento) · início/fim · **almoço/pausa** (checkbox → início/fim) · serviço executado · observações · fotos (múltiplas, com legenda) · **materiais utilizados** · tempo trabalhado (calculado).
- **Numeração:** `numero_rat` **sequencial atribuído pelo servidor** (nunca pelo dispositivo — evita colisão offline/multi-dispositivo).
- **Salvar rascunho** a qualquer momento (sem validação; status interno `em_andamento`).
- **Encerrar a RAT do dia** → status `registrado` (**rótulo "Atendimento Realizado"**) **exige os campos obrigatórios preenchidos**. Encerrar fecha o **dia**, **não** conclui o serviço — "Concluída"/"Concluída c/ pendência" são ação **da Tarefa** (§7 e §8 "Duas pendências distintas"). `concluida*` em RAT é só **dado histórico**.
- **Modal guiado ao encerrar (06/26):** ao encerrar a RAT do dia, o app pergunta o desfecho num modal acionável: **"Vou voltar depois"** → Tarefa vai a **Em pausa** + registra a passagem (o que falta/levar); **"Terminei o serviço"** → modal com botão **"Concluir a Tarefa agora"** (Concluída / c/ pendência), sem o técnico navegar até a Tarefa; **"Volta amanhã? Sim"** segue **sem modal**. Encerrar a RAT ≠ concluir o serviço (§8) — o modal só **guia** ao desfecho certo.
- **Sem PDF/e-mail por dia:** a RAT diária é registro **interno** (§7, linha do "entregável consolidado"); o documento ao cliente sai no nível da Tarefa. *(O e-mail da RAT pro adm@tsrv está previsto em §12, mas ainda pendente — §13.)*
- Campos do formulário são **configuráveis** (modelos por tipo de serviço).
- **Numeração exibida** com separador `/`: ex. `#04744/01` (tarefa/sequência da RAT).

### 8.1 Formulário da RAT no app do técnico — layout atual (10–11/06)

Referência visual: `docs/mockups/mockup-nova-rat-topo.html`. Reorganização completa do formulário:

- **Topo:** card de **contexto** (cliente/tarefa) + **grid 2×2 de registros** em cards coloridos (estilo dos tiles da home): **Deslocamento** · **Pausa/Almoço** · **Produtos** · **Fotos**. Cada card abre um **modal** com identidade de cor (header colorido, botão **Concluir** na cor do card) e mostra badge de estado (**Pendente** / valor preenchido com ✓).
- **Deslocamento (do dia):** **IDA e RETORNO são dois toggles Sim/Não independentes** — ida=Sim revela início/fim da ida; retorno=Sim revela início/fim do retorno; **ambos=Não é estado válido** (técnico já estava no local, ou o trecho foi registrado em outra tarefa). Horários por **carimbo de hora** (Iniciar/Encerrar, igual ao timer da RAT — o técnico não digita; editável se precisar). **Faturamento:** o tempo de deslocamento (**ida + retorno que existiram**) **soma ao tempo da atividade da tarefa** (`tempo = execução + ida + retorno − almoço − pausa`); cada RAT cobra só os trechos que registrou. (Pernoite é à parte — §4.1.)
- **Pausa/Almoço:** num modal só — "Houve almoço?" e pausa com motivo/horários, ambos com botões **Sim/Não**.
- **Produtos:** pergunta Sim/Não + **steppers** de quantidade; catálogo de produtos mora aqui (autocomplete paginado — o catálogo tem ~1.715 itens, acima do teto de 1.000/req do Supabase). No fechamento, **Utilizada = teto da soma** das RATs na conciliação.
- **Botões Sim/Não semânticos:** Sim verde, Não vermelho, preenchidos ao selecionar.
- **Pares lado a lado** (grid `1fr 1fr`): Data + Veículo · Hora início + término. Veículo é seletor inline com opção **"Sem veículo"**. Botão de GPS manual foi removido.
- **Data automática pra RAT VAZIA reaberta em dia posterior (07/26, SW v637 — trava tripla):** RAT `em_andamento` de dia anterior ganha **Data = hoje AUTOMATICAMENTE** (sem pergunta — popup viraria ritual) no **primeiro gesto de trabalho** do dia, coerente com a âncora do GPS v635. Travas: **(1) "vazia" = ausência PROVADA** — nenhum campo de trabalho respondido (inclusive "Não"), sem foto/assinatura/material, e **nenhum `respostas_ts` fora do bootstrap** (data/técnicos/veículo) — o carimbo por campo (0096) é o juiz; **(2)** dispara no primeiro input/change de campo ≠ 'data' (mexer na Data = decisão explícita do técnico, vence), nunca na abertura; **(3)** transparência: toast ("Data ajustada para hoje — DD/MM") + evento na **trilha imutável `sync_eventos`** (`data ajustada automaticamente: X → Y`; não conta como reedição na régua). **Borda tarefa+dia**: já existindo RAT da tarefa com Data = hoje (checagem local + servidor quando online), NÃO ajusta e avisa — colisão é decisão humana. **Caso-lição (4851, 14/07):** a RAT que motivou a feature foi corretamente **REJEITADA** pelo juiz — tinha almoço apontado no dia e `respostas_ts` com toque em hora_inicio; ajustar moveria o almoço real pro dia errado. É o **teste negativo real** da trava 1 (harness com o payload dela: PASS); o positivo será a próxima RAT genuinamente vazia, verificável pelo evento na trilha. Orientação enquanto o caso existir: "abriu sem trabalhar? ajusta a Data antes de preencher".
- **Local (GPS) da RAT = INÍCIO DA EXECUÇÃO (07/26, SW v635):** o carimbo (`checkin_lat/lng/precisao/em`) é capturado quando `hora_inicio` ganha valor — pelo botão "Iniciar atendimento" ou digitada — e a **primeira captura vence** (nunca sobrescreve). Abrir o formulário NÃO carimba mais (antes marcava o local da abertura, não do serviço). Falhou (sem permissão/sinal)? Campo fica vazio — opcional, offline-first intacto. Exibição: mini-mapa satélite no card Local (GPS) do portal (tiles Esri + pino, clique abre o Google Maps) e no **PDF interno** dentro do campo (nunca no PDF do cliente). **Nota de treinamento da gestão (leitura do pino):** (1) a semântica honesta é **"onde o técnico estava ao REGISTRAR o início da execução"** — coincide com o local do serviço quando o preenchimento é em tempo real; **pino divergente** (ex.: residência com início declarado em cliente) é **SINAL de preenchimento tardio**, cruzável com o carimbo local `respostas_ts` (0096) — instrumento de auditoria, não bug; (2) **data de corte das duas semânticas:** pinos de RATs **pré-v635 (14/07)** = local da **abertura do formulário**; **pós-v635** = local do **registro do início da execução**. Tooltip distintivo no pino antigo fica como melhoria opcional futura.
- **Técnicos responsáveis:** modal **fullscreen** (escala para 15–20 técnicos), cards no padrão do admin + botão "+ Adicionar técnico".
- **Timers reabríveis (10/06):** todos os pares de horário (atendimento, almoço, pausa, ida, retorno) usam o mesmo sistema de timer — inicia/encerra e **pode reabrir** um par já fechado.
- **Serviço executado / Pendências / Observações:** caixas maiores, placeholder orientativo e **bullets `-` automáticos** ao digitar.
- **Indicador de progresso para concluir:** mostra o que falta (campos obrigatórios + produtos + foto) antes de liberar o Concluir.
- **Anti-RAT-órfã:** rascunho recém-aberto **sem trabalho real é descartado** ao sair (não fica lixo local).
- **Sem ditado por voz** (removido — travava o app no iOS/PWA).

### Duas "pendências" distintas (não confundir)

> **Correção (Commit 2 do fluxo do técnico, §211-218):** "Concluída com pendência" **não é mais status da RAT**. Encerrar a RAT fecha o **dia** → `registrado`; concluir o serviço **com ou sem pendência** é ação **deliberada na Tarefa** (botões "RAT de hoje" / "Concluir serviço"). A RAT nunca conclui o serviço. O texto abaixo foi ajustado.

1. **`Concluída com pendência`** — **status da TAREFA, definido pelo técnico (ou admin)** ao **concluir o serviço** na Tarefa. O trabalho terminou, sobrou um **detalhe pequeno**. **NÃO bloqueia** faturamento nem fechamento da OS — o admin segue aprovando normal. Ao concluir com pendência, o técnico pode **gerar uma "tarefa de retorno"** (nova Tarefa, sem responsável, com a pendência na orientação) pra resolver o detalhe depois.
   > **Atualização (F1 — PR #104, 07/26):** a geração da tarefa da pendência no portal usa a **RPC atômica `gerar_tarefa_de_pendencia`** (tudo-ou-nada, idempotente pela chave da operação — retry/duplo-clique devolvem a tarefa já criada; segunda continuação legítima não é bloqueada; mesma chave com payload diferente ⇒ `IDEMPOTENCIA_CONFLITO`). A nova tarefa **nasce vinculada** (`origem_tipo='continuacao_planejada'` + FK pra tarefa **e pra RAT** da pendência) e a original vira `concluida` **preservando o texto de `pendencias`** (antes era zerado — o rastro agora fica na auditoria imutável, evento `pendencia_gerou_tarefa`).
2. **OS Pendentes / `Devolvida`** — **estado da OS, definido pelo administrativo** na revisão. O admin **devolveu** a OS pro técnico **corrigir** (ex.: descrição errada do serviço executado, material inconsistente com o fechamento). A OS volta **editável** e **precisa ser corrigida** antes de seguir. O card "OS Pendentes" da home lista justamente essas.

São **eixos diferentes** e podem coexistir (uma Tarefa "concluída c/ pendência" ainda pode ser devolvida pelo admin se houver erro de dado).

### Origem do atendimento (F1 — fundação da frente Produção & Qualidade, PR #104)

Toda tarefa carrega a **origem presumida** — `tarefas.origem_tipo` + `tarefa_origem_id` + `rat_origem_id` (migração 0111). **Vocabulário oficial** (fonte única `js/utils.js` — `ORIGEM_TIPOS`/`ORIGEM_LABEL`, mesmo padrão das devoluções): `nova_solicitacao` (default) · `continuacao_planejada` · `retorno_relacionado` · `suspeita_retrabalho`.

- **Validação central no banco** (`tarefas_origem_valida`, dispara em insert e em update de origem/vínculos **e de `cliente_id`**): origem ≠ nova exige tarefa de origem · sem autorreferência · **origem do MESMO cliente** (`ORIGEM_CLIENTE_DIVERGENTE`) · RAT de origem pertence à tarefa de origem · sem ciclo na cadeia · **alteração posterior exige justificativa** (só via RPC `alterar_origem_tarefa`, mín. 5 caracteres).
- **Auditoria imutável** — `tarefa_origem_eventos` (sem FK: o histórico sobrevive à exclusão da tarefa e não bloqueia o delete; FKs de origem são `on delete set null` com evento automático justificado). Eventos: `origem_definida` · `origem_alterada` · `pendencia_gerou_tarefa` · `backfill`. Update/delete de evento é rejeitado para qualquer papel.
- **Portal:** bloco "Origem do atendimento" na aba Dados — seletor na criação (busca da tarefa de origem pré-filtrada pelo cliente; RAT opcional; trocar/apagar o cliente limpa a escolha e o save revalida), linha de leitura com **links** (tarefa de origem e evidência da RAT em nova aba) + resumo da auditoria + "Alterar origem" com justificativa. Campo **"Local do atendimento"** (`local_servico`) na mesma aba; origem relacionada mostra o nudge de vincular equipamento/local (habilita reincidência por ativo).
- **App do técnico:** não muda nesta fase — tarefa de campo nasce `nova_solicitacao` (decisão: o RLS só mostra ao técnico as próprias tarefas, um seletor não teria o que listar). O sync publicado segue compatível (`criar_tarefa_app` recriada com os 3 parâmetros novos com default; a versão real de produção tinha 8 parâmetros com `p_local` — drift do arquivo 0043 documentado na 0111).
- **Backfill (migração 0112):** os **7 casos determinísticos** de tarefa gerada de pendência (4777→4762 · 4826→4792 · 4830→4794 · 4835→4817 · 4843→4837 · 4858→4793 · 4860→4828) vinculados como continuação planejada via `backfill_origem_pendencias()` — precondições rígidas (texto real confirma o par, mesmo cliente), idempotente, auditado com eventos `backfill`; `rat_origem_id` fica nulo (não determinístico). Os demais candidatos do levantamento passam por validação manual da gestão (F0), nunca automática.
- **Guarda de escopo:** a origem é só fundação — **não alimenta** nota, ranking, classificação de retrabalho nem o motor de desempenho (esses são fases futuras, F2+, com aprovação própria).

#### Referência externa na origem (F1.1 — migração 0113, PR #105)

Origem relacionada pode apontar para atendimento **fora do SR** (sistema anterior — caso real: 04748, "Tarefa Auvo 7534999/4"): `tarefas.origem_ref_externa` (texto livre curto, ex.: `Auvo 7534999/4`; trim normalizado no trigger; máx. 120 — `ORIGEM_REF_LONGA`).

- **Regra:** tipos relacionados exigem **tarefa do SR OU referência externa** — **mutuamente exclusivas** (`ORIGEM_REF_COM_VINCULO` se vierem as duas; a ref é para quando **não há** tarefa no SR). `nova_solicitacao` não aceita nenhuma (`ORIGEM_INCONSISTENTE`). Mudar a ref exige justificativa e é auditado (`ref_externa_old/new` em `tarefa_origem_eventos`).
- **Portal:** na criação e no modal Alterar origem, escolha explícita **"Tarefa anterior no Service Report" × "Atendimento anterior fora do Service Report"**; trocar de modo limpa os campos do modo incompatível; trocar o cliente (modo nova) limpa tarefa, RAT **e** referência; voltar a Nova solicitação zera tudo (inclusive no modal — o modo volta a SR). Leitura: `ref. externa: <valor>` como **texto seguro** (`esc()`), sem link. No modal, a RAT atual vem **pré-selecionada** e respostas assíncronas fora de ordem são descartadas (guarda por tarefa escolhida).
- **RPC:** `alterar_origem_tarefa` ganhou `p_ref_externa` (default null — chamadas antigas seguem válidas); `criar_tarefa_app` não muda. A ref externa **não** habilita reincidência por ativo (isso continua exigindo equipamento/local); é rastreabilidade documental do legado.

#### Motivo estruturado da devolução (Fase A — no ar)

Ao devolver, o admin escolhe **motivo(s)** de uma lista fechada (não texto livre) — o técnico vê exatamente o que corrigir. Dois níveis:
- **Por Tarefa:** Material divergente do que foi orçado/levado · RAT não preenchida · Outro (detalhe obrigatório).
- **Por RAT:** Preenchimento incompleto · Produto incorreto · Pausa/horário incorreto · Descrição insuficiente · Pendência não registrada · Outro (detalhe obrigatório).

*Interim:* os motivos de RAT convivem no mesmo modal da devolução de Tarefa até a **Fase B** trazer a devolução por-RAT de verdade (aí os 5 granulares migram pro nível da RAT).

- **Dados:** `tarefas.motivo_devolucao_cats text[]` (códigos) + `motivo_devolucao_detalhe` (o "Outro") + `motivo_devolucao` (texto renderizado, **retrocompatível** com registros anteriores à Fase A, usado como fallback). Vocabulário oficial em **fonte única** no `js/utils.js` (`DEVOLUCAO_MOTIVOS` / `MOTIVO_LABEL`), lido por portal e app; ambos exibem os motivos como **chips** na ordem gravada + o detalhe.
- **Editar × Devolver (critério do admin):** se o admin **sabe** a informação correta → **edita** ele mesmo (auditado, via `rat_edicoes`); só **devolve** quando **apenas o técnico** sabe/pode corrigir. Devolver não é pra consertar o que o admin já tem em mãos.

#### Tarefa devolvida no app do técnico: dois caminhos + regra de destravamento (15/07 — no ar)

Ao tocar **"Iniciar RAT desta tarefa"** numa tarefa `Devolvida`, o app abre um **seletor** (`#modal-devol-escolha`) com o **motivo da devolução visível** (chips da Fase A + detalhe, que orientam a escolha) e duas ações:
- **Corrigir a RAT devolvida** (com a data da RAT) — reabre a última RAT registrada, hidratando material+fotos do servidor (fluxo que já existia como caminho único).
- **Nova RAT de hoje** — registra um novo dia de trabalho (caso real que motivou: 04790, devolvida com "Incluir RAT do dia 02" — a RAT nova nasce com Data=hoje e o técnico ajusta a data no formulário). Se já existe RAT de hoje, a opção vira "Abrir a RAT de hoje" (1 RAT por tarefa/dia); se a RAT devolvida **é** a de hoje, não há escolha (mesmo registro).

**Regra de destravamento:** criar/registrar **RAT nova NÃO encerra a devolução**. `Devolvida` só sai quando a **RAT devolvida** (RAT criada **antes** de `devolvida_em`) for corrigida e reenviada (`sync.js`, guarda `corrigeDevolucao`) — ou quando a gestão resolver no portal. Sem isso, a RAT nova viraria atalho pra limpar devolução sem corrigir e a métrica de devolução do painel perderia o sentido. Devoluções legadas sem `devolvida_em` (pré-0088) mantêm o comportamento antigo. O trigger do servidor (`rat_inicia_tarefa`, 0072) já não toca `devolvida`; o lembrete de +1 dia continua ativo enquanto a correção real não vem.

*Comportamento conhecido (aceito, não é buraco):* o técnico pode reenviar a RAT devolvida **sem alterar nada** e destravar — auditado pela `tarefa_devolucoes` (0099, reincidência contada); a gestão confere e re-devolve.

#### Lembrete de devolvida sem retorno (+1 dia — no ar)

Toda devolução carimba `tarefas.devolvida_em`. Enquanto a tarefa seguir `Devolvida`:
- **Portal** (Painel) — cartão de alerta "Devolvidas sem retorno há +1 dia" listando as vencidas (>24h).
- **App do técnico** — idade "Devolvida há X dias — corrigir" no detalhe/contexto da tarefa e na label da home.
- **Push** — Edge Function `lembrete-devolvida`, agendada por `pg_cron` a cada 4h, envia **no máximo 1 push/dia** aos técnicos da tarefa até ela sair de `Devolvida`; `tarefas.devolvida_notif_em` marca o último envio (evita spam). Autenticação da função por **segredo compartilhado** (`x-cron-secret` lido de `app_secrets`), não JWT — é chamada pelo cron, não por um usuário.

*Pendente (Fases B/C/D, após 1–2 semanas de uso):* devolução por-RAT propriamente dita, célula vermelha no calendário pras devolvidas, e a formalização da "trava" de edição.

### Tempo por técnico (equipes compartilhadas e artefatos simultâneos) — casos "Marcelo" e "Pablo"

**Princípio: tempo é da pessoa, não do documento — e vale para TODOS os artefatos com tempo (RAT, Deslocamento, futura jornada).** O artefato diz *o que* foi feito e *quem* participou; as **horas são por técnico**. Casos reais (levantados pela Thaís):
- **Marcelo:** 2 tarefas simultâneas no cliente; ele sai da Tarefa A no meio do dia pra ajudar a B → consta nas duas RATs → tempo duplicava e almoço conflitava ("dois almoços").
- **Pablo:** auxiliou a RAT até 10h e voltou mais cedo iniciando um **Deslocamento** → consta na RAT e no Deslocamento; a equipe almoça na RAT, ele almoça no Deslocamento → sistema entendia dois almoços dele, e a saída às 10h só existia nas observações (texto solto).

- **Definitivo (já desenhado, §10.1 — jornada contínua, opt-in do FBTB):** cada técnico tem a própria linha do tempo em segmentos (tarefa · deslocamento · almoço · pausa); trocar = handoff; **almoço é um segmento da jornada da pessoa** (um por dia, por construção). Cada artefato mostra o participante com o **intervalo dele**. Conflito impossível — não existe "em qual documento marco o almoço".
- **Transição (modelo atual, enquanto a jornada não é construída):**
  1. **Horário por técnico em qualquer artefato que lista pessoas** (RAT e Deslocamento) — início/fim próprios por participante (padrão = horário do artefato; edita só na exceção). Saída antecipada / entrada tardia vira dado estruturado, não observação.
  2. **Almoço/pausa pertence ao técnico no dia, independente de onde for registrado** — **um por pessoa/dia**; o sistema desconta uma única vez nos cálculos e **bloqueia/acusa** um segundo registro do mesmo técnico no mesmo dia, em qualquer combinação de artefatos (RAT+RAT, RAT+Deslocamento). Pessoas diferentes almoçando em artefatos diferentes: normal, um almoço de cada.
- **Cálculo de horas (qualquer modelo):** por técnico, Σ dos intervalos de participação em todos os artefatos do dia − o almoço/pausa único daquele técnico.

**Integração com o ponto (Tangerino / Sólides DP):** o almoço por técnico/dia é **puxado automaticamente do ponto**, em vez de digitado.
- Edge Function agendada consulta a API `punch-controller` do Tangerino (batidas paginadas, com filtros; requer **token de integração** solicitado ao suporte — fica em Configurações > Integração). Mapeamento técnico SR ↔ colaborador Tangerino em tabela própria.
- Dia normal = 4 batidas (entrada · saída almoço · volta · saída): o par do meio vira o registro de **almoço (origem "ponto")**, somente-leitura no app ("Almoço 12:02–13:04 · puxado do ponto").
- **Identificação do almoço (3 camadas):** (1) se a API já entregar o intervalo classificado pelo próprio Tangerino (apuração CLT/folha), usar direto; (2) heurística nas batidas cruas — pareia entrada/saída; com 4 batidas o gap do meio é o almoço; com mais gaps, almoço = **maior gap dentro da janela de almoço** (parâmetros em Configurações: janela ex. 10:30–14:30 · duração plausível ex. 20min–2h30; demais gaps = pausas); (3) **na dúvida, não chuta** — batidas ímpares, sem almoço registrado ou sem gap plausível → "almoço não identificado", abre fallback manual sinalizado. Cada registro guarda **origem + regra aplicada** (auditoria: "ponto · camada 2 · gap 12:02–13:04, 62 min, janela ok").
- **Fallback manual** só quando o ponto não veio — marcado como manual e sinalizado; ponto, quando chegar, prevalece. Releitura dos últimos ~7 dias por rodada (captura abonos/ajustes tardios).
- **Bônus pra jornada contínua (§10.1):** entrada/saída do dia vêm da mesma consulta = a moldura da validação "Σ segmentos = entrada → saída".
- Tangerino segue sendo o registro **oficial/legal**; o SR consome operacionalmente (arredondamento 5-em-5 e faturamento são camada do SR).

### Autoria da RAT — edição colaborativa por login (nº de celulares varia)

Em campo o nº de celulares **varia**, e **vários técnicos podem preencher a MESMA RAT ao mesmo tempo, cada um no seu login**, dividindo as seções por combinação entre eles (ex.: um lança o serviço executado, o outro o material). A RAT é **um documento compartilhado** por `(tarefa, dia)`; cada contribuição é **atribuída ao login** (auditoria: "material por Pablo, execução por Charles").

- **Seções que somam (append):** material (linhas), fotos, **participações de tempo** (uma por técnico) → merge por **união**; sincronizam independentes, então dois logins em **seções diferentes só se encaixam, sem conflito**.
- **Campos de valor único** (descrição, horários do deslocamento do dia): **última escrita vence**, com atribuição — na prática um só preenche (combinação entre eles).
- **Mesma seção pelos dois:** online, cada um **vê o estado atual** (o que o outro já lançou), o que evita relançar; offline, se ambos mexeram na mesma coisa (ex.: os dois lançaram material), o servidor **não soma escondido — marca conflito pro admin** (§12).
- **Tempo é sempre por pessoa, mas login de cada técnico NÃO é obrigatório.** O padrão é **uma pessoa preencher a RAT pela equipe** — incluindo o horário de cada participante (chips "horário por técnico"). A participação de um técnico existe na RAT mesmo que ele nunca logue. Se *houver* um segundo aparelho e o próprio técnico ajustar o horário dele, esse ajuste **prevalece** sobre o que foi preenchido por outro — é regra de **desempate**, não exigência.

Constraint `(tarefa, dia)` garante **uma RAT**; o que muda é que ela é **colaborativa**, não de dono único.

### Edição de RAT pela gestão (admin) — auditoria, motivo e restauração (06/26)

O técnico às vezes esquece algo (um técnico a bordo, um produto, uma foto) e já saiu pra outra tarefa; pedir correção trava a operação. Então o **admin pode editar/completar uma RAT preenchida** — com rastro.

- **Editor único (07/26 — implementação compartilhada):** a edição auditada vive no módulo **`js/rat-editor.js`** (estado técnicos/produtos/fotos + diff + motivo + Edge `rat-editar`) e roda em **dois lugares com o MESMO código**: a página `rat.html` e a **aba RATs da Tarefa** (edição direta no card). Continua **não existindo caminho de escrita sem auditoria** — o editor inline antigo do modal (update direto, sem motivo) foi removido junto com o modal morto.
- **Ações no card da RAT (aba RATs da Tarefa, 07/26):** o botão "Abrir ↗" saiu do cabeçalho; as ações operacionais rodam direto no card — **Editar** (só admin, mesma regra abaixo), **PDF** (motor vetorial, RAT avulsa), **Nova tarefa da pendência** (aparece **só** quando a RAT tem pendência de retorno: `volta_amanha='Não'` + `passagem_motivo='volto_depois'`) e **Encerrar** (só `em_andamento`). Ações secundárias no menu **⋮**: **Ver em página completa ↗** (rat.html) e **Excluir RAT** (RPC `admin_excluir_rat`). O `rat.html` permanece como rota de acesso direto/compatibilidade (link do calendário, histórico), mas não é fluxo obrigatório.
- **Só admin** (não gestor, não comercial), imposto no **servidor** pela Edge Function `rat-editar` (`app_role()='admin'` via `portal_acessos`; 403 pro resto) — não depende da UI.
- **Edita:** todos os campos, **técnicos responsáveis** (add/remove, só perfil `tecnico_campo`), **produtos** (qty/adicionar do catálogo/remover) e **fotos** (upload/remover/legenda). Condicionais (almoço/pausa/deslocamento = Sim) revelam os horários ao vivo; textareas auto-ajustam; almoço/pausa em seção própria.
- **Reflete ao vivo:** horas (Jornada) e conciliação recalculam das views; `tempo_trabalhado` é recalculado pela **mesma fórmula do §8.1** (espelha o app do técnico).
- **Trava do faturado:** Tarefa com OS no Omie (`aprovada_faturamento`/`faturada`) → **bloqueia (409)** alterações **financeiras** (técnicos/produtos/horários); **não-financeiras** (serviço, observações, situação, fotos) seguem editáveis. Correção pós-fatura é fluxo do Omie, não edição silenciosa no SR.
- **Motivo obrigatório, 1 por lote:** Esquecimento do técnico / Completação / Mudança de processo / Pedido do cliente / **Correção de texto** / Outro — gravado igual em todas as alterações do save; base do índice de assertividade (§13 pendente). **Regra do "Correção de texto" (07/26, migração 0106):** é ajuste cosmético (typo, redação) e **NÃO conta em nenhuma métrica de desempenho ou assertividade do técnico** — o índice de assertividade (§13) e qualquer lente futura sobre `rat_edicoes` devem filtrar `motivo <> 'correcao_texto'`. O rótulo na UI já avisa: "Correção de texto (não conta no desempenho)".
- **Auditoria não-adulterável:** cada alteração → linha em **`rat_edicoes`** (quem · quando · campo · anterior→novo · motivo). RLS **só de leitura** (admin/gestor); **nenhuma escrita** por cliente — só a Edge Function (service role) grava. Migração 0080.
- **Restaurar:** histórico no detalhe da RAT com **Restaurar** por linha (alterar→volta, remover→re-insere, adicionar→remove); a restauração entra como novo registro (rastro nunca some). Selo **"Ajustada pela gestão"** no cabeçalho.
- **Só portal (admin online):** não entra na fila offline; o app do técnico segue offline-first intacto — a RAT do técnico é a origem, o admin corrige por cima, com rastro.
- **Reclassificar como visita improdutiva (07/26, SW v623):** o admin pode reclassificar uma RAT pra `improdutiva` **pelo mesmo editor auditado** — ação no menu ⋮ do card (aba RATs da Tarefa) e botão na `rat.html`, com modal próprio (motivo obrigatório, mesmas chaves do app; "Outro" exige texto). No servidor é o **alvo `status` do `rat-editar`** (única transição permitida: → improdutiva), que grava `atendimento_executado=false` + `motivo_improdutiva` e loga antes→depois em `rat_edicoes` (**Restaurar** reverte). **Guarda**: bloqueia se a RAT tiver material lançado (improdutiva não tem execução). Efeito: sai da régua de desempenho (improdutivas não são avaliadas); produtos/faturamento intactos. Caso de origem: **04817/01** — dia 1 ficou "registrado" vazio pelo resolvedor de pausa esquecida, mas a passagem provava impedimento do cliente ("equipe da WestRock vai montar um andaime"); reclassificada pela gestão, tirou o atraso injusto de Max e Marcelo. *(Nota de fluxo: o resolvedor de pausa esquecida gera "registrado" sem `hora_termino` — que a régua lê como atraso; se o caso se repetir, avaliar carimbo próprio na v2.1.)*
- **Sync pós-ajuste também deixa rastro (07/26, migração 0095):** caso real (Tarefa 04828): a gestão ajustou um campo e depois o técnico reabriu a MESMA RAT no app ("edição pós-confirmação"); o sync faz upsert da RAT inteira e sobrescrevia o ajuste **em silêncio** — o histórico mentia. Agora o trigger `trg_audita_sync_pos_ajuste` (AFTER UPDATE de `respostas` em `rats`) grava o diff campo a campo em `rat_edicoes` com **motivo `sync_app`** e ator = técnico autenticado, sempre que uma escrita não-service-role alterar `respostas` de RAT com `ajustada_gestao=true`. Ninguém é bloqueado (a última palavra é de quem editou por último), mas o admin vê a reedição no histórico e pode **Restaurar**. *(Trigger é seguro aqui — só INSERE em `rat_edicoes`, sem UPDATE em rats/tarefas; não conflita com a decisão "sem trigger" do conflito de material, que envolvia `rat_inicia_tarefa`.)*

### Painel de Desempenho (motor — Fase 1, migrações 0097/0098, 07/26)

A métrica central chama-se **"Preenchimento online"** em TODAS as superfícies (card do app, detalhe, admin, spec). Legenda-contrato obrigatória onde a régua é explicada: *"Online = encerrada no dia do trabalho. Sem sinal não perde ponto — o app funciona offline e o registro conta normalmente."* (a palavra é o rótulo; a legenda desfaz a leitura "precisa de internet" — a régua é offline-first: o evento é carimbado no aparelho).

Nota mensal 0–100 por técnico (**régua v2**, migração 0098): **65% Preenchimento online** (COLETIVA — a RAT pontua todos os `rat_tecnicos`; **D+0 = 1** vale até **04:00 da madrugada seguinte** · **D+1 = 0,5** só até **12:00 do próximo dia útil** · depois = 0; **RAT aberta** — em andamento, sem evento de encerramento ou sem `hora_termino` — conta **atrasada quando o prazo D+1 venceu** e fica **pendente/fora** enquanto o prazo corre, com **reconciliação automática** na view ao encerrar; **improdutivas fora da régua**; **RATs em janela de instabilidade conhecida fora** — defensáveis por bug) **+ 15% reedição pós-encerramento** (INDIVIDUAL — **eventos** em dia posterior, não RATs distintas, com **teto 6/mês** calibrável na carência; device→técnico via `vw_device_tecnico`) **+ 20% devoluções** (COLETIVA — técnicos das RATs da tarefa devolvida; `devolvida_em` guarda só a última devolução, limitação v1).

- **Timezone:** dia declarado (`respostas.data`, âncora = dia do TRABALHO) × encerramento real convertidos pra `America/Sao_Paulo` **antes** de extrair a data — encerrar 23h em Brasília é D+0 (testado; o `em` dos `sync_eventos` é o relógio do aparelho no momento do ato, então offline não é punido). v1 usa a proxy "último `salvo pelo técnico`"; **v2 trocará pelo carimbo local `respostas_ts`** (0096).
- **Privacidade por construção:** views sem grant pra clientes; acesso SÓ por RPC — `meu_placar()` devolve a linha do próprio `auth.uid()`; `desempenho_time()`/`desempenho_rats()` exigem admin/gestor.
- **Corte do go-live no servidor:** `desempenho_config.inicio` (**NULL = painel desligado — estado atual**); os RPCs e o snapshot recusam meses anteriores — retroativo nunca entra no placar. **Duas condições travam o go-live** (14/07): (1) **teste real do Pablo com a versão ATUAL do app na frota (v613+)** — o teste anterior validou os fixes de encerramento v559→v575, mas a ativação exige a build corrente aprovada; (2) **confirmação da data pela gestão** — um clique na página Desempenho (dupla confirmação). Com as duas, começa o período de observação (carência = início + 28 dias, selo no card via `desempenho_status()`).
- **Snapshot mensal** (`desempenho_snapshots` + `gerar_snapshot_desempenho(mes)`, admin-only): placar oficial congelado, histórico imutável.
- **Janelas de instabilidade** (`app_instabilidade_janelas`): RATs de dias dentro de uma janela saem da régua (faixa `fora_janela_bug`) — mecanismo permanente pra incidentes futuros. **A janela semeada 30/06→06/07 (v559→v575) foi REMOVIDA na 0104 (14/07), por veredito operacional da gestão**: o app não estava instável pra equipe após os hotfixes de 30/06 — os dados confirmaram (17 das 25 RATs escondidas tinham sido encerradas em D+0; as 8 restantes, quase todas do Pablo com encerramento em mutirão dias depois, passaram a contar como atrasadas reais — decidido não dar o benefício da dúvida).
- **Histórico de devoluções (migração 0099):** re-devolução sobrescrevia motivo/cats/`devolvida_em` na tarefa — dado perdido pra sempre. Agora `tarefa_devolucoes` guarda **uma linha por devolução** (cats, motivo, ator, `resolvida_em` carimbado quando a tarefa sai de 'devolvida'), via trigger `trg_registra_devolucao` (AFTER UPDATE OF status; só insere/atualiza na tabela-evento — sem recursão). **Backfill parcial marcado `origem='backfill'`** (última devolução conhecida; sem `resolvida_em`) — série parcial nunca disfarçada de completa. **Visível no PORTAL (07/26, SW v627):** o detalhe da Tarefa mostra a devolução — status `devolvida` = banner vermelho na faixa de situação (categorias por extenso + detalhe + carimbo + selo "Nª devolução" na reincidência); qualquer tarefa com histórico = bloco cinza discreto "Histórico de devoluções" (cada linha: nª, data, categorias, resolvida em / em aberto; backfill sinalizado). Antes o motivo só aparecia pro técnico no app. Devolução pré-0099 (sem linha na série) exibe o motivo dos campos da tarefa como "registro parcial" — a informação **nunca sai da tela**. **Ciclo fecha sozinho (07/26, SW v628):** quando o técnico **salva a correção** (RAT volta 'registrado' no sync) de tarefa **devolvida**, a tarefa retorna automaticamente pra **`concluida`** — o serviço já era concluído; a devolução é de preenchimento. O trigger 0099 carimba `resolvida_em`; a gestão confere no fluxo normal e, se a correção veio ruim, **re-devolve** (2ª devolução com reincidência contada). "Vou voltar depois" não dispara (pausa ≠ correção); tarefas em faturamento intocadas. Lentes da F3 (visão da gestão, FORA da nota até a v3): **categorias×técnico×mês** (dado da Fase A, imediato), **reincidência** (2+ linhas na mesma tarefa) e **tempo de correção** (`resolvida_em − devolvida_em`; backfill fica fora dessa lente), exibindo quando houver volume.
- **Régua CRAVADA (14/07):** a v2 da 0098 como implementada — reedição atribuída ao **autor real** (device→técnico), só **dia posterior**, teto 6/mês. A âncora da primeira decomposição fica registrada como **primeira calibragem, não como alvo** (as parcelas dela se perderam; decidido não reconstruir por overfitting — régua explicável linha a linha vale mais que régua que "bate número").
- **Regra permanente de processo:** retrato para discussão/decisão sai SEMPRE de **snapshot carimbado** (`gerar_snapshot_desempenho`/insert com `gerado_em`), NUNCA da view viva — a base muda no meio do dia (deriva provada: 27 eventos de julho chegaram num único dia de análise) e rodadas sem carimbo não se comparam.
- **Referência oficial de pré-lançamento:** snapshot de **julho/2026 RECARIMBADO 14/07 18:07** (0105, após a reclassificação da 04817/01 pra improdutiva; antes 0104 removeu a janela de instabilidade) persistido em `desempenho_snapshots` (visível só à gestão via RLS; os RPCs do placar não leem snapshots — o corte do go-live segue intacto). Retrato vigente: Marcelo 89 · Alessandro 87 · Max 87 · Charles 72 · Maicon 68 · Arian 62 · Francisco 58 · Pablo 47. *(Carimbos anteriores, registrados como calibragem: 13:56 COM janela — Alessandro 100 · Max 77 · Charles 75 · Maicon 68 · Arian 66 · Marcelo 65 · Pablo 59 · Francisco 58; 17:30 sem janela — Alessandro 87 · Marcelo 83 · Max 82 · Maicon/Charles 68 · Arian 62 · Francisco 58 · Pablo 47.)*
- **DECISÃO CONSOLIDADA do modelo (14/07, após dry-run composta×binário):** o motor é a **composta v2, inalterada**, no go-live e na carência; a **leitura é contagem-primeiro**. Regras de exibição: (a) **formatos distintos anti-confusão** — a nota oficial é SEMPRE "**XX/100**" (nunca "XX%"); a contagem é SEMPRE "**Y de X RATs limpas**" (limpa = encerrada na régua D+0/D+1; são dois indicadores distintos); (b) **selo de amostra em três níveis, sem retirar ninguém** — <3 avaliadas "Amostra muito baixa" · 3–4 "Amostra limitada" · 5+ sem selo (endurecimento reavaliado com 2–3 meses de série); (c) **ranking com coluna "Principais ocorrências"** ("N coletivas de atraso · N reedições próprias · N devoluções") — a tabela se explica sozinha (caso Pablo≠Max visível na linha); (d) **"Entender minha nota"** no card do técnico é o lar da fórmula: pesos 65/15/20, regra aplicada, fatos que pesaram com impacto por ocorrência, versão e período da regra — pesos saem da tela principal; (e) hierarquia do card: contagem ("6 RATs avaliadas · 4 limpas · 2 com problema") → "Nota do mês: 59/100" → linha de ocorrências. **Reavaliação formal do modelo (composta × binário × híbridos) agendada pro fim da carência**, com a comparação rodando a cada snapshot mensal (dry-run read-only documentado: binário colapsa a discriminação com n baixo e perdoa reincidência de volume; cenários D+0-estrito × D+1-tolerado empataram em julho).
- **REDESENHO FINAL DO CARD (14/07) — dois indicadores, dois públicos:** o **app do técnico** mostra SÓ o **percentual de RATs sem problema** (`sem problema ÷ avaliadas × 100`; RPC novo `meu_resultado_rats`, 0103) — a nota composta, pesos, fórmula e barras **saíram integralmente do app**. O **portal** mantém a composta v2 rebatizada **"Índice interno de disciplina"** (ranking, volume, reincidência, natureza das ocorrências), exibindo ao lado o % de RATs sem problema (`desempenho_binario`). **Os indicadores medem coisas diferentes**: o percentual responde "quantas RATs tiveram problema"; o índice responde volume/reincidência/impacto — **divergência entre eles é comportamento esperado, não bug**; conversa de gestão parte dos fatos do drill-down. Critérios de RAT com problema (versão atual): encerrada depois de D+1 · aberta com prazo vencido · **reeditada em dia posterior pelo próprio técnico** (individual, device→técnico) · **tarefa devolvida** (coletiva, como o atraso). D+0/D+1 não sujam (D+1 = "tardia", informativo). Tendência do card em **pontos percentuais** (nunca "+15%"); <3 avaliadas = "Amostra limitada" com percentual sem tendência; zero elegíveis = "Ainda não há RATs avaliadas neste mês." (nunca 0%). Link do card: **"Entender meu resultado"** (só o binário). Motor/views/snapshots intactos.
- **CORREÇÃO DA GESTÃO CONTA NO BINÁRIO (14/07, migração 0107, SW v625):** 4º critério de "RAT com problema": **corrigida pela gestão por falha do técnico** — existe edição no portal (`rat_edicoes`, `operacao<>'restore'`) com motivo **Esquecimento do técnico** ou **Completação**. Atribuição **coletiva** (equipe toda da RAT, como atraso/devolução). **Não contam**: Correção de texto (cosmético), Mudança de processo, Pedido do cliente, Outro (ambíguo — quem quer que pese escolhe motivo classificado) e as linhas `sync_app` (reedição do técnico, já contada pelos eventos — sem dupla punição). Limitação v1: Restaurar uma edição não remove a marca da edição original. Superfícies: chip "N corrigidas pela gestão" no ranking (`r_ajuste` do `desempenho_binario`), ocorrência/chip/motivo no card do técnico (`corrigida_gestao` do `meu_resultado_rats`). Consequência operacional assumida: o motivo escolhido no modal de edição **afeta o placar do técnico na hora** — classificar com cuidado. Composta v2 interna inalterada (reavaliação no fim da carência).
- **PÁGINA DESEMPENHO SEM PONTOS (14/07, SW v619/v620):** **nenhum ponto, desconto ou nota aparece na interface**: no drill-down, RATs avaliadas mostram situação por extenso ("Com problema | Encerrada com atraso" / "Sem problema | Encerrada no dia" / "Não avaliada"); reedições mostram só data·campo·alteração·origem + chip "Reedição posterior"; devoluções mostram "RAT com problema" (sem −pts); o bloco "Dados técnicos da régua (auditoria)" **saiu da tela**. O **Índice interno de disciplina segue intacto no banco/snapshots** (cálculo, RPCs e histórico); se a auditoria precisar da leitura, sai por consulta/exportação administrativa — não pela página. O chip D+1 perdeu o "(meio ponto)". *(Isso substitui, NA UI, o item (a)/(d) da decisão consolidada acima — os formatos "XX/100" e "Entender minha nota com pesos" valem pro dado interno, não pra superfície.)*
- **RANKING EM TRÊS SEGMENTOS, NARRATIVA ÚNICA (portão 14/07, SW v621):** a linha do ranking tem UMA coluna de leitura ("Resultado do mês"), em **três segmentos com naturezas separadas** (display puro — dados direto de `desempenho_binario` + view composta, zero cálculo no front): **(1) RESULTADO** em negrito — "X de Y sem problema · Z%", o MESMO número do card do técnico no app (consistência app↔portal; a coluna "% com problema" redundante foi removida); **(2) PROBLEMAS** — chips só do que descontou, com unidade explícita: "N RATs com atraso" e "N RATs devolvidas" (coletivas, unidade RAT via `r_atraso`/`r_devolucao`) e "N reedições (M RATs)" (individual — **eventos com âncora de RATs distintas** via `r_reedicao`, pra 13 eventos não parecerem 13 RATs); mês limpo = chip verde "sem ocorrências" sozinho; **(3) FORA DA CONTA** em cinza discreto — "aberta no prazo · na janela do app · em D+1 (tardia)": contexto, não resultado, sem chip colorido. Cada segmento/chip tem **tooltip de uma frase com a regra** (atribuição coletiva/individual; janela = "fora da avaliação"). O "fora da conta" usa **chips-fantasma** (crivo 14/07, SW v622): outline cinza, fundo transparente, fonte um passo menor, ícone **SVG de linha** discreto (ampulheta = aberta no prazo · ferramenta = janela do app · relógio = D+1 tardia; emoji sugeridos adaptados pra regra da casa) — **duas famílias inconfundíveis: chip cheio desconta, chip fantasma informa**. **Tendência na mesma narrativa** (% sem problema: subir = verde, cair = vermelho, "pontos percentuais" por extenso); ordenação "Mais atenção" = menor % sem problema primeiro. **Unidades de devolução rotuladas nos dois pontos**: KPI do topo em TAREFAS ("N tarefas devolvidas no mês"), chip da linha em RATs, com tooltip-ponte ("uma tarefa pode conter várias RATs") — números diferentes, ambos corretos, só convivem com rótulo explícito. O KPI "Resultado da equipe" também fala a narrativa única: **"% de RATs sem problema"** ("53% · 17 de 32 RATs sem problema") — página inteira coerente com o card do técnico. **F3 declarada COMPLETA (14/07)** — fim da fase de construção do painel; resta operação da gestão: comunicado ao time + definição da data de go-live na página.
- Fases seguintes: F2 card do técnico ✅ (mergeada; redesenho final no PR #102), F3 ranking admin com drill-down + as três lentes de devolução (PR #102), F4 go-live, F5 proteção por campo + métrica v2.1 (carimbo local).

### RAT improdutiva (visita sem execução)

Acontece (cliente não liberou, local não pronto, falta de peça, clima, equipamento do cliente indisponível...). A RAT ganha o eixo **"Atendimento executado? Sim/Não"**:
- **Não →** escolhe **motivo** (lista + "outro" texto). A RAT **registra deslocamento e tempo de quem foi** (viagem perdida é custo real — relevante no FBTB por hora), execução zerada. A **Tarefa não conclui** — fica aguardando nova ida.
- Se o tempo/deslocamento improdutivo é faturável, decide a **modalidade** (§10.1); o SR garante o **registro**.
- **Alerta pro admin:** RAT improdutiva gera aviso "visita improdutiva em [cliente] · motivo [X] · reagendar" — pra Thaís remarcar.

---

## 9. Material e conciliação

Coração do sistema. Conciliação **interna** (não depende do Omie).

### As 5 colunas por linha de material (no nível da Tarefa)

| Coluna | Quem edita | Observação |
|--------|-----------|------------|
| **Orçada** | Comercial (no orçamento) | Trava no aprovado. Vazia se a OS foi criada direto. |
| **Levada** | Administrativo (e pode **adicionar materiais** fora do orçamento) | Saída de estoque (uma "retirada"). |
| **Utilizada** | Técnico (na RAT, somando as visitas da Tarefa) | — |
| **Devolvida** | Calculada (= Levada − Utilizada) | O que volta pro estoque. |
| **Situação** | Calculada | Sinaliza divergências. |

**Visibilidade do técnico:** vê *orçada* e *levada* (leitura), edita só *utilizada*. **Não vê preço** (ver §10).

**Terminologia no app do técnico (11/06):** nos textos visíveis, "Levado"/"Comigo" virou **"Disponível"** (o conceito/coluna interna continua *levada*). **Nas telas do admin (06/26)** a coluna "Levada" aparece como **"Disponibilizada"** — mesmo conceito/valor, só rótulo.

### Duas conciliações (não uma)
- **Orçado × Utilizado** → custo/faturamento (usou mais/menos do que foi vendido).
- **Levado × Utilizado → Devolvida** → estoque (o que sobra volta).
- Material **usado sem ter sido orçado** (linha sem orçada) aparece **destacado** — "gastou fora da proposta".

### Origem da linha de material (dois tipos, `produto_id` opcional)
- **Do catálogo:** produto do Omie, com preço puxado (editável).
- **Item avulso:** descrição + quantidade digitadas, sem produto; preço manual.

Ambos usam as mesmas 5 colunas.

### Problema da bobina (unidade)
Registrar tudo na **unidade de consumo (ex.: metro)**, não na embalagem. Ex.: orçada 100 m / levada 500 m (a bobina inteira, em metros) / utilizada 95 m / devolvida 405 m. O sistema concilia em metros; não precisa saber que "é 1 bobina".

**Decimais e arredondamento (decidido):** o técnico pode apontar **decimais na RAT** em unidades fracionárias (ex.: 0,3 m) e o valor é salvo como digitado. O **arredondamento acontece na Tarefa, não na RAT**: Utilizada da tarefa (por produto) = **teto (pra cima, inteiro) da Σ dos utilizados das RATs** — ex.: 0,3 + 0,4 + 0,5 = 1,2 → Utilizada **2 m** (uma só vez na soma; nunca por apontamento, que inflaria 1+1+1=3). A Devolvida usa o valor já arredondado. Na aba Produtos, exibir o arredondado como oficial com a soma real discreta ao lado ("2 · Σ 1,2 m") para auditoria; as RATs continuam exibindo o decimal real. Unidades inteiras (PC) só aceitam inteiro no apontamento.

> **Evolução futura (não agora):** rastrear a bobina/lote específico (saldo daquela bobina: 500 → 405 m) — camada de estoque mais avançada, no módulo de inventário.

### Apresentação da tabela (back-office) — aba "Produtos"

Referência visual: `docs/mockups/mockup-tarefa.html`. **Só apresentação** — os dados e termos não mudam (Orçada, Levada, Utilizada, Devolvida e os KPIs ficam intactos).

- Coluna **Un.** única (PC, m, …); as quatro colunas de quantidade são **números puros, alinhados à direita**, sem unidade grudada no número (nomes mantidos, inclusive "Devolvida").
- **Valor unit.** em **moeda formatada** (R$ 8.061,10), **read-only** (vem do orçamento congelado); só vira **editável** em **item avulso / fora da proposta**.
- **Só a Levada é editável** (input discreto); o resto é texto.
- **Zeros** = "0" em cinza suave; **"—"** só para N/A (ex.: Orçada de item fora da proposta).
- **Devolvida nunca negativa na tela:** quando Utilizada > Levada, exibe Devolvida "—" e destaca a **Utilizada em vermelho**; o sinal fica no badge. (O cálculo interno continua.)
- **Situação só no badge** (sem "• fora da proposta" inline); a linha fora-da-proposta ganha leve fundo. Badges: **OK** (verde) · **Devolver N** (âmbar, com a quantidade) · **Fora da proposta** (vermelho).
- **KPI cards** mantidos, com moeda consistente.

### Remessa de material e estoque em campo (Container) — caso contrato/pool (hoje WestRock-FBTB)

**Problema que resolve:** no contrato por hora, o material sai como **pool da viagem/semana** (planilha do almoxarifado) e é consumido por várias tarefas — inclusive criadas em campo. A conciliação por tarefa não cobre isso; o fechamento era manual, RAT por RAT. *(Desenho validado com a responsável do almoxarifado.)*

**Locais de estoque (mínimo, sem virar WMS):** `Matriz` · `Container WestRock-FBTB` (vinculado ao contrato). Só saldo por produto por local + movimentações (abastecimento · consumo via RAT · retorno · ajuste de inventário · retirada por terceiro).

**Duas classes de material, na mesma remessa (decidido por item; padrão vem da categoria do produto):**
- **Consumo/infraestrutura** (cabo, conectores comuns, fixação...) → **regra de ouro: tudo que vai pro cliente entra no saldo do Container** (abastecimento Matriz → Container), mesmo material usado no mesmo dia. O Container = "estoque no cliente", não a caixa física. Elimina origem por linha na RAT — consumo **sempre debita o Container**.
- **Itens de valor / serializados** (câmeras etc.) → **modo viagem**: saem na remessa marcados "retorna no fim da visita", são usados ou devolvidos, **conferidos a cada visita**. Não compõem o saldo permanente do container. Item serializado **exige Nº de série** no apontamento da RAT e na retirada/devolução (sem série não fecha) — resolve a falta recorrente de série nas RATs.

**Fluxo:**
- **Remessa de abastecimento:** o registro da saída (substitui a planilha). Recorrente — pode duplicar a anterior. Reposição no meio da semana entra na mesma, com data. No app do técnico, ação rápida **"Levar material → [contrato]"** registra na hora o que foi pro carro (evita saída sem registro).
- **Linhas de dois tipos (além das duas classes):** **pool do contrato** (sem destino certo) ou **vinculada a tarefa** (orçamento aprovado — vira a **Levada** da tarefa; sugestão automática ao montar a remessa a partir das tarefas agendadas; uma tarefa pode somar linhas de várias remessas; sobra pode "permanecer em campo").
- **Consumo:** apontamento de material na RAT debita o saldo automaticamente — **nada muda pro técnico**. O app mostra o **saldo do Container** ao apontar/levar.
- **Retorno definitivo:** transferência Container → Matriz.
- **Inventário (contagem):** tela "Contagem do Container" no app (offline ok) — digita o contado, sistema compara com o saldo teórico e registra **divergência** como ajuste auditável (consumo não apontado / perda). **Quem conta é função, não pessoa:** técnico no local ou almoxarifado em visita; o registro guarda quem/quando. **Agendamento: mensal, ~1 semana antes do fechamento/faturamento das OS do contrato** — dá tempo de corrigir apontamentos de RAT antes de faturar (evita cobrar pendência antiga). Itens de valor: conferência **a cada visita** (automático no modo viagem). Na contagem, material do site que estiver no carro conta junto.
- **Retiradas por terceiros:** **nada sai do container sem registro, e todo registro tem dono.** Terceiro não registra direto: ou um técnico TSRV registra **em nome dele** (movimentação "retirada por terceiro": nome, motivo, vínculo com tarefa se houver), ou — se recorrente/autorizado — recebe **perfil restrito** no app (só retirada/devolução). Tudo aparece no histórico e em relatório por pessoa/período; a contagem pega o que sair sem registro. *(Pendente: definir papel do Yago.)*
- **Conciliação por tarefa** (Orçada/Levada/Utilizada/Devolvida) **continua igual** para tarefas com orçamento; a camada de local cobre o pool. Drill-down do consumo mostra qual RAT usou o quê (inclusive obra que "bebeu" do pool).
- **Modo viagem com retorno** (sem estoque em campo) permanece disponível para outros clientes: mesmo mecanismo — movimentação entre locais + consumo via RAT + conferência com divergência no retorno.
- Tela back-office do Container: saldo atual por produto, histórico de movimentações com drill-down, e "Fazer contagem".

---

## 10. Faturamento

Por **Tarefa**. Decisão do **administrativo** (na mão).

1. Técnico **conclui** as RATs da Tarefa.
2. **Administrativo revisa** e: **devolve ao técnico** (se há pendência) **ou aprova pra faturar**.
3. Ao aprovar, o sistema **gera automaticamente uma OS no Omie** com status **"a Faturar"**.
4. Quando essa OS é **faturada no Omie**, o status **volta pro sistema** como **Faturada**.
5. Do faturamento, o sistema guarda **só o número da OS do Omie**.

> **Duas "OS" distintas:** a **OS interna = Tarefa** (criada no aprovado do orçamento, nosso sistema, execução) e a **OS fiscal no Omie** (criada no aprovar-pra-faturar do admin). A conciliação de material é só interna; a OS do Omie é só fiscal.

### 10.1 Modalidade de faturamento (no nível do contrato/obra)

Cada **contrato/obra** (não o cliente puro) tem uma **modalidade**, que define como aquele trabalho é faturado. Um mesmo cliente pode ter várias (ex.: **WestRock-FBTB por hora** + outra obra fechada).

- **Por hora** — fatura **Σ horas** do técnico no contrato. Hoje, só o **WestRock-FBTB**.
- **Projeto fechado / orçamento** — fatura o **valor do orçamento aprovado**; tempo = controle interno.
- **Contrato (locação/manutenção)** — coberto pelo contrato; **não fatura avulso**; tempo = controle/SLA.
- **Não-faturável** (garantia / cortesia / interno).

O **técnico nunca escolhe a modalidade** — ela é **derivada** (do contrato/obra, ou do orçamento de origem). O técnico só registra **cliente + Tipo de Serviço + execução + tempo + materiais**; o **admin confirma/ajusta** a modalidade na revisão pra faturar. Cliente/contrato sem modalidade definida → tarefa entra **pendente de classificação**.

**Modo "dia contínuo" (opt-in — só contratos por hora; hoje WestRock-FBTB):**
- A jornada do técnico vira uma **linha do tempo contínua**: ele está **sempre** num segmento (tarefa · pausa · almoço · deslocamento). Trocar de tarefa = **handoff** (a próxima abre no instante em que a anterior fecha) → **sem buraco** por construção.
- Tarefas podem ser **criadas em campo** na hora (cliente já é o do contrato; técnico só dá Tipo de Serviço + título).
- Ao **encerrar o dia**, valida **Σ segmentos = entrada → saída**; tempo solto **trava o faturamento** até classificar (estica a tarefa vizinha ou marca como pausa/não-faturável).
- **Hora faturada arredondada de 5 em 5 minutos** — os horários (início/fim dos segmentos) encaixam em marcas de 5 min, então as durações saem múltiplas de 5 (ex.: 10:32 → 10:30). Direção: **mais próximo** (confirmar se for sempre pra cima). Sem mínimo de cobrança definido.
- **Demais contratos:** modo **normal** — tarefa abre/fecha independente, buraco é irrelevante (tempo é só controle interno).

---

## 11. Integração Omie

- **Leitura (já em produção — Fase 1):** clientes e produtos. **Adicionar o preço do produto** na sincronização.
- **Escrita (nova — primeira escrita no ERP):** criar a **OS "a Faturar"** ao aprovar a Tarefa.
  - **Idempotência obrigatória:** aprovar gera **uma** OS; reclicar não duplica (guarda o número retornado, não recria).
- **Detectar "faturado":** **webhook** do Omie (se existir) ou **checagem periódica** do status das OS criadas. Code confirma na doc do Omie; na dúvida, checagem periódica resolve.
- **Segredos** (`OMIE_APP_KEY` / `OMIE_APP_SECRET`) só no servidor (Edge Function secrets). Toda chamada ao Omie é server-side.

---

## 12. Padrões transversais

- **Offline / accountability:** cada artefato de campo tem `client_uuid` (idempotência) e `sync_status` (`rascunho → salvo_local → na_fila → enviando → confirmado | erro`). Só vira **confirmado** depois que o **servidor** carimba o recebimento (trigger). `sync_eventos` = trilha de auditoria imutável (device_id + timestamps). O ACK do servidor é a verdade — resolve o "salvei mas não chegou".
- **Invariante da fila de sync — todo estado pendente aparece num contador (24/07, regra de casa, não violar):** *nenhum estado da fila de sync pode ficar fora do contador visível — **estado não contado vira órfão invisível** (o técnico vê "✓ sincronizado", o dado nunca sobe, ninguém percebe).* A **coleta** do `syncAll` e o **contador** do badge/Home têm que enxergar o **mesmo conjunto** de estados pendentes. Regra prática ao mexer em `sync_status`/fila: (a) coleta usa `!== confirmado` (pega tudo que não terminou com sucesso) **ou** um `PEND` que inclua **todo** estado não-terminal (`salvo_local, na_fila, enviando, erro`); (b) o badge conta **o mesmo**; (c) só `confirmado` (sucesso) e `rascunho` (ainda não enfileirado) podem ficar de fora. Ao terminar, rode a auditoria *estados × contado? × recoletado?* — nenhuma célula "não/não" fora de `confirmado`/`rascunho`. Este incidente (23–24/07) gerou **dois bugs da mesma família**: pré-orçamento fora da conta do badge (v677) e `enviando` fora da coleta **e** do badge (v680 — item preso em `enviando` depois que o iOS matou o PWA no meio do upload: invisível e sem retry). **Exceção conhecida e sob a regra:** `jornada_segmentos` é **recoletado** (`!== confirmado`) mas **não entra no badge** — não vira órfão de perda (sempre re-tenta; falha aparece no toast), mas é alta-frequência e contá-lo deixaria o badge cronicamente não-zero; se algum dia precisar de visibilidade permanente, some no contador junto com os demais.
- **Guarda de corrida no ACK (07/26, caso 04895):** salvar **durante** um envio em voo (ex.: encerrar a RAT enquanto as fotos sobem) muda o `sync_status` para `salvo_local`; o ACK do envio antigo **só confirma se o status ainda é `enviando`** — senão o retrato que subiu está velho: volta pra `na_fila` (evento "alterada durante o envio — reenviar") e uma **rodada extra** reenvia a versão nova. `syncAll` chamado com rodada em voo também **re-executa ao terminar** em vez de descartar. O retrato do envio é tirado **depois** de marcar `enviando` (fecha a janela da frente). Vale para RAT e pré-orçamento. *(Antes, o ACK esmagava o salvamento: a RAT ficava "confirmada" no aparelho com dado que nunca subiu — o encerramento da 04895 ficou preso na sexta e só chegou segunda, quando uma nova edição re-marcou pendente.)*
- **RAT de outra conta no aparelho (07/26):** aparelho que trocou de login pode ter RAT pendente criada sob a conta anterior — o RLS do servidor recusa (`42501`, só o dono grava a própria RAT) e antes ela re-tentava para sempre ("1 item com erro de envio" a cada sync, sem solução). O sync trata **somente** o `42501` ocorrido **no upsert de `rats`** (marcado na origem em `enviarRat`; um 42501 de outra tabela mantém o retry padrão): grava `envio_bloqueado_rls = { em, usuario, provado }` (horário, login ativo no bloqueio e se a propriedade divergente está comprovada pelos dados locais) e **interrompe o retry automático na sessão** — sem alerta repetido (o item não conta no toast). Nova tentativa acontece quando (a) o **dono** loga, (b) o **login muda** em relação ao registrado no bloqueio, ou (c) o técnico aciona o **sync manual** (botão). Mensagens na lista: propriedade comprovada → *"Esta RAT foi criada por outro usuário neste aparelho. Entre com a conta original para sincronizá-la."*; não comprovada → *"Esta RAT não pôde ser sincronizada por restrição de acesso. O conteúdo permanece salvo neste aparelho."* O flag limpa sozinho quando um envio passa. Nada é apagado, nada muda de dono (`client_uuid`/`tecnico_id` intocados) — excluir continua sendo ação explícita no 🗑.
- **Trabalho não-sincronizado nunca é apagado sozinho.** Deletar artefato de campo ainda não enviado (pendente/erro) é **sempre ação humana explícita**. Caso da **RAT órfã** (local, não sincronizada, cuja Tarefa foi excluída → recebeu tombstone): o `pullChanges` **não** a remove de propósito; ela é **rotulada "Tarefa removida — não será enviada"** (com o motivo) e o técnico apaga pelo **🗑**. Auto-limpeza só é permitida para órfãs **totalmente vazias** (sem dado a perder). Protege contra exclusão acidental da Tarefa pelo admin levar junto o trabalho de campo do técnico.
- **Sync resiliente — a fila não trava por um item (06/26):**
  - **RAT com tarefa-pai ausente no servidor** (FK `rats_tarefa_id_fkey`): em vez de erro em loop, o envio **recria a Tarefa mínima** a partir dos dados da própria RAT (`cliente_id`, data, tipo de serviço, via `criar_tarefa_app`) e **reenvia uma vez**. Diferente da RAT órfã *local* acima (lá a Tarefa foi excluída de propósito → tombstone; aqui a RAT é válida e a pai é reconstituída).
  - **Finalização colaborativa da viagem (06/26):** **qualquer técnico a bordo** pode lançar/finalizar a viagem (não só quem criou). O RLS de `deslocamentos` só deixa o criador gravar, então a escrita do modelo-novo (viagem com trechos) passa pela **Edge Function `viagem-merge`** (service role), que autoriza *a-bordo / criador / escritório* e **mescla por união**: preenche o que está vazio; em **horas** (saída/chegada/refeição) divergentes **mantém o valor do servidor e registra o conflito** em `deslocamentos.conflito` pro admin (selo "⚠ conflito — revisar" no portal) — nunca sobrescreve em silêncio; **`criado_por` é preservado** (a-bordo não vira dono). Só marca `confirmado` quando a função confirma de verdade — acaba o falso "✓ sincronizado". *(Substitui a regra anterior "não empurrar artefato de outro técnico", que marcava confirmado sem enviar e **descartava em silêncio** o lançamento do co-piloto — causa real de viagem que aparecia concluída no app e "em andamento" no portal.)* **403** (não está a bordo) ainda para de reenviar, sem loop. Caminho **legado** (1 registro = 1 trajeto) segue direto na tabela, só o criador.
- **Fuso horário (06/26):** o banco guarda instantes em **timestamptz (UTC)**; a exibição é que define o fuso. **Portal (admin) = sempre `America/Sao_Paulo`** (fuso do escritório), independente da máquina de quem acessa — helpers `fdt`/`fdata`/`dt`/`dDMA` forçam o fuso; views que extraem hora/data de timestamptz usam `at time zone 'America/Sao_Paulo'` (ex.: `vw_participacoes_dia`). **App do técnico = fuso do aparelho** (ele está no Brasil; `isoNoDia`/`hhmmDe` fazem ida-e-volta no fuso local). **Data-só (`AAAA-MM-DD`)** nunca passa por `new Date` direto (split de string), pra não escorregar 1 dia. Sintoma que isso resolveu: admin numa máquina em -4 via tudo ~1h adiantado.
- **Cuidado com `data_tarefa` (06/26):** é `timestamptz` guardado em **meia-noite UTC**; aplicar `at time zone 'America/Sao_Paulo'` + `::date` **nela** **derruba o dia** (23/06 00:00+00 → 22/06). Para o "dia da RAT" use `coalesce(respostas.data, data_tarefa::date)` (sem conversão de fuso) — padrão da `vw_participacoes_dia`. Corrigido em `vw_alerta_desloc_sem_volta`, `vw_rats_busca` e `rat_inicia_tarefa` (migrações 0081/0082) depois de gerar um alerta falso de "ida sem volta". Regra: `at time zone` só em colunas que são **instante real** (saída/chegada), nunca em data-só-meia-noite-UTC.
- **Auto-update do app do técnico (06/26):** o app se atualiza **sozinho** quando há versão nova, mas com **trava absoluta**: NUNCA recarrega com o técnico no meio de algo. A versão nova fica em espera (`reg.waiting`) e só troca quando o app está **100% ocioso na home** — `TecnicoApp.podeRecarregar()` (fonte da verdade, **`false` na dúvida**): exige `screen==='home'`, sem RAT aberta (`cur`), sem deslocamento em edição (`dlCur`, que mora em memória até salvar), sem gravação em debounce (autosave da RAT / pausa) e sem nenhum modal aberto. Gates extras: **online** e **sem sync rodando**. Reavalia ao voltar pra home, no `visibilitychange`, ao fim de um sync e a cada 60 s; **espera indefinida** enquanto ocupado (melhor ficar na versão velha do que perder dado). Sem loop (`swapIniciado` 1×/versão + guard `recarregando`); **offline nunca recarrega**. A barra "Atualizar" continua como **saída manual** (escolha explícita). Regra inviolável: **dado não-salvo do técnico jamais se perde por causa de um auto-reload**. *(Só passa a valer a partir da 1ª versão que já roda esse código — na virada, o técnico toca "Atualizar" uma última vez.)*
- **PDF:** serviço único, reusado (pré-orçamento, orçamento, RAT).
- **E-mail ao finalizar:** seletivo — pré-orçamento → comercial@tsrv; RAT concluída → adm@tsrv; **orçamento não dispara e-mail**.
- **Preço escondido do técnico = no nível dos dados, não só na tela.** Se só ocultar no visual, o preço vai junto no que o app baixa (legível via DevTools). O app do técnico deve **ler de uma fonte sem as colunas de preço** (view sem preço, ou consulta que não seleciona esses campos) — o valor nunca chega ao aparelho.
- **Soft delete:** orçamentos "excluídos" são arquivados (some das listas ativas, mantém histórico).
- **Numeração sequencial pelo servidor** (RAT, e número da Tarefa).
- **Link opcional** como padrão recorrente: `pre_orcamento_id`, `orcamento_id`, `produto_id` — preenchido = ligado; vazio = origem alternativa/avulso.
- **"Melhorar escrita" (IA):** botão ✨ ao lado de textareas que reescreve o texto livre em português profissional (edge function `melhorar-texto`, Claude Haiku; chave só no servidor). Helper compartilhado em `js/utils.js`, **desktop-only**: vive nas telas do back-office (Tarefa, RAT em edição) e na descrição do serviço do orçamento (comercial-app). **Decisão (10/06): NÃO fica no app do técnico** — foi testado lá e removido; o texto bruto do campo é melhorado no escritório.
- **Identidade do usuário vem do Portal:** papel sincronizado de `portal_acessos` (não de `usuarios.role`), foto/avatar de `usuarios.foto` (base64 gravada pelo Portal), cargo em texto livre. **Gestão de usuários saiu do Service Report** (centralizada no Portal).
- **Isolamento de dados por usuário no aparelho (06/26):** dispositivos de campo são compartilhados. O **IndexedDB é por usuário** — nome `service_report_u_<uid>` (`DBLocal.setUser(uid)` reabre no banco do uid e fecha a conexão anterior). Ao **trocar de login** (inclui a 1ª vez pós-rollout) limpam-se os caches re-obteníveis (`sr_tarefas_v1`/`sr_resp_tarefa_v1`/`sr_tec_screen`) e os **cursores de pull** (`sr_pull_*`) → o novo usuário re-baixa **só os dados dele** (RLS já garante o escopo). **Nunca apaga** trabalho não-sincronizado (o banco do usuário anterior fica intacto on-disk). Resolve a colisão "logada como Pablo aparecendo RAT do Teste". *(O catálogo `sr_ref_v1` e o `device_id` continuam globais — são do aparelho, não do usuário.)*
- **Sessão do app do técnico (06/26):** **logout automático 1×/dia** (na virada do dia, fuso `America/Sao_Paulo` — `sr_login_dia`, checado na abertura, por timer e ao voltar do 2º plano) e **exigir login ao FECHAR o app** (heartbeat `sr_app_alive` em `sessionStorage`: some ao fechar, sobrevive a reload — `fazerLogin` o marca, o `init` exige login se faltar). **Re-login exige internet (bloqueia offline)** — decisão da gestão pra dispositivos compartilhados; afrouxável p/ "trabalhar offline e logar ao reconectar" se travar campo. Vale **só** no app do técnico (o portal admin segue em `localStorage`, sem logout diário).

---

## 13. Estado atual da construção

*Atualizado em 25/06/2026.*

### Concluído

**Base / banco**
- **Reestruturação dois níveis FEITA:** `tarefas` (pai, a OS) + `rats` (filhas, `rats.tarefa_id`). Numeração pelo servidor; exibição `#04744/01`.
- Slice-1 completo: clientes, produtos, tipos_servico, formulario_modelos, tarefas, rats, relatorio_fotos, materiais, sync_eventos, sync_log, view de conciliação, RLS por papel, bucket de anexos.
- **Trigger:** Tarefa entra em *Em execução* ao receber a primeira RAT; também faz *Em execução ↔ Em pausa* (RAT "volto depois" → Em pausa; nova RAT → Em execução) — `rat_inicia_tarefa`, INSERT/UPDATE (§7).
- Papel `comercial` liberado; papel sincronizado com o Portal (`portal_acessos`); gestão de usuários **removida do SR** (centralizada no Portal); foto/cargo vindos do Portal.
- **Preço de venda do Omie** em `produtos.preco_venda` (sync paginado; ~1.715 produtos).

**Edge functions no ar:** `omie-sync` (leitura Omie F1) · `aprovar-orcamento` (aprovado → gera Tarefa, só se houver serviço) · `reabrir-orcamento` (desfaz a aprovação removendo a Tarefa) · `documentos` (PDF + e-mail do pré-orçamento via Resend → comercial@tsrv) · `melhorar-texto` (IA, Claude Haiku) · `manage-users` · `portal-usuarios` · `notify-push` · `orcamento-importar-fotos` · `viagem-merge` (finalização colaborativa da viagem — §12) · `rat-editar` (edição de RAT pela gestão, admin-only e auditada — §8).

**Módulo comercial**
- Pré-orçamento de campo (offline) e orçamento funcionando, com status/arquivamento.
- **Orçamentos migraram para o app "Gestão Comercial" (`comercial-app`)** — menu removido da sidebar do SR. Editor com botões na paleta da marca, descrição auto-crescente/redimensionável, "Proposta Nº" em destaque.

**Back-office (admin)**
- **Re-skin completo** no design system: sidebar clara color-codeada, painel com KPIs translúcidos, listas em `.listpanel` (Tarefas, Orçamentos, Deslocamentos), Jornada com KPIs color-codeados, Configurações com abas/badges na paleta, sentence case em toda parte, paleta oficial de 6 cores.
- **Tela de detalhe da Tarefa (§7) implementada:** cabeçalho rico, faixa "Situação da tarefa" (6 cards), abas com ✓/contador, Resumo operacional, Linha do tempo (trilha `sync_eventos`).
- Responsáveis em **chips** (avatar + nome + papel real + ×) com "+ Adicionar".
- Relatório da RAT (`rat.html`) e **PDF da RAT** na paleta do design system.
- **"Melhorar escrita" (IA)** nas textareas do desktop (ver §12).
- **Visões de RAT e Deslocamento (06/26):** RATs em **Calendário + Lista** global (busca, cliente, técnicos, agrupa pela data da RAT); **Calendário de Deslocamentos** (1 chip por trecho, base = "Traders") + detalhe leitura + alerta "ida sem volta"; **aba Deslocamento** na Tarefa + marcar **Revisado** no editor (§7).
- **Navegação (06/26):** abrir Tarefa/RAT/Deslocamento em **nova aba** (ícone + Ctrl/Cmd-clique); **ordenação por clique no cabeçalho** em todas as listas; top bar do detalhe mostra `Tarefa Nº NNNNN`.
- **Push ao técnico (06/26):** `notify-push` estendida — **"Nova tarefa atribuída"** e **"Tarefa reagendada"** pros técnicos atribuídos (§7, Home do técnico); a do encerramento da RAT pro admin virou **"Atendimento realizado"**.

**App do técnico (PWA)**
- Home em hub + OS para hoje + Agenda + Pré-orçamento + **Deslocamento/pernoite** (§4.1) — implementados.
- **Formulário da RAT reorganizado** (§8.1): card de contexto + grid 2×2 de registros, modais coloridos, Sim/Não semânticos, técnicos em modal fullscreen, indicador de progresso para concluir, **timers reabríveis** (atendimento/almoço/pausa/ida/retorno).
- Pacote UX: autosave, catálogo offline, banners de sync, fotos, dark mode, correções iOS (inputs date/time), anti-RAT-órfã. Ditado por voz **removido** (travava iOS/PWA).
- Emojis → **ícones SVG**; terminologia "Disponível" (§9); **sem R$** nas telas do técnico.
- **Sync resiliente (06/26):** RAT com tarefa-pai ausente **recria a pai e reenvia**; **viagem com finalização colaborativa** — qualquer um a bordo finaliza via `viagem-merge` (merge por união + conflito pro admin), substituindo o antigo "não re-empurrar viagem de outro técnico" — ver §12.
- **Push de campo (06/26):** recebe "Nova tarefa atribuída" / "Tarefa reagendada" mesmo com o app fechado (§7).
- **Auto-update seguro (06/26):** o app troca de versão **sozinho**, mas só com a **home ociosa** (nunca com RAT/deslocamento/modal aberto ou gravação pendente) — §12.
- **Entregas de 23/06:** fuso padronizado no portal (America/Sao_Paulo) + correção da view da Jornada · Jornada mostra nome de todo participante + avatar com foto + chips de RAT/Deslocamento clicáveis · RAT com datas em DD/MM/AAAA · conciliação ignora material de qtd 0 (migração 0077) · **lista de RAT no portal mostra o status da própria RAT** (não o da Tarefa) · Painel focado em "Tarefas pendentes de execução" (cards) · datas/horas do portal sempre em fuso de Sao_Paulo.
- **Entregas de 24/06:**
  - **Edição de RAT pela gestão** (§8 nova subseção): editor único `rat.html` (a Tarefa só linka **"Editar ↗"**), admin-only no servidor (`rat-editar`), **motivo obrigatório**, **auditoria `rat_edicoes` + Restaurar + selo "Ajustada pela gestão"**, trava do faturado. Migração 0080.
  - Editor: produtos qty/adicionar/remover, técnicos com **avatar** (foto do Portal, só `tecnico_campo`), condicionais (almoço/pausa/deslocamento) reveladas ao vivo, textareas auto-ajustáveis, **"Pausas e almoço" em seção própria**.
  - **Jornada:** soma o **deslocamento do dia** (ida/retorno) com **dedup por união** (migrações 0078/0079); chips "RAT Ida 4751/02" / "RAT Retorno 4752/01"; **chip de Almoço com nº e cor da RAT**.
  - **Bug de fuso corrigido:** alerta "ida sem volta" usava `data_tarefa` (meia-noite UTC) + data agendada → alerta falso; agora usa a data real da RAT (migração 0081; idem `vw_rats_busca`/`rat_inicia_tarefa` na 0082 — §12).
  - **Double-check:** corrigida a superrcontagem do tempo no caso **legado** da `rat-editar` (passou a espelhar a fórmula do §8.1).
  - **Devolução não perde mais os filhos:** ao reabrir uma RAT sincronizada (ex.: tarefa devolvida), o técnico passa a **hidratar material e fotos do servidor** no local (não vêm no pull `SYNC_MAP`) — antes a RAT reabria sem produto/foto. Merge por id (não clobbera trabalho local), fotos com URL assinada; só online e sem trabalho local pendente. *(15/07: reabrir pra corrigir deixou de ser o caminho único — na tarefa devolvida o técnico escolhe entre corrigir a RAT devolvida e abrir RAT nova de hoje, com regra de destravamento; ver §"Tarefa devolvida no app do técnico".)*
  - **Limpeza pontual:** removida a duplicação de material da RAT 04765 (caso **isolado** — RAT colaborativa, 2 aparelhos lançaram offline; varredura confirmou só 1 ocorrência). Ver pendente "Conflito de material em RAT colaborativa".
- **Entregas de 25/06:**
  - **Busca de OS no app do técnico + janela de 14 dias:** a lista padrão de Tarefas janela em 14 dias (mas **nunca esconde** tarefa ativa/pendente nem sem data); a caixa de busca consulta **3 meses online** (SELECT na sessão do técnico → herda a RLS `os_tecnico_sel`: titular + co-responsável, **sem** service role) e, offline, filtra o cache de 14 dias. Casa nº/cliente/orientação/local/tipo. Só leitura, sem objeto novo no banco.
  - **Orientação ao técnico visível onde ele trabalha:** o card de contexto no topo da RAT (e o card da lista de Tarefas) passam a mostrar a **Orientação** (`tarefas.orientacao`) — antes só no detalhe da Tarefa, deixando o técnico "no escuro" durante a RAT.
  - **Barra de navegação fixa no rodapé (estilo app)** — abas **Início · Tarefas · RATs · Desloc.** (Jornada pelo Início). O rodapé virou **item de layout (flex)** num shell de altura fixa (`100dvh`/visual viewport), **não `position:fixed`** → corrige de vez o bug do "rodapé subindo pro meio". No **formulário da RAT** a barra some e aparecem as ações da RAT; idem pré-orçamento.
  - **Rodapé de ações da RAT** colorido na paleta: **Cancelar** (neutro) · **Salvar e continuar** (verde `#179A47`) · **Encerrar a RAT do dia** (vermelho `#E5403A`), full-width.
  - **Isolamento de dados por usuário no mesmo aparelho** (§12): IndexedDB **por usuário** (`service_report_u_<uid>`) + limpeza de caches/cursores ao trocar de login → corrige a colisão "logada como Pablo vendo RAT do Teste". Não apaga trabalho não-sincronizado.
  - **Sessão do app do técnico** (§12): **logout automático 1×/dia** (virada do dia, fuso SP) e **exigir login ao fechar o app** (heartbeat em `sessionStorage`; reload mantém, fechar exige login). Re-login exige internet (bloqueia offline — decisão da gestão).
  - **Conflito de material em RAT colaborativa — FEITO (5 fases):** `materiais.created_by`/`device_id` carimbados na criação e preservados na hidratação/re-sync (migração 0083); detecção **DERIVADA** (view `vw_rat_material_conflito` — autores distintos por RAT ≥2; migração 0084) — **sem trigger** (evita recursão e virar o status da Tarefa via `rat_inicia_tarefa`); **gate no portal** (faixa Situação "Conflito de material", aba Material em vermelho, "Próxima ação" pede resolver antes de faturar); **resolução no editor da RAT** (aviso + "por &lt;técnico&gt;" por linha; admin remove o conjunto duplicado, auditado via `rat-editar`; ao sobrar 1 autor a view zera). Teste crítico OK: re-sync do mesmo autor = 1 autor distinto → não acusa. *(As colunas auxiliares `rats.material_conflito`/`materiais.conflito` da 0083 — pensadas p/ a abordagem com trigger, descartada — foram **dropadas na 0085**, já que a detecção é derivada; o índice `materiais(rat_id)` ficou.)*
  - **Busca + janela de 14 dias em "Minhas RATs"** (mesmo padrão de Tarefas): a lista janela em 14 dias (pela data da RAT), mas **sempre** mostra as **em andamento** e as **não-enviadas**; a **busca** (nº da OS/RAT, cliente, status) alcança **todas as RATs locais** (não só a janela), com aviso de quantas estão ocultas. **Busca estendida ao servidor:** ao focar a busca, `topUpRats90` traz do servidor (RLS titular `tarefas_tecnico_select`, últimos 90 dias) as RATs do técnico ausentes no aparelho (`aplicarDoServidor`) e re-renderiza — depois o filtro local cobre tudo e abrir hidrata os filhos. 1 fetch (guardado 60s); offline cai no local.
- **Entregas de 13/07:**
  - **Jornada inclui o tempo do pré-orçamento:** o painel "Horas do dia por técnico" passa a somar os **pré-orçamentos** do dia como participações — a **visita** (`visita_inicio→visita_termino`, chip rosa) e o **deslocamento** (`ida→retorno`, chip laranja, cor = deslocamento) — no **mesmo motor de união de intervalos + almoço único** das RATs/deslocamentos; assim o levantamento **conta nas horas do técnico** e quem só fez pré-orçamento no dia **passa a aparecer** na tabela. Feito **no `jornada.js`** (lê `pre_orcamentos` direto, RLS `preorc_office_all`), **sem tocar a `vw_participacoes_dia`** — pra não poluir um futuro consumo de faturamento com um artefato que não é RAT/deslocamento; chips **não clicáveis** (não há visualizador de pré-orçamento no portal). A **união deduplica** se o deslocamento envolver a visita → **sem dupla-contagem** (diverge de propósito do `tempo_trabalhado` gravado pelo app, que **soma** visita + deslocamento e pode contar dobrado; a Jornada, por união, fica mais correta).
- Service worker na casa da **v584**; produção no Vercel (`servicereport-app.vercel.app`).

### Pendente (próximos passos)

1. **Faturamento — escrita no Omie:** criar a OS **"a Faturar"** ao aprovar a Tarefa (idempotente) + retorno do status *Faturada* (webhook ou checagem periódica). Hoje "A faturar" existe só como **filtro local** na lista de tarefas — a integração de escrita não foi construída.
2. **E-mail da RAT concluída** → adm@tsrv.com.br (o serviço `documentos` hoje cobre o pré-orçamento; estender para a RAT).
2b. **Migrar os demais relatórios pro PDF vetorial — ✅ FEITO (07/26):** Tarefa, RAT avulsa (modal/rat.html) e "PDF unificado" já saem do motor pdfmake (§7 "PDF da Tarefa"); o gerador HTML antigo foi removido. Resta como candidato futuro: pré-orçamento/orçamento no mesmo motor (hoje têm gerador próprio, §5).
3. **Modalidade de faturamento por contrato/obra** (§10.1): o filtro "pendente de classificação" já existe (`tarefas.modalidade` vazia); falta o cadastro/derivação da modalidade no contrato.
4. **Modo "dia contínuo"** (WestRock-FBTB): linha do tempo contínua, handoff, arredondamento de 5 min — desenhado (§10.1), não construído.
5. **Câmbio US$/PTAX** no material do orçamento — futuro desenhado (§5), é só plugar.
6. **Rastreio de bobina/lote** — evolução futura do estoque (§9).
7. **Tempo por técnico + integração Tangerino (§8)** — desenhado (casos Marcelo/Pablo; almoço por pessoa/dia puxado do ponto, 3 camadas). Pacote de transição pronto pra build; **passo zero: pedir o token de integração ao suporte do Tangerino**.
8. **Remessa de material + estoque em campo/Container (§9)** — desenhado e validado com o almoxarifado; aguarda ok final + definição do papel do Yago. Mata a planilha semanal da WestRock.
9. **Módulo "Viagem" (§4.1)** — desenho de referência registrado; **não construir** antes da jornada contínua (provável redundância).
10. **Deslocamento do dia na Jornada — dedup por união (FEITO, 24/06):** a Jornada **soma** a ida/retorno do dia ao tempo do técnico (§8.1) via `vw_participacoes_dia`. O risco de **contar dobrado** (mesma ida lançada em 2 RATs do dia) é resolvido **naturalmente pela UNIÃO dos intervalos** (gaps-and-islands no consumidor): trechos idênticos contam **uma vez**, trechos diferentes somam. Validado (BMW/Benteler/Cosma). A mecânica "por pessoa/dia" do almoço fica de reserva caso surja um caso que a união não cubra.
11. **Ideias estratégicas (cada uma é projeto próprio, futuro):** central de pendências do admin (unifica alertas: improdutiva, conflitos, devolução, contagem, faturamento) · GPS pontual no início/fim da execução (prova de presença, além do deslocamento) · checklist por tipo de serviço (preventiva padronizada) · histórico por local/equipamento (manutenção) · cockpit de fechamento do mês (horas + material + container + improdutivas prontos pra faturar).
12. **Índice de assertividade do técnico (futuro):** a base já existe — `rat_edicoes` guarda **motivo** + `tarefa_id` e a RAT tem o titular (`rats.tecnico_id`). Falta o relatório que agrega "esquecimentos por técnico" (distinguindo **esquecimento** de completação/processo) pra medir a qualidade do preenchimento.
13. **Revisão de segurança do banco (projeto próprio, testado):** endurecer as ~13 views `SECURITY DEFINER` (avaliar `security_invoker`), **revogar grants desnecessários do `anon`** (visibilidade no GraphQL/PostgREST), `function_search_path_mutable` e policies `rls always_true`. **Pré-existente** (não veio da edição de RAT; a `rat_edicoes` já está protegida por RLS) e **sem incidente conhecido** → não urgente, mas mexer às cegas quebra acesso (gente deixa de ver o que precisa): fazer **view por view, com teste**, separado de outras entregas.
14. **Conflito de material em RAT colaborativa — ✅ FEITO (25/06):** dois técnicos lançando material **offline na MESMA RAT** duplicava (inflava faturamento). Implementado em 5 fases (**dono-é-a-RAT**, §8 "nunca soma em silêncio"): `materiais.created_by`/`device_id` (carimbado na criação, preservado na hidratação/re-sync — 0083); **detecção derivada** `vw_rat_material_conflito` (≥2 autores distintos por RAT — 0084), **sem trigger** (o trigger recursionaria e dispararia `rat_inicia_tarefa`, podendo virar o status da Tarefa); **gate no portal** (Situação/aba Material/Próxima ação); **resolução no editor da RAT** (autor por linha + aviso; remoção auditada via `rat-editar`; view zera ao sobrar 1 autor). Teste crítico OK (mesmo autor re-sync = 1 distinto → não acusa). Colunas auxiliares `rats.material_conflito`/`materiais.conflito` (0083) foram dropadas (0085) — detecção é derivada; índice `materiais(rat_id)` mantido. **Decisão (25/06): manter a VIEW, NÃO reintroduzir o trigger** — o trigger traria de volta o risco no `rat_inicia_tarefa`/recursão por um ganho (flag gravada p/ push/relatório) que hoje não é necessidade (conflito é raro). Se um dia precisar de **alerta ativo de conflito**, ler a **view** `vw_rat_material_conflito`, nunca um trigger no banco.

---

*Fim do documento. O que faltar, a gente acrescenta aqui.*
