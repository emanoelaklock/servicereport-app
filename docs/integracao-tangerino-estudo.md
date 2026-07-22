# Integração de almoço SR × Sólides/Tangerino — estudo no portão (22/07/2026)

> **Direção aprovada:** Tangerino → SR; o SR **somente lê e concilia**; nenhuma gravação, ajuste
> ou marcação no Tangerino (registro legal intocado). **Fase C** = conciliação (server-side +
> portal); **Fase B** (futura) = sugestão de almoço na RAT, **sempre confirmada pelo técnico**.
> Este documento é o entregável do levantamento read-only — **nada foi implementado, nenhuma
> tabela criada, nenhum token provisionado, lógica de `almocos` intocada**.

---

## 1. Viabilidade técnica — resumo executivo

**Viável, com fundação melhor do que o esperado.** Três fatos principais:

1. **A API oficial existe e é pública** (docs.tangerino.com.br, Swaggers abertos): autenticação por
   token estático em header, colaboradores com `externalId`/CPF/PIS, marcações **já pareadas**
   (`dateIn`/`dateOut`) com filtro incremental `lastUpdate` — desenho ideal para pull por cron.
   Sem webhook (só pull). Token liberado **sob demanda pelo suporte** da Sólides.
2. **O SR já reservou o encaixe** (migração 0055, de junho): `almocos.origem` tem CHECK
   `('manual','ponto')` com comentário explícito *"origem 'ponto' fica RESERVADA para a futura
   integração Tangerino"*; a UI do app e da Jornada **já renderizam o rótulo `ponto`**
   (`js/tecnico.js:3230`, `js/jornada.js:204-205`). O dedup pessoa/dia (`UNIQUE (tecnico_id, dia)`
   + `fn_registrar_almoco` + `almoco_conflitos`) está no servidor e não precisa mudar.
3. **A infra de importação já tem padrão na casa**: `pg_cron` → `net.http_post` → Edge Function com
   `x-cron-secret` lido do Vault (0090/0094/0125), segredos por `Deno.env` (P1a). O
   `TANGERINO_TOKEN` entra como Function Secret nesse mesmo molde.

O que **não** é dado ainda: liberação do token no plano contratado, fuso das datas da API, rate
limit e o comportamento real das batidas de almoço dos nossos técnicos (ver §2 e §8).

## 2. Pendências operacionais — ✅ RESPONDIDAS (22/07)

| # | Pergunta | Resposta |
|---|---|---|
| P1 | Os técnicos batem saída e retorno do almoço no Tangerino? | **Sim — é regra: devem registrar sempre** saída e retorno do almoço. |
| P2 | O intervalo é marcação real ou pré-assinalação? | **Marcações reais** (não pré-assinaladas) — o ponto mede o almoço de verdade; a conciliação de duração e a futura Fase B fazem sentido. |
| P3 | O contrato tem token de integração habilitado? | **Sim — acesso à API/token já existe.** Guardar exclusivamente como Function Secret quando a Fase C começar (nunca exibir/copiar/registrar). |

Com as três respondidas, o estudo avança para o **desenho final da Fase C** —
ver `docs/ponto-fase-c-desenho.md` (portão de implementação).

**Estado do ambiente (verificado em 22/07, sem tocar em segredo):** não há **nenhuma** referência a
`TANGERINO_TOKEN` no repositório (grep limpo), nenhuma Edge Function de ponto, nenhuma tabela de
espelho. A existência de Function Secret não é visível pelas ferramentas daqui (comportamento
correto para segredo) — checar no Dashboard do Supabase (Functions → Secrets) e no portal Tangerino.
O token, quando vier: **só Function Secret** (`Deno.env.get('TANGERINO_TOKEN')`) — nunca navegador,
nunca código, nunca tabela (regra do CLAUDE.md, que já cita esse token).

## 3. API oficial — mapa do que foi confirmado

Fontes primárias: portal https://docs.tangerino.com.br/ e os Swaggers públicos
(`employer.tangerino.com.br/v2/api-docs` e `api.tangerino.com.br/api/punch/v2/api-docs`).
Grau de confiança marcado por item; detalhes e URLs no relatório de pesquisa (base deste §).

- **Autenticação [confirmado]:** token estático, header `Authorization: Basic <token>`; liberação
  pelo suporte; token fica no portal do empregador. Não é OAuth. *(Por empresa ou por usuário: não
  documentado — perguntar.)*
