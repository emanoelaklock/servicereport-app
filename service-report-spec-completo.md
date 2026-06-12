# Service Report + Módulo Comercial — Especificação Consolidada

> Documento vivo. Reúne tudo que foi desenhado até aqui. Serve de referência única para a construção (Claude Code) e para revisão do time. Ao lembrar de algo novo, acrescenta-se aqui — não precisa segurar nada de cabeça.
>
> **Última atualização: 12/06/2026** (incorpora o trabalho de 09–11/06: re-skin do admin, reorganização da RAT do técnico, timers reabríveis, IA "Melhorar escrita", pernoite, paleta oficial).

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
- **Campos:** cliente (catálogo Omie) · descrição do que precisa ser feito (o levantamento) · **materiais necessários** (itens do catálogo, com quantidade) · fotos · **deslocamento** (Sim/Não + horários) · **início/fim do levantamento** · **almoço/pausa** · técnico e data (automáticos).
- **Controle de tempo:** completo (deslocamento, início/fim, pausa, almoço) → tempo de trabalho do técnico.
- **Ao finalizar:** gera **PDF** + dispara **e-mail para comercial@tsrv.com.br** + **aparece no painel do administrativo** como "pré-orçamento".

> Pré-orçamento e RAT são o **mesmo tipo de artefato** (visita de campo) com o mesmo esqueleto. Diferem só no propósito/alguns campos: pré-orçamento = *materiais necessários* + levantamento; RAT = *materiais usados* + serviço executado/checklist.

### 4.1 Deslocamento (pernoite) — artefato à parte

Artefato **próprio** do técnico (não é um campo dentro da RAT — esse é o bloco de deslocamento/tempo). Registra **viagens com pernoite**. **Continua valendo** (decisão confirmada).

**Implementado (11/06):** acessível em **Home > Deslocamento** no app do técnico. Blocos de **Ida** e **Volta** (com ícones SVG) e **técnicos a bordo** selecionados em cards (mesmo padrão visual da RAT).

> Não confundir com o **deslocamento do dia**, que mora dentro da RAT (botão "Deslocamento" no grid de registros — pergunta Sim/Não + horários de ida/retorno). Pernoite é viagem; deslocamento do dia é o trajeto da visita.

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
| **Aprovado** | Gera a **OS/Tarefa** e **congela o orçado** (material e quantidades viram base imutável). Implementado via edge function `aprovar-orcamento`; **só gera Tarefa se o orçamento tiver serviço** (orçamento só-materiais não vira OS). **Reabrir** um aprovado desfaz: a edge function `reabrir-orcamento` remove a Tarefa gerada. |
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
`Aguardando execução` (se houver data, a tela mostra "Agendada p/ DD/MM" — a data é um campo, não um status) · `Em execução` · `Concluída` · `Concluída com pendência` · `Devolvida` (admin retornou ao técnico) · `Aprovada p/ faturamento` (gerou OS no Omie "a Faturar") · `Faturada`.

**Atividade atual do técnico** (só quando "Em execução", vem da RAT do dia):
`Trabalhando` · `Em pausa` · `Em almoço`.

Os dois eixos podem colorir o card. Pausa/almoço são estados **momentâneos** da RAT do dia, não se misturam com o ciclo de vida da OS.

### Regras de RAT dentro da OS
- **1 RAT por OS por dia** — não abre duas RATs pra mesma OS no mesmo dia. É na RAT do dia que se registra pausa, almoço, etc.
- O técnico pode ter **várias OS abertas no mesmo dia** (uma RAT por OS).
- **1 almoço por dia** — só uma RAT pode estar em "almoço" no dia (o almoço é do dia do técnico, descontado uma única vez do tempo, mesmo rodando várias OS). Pausa não tem esse limite.

→ Restrições no banco: RAT única por `(tarefa, dia)`; almoço único por `(técnico, dia)`.

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
`Aguardando execução` (cinza) · `Em execução` (verde) · `Em pausa` (âmbar) · `Em almoço` (azul) · `Concluída` (teal) · `Concluída c/ pendência` (vermelho).

### Tela de detalhe da Tarefa (back-office / admin)

Referência visual: `docs/mockups/mockup-admin-tarefa-completa.html`. É o **hub da tarefa** pro admin/gestor — só apresentação e organização; os dados/abas/regras não mudam.

