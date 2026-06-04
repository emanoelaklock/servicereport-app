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

Artefato **próprio** do técnico (não é um campo dentro da RAT — esse é o bloco de deslocamento/tempo). Registra **viagens com pernoite**. **Continua valendo** (decisão confirmada). Formulário **fixo**, registro próprio (tabela `deslocamentos`), **offline-first** como os demais artefatos de campo. *(Formulários do técnico — pré-orçamento e deslocamento — são fixos; a RAT segue configurável por tipo de serviço, §8.)*

> **Recuperado do §15 do doc antigo (já arquivado):** lá a §15 era **ela própria um placeholder** — não havia definição fechada, só exemplos. Campos sugeridos (a fechar com o time): **destino · data/hora de ida e volta · nº de pernoites · quem viajou · veículo · despesas? · observações · fotos?**. **Pendente de especificação antes de construir** — não reinventar; fechar os campos com o time primeiro.

---

## 5. Orçamento

- **Quem cria:** **comercial**. Pode ser **transformado de um pré-orçamento** ou **criado novo** (`pre_orcamento_id` opcional).
- **Estrutura (modelo atual):**
  - **Serviço = descrição livre (texto longo) + valor final.** É **um bloco único** no orçamento (colunas `orcamentos.servico_descricao` + `servico_valor`), **não** itemizado (sem qtd/unitário/total). *(Mudança: antes serviço era item de tabela.)*
  - **Materiais = itemizados** em `orcamento_itens` (tipo `material`/`avulso`): **do catálogo** (preço do **Omie**, editável) ou **avulso** (descrição + preço manual). Subtotal = `qtd × preço` (coluna gerada).
  - **Campos do orçamento:** `prazo_execucao` (texto, ex.: "5 dias úteis") · `condicao_pagamento` (forma de pagamento) · `observacoes` (com checkbox que insere a frase-padrão "Serviço executado em horário comercial (segunda a sexta, das 7h às 17h)."). **Sem garantia, sem impostos.** Validade = padrão "15 dias" (constante, env `EMPRESA_VALIDADE`).
- **Total** = valor do serviço + Σ subtotais dos materiais. **Orçamento vazio** (sem serviço e sem material) é **bloqueado**.
- **Ao finalizar:** gera **só o PDF** (sem e-mail automático). O comercial/admin envia ao cliente do jeito dele.
- **O técnico não vê preço** — nem do produto, nem do orçamento (ver regra de dados em §10).

### Layout do PDF do orçamento (CLIENT-SIDE — render do template + impressão)

Referência visual: **`docs/mockups/orcamento-pdf-v2.jpg`** (e o `orcamento-pdf.html` original). O **orçamento** é gerado **no navegador**: o `orcamentoHTML()` (em `js/orcamentos.js`) monta o HTML do template (fonte **Inter**, A4), **pagina em folhas via JS** e abre a impressão → "Salvar como PDF". *(pdf-lib na Edge Function `documentos` segue só para o e-mail do pré-orçamento.)* Acento **navy `#1B2A4A`** + **vermelho `#BE1622`** no Total. Numeração com prefixo do ano (`260001`, `270001`…).

**Estrutura (ordem):**
1. **Cabeçalho (pág. 1):** selo "TS" + "TRADERS SERVICE" + bloco da empresa à direita (razão social, CNPJ·IE·IM, endereço, telefone). **Pág. 2+: cabeçalho ENXUTO** (TS + "Proposta Nº X") — não repete o endereço.
2. **"Proposta Nº X"** + **Emissão** (no topo fica **só** isso; Validade/Prazo vão para Condições comerciais).
3. **Cliente:** rótulo acima; nome (esq.) + documento/endereço (dir.) centralizados; endereço limpo (UF única "Itupeva/SP", CEP formatado).
4. **Serviço:** card azul-claro — **1ª linha do `servico_descricao` = resumo em destaque**, demais linhas = **bullets** (lista nativa); **Valor do serviço abaixo** da descrição.
5. **Materiais:** tabela Item · Descrição · Un. · Qtd · Vlr. Unit. · Total (com nº do item e zebra). O **cabeçalho da tabela repete** quando quebra de página. **Item sem preço** (fornecido pelo cliente) = **"—"** em unit/total e **fora do subtotal**.
6. **Resumo:** Subtotais **só quando há os dois grupos** (serviço + materiais); com um grupo só, vai direto ao **Total** (card; valor em vermelho).
7. **Condições comerciais** (embaixo) = **Prazo de execução** (se houver) · **Validade** ("15 dias") · **Forma de pagamento** (oculta a linha quando vazia) — **ao lado de Observações**.
8. **Rodapé corrido em todas as páginas:** contato + "Página i de n".