- **Colaboradores [confirmado]:** `GET /employee/find-all` (paginado, filtro `lastUpdate` em ms,
  `showFired`) e `GET /employee/find` por `tangerinoId` **ou `externalId`**. O modelo `Employee`
  tem **CPF e PIS**.
- **Marcações [confirmado]:** Punch API `GET /` com filtros `employeeId`/`externalId`,
  `startDateInMillis`/`endDateInMillis`, **`lastUpdate`** (delta), `status`
  (APPROVED|PENDING|REPROVED), paginação. O registro **já vem pareado**: `dateIn`/`dateOut`
  (+ `nsrIn`/`nsrOut`, localização). A doc avisa que o próprio sistema organiza entradas/saídas.
- **Almoço [inferido]:** **não há campo "almoço"** em nenhum schema examinado. O intervalo é o
  **gap entre dois pares do mesmo dia** (saída do 1º trecho → entrada do 2º). Rotular qual gap é
  almoço fica com o consumidor (heurística: maior gap entre ~10h e ~15h; cruzável com a escala).
- **Correções/exclusões [confirmado parcial]:** `status` PENDING/REPROVED existe nos filtros;
  `lastUpdate` cobre marcações corrigidas/lançadas depois. Semântica exata de exclusão: perguntar.
- **Apuração [confirmado]:** `GET /daily-summary/` traz horas trabalhadas/saldos, **sem** campo de
  intervalo. Folha de ponto via Report API retorna **PDF em base64** (não serve para parsing).
- **Fuso [não encontrado]:** a doc não explicita o fuso de `dateIn`/`dateOut` nem dos filtros em
  ms. **Crítico — perguntar antes de qualquer parser.**
- **Rate limit / janela máxima [não encontrado]:** nada na doc. Perguntar; desenhar o cron
  conservador até lá.
- **Webhook [não encontrado]:** modelo é pull; `lastUpdate` é o mecanismo incremental previsto.
- **Fallback fiscal [confirmado]:** exportação AFD existe (UI e endpoint) — é rede de segurança
  para auditoria, não canal de integração (ASCII posicional, batidas cruas).
- **Dependem de liberação comercial:** o token em si (suporte), e possivelmente a Report API.

## 4. Matching de identidade (técnico SR ↔ colaborador Tangerino)

**Estado atual:** o vínculo interno do SR é frágil por design herdado — a 0055 casa participação
por **nome** (`lower(trim(nome))`), e a coluna `usuarios.cpf` **existe em produção (15/15 ativos
preenchidos) mas não é versionada** em migração (base pré-0002). Nome não pode ser chave; CPF
não-versionado não deve virar chave operacional.

**Proposta (conforme direção): tabela explícita de vínculo, auditável**

`ponto_colaboradores_map` (1 linha por técnico vinculado):
- `tecnico_id uuid` FK `usuarios` (unique) · `tangerino_employee_id bigint` (unique) ·
  `tangerino_external_id text null` · `vinculado_por uuid` + `vinculado_em timestamptz` (auditoria)
  · `ativo boolean` · `observacao text`.
- **Origem do vínculo:** tela administrativa simples (ou seed via SQL revisado): lista colaboradores
  da API × usuários do SR, **CPF apenas como sugestão de pareamento inicial** — a confirmação é
  humana e fica carimbada. Depois de confirmado, a chave operacional é `tangerino_employee_id`.
- **Melhor ainda (se a Sólides permitir):** preencher o `externalId` do colaborador no portal
  Tangerino com o `usuarios.id` do SR — vínculo bidirecional sem depender de CPF. (Pergunta Q7.)
- Sem vínculo → técnico aparece na conciliação como **`sem_vinculo`** (nunca casado por heurística
  silenciosa).

## 5. Modelo de dados candidato (Fase C — nada criado ainda)

**`ponto_marcacoes`** — espelho **imutável** do que a API retornou (append/update por chave de
origem; nunca editado por humano):
- `id uuid pk` · `tangerino_punch_id bigint unique` (dedup pela chave original) ·
  `tecnico_id uuid` (resolvido via map no momento da importação) · `tangerino_employee_id bigint` ·
  `dia date` · `entrada timestamptz` · `saida timestamptz` (par `dateIn`/`dateOut` como veio) ·
  `status_origem text` (APPROVED/PENDING/REPROVED) · `tz_origem text` ·
  `origem_atualizado_em timestamptz` (o `lastUpdate` deles) · `importado_em timestamptz` ·
  `atualizado_em timestamptz` (nosso, para o delta-pull do portal se um dia precisar).