- **Cabeçalho rico:** nome do cliente, subtítulo (tipo), `Tarefa Nº` com copiar, **status geral**, data agendada, **responsável principal** (avatar), e ações **Exportar (PDF)** + menu.
- **Faixa "Situação da tarefa"** — radar de 6 mini-status que mostra a saúde inteira num relance, com cor: **Dados** (Preenchido) · **RATs** · **Produtos** (ex.: "95 m a devolver") · **Fora da proposta** (nº de itens) · **Faturamento** · **Anexos**. Verde = ok · âmbar = pendência · vermelho = fora da proposta.
- **Abas com indicador:** ✓ no que está ok e **contador** no que pede atenção (ex.: Produtos ② · Faturamento ①). Abas: Dados · RATs · Produtos · Equipamentos · Faturamento · Anexos · **Histórico**.
- **Resumo operacional** (coluna lateral) — apoio à decisão, tudo de dado real: **Horas registradas** (Σ das RATs) · **Valor utilizado** (conciliação) · **A devolver** · **Itens fora da proposta**.
- **Próxima ação recomendada** — motor de regras simples sobre os gates de faturamento:
  - RAT não confirmada → "aguardar sincronização";
  - `a devolver > 0` **ou** item fora da proposta → "conferir devolução de materiais antes do faturamento";
  - tudo ok e não faturado → "liberar faturamento";
  - já faturado → sem ação.
- **Linha do tempo da tarefa** — trilha de eventos (criada → responsáveis → RAT → produtos → pendência → concluída). É a leitura da **trilha de auditoria (`sync_eventos`, §12)**, não um dado novo.
- "Dados da tarefa" no radar usa **"Preenchido"** (não "Concluído" — dados não concluem).
- Em tela menor, as duas colunas, a faixa de situação e a timeline **empilham**.

---

## 8. RAT (Relatório de Atendimento Técnico)

Cada RAT = uma visita/dia dentro de uma Tarefa. Offline-first.

- **Cabeçalho (nível Tarefa):** cliente, OS, tipo de tarefa, orientação/serviço solicitado.
- **Corpo (nível RAT, preenchido pelo técnico):** deslocamento (Sim/Não + horários — "Não" esconde os campos de deslocamento) · início/fim · **almoço/pausa** (checkbox → início/fim) · serviço executado · observações · fotos (múltiplas, com legenda) · **materiais utilizados** · tempo trabalhado (calculado).
- **Numeração:** `numero_rat` **sequencial atribuído pelo servidor** (nunca pelo dispositivo — evita colisão offline/multi-dispositivo).
- **Salvar rascunho** a qualquer momento (sem validação; status "Em andamento").
- **Concluir** (`Concluído` / `Concluído com pendência`) **exige todos os campos obrigatórios preenchidos** — vale para as duas opções. Sem isso, não conclui.
- **Ao concluir:** gera **PDF** + dispara **e-mail para adm@tsrv.com.br**.
- Campos do formulário são **configuráveis** (modelos por tipo de serviço).
- **Numeração exibida** com separador `/`: ex. `#04744/01` (tarefa/sequência da RAT).

### 8.1 Formulário da RAT no app do técnico — layout atual (10–11/06)

Referência visual: `docs/mockups/mockup-nova-rat-topo.html`. Reorganização completa do formulário:

- **Topo:** card de **contexto** (cliente/tarefa) + **grid 2×2 de registros** em cards coloridos (estilo dos tiles da home): **Deslocamento** · **Pausa/Almoço** · **Produtos** · **Fotos**. Cada card abre um **modal** com identidade de cor (header colorido, botão **Concluir** na cor do card) e mostra badge de estado (**Pendente** / valor preenchido com ✓).
- **Deslocamento (do dia):** pergunta Sim/Não + horários de **ida/retorno**. (Pernoite é à parte — §4.1.)
- **Pausa/Almoço:** num modal só — "Houve almoço?" e pausa com motivo/horários, ambos com botões **Sim/Não**.
- **Produtos:** pergunta Sim/Não + **steppers** de quantidade; catálogo de produtos mora aqui (autocomplete paginado — o catálogo tem ~1.715 itens, acima do teto de 1.000/req do Supabase). No fechamento, **Utilizada = teto da soma** das RATs na conciliação.
- **Botões Sim/Não semânticos:** Sim verde, Não vermelho, preenchidos ao selecionar.
- **Pares lado a lado** (grid `1fr 1fr`): Data + Veículo · Hora início + término. Veículo é seletor inline com opção **"Sem veículo"**. Botão de GPS manual foi removido.
- **Técnicos responsáveis:** modal **fullscreen** (escala para 15–20 técnicos), cards no padrão do admin + botão "+ Adicionar técnico".
- **Timers reabríveis (10/06):** todos os pares de horário (atendimento, almoço, pausa, ida, retorno) usam o mesmo sistema de timer — inicia/encerra e **pode reabrir** um par já fechado.
- **Serviço executado / Pendências / Observações:** caixas maiores, placeholder orientativo e **bullets `-` automáticos** ao digitar.
- **Indicador de progresso para concluir:** mostra o que falta (campos obrigatórios + produtos + foto) antes de liberar o Concluir.
- **Anti-RAT-órfã:** rascunho recém-aberto **sem trabalho real é descartado** ao sair (não fica lixo local).
- **Sem ditado por voz** (removido — travava o app no iOS/PWA).