**Normalização de exibição:** data sem shift de fuso (`YYYY-MM-DD` direto); prazo em caixa consistente ("15 dias", não "15 Dias"); unidade padronizada ("PÇ"→"PC"); dados do cliente em Title Case (siglas/UF preservadas).

**Variantes (seções condicionais):** completo · só serviço · só materiais · pré-orçamento (sem valores/pagamento).

**Paginação:** sem `position:absolute/fixed` no conteúdo (causava bullets fora de ordem); a folha tem cabeçalho/rodapé próprios por página; a tabela quebra repetindo o thead; resumo é bloco atômico (não racha). **Testar gerando o PDF de verdade** (Chrome headless ou impressão) — não confiar só no código.

**Removido do modelo do Omie** (não usar): "Local de Estoque", "Previsão de Faturamento", "Ordem de Serviço incluído em", "Total do ISS"/Impostos, **desconto** e **Vencimentos**. PDF enxuto.

---

## 6. Status do orçamento

Quem marca: **comercial**, quando o cliente responde.

| Status | O que acontece |
|--------|----------------|
| **Aprovado** | Gera a **OS/Tarefa** e **congela o orçado** (material e quantidades viram base imutável). |
| **Não aprovado** | Sistema **avisa**; uma pessoa decide **excluir (arquivar) ou manter**. |
| **Sem retorno há 90 dias** | Sistema **avisa** (nada automático); pessoa decide **excluir (arquivar) ou manter**. |

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

---

## 10. Faturamento

Por **Tarefa**. Decisão do **administrativo** (na mão).

1. Técnico **conclui** as RATs da Tarefa.
2. **Administrativo revisa** e: **devolve ao técnico** (se há pendência) **ou aprova pra faturar**.
3. Ao aprovar, o sistema **gera automaticamente uma OS no Omie** com status **"a Faturar"**.
4. Quando essa OS é **faturada no Omie**, o status **volta pro sistema** como **Faturada**.
5. Do faturamento, o sistema guarda **só o número da OS do Omie**.

> **Duas "OS" distintas:** a **OS interna = Tarefa** (criada no aprovado do orçamento, nosso sistema, execução) e a **OS fiscal no Omie** (criada no aprovar-pra-faturar do admin). A conciliação de material é só interna; a OS do Omie é só fiscal.

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
- **Reestruturação dois níveis** (`tarefas`→`rats`; nova `tarefas` OS/job; `rats.tarefa_id`; filhas `tarefa_id`→`rat_id`). Validada no ar. *(commit bc485a4)*
- **#4.1 Schema comercial** — `pre_orcamentos`(+itens), `orcamentos`(+itens c/ preço e subtotal gerado), links opcionais, status + arquivar, RLS por papel (técnico sem acesso a orçamento). *(commit 7fa68ac)*
- **#4.2 Pré-orçamento (app de campo, offline)** — form **fixo** (cliente, descrição, materiais necessários sem preço, fotos, bloco de tempo), sync idempotente por `client_uuid`, numeração server-side (IDENTITY), ACK `recebido_em`→confirmado. Home **interina** de 3 botões (substituível pelo hub §7). *(commits 201e36e, f33c77b, 4844790)*

**Pendente (próximos passos):**
1. **Módulo comercial (em andamento):** ✅ 4.1 schema · ✅ 4.2 pré-orçamento · ⏭️ **4.3 Orçamento** (comercial: criar do zero ou de um pré-orçamento; itens com preço; total; condição de pagamento; PDF **sem** e-mail) · 4.4 status/arquivo · 4.5 **PDF (servidor) + e-mail (Resend)** — construído quando o primeiro consumidor precisar (no "concluir" do pré-orçamento; já marcado como TODO no código).
2. **Material/conciliação** com as 5 colunas + permissões por papel + preço oculto no nível de dados.
3. **Faturamento:** revisão do admin, escrita da OS no Omie ("a Faturar") com idempotência, retorno do status faturado.
4. **App do técnico (UI):** home em **hub de 5 áreas** (§7: OS para hoje · OS Pendentes · Agenda · Pré Orçamento · Deslocamento) + telas "OS para hoje" e "Agenda" + fluxo **RAT dentro de OS** (ver mockups). Sync com estado; sem R$. A home interina de 3 botões fica **até o fluxo de OS existir**.
5. **Deslocamento (pernoite)** — fechar os campos com o time (§4.1) e construir (form fixo, offline, tabela `deslocamentos`).
6. Regras: 1 RAT por (OS, dia); 1 almoço por (técnico, dia); status em dois eixos; concluir exige campos obrigatórios.

---

*Fim do documento. O que faltar, a gente acrescenta aqui.*