- **Minimização LGPD:** não guardar payload bruto, nem localização, nem NSR, nem CPF/PIS — só o
  necessário para conciliar (quem, quando, par entrada/saída, status). Marcação de colaborador sem
  vínculo **não é importada**.
- RLS: leitura só `admin`/`gestor_axis` na Fase C (Fase B acrescentaria política
  `tecnico_id = auth.uid()` para o próprio técnico ler a sugestão dele). Escrita: só service_role
  (Edge). `security_invoker` em qualquer view por cima (regra da casa, F17).

**`ponto_sync_execucoes`** — trilha de cada rodada do cron:
- `id` · `iniciado_em`/`terminado_em` · `cursor_anterior`/`cursor_novo` (o `lastUpdate` em ms) ·
  `status (ok|erro|parcial)` · `marcacoes_novas`/`atualizadas` int ·
  `erro_sanitizado text` (mensagem **sem** token/URL com credencial/dado pessoal).

**Estratégia do sync (cron):**
- Edge Function `ponto-sync` (padrão 0090/0125: `verify_jwt=false`, `x-cron-secret` do Vault,
  `TANGERINO_TOKEN` por `Deno.env`). Agenda proposta: **1×/dia de manhã** (ex.: 09:00, importa
  D-1 e reprocessa D-7..D-1 via `lastUpdate` para pegar correções tardias) — conservador até
  conhecer o rate limit; frequência sobe depois se a Fase B pedir.
- Escopo do pull: **só colaboradores presentes no map** (minimização). O recorte "pessoa-dia com
  atividade no SR" é aplicado **na conciliação**, não no pull — o cursor incremental por
  `lastUpdate` não combina com filtro por dia-com-atividade, e correções tardias chegariam furadas.
- **Sem tolerância a escrita:** a função só faz `GET`; nenhuma rota de escrita da API entra no
  código.

## 6. Casos que NÃO são "almoço óbvio" (mapa de armadilhas do pareamento)

A API entrega pares, não "almoços". A inferência precisa tratar explicitamente:

| Caso | Tratamento proposto |
|---|---|
| Nº ímpar de batidas / par sem `dateOut` | dia vira **`incompleto`** — nunca inferir almoço de par aberto |
| Marcação corrigida/lançada depois | chega pelo `lastUpdate` (janela D-7); espelho atualiza pela `tangerino_punch_id`; conciliação do dia é recalculada |
| Duplicidade de batida | dedup por `tangerino_punch_id`; se a API devolver pares sobrepostos, dia vira `incompleto` |
| Intervalo **pré-assinalado** | depende da resposta P3/Q5 — se pré-assinalado, o "ponto" não mede almoço e a tipologia de duração precisa ser reinterpretada (ou desligada) |
| Dia virando meia-noite | pareamento por dia **local** (fuso confirmado na Q4); par que cruza 00:00 fica no dia da entrada e marca `incompleto` para almoço |
| Mais de uma pausa no dia | candidato a almoço = maior gap na janela ~10h–15h; demais gaps ignorados na Fase C (listados no detalhe do dia) |
| Sem RAT/atividade no SR no dia | **fora do recorte** — não é divergência (férias/escritório); aparece no filtro só como informativo, nunca em âmbar |
| `status PENDING`/`REPROVED` | PENDING = `inconclusivo` (aguardando ajuste no Tangerino); REPROVED não entra no pareamento |

## 7. Conciliação (Fase C) — tipologia e tela

**Âncora do recorte:** participação em `vw_participacoes_dia` (RAT do dia, trecho de viagem,
deslocamento-do-dia). **Nota de decisão:** a view **não tem ramo de pré-orçamento** — a Jornada
soma pré-orçamento como participação sintética **no cliente** (`js/jornada.js:133-159`). Para a
conciliação server-side: ou (a) aceitar que pré-orçamento fica fora do recorte na Fase C
(recomendado — raro e simples), ou (b) criar o ramo na view (mexe em view vigiada — F17/0123,
redeclarar invoker). Decidir no portão.

**Tipologia (status por pessoa-dia ativo):**