### Duas "pendências" distintas (não confundir)

1. **`Concluído com pendência`** — **status da RAT, definido pelo técnico** ao fechar. A atividade principal foi feita, sobrou um **detalhe pequeno**. **NÃO bloqueia** faturamento nem fechamento da OS — o admin segue aprovando normal.
2. **OS Pendentes / `Devolvida`** — **estado da OS, definido pelo administrativo** na revisão. O admin **devolveu** a OS pro técnico **corrigir** (ex.: descrição errada do serviço executado, material inconsistente com o fechamento). A OS volta **editável** e **precisa ser corrigida** antes de seguir. O card "OS Pendentes" da home lista justamente essas.

São **eixos diferentes** e podem coexistir (uma RAT "concluída c/ pendência" ainda pode ser devolvida pelo admin se houver erro de dado).

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

**Terminologia no app do técnico (11/06):** nos textos visíveis, "Levado"/"Comigo" virou **"Disponível"** (o conceito/coluna interna continua *levada*).

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
- **Trabalho não-sincronizado nunca é apagado sozinho.** Deletar artefato de campo ainda não enviado (pendente/erro) é **sempre ação humana explícita**. Caso da **RAT órfã** (local, não sincronizada, cuja Tarefa foi excluída → recebeu tombstone): o `pullChanges` **não** a remove de propósito; ela é **rotulada "Tarefa removida — não será enviada"** (com o motivo) e o técnico apaga pelo **🗑**. Auto-limpeza só é permitida para órfãs **totalmente vazias** (sem dado a perder). Protege contra exclusão acidental da Tarefa pelo admin levar junto o trabalho de campo do técnico.
- **PDF:** serviço único, reusado (pré-orçamento, orçamento, RAT).
- **E-mail ao finalizar:** seletivo — pré-orçamento → comercial@tsrv; RAT concluída → adm@tsrv; **orçamento não dispara e-mail**.
- **Preço escondido do técnico = no nível dos dados, não só na tela.** Se só ocultar no visual, o preço vai junto no que o app baixa (legível via DevTools). O app do técnico deve **ler de uma fonte sem as colunas de preço** (view sem preço, ou consulta que não seleciona esses campos) — o valor nunca chega ao aparelho.
- **Soft delete:** orçamentos "excluídos" são arquivados (some das listas ativas, mantém histórico).
- **Numeração sequencial pelo servidor** (RAT, e número da Tarefa).
- **Link opcional** como padrão recorrente: `pre_orcamento_id`, `orcamento_id`, `produto_id` — preenchido = ligado; vazio = origem alternativa/avulso.
- **"Melhorar escrita" (IA):** botão ✨ ao lado de textareas que reescreve o texto livre em português profissional (edge function `melhorar-texto`, Claude Haiku; chave só no servidor). Helper compartilhado em `js/utils.js`, **desktop-only**: vive nas telas do back-office (Tarefa, RAT em edição) e na descrição do serviço do orçamento (comercial-app). **Decisão (10/06): NÃO fica no app do técnico** — foi testado lá e removido; o texto bruto do campo é melhorado no escritório.
- **Identidade do usuário vem do Portal:** papel sincronizado de `portal_acessos` (não de `usuarios.role`), foto/avatar de `usuarios.foto` (base64 gravada pelo Portal), cargo em texto livre. **Gestão de usuários saiu do Service Report** (centralizada no Portal).

---

## 13. Estado atual da construção

*Atualizado em 12/06/2026.*

### Concluído

