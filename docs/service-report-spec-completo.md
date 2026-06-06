# Service Report + Módulo Comercial — Especificação Consolidada

> Documento vivo. Reúne tudo que foi desenhado até aqui. Serve de referência única para a construção (Claude Code) e para revisão do time. Ao lembrar de algo novo, acrescenta-se aqui — não precisa segurar nada de cabeça.

---

## 1. Visão geral

Plataforma interna da **Traders Service (TSRV)** para substituir gradualmente o Auvo e integrar com o Omie. Vive no portal **"Traders Apps"** (Supabase, projeto `iwufrqmzcvaiyzynodkg`), como mais um módulo ao lado do AxisInventory.

**Stack:** HTML/CSS/JS puro + Supabase + Vercel. Design system "Bold" (navy `#1B2A4A`). Backend único compartilhado.

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

> ⚠️ **Recuperar a definição completa** (campos, regras) do `especificacao-consolidada.md` (§15) — ela foi decidida em sessão anterior e ficou de fora desta consolidação. Não reinventar: trazer o que já existe no doc antigo.

---

## 5. Orçamento

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
| **Aprovado** | Gera a **OS/Tarefa** e **congela o orçado** (material e quantidades viram base imutável). |
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

Cada **contrato/obra** (não o cliente puro) tem uma **modalidade**, que define como aquele trabalho é faturado. Um mesmo cliente pode ter várias (ex.: WestRock-FBTB por hora + outra obra fechada).

- **Por hora** — fatura Σ horas do técnico no contrato. Hoje, só o **WestRock-FBTB**.
- **Projeto fechado / orçamento** — fatura o valor do orçamento aprovado; tempo = controle interno.
- **Contrato (locação/manutenção)** — coberto pelo contrato; não fatura avulso; tempo = controle/SLA.
- **Não-faturável** (garantia / cortesia / interno).

**O técnico nunca escolhe a modalidade** — ela é **derivada** (do contrato/obra, ou do orçamento de origem). O técnico só registra **cliente + Tipo de Serviço + execução + tempo + materiais**; o **admin confirma/ajusta** a modalidade na revisão pra faturar. Cliente/contrato **sem modalidade definida → tarefa entra pendente de classificação**.

**Modo "dia contínuo"** (opt-in — só contratos por hora; hoje WestRock-FBTB):

- A jornada do técnico vira uma **linha do tempo contínua**: ele está sempre num segmento (**tarefa · pausa · almoço · deslocamento**). Trocar de tarefa = **handoff** (a próxima abre no instante em que a anterior fecha) → **sem buraco por construção**.
- Tarefas podem ser **criadas em campo na hora** (cliente já é o do contrato; técnico só dá Tipo de Serviço + título).
- Ao **encerrar o dia**, valida **Σ segmentos = entrada → saída**; tempo solto **trava o faturamento** até classificar (estica a tarefa vizinha ou marca como pausa/não-faturável).
- **Hora faturada arredondada para cima, de 30 em 30 min** — a duração faturável de cada tarefa é arredondada **sempre para cima** ao próximo múltiplo de 30 minutos (ex.: 1h05 → 1h30; 2h31 → 3h00; 0h10 → 0h30). Os horários dos segmentos seguem reais (controle); o arredondamento incide no **valor faturado**.

**Demais contratos: modo normal** — tarefa abre/fecha independente, buraco é irrelevante (tempo é só controle interno).