| Status | Condição | Cor |
|---|---|---|
| `conciliado` | almoço SR e intervalo do ponto dentro das tolerâncias | verde |
| `divergente_duracao` | durações além da tolerância de duração | âmbar |
| `divergente_horario` | início/término deslocados além da tolerância (mesmo com duração ok) | âmbar |
| `sr_sem_ponto` | almoço declarado no SR, nenhum intervalo inferível no ponto | âmbar |
| `ponto_sem_sr` | intervalo no ponto, SR sem almoço declarado (pessoa-dia ativo) | âmbar |
| `sem_vinculo` | técnico ativo no dia sem linha no `ponto_colaboradores_map` | âmbar (seção própria) |
| `incompleto` | ponto ímpar/aberto/PENDING/cruza meia-noite | cinza (informativo) |
| `fora_recorte` | ponto existe, SR sem atividade no dia | oculto por padrão (filtro opcional) |

**Tolerâncias — proposta de calibração (sem cravar ±10min):**
- Amostra SR já medida (66 almoços completos, 13/06→22/07): início com precisão de carimbo
  (55/66 fora de múltiplo de 5min), mediana 12:11; **duração mediana 60min com 64% exatamente
  60min** — ou seja, o lado SR declara majoritariamente "1h redonda". A divergência típica vai
  aparecer na **duração**, não no início.
- Procedimento: importar 30–60 dias de ponto (primeiro sync), cruzar com a amostra SR e medir a
  distribuição de |Δinício|, |Δtérmino|, |Δduração|; propor cortes por percentil (ex.: âmbar além
  do p90 de cada delta, com piso mínimo para não alertar ruído de 2–3min e teto para não engolir
  divergência real). **Três tolerâncias separadas** (início / término / duração), parametrizadas
  em tabela de config — ajustáveis pela gestão sem deploy.

**Tela (portal, read-only, padrão das lentes):**
- Filtros: período + técnico (como Desempenho/Jornada). Uma linha por pessoa-dia ativo:
  horários SR (almoço declarado + artefato de origem) × Tangerino (intervalo inferido + status
  origem), status da tipologia com chip de cor; divergências em **âmbar** no padrão dos cards do
  Painel (`devol-alert`) e drill-down por técnico no padrão das 3 lentes (`js/desempenho.js`).
- **Nenhuma correção automática, nenhum desconto silencioso**: a tela só mostra; qualquer ajuste
  continua sendo o fluxo humano de hoje (editar RAT auditado / devolver ao técnico). A conciliação
  não escreve em `almocos`, não escreve no Tangerino, não altera faturamento.

## 8. Perguntas ao suporte da Sólides (plano contratado)

1. A API REST (docs.tangerino.com.br) está **inclusa no nosso plano**? O que precisam para
   **liberar o token de integração**?
2. O token é por **empresa** ou por usuário? Expira/rotaciona? Como revogar/regerar?
3. Existe **rate limit** (req/min, req/dia)? Janela máxima de `startDate`–`endDate` por consulta?
4. `dateIn`/`dateOut` retornam em **qual fuso** (UTC / empregador / colaborador)? E os filtros em
   milissegundos são interpretados em qual fuso?
5. Existe endpoint de **espelho apurado em JSON** com o intervalo de almoço identificado, ou o
   desenho é consumir os pares de `GET /punch` e inferir o intervalo pelo gap? O intervalo
   **pré-assinalado** aparece como marcação ou só na apuração da folha?
6. Batidas ímpares (esquecimento): como ficam na API? `PENDING` some do resultado quando ajustado?
   Exclusão de marcação gera algum sinal no `lastUpdate`?
7. Podemos preencher o **`externalId`** dos colaboradores pelo portal (sem API de escrita) para
   vincular à nossa base? CPF/PIS vêm sempre preenchidos no retorno de `/employee`?
8. Existe **webhook** de marcação ou o desenho oficial é polling por `lastUpdate`? Há frequência
   recomendada?
9. A Report API está ativa/inclusa? Há retorno estruturado além do PDF base64?
10. Existe ambiente de **homologação/sandbox**?

## 9. Riscos — privacidade e acesso (LGPD)

- **Dado de ponto é dado pessoal trabalhista.** Base legal: legítimo interesse/execução de contrato
  (gestão de jornada já é finalidade do Tangerino; o SR só **espelha o mínimo** para conciliar).
  Minimização aplicada no modelo: sem payload bruto, sem GPS das batidas, sem CPF/PIS no espelho,
  só colaboradores vinculados, e recorte de exibição pessoa-dia ativo.