**Base / banco**
- **Reestruturação dois níveis FEITA:** `tarefas` (pai, a OS) + `rats` (filhas, `rats.tarefa_id`). Numeração pelo servidor; exibição `#04744/01`.
- Slice-1 completo: clientes, produtos, tipos_servico, formulario_modelos, tarefas, rats, relatorio_fotos, materiais, sync_eventos, sync_log, view de conciliação, RLS por papel, bucket de anexos.
- **Trigger:** Tarefa entra em *Em execução* ao receber a primeira RAT (§7).
- Papel `comercial` liberado; papel sincronizado com o Portal (`portal_acessos`); gestão de usuários **removida do SR** (centralizada no Portal); foto/cargo vindos do Portal.
- **Preço de venda do Omie** em `produtos.preco_venda` (sync paginado; ~1.715 produtos).

**Edge functions no ar:** `omie-sync` (leitura Omie F1) · `aprovar-orcamento` (aprovado → gera Tarefa, só se houver serviço) · `reabrir-orcamento` (desfaz a aprovação removendo a Tarefa) · `documentos` (PDF + e-mail do pré-orçamento via Resend → comercial@tsrv) · `melhorar-texto` (IA, Claude Haiku) · `manage-users` · `notify-push` · `orcamento-importar-fotos`.

**Módulo comercial**
- Pré-orçamento de campo (offline) e orçamento funcionando, com status/arquivamento.
- **Orçamentos migraram para o app "Gestão Comercial" (`comercial-app`)** — menu removido da sidebar do SR. Editor com botões na paleta da marca, descrição auto-crescente/redimensionável, "Proposta Nº" em destaque.

**Back-office (admin)**
- **Re-skin completo** no design system: sidebar clara color-codeada, painel com KPIs translúcidos, listas em `.listpanel` (Tarefas, Orçamentos, Deslocamentos), Jornada com KPIs color-codeados, Configurações com abas/badges na paleta, sentence case em toda parte, paleta oficial de 6 cores.
- **Tela de detalhe da Tarefa (§7) implementada:** cabeçalho rico, faixa "Situação da tarefa" (6 cards), abas com ✓/contador, Resumo operacional, Linha do tempo (trilha `sync_eventos`).
- Responsáveis em **chips** (avatar + nome + papel real + ×) com "+ Adicionar".
- Relatório da RAT (`rat.html`) e **PDF da RAT** na paleta do design system.
- **"Melhorar escrita" (IA)** nas textareas do desktop (ver §12).

**App do técnico (PWA)**
- Home em hub + OS para hoje + Agenda + Pré-orçamento + **Deslocamento/pernoite** (§4.1) — implementados.
- **Formulário da RAT reorganizado** (§8.1): card de contexto + grid 2×2 de registros, modais coloridos, Sim/Não semânticos, técnicos em modal fullscreen, indicador de progresso para concluir, **timers reabríveis** (atendimento/almoço/pausa/ida/retorno).
- Pacote UX: autosave, catálogo offline, banners de sync, fotos, dark mode, correções iOS (inputs date/time), anti-RAT-órfã. Ditado por voz **removido** (travava iOS/PWA).
- Emojis → **ícones SVG**; terminologia "Disponível" (§9); **sem R$** nas telas do técnico.
- Service worker na casa da **v300**; produção no Vercel (`servicereport-app.vercel.app`).

### Pendente (próximos passos)

1. **Faturamento — escrita no Omie:** criar a OS **"a Faturar"** ao aprovar a Tarefa (idempotente) + retorno do status *Faturada* (webhook ou checagem periódica). Hoje "A faturar" existe só como **filtro local** na lista de tarefas — a integração de escrita não foi construída.
2. **E-mail da RAT concluída** → adm@tsrv.com.br (o serviço `documentos` hoje cobre o pré-orçamento; estender para a RAT).
3. **Modalidade de faturamento por contrato/obra** (§10.1): o filtro "pendente de classificação" já existe (`tarefas.modalidade` vazia); falta o cadastro/derivação da modalidade no contrato.
4. **Modo "dia contínuo"** (WestRock-FBTB): linha do tempo contínua, handoff, arredondamento de 5 min — desenhado (§10.1), não construído.
5. **Câmbio US$/PTAX** no material do orçamento — futuro desenhado (§5), é só plugar.
6. **Rastreio de bobina/lote** — evolução futura do estoque (§9).

---

*Fim do documento. O que faltar, a gente acrescenta aqui.*
