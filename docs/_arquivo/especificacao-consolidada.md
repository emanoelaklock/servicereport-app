# Service Report + Módulo Comercial — Especificação Consolidada

> ⚠️ **ARQUIVADO / OBSOLETO.** A fonte única da verdade agora é **`docs/service-report-spec-completo.md`**. Este arquivo fica só como histórico. O que era exclusivo daqui (Deslocamento §15, nav do técnico §14) já foi migrado: a §15 era um placeholder ("campos a definir") → recuperada em §4.1 do novo doc; a §14 (3 botões) foi substituída pelo hub de 5 áreas (§7).

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

---

## 5. Orçamento

- **Quem cria:** **comercial**. Pode ser **transformado de um pré-orçamento** ou **criado novo** (`pre_orcamento_id` opcional).
- **Preços:**
  - **Serviço:** digitado na hora (manual).
  - **Material do catálogo:** puxa o preço do **Omie**, mas **editável**.
  - **Item avulso:** preço digitado na mão.
- **Ao finalizar:** gera **só o PDF** (sem e-mail automático). O comercial/admin envia ao cliente do jeito dele (e-mail próprio, WhatsApp…).
- **O técnico não vê preço** — nem do produto, nem do orçamento (ver regra de dados em §10).

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

### Tela inicial do técnico (celular)
Lista das **OS abertas e vinculadas a ele**, com **cores por status/atividade** (aguardando execução, em pausa, almoço, concluída, concluída com pendência).

---

## 8. RAT (Relatório de Atendimento Técnico)

Cada RAT = uma visita/dia dentro de uma Tarefa. Offline-first.

- **Cabeçalho (nível Tarefa):** cliente, OS, tipo de tarefa, orientação/serviço solicitado.
- **Corpo (nível RAT, preenchido pelo técnico):** deslocamento (Sim/Não + horários — "Não" esconde os campos de deslocamento) · início/fim · **almoço/pausa** (checkbox → início/fim) · serviço executado · observações · fotos (múltiplas, com legenda) · **materiais utilizados** · tempo trabalhado (calculado).
- **Numeração:** `numero_rat` **sequencial atribuído pelo servidor** (nunca pelo dispositivo — evita colisão offline/multi-dispositivo).
- **Salvar rascunho** a qualquer momento (sem validação; status "Em andamento").
- **Concluir** (`Concluído` / `Concluído com pendências`) só com os campos obrigatórios preenchidos.
- "Concluído com pendências" (serviço) ≠ relatório completo (formulário) — são coisas distintas.
- **Ao concluir:** gera **PDF** + dispara **e-mail para adm@tsrv.com.br**.
- Campos do formulário são **configuráveis** (modelos por tipo de serviço).

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

**Visibilidade do técnico:** vê *orçada* e *levada* (leitura), edita só *utilizada*. **Não vê preço** (ver §10/§12).

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

**Pendente (próximos passos):**
1. ✅ **Reestruturação dois níveis** (feito, `bc485a4`): `tarefas`→`rats`; nova `tarefas` (OS/job); `rats.tarefa_id`; filhas `tarefa_id`→`rat_id`. Fundação validada no ar (OS → 2 RATs em dias → painel). Faturamento ainda na RAT (move no #6).
2. ✅ **Papel `comercial`** (feito, `e4f8efd`): liberado no CHECK, na tela de Usuários, no portal.
3. ✅ **Preço em `produtos`** (feito, `e4f8efd`): `preco_venda` do Omie (`valor_unitario`); 1714 produtos com preço.
4. **Módulo comercial** (em andamento):
   - ✅ 4.1 **Schema** — `pre_orcamentos`(+itens), `orcamentos`(+itens c/ preço e subtotal), links opcionais, status + arquivar, RLS por papel (técnico sem acesso a orçamento).
   - ⏭️ 4.2 Pré-orçamento (app de campo, offline) · 4.3 Orçamento (portal, comercial) · 4.4 Status/arquivo · 4.5 Serviços de PDF (servidor) e e-mail (Resend).
5. **Material/conciliação** com as 5 colunas + permissões por papel + preço oculto no nível de dados.
6. **Faturamento:** revisão do admin, escrita da OS no Omie ("a Faturar") com idempotência, retorno do status faturado.
7. **PDF + e-mail ao finalizar** (serviço compartilhado).
8. Regras: 1 RAT por (OS, dia); 1 almoço por (técnico, dia); status em dois eixos.

---

---

## 14. App do técnico — navegação (home pós-login)

Após o login, o técnico vê um **painel com botões** (não mais a lista direta de RATs):

1. **Ordens de Serviço** → lista das **OS destinadas a ele** (com cores por status/atividade). Ao abrir uma OS: **Nova RAT** (do dia) ou continuar a **RAT em andamento** daquele dia. (RAT sempre vive dentro de uma OS — não há mais RAT avulsa.)
2. **Pré-Orçamento** → **Novo Pré-Orçamento** (o levantamento de campo; formulário **fixo**; sem preço). Lista os dele. *(Nome "Pré-Orçamento" no app do técnico para não confundir com o orçamento do comercial.)*
3. **Deslocamento** → **Novo Deslocamento** — artefato próprio, **formulário fixo específico para deslocamento com pernoite** (viagem com pernoite). *(Campos a definir — ver §15.)*

> Formulários do técnico são **fixos** (pré-orçamento e deslocamento), não configuráveis. A RAT segue configurável por tipo de serviço.

## 15. Deslocamento (pernoite) — NOVO artefato

Formulário fixo, registro próprio (tabela `deslocamentos`), offline-first como os demais artefatos de campo. **Campos a definir com o time** (ex.: destino, data/hora de ida e volta, nº de pernoites, quem viajou, veículo, despesas?, observações, fotos?). Pendente de especificação antes de construir.

*Fim do documento. O que faltar, a gente acrescenta aqui.*