- **Acesso:** Fase C = leitura restrita a `admin`/`gestor_axis` (RLS + `security_invoker` — lição
  F17). Técnico não vê ponto de colega em hipótese alguma; na Fase B vê **só o próprio dia**.
- **Segredo:** `TANGERINO_TOKEN` só como Function Secret; erros logados **sanitizados** (sem token,
  sem URL com credencial); regra já vigente no projeto (P1a).
- **Retenção:** propor janela de retenção do espelho (ex.: 12 meses) — o registro legal permanece
  no Tangerino; o espelho é operacional. Decidir com a gestão.
- **Risco de interpretação:** conciliar contra pré-assinalação (se P3 confirmar) geraria "falsas
  conciliações perfeitas" — por isso P1/P3 vêm **antes** de qualquer desenho final de tolerância.
- **Risco trabalhista de uso indevido:** a tela é de conferência operacional; **não** é instrumento
  de desconto automático — deixado explícito na tela e no spec quando implementar.

## 10. Fases, estimativa e rollback

**Fase C — conciliação (server-side + portal; app intocado, sem SW bump):**
1. **C0 — destravas externas** (sem código): respostas P1–P3 + Q1–Q10; token liberado e guardado
   como Function Secret (manual, Dashboard). *Dependência exclusiva de terceiros.*
2. **C1 — fundação** (1 PR): migração `ponto_colaboradores_map` + `ponto_marcacoes` +
   `ponto_sync_execucoes` (RLS restrito, invoker) + Edge `ponto-sync` (GET-only, cursor
   `lastUpdate`, janela D-7) + cron 1×/dia. ~2–3 dias de trabalho + homologação da 1ª carga.
3. **C2 — vínculos** (1 PR pequeno): tela/rotina de vínculo com sugestão por CPF e confirmação
   humana carimbada. ~1 dia.
4. **C3 — conciliação** (1 PR): cálculo da tipologia (view/RPC com as 3 tolerâncias em config) +
   tela read-only no portal (padrão lentes/âmbar). ~2–3 dias, incluindo a calibração com a
   amostra real (30–60 dias importados).
- **Rollback C:** desagendar o cron (`cron.unschedule`), desativar a Edge — o espelho para de
  crescer e a tela mostra "sem dados novos"; em último caso, drop das 3 tabelas. **Nada do fluxo
  atual (RAT/almoços/faturamento) depende delas** — side-car puro, risco de regressão ~zero.

**Fase B — sugestão de almoço na RAT (depois da C estabilizar):**
- App do técnico: ao abrir o modal Pausa/Almoço com rede, buscar sugestão do espelho do dia
  (mesmo padrão do `carregarAlmocosDia`) e pré-popular **com indicação de origem** ("do ponto —
  confirma?"); técnico ajusta livremente; **o declarado na RAT continua sendo dele** (o fluxo
  manual/`fn_registrar_almoco` não muda); offline ou sem marcação → campo manual como hoje,
  **nunca bloqueia**. Ganchos de UI já existentes (rótulo `ponto` em `tecnico.js:3230`).
- Requer: RLS de leitura do próprio dia no espelho (ou entrada no `SYNC_MAP` p/ offline-first) +
  SW bump. ~2–3 dias + teste de campo. Decisões de design (escrever ou não `origem='ponto'` em
  `almocos`) ficam para o portão da B — **não** são pré-decididas aqui.
- **Rollback B:** reverter o JS do app + SW bump (a sugestão é aditiva; sem ela o campo volta a
  ser manual).

**Fora de escopo permanente (reafirmado):** escrita no Tangerino; desconto automático; qualquer
uso do ponto para faturamento sem revisão humana.

---

*Levantamento: pesquisa da doc/Swagger oficiais (22/07), varredura do repo (migrações 0055/0056/
0090/0091/0094/0125, `js/tecnico.js`, `js/jornada.js`, `js/desempenho.js`, `js/painel.js`,
`js/sync.js`, `js/db-local.js`) e inspeção do banco de produção (schemas `almocos`/
`almoco_conflitos`/`usuarios`, cron.job, amostra de 66 almoços). Sem alteração de código, schema
ou segredo.*