> **Status de implementação — IMPLEMENTADO (SW v153):**
> - **Modalidade na Tarefa** (aba Faturamento): por_hora/projeto_fechado/contrato/nao_faturavel; null = pendente de classificação. Cálculo **por hora** = Σ tempo das RATs **arredondado p/ cima 30 min** × valor/hora. (migração 0030)
> - **Modalidade padrão no Cliente/obra** (Config → Clientes) → **deriva** p/ a tarefa (sugestão "confirme ao salvar"). (migração 0031) — modelado no cliente porque no Omie os clientes já são por obra (ex. "WestRock - FBTB"). Se precisar de várias obras por cadastro de cliente, criar tabela `contratos`.
> - **Dia contínuo** (app do técnico, tela "Jornada do dia", offline): linha do tempo de segmentos (trabalho/pausa/almoço/deslocamento) com **handoff** (sem buraco). Tabela `jornada_segmentos` (migração 0032), offline em IndexedDB (db-local v4) + sync idempotente.
> - **Visão do admin** (página **Jornada**): por técnico+dia, KPIs por tipo, **horas de trabalho por cliente** (faturável por hora, arredondado p/ cima 30 min), linha do tempo e **detecção de buraco**.
> - **Pendente (evolução):** reconciliar segmento→tarefa automaticamente (hoje o segmento de trabalho guarda cliente+tipo+título; o admin ainda cria/vincula a tarefa para faturar) e classificar por hora vs projeto/PC vs não-faturável **por atividade** direto da jornada.

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
- **PDF:** serviço único, reusado (pré-orçamento, orçamento, RAT).
- **E-mail ao finalizar:** seletivo — pré-orçamento → comercial@tsrv; RAT concluída → adm@tsrv; **orçamento não dispara e-mail**.
- **Preço escondido do técnico = no nível dos dados, não só na tela.** Se só ocultar no visual, o preço vai junto no que o app baixa (legível via DevTools). O app do técnico deve **ler de uma fonte sem as colunas de preço** (view sem preço, ou consulta que não seleciona esses campos) — o valor nunca chega ao aparelho.
- **Soft delete:** orçamentos "excluídos" são arquivados (some das listas ativas, mantém histórico).
- **Numeração sequencial pelo servidor** (RAT, e número da Tarefa).
- **Link opcional** como padrão recorrente: `pre_orcamento_id`, `orcamento_id`, `produto_id` — preenchido = ligado; vazio = origem alternativa/avulso.

---

## 13. Estado atual da construção

**Já feito:**
- Slice-1 do Service Report migrado no projeto (clientes, produtos, tipos_servico, formulario_modelos, tarefas, relatorio_fotos, materiais, sync_eventos, sync_log + view de conciliação + RLS por papel + bucket de anexos).
- App de campo (PWA, IndexedDB, formulário dinâmico de RAT, sync idempotente), painel/relatórios/configurações, login/auth.
- Integração Omie **Fase 1** (leitura de clientes/produtos via Edge Function `omie-sync`).
- **Papel `comercial`** liberado (banco + tela de Usuários + roteamento). *(commit e4f8efd)*
- **Preço de venda do Omie** em `produtos.preco_venda` + sync (1714 produtos com preço). *(commit e4f8efd)*

**Pendente (próximos passos):**
1. **CONFIRMAR/Fazer a reestruturação dois níveis** (renomear `tarefas`→`rats`; criar `tarefas` pai; `rats.tarefa_id`). **Pré-requisito do módulo comercial** (o "aprovado gera Tarefa" e a conciliação dependem disso). Validar no ar antes de empilhar.
2. **Módulo comercial:** pré-orçamento (campo, offline), orçamento, status, exclusão/arquivo. PDF **no servidor**; e-mail via **Resend** (verificar domínio tsrv.com.br).
3. **Material/conciliação** com as 5 colunas + permissões por papel + preço oculto no nível de dados.
4. **Faturamento:** revisão do admin, escrita da OS no Omie ("a Faturar") com idempotência, retorno do status faturado.
5. **PDF + e-mail ao finalizar** (serviço compartilhado).
6. **App do técnico (UI):** home em hub de 4 áreas + telas "OS para hoje" e "Agenda" (ver §7 e mockups). Sync com estado; sem R$; sem prioridade/marcador de pendência.
7. Regras: 1 RAT por (OS, dia); 1 almoço por (técnico, dia); status em dois eixos; concluir exige campos obrigatórios.

---

*Fim do documento. O que faltar, a gente acrescenta aqui.*
