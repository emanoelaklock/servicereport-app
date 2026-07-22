# Fase C — Conciliação de almoço SR × Sólides/Tangerino — DESENHO FINAL (portão)

> **DECISÃO CONSOLIDADA (22/07):** Fases C e D **aprovadas conceitualmente**; autorizado
> **somente o PR-C1** (fundação + espelho + vínculos + trilha + Edge GET-only + testes + docs),
> entregue **parado antes do merge**. O `TANGERINO_TOKEN` será provisionado manualmente no
> Dashboard **somente após a revisão do PR** — nunca solicitar, exibir ou registrar o valor.
> A evolução visual (Fase D) será **na tela existente `jornada.html`** — não haverá tela nova;
> mockup aprovado: `docs/mockups/mockup-jornada-conciliacao-tangerino.png`. Ainda **não**
> implementar: mudanças em `jornada.html`, cálculo de cobertura, classificação manual,
> fechamento mensal, mudanças em `almocos`, escrita no Tangerino, integração com Desempenho.
> Processo: toda alteração (inclusive docs) via branch + PR — sem commit direto na `main`.

> Sequência de `docs/integracao-tangerino-estudo.md` (estudo aprovado; pendências P1–P3
> respondidas em 22/07: **técnicos devem bater sempre** saída/retorno do almoço; **marcações
> reais**, não pré-assinaladas; **token de API já existe**). Este documento é o desenho de
> implementação da Fase C — **nada implementado**: sem código, sem migrations, sem cron, sem
> secrets. Implementação só após aprovação deste portão, PR a PR.

## 0. Invariantes de segurança (não-negociáveis, valem para todos os PRs)

1. Token **nunca** é exibido, copiado ou registrado (nem em log, nem em erro, nem neste repo).
   Vive **só** como Function Secret (`Deno.env.get('TANGERINO_TOKEN')`), provisionado à mão no
   Dashboard.
2. **Nenhuma chamada à API do Tangerino a partir do navegador** — todo tráfego passa pela Edge
   Function (server-side).
3. O SR **nunca escreve** no Tangerino: a Edge só usa `GET`; nenhuma rota de escrita
   (`POST/PUT/DELETE`) entra no código, nem "por precaução".
4. **Nenhuma alteração automática em `almocos`**: a Fase C não insere, não edita, não deriva nada
   na tabela viva. O espelho é side-car de leitura.
5. Nenhuma marcação oficial é criada, corrigida ou invalidada — o registro legal é do Tangerino.

## 1. O que a validação do Swagger cravou (22/07)

| Ponto | Veredicto | Consequência no desenho |
|---|---|---|
| **Identidade da marcação** | ✅ `Punch.id` (int64) único; **o par entrada/saída é UM registro** (`dateIn`+`dateOut` no mesmo objeto; `pendingType ENTRADA\|SAIDA\|AMBOS` marca metade pendente) | Dedup por `id`; não precisamos parear batidas cruas — a Sólides já pareia |
| **Correção retroativa** | ✅ edição é **in-place no mesmo `punchId`** (`POST /modify` usa punchId + hora antiga/nova; flags `adjust`, `edited`, `editedIn/Out`); `Punch.lastModifiedDate` existe | Upsert por `id` + recomputar a conciliação dos dias afetados; cursor avança por `lastModifiedDate` |
| **Incremental** | ✅ doc narrativa: `lastUpdate` é o mecanismo de polling ("passe a data da última requisição"); família documenta como **millis**; o spec do punch declara int32 (provável erro de spec) | Cursor em millis; conferir na prática no reconhecimento (R3) |
| **Paginação** | ✅ estilo Spring (`page`/`size`, `Page«Punch»` com `totalElements`); **sem default/máximo documentado** | Página pequena fixa (ex.: 200) e iteração até `last=true` |
| **Fuso** | ⚠️ campos de resposta **sem** documentação de offset; `Employee.timezone` é enum nomeado (`SAO_PAULO` → `America/Sao_Paulo`, mapeamento publicado) | **Reconhecimento empírico R1** antes de qualquer parser definitivo; espelho guarda o texto cru + normalizado |
| **Exclusão** | ⚠️ `Punch.excluded` (bool) existe, semântica **não documentada**; não há filtro `excluded` no GET | Espelho guarda o flag; **R2** verifica se excluído some ou vem `true` |
| **Rate limit** | ❌ nada documentado (nem 429) | Desenho conservador (§6) + pergunta formal à Sólides segue de pé |
| **Escala** | ✅ bônus: `GET /v2/employee-work-schedule/{id}` retorna `startMainInterval`/`endMainInterval` e `preAssignedInterval` (bool) | Rotula qual gap é o almoço; `preAssignedInterval` vira **checagem defensiva** de P2 por colaborador |
| **Employer `find-all` (diagnóstico server-side 22/07, sanitizado)** | ✅ **`showFired=true` retorna SOMENTE os demitidos** ("mostrar OS demitidos"); sem o parâmetro vêm os ativos. Campos comprovados: `id` (number), `name` (string), `cpf` (string, 8/8 no conjunto testado), `externalId` (string, 7/8), **`fired` (boolean explícito)**; reforço `resignationDate` (number). **`excluded` NÃO existe** no payload. Paginação Spring padrão (página inicial 0, `first`/`last`) | Consulta definitiva = **duas buscas paginadas unidas por id** (ativos + demitidos), `demitido = fired === true` estrito (inconsistência → erro sanitizado); contagens do dia: 12 ativos, 8 demitidos, 11 ids distintos batendo ponto na janela de 3 dias, 0∩demitidos |

**Reconhecimento empírico (R1–R3)** — primeiro uso do token, dentro do PR-C1, só `GET`, resultados
anotados no próprio doc (sem dados pessoais além do necessário):
- **R1 (fuso):** buscar ~10 marcações de dias conhecidos e comparar com o portal Tangerino →
  fixa a interpretação de `dateIn`/`dateOut` (offset? hora local do colaborador? UTC?).
- **R2 (exclusão):** localizar (ou provocar via portal, pelo RH, não pela API) uma marcação
  excluída e observar: some do GET ou vem `excluded=true`?
- **R3 (lastUpdate):** editar uma marcação de teste no portal (RH) e confirmar que ela reaparece
  no filtro `lastUpdate` com `lastModifiedDate` avançado; confirmar unidade (millis).
- **Gate:** os três resultados documentados **antes** do PR-C3 (carga histórica).

## 2. Arquitetura — fluxo incremental Tangerino → SR

```
pg_cron (1×/dia 06:30 BRT)
  └─ net.http_post + x-cron-secret (Vault)            [padrão 0090/0125]
       └─ Edge Function `ponto-sync` (verify_jwt=false; TANGERINO_TOKEN via Deno.env)
            1. lê cursor da última execução OK (ponto_sync_execucoes)
            2. GET /punch?lastUpdate=<cursor>&page=N&size=200   (só colaboradores? não —
               a API filtra por employee opcionalmente; puxamos o delta geral e DESCARTAMOS
               na hora quem não está no ponto_colaboradores_map)
            3. para cada Punch: normaliza (R1) e UPSERT em ponto_marcacoes por tangerino_punch_id
            4. marca os (tecnico_id, dia) tocados e recomputa a conciliação desses dias
            5. grava execução (cursor novo = max(lastModifiedDate) visto, contagens, erro sanitizado)
```

- **Idempotência:** upsert por `tangerino_punch_id`; reprocessar o mesmo delta é no-op. O cursor
  só avança quando a execução termina OK — falha no meio ⇒ próxima rodada repete o delta inteiro.
- **Cinto e suspensório contra `lastUpdate` traiçoeiro:** além do delta, a rodada diária SEMPRE
  re-consulta a janela **D-7..D-0** por período (`startDateInMillis`/`endDateInMillis`) — pega
  correção tardia mesmo que o `lastUpdate` da Sólides tenha semântica inesperada. (Custo: ~7 dias
  × ~15 pessoas = pequeno.)
- **Retry (auditoria C1):** 3 tentativas com backoff 1s/3s/9s para 5xx/rede/429; **429 respeita
  `Retry-After`** quando fornecido (teto 30s); 401/403 aborta sem re-tentar (token/permissão —
  alerta humano); **deadline de 100s por rodada** (limite de execução da Edge) — estourou, aborta
  a rodada inteira sem avançar cursor. Erro persistente deixa o cursor parado (autocorretivo).
- **Método e autenticação (auditoria C1):** a execução grava no espelho do SR → **só POST**
  (GET/OPTIONS = 405; sem CORS — nunca chamada por navegador). Anônimo nunca passa: cron
  autentica por `x-cron-secret` (header, nunca URL) e só roda o delta; **modo manual exige JWT de
  admin/gestor** (`portal_acessos`). **Reconhecimento**: só admin autenticado E
  `ponto_config.reconhecimento_ativo` (desligar após fechar R1/R2/R3); amostra ≤5 linhas com o
  mínimo p/ R1/R2/R3 (sem nome/CPF/PIS/e-mail/payload bruto); não grava em `ponto_marcacoes`.
- **Preservação temporal (auditoria C1):** nenhuma conversão é irreversível — o espelho guarda
  cru + normalizado + fuso de origem também para o `lastModifiedDate`
  (`origem_modificado_raw`); a data local operacional é recalculável a partir do cru. Nada assume
  UTC ou Brasília sem o R1.
- **Ressalva D-7:** a janela é rede de segurança para correções **recentes**; a suficiência para
  exclusões e correções antigas só se afirma depois do R2/R3 — até lá, não é apresentada como
  solução definitiva.
- **Observabilidade:** `ponto_sync_execucoes` é a fonte (status, contagens, duração, erro
  sanitizado); painel/Jornada pode mostrar "ponto sincronizado até <data>"; execução `erro` por
  2 rodadas seguidas → aparece no painel admin (padrão cards âmbar). Logs da Edge **sem** token,
  sem URL com credencial, sem payload.

## 3. Modelo de dados (3 tabelas novas + 1 de config — nada criado ainda)

**`ponto_colaboradores_map`** — vínculo confirmado, auditável (pré-requisito de importação):
```
tecnico_id uuid pk → usuarios(id)
tangerino_employee_id bigint unique not null
tangerino_external_id text null
vinculado_por uuid not null → usuarios(id)     -- quem confirmou
vinculado_em timestamptz not null default now()
ativo boolean not null default true
observacao text
```
Regras: CPF **só** alimenta a sugestão de pareamento na tela de vínculo (comparação em memória,
nunca gravado no map); confirmação é humana; sem linha aqui ⇒ marcação descartada no sync e
técnico listado como `sem_vinculo` na conciliação. RLS: select/insert/update só admin/gestor_axis;
service_role lê no sync.

**`ponto_marcacoes`** — espelho imutável-por-humanos (só a Edge escreve):
```
id uuid pk default gen_random_uuid()
tangerino_punch_id bigint unique not null        -- Punch.id (chave de dedup/upsert)
tecnico_id uuid not null → usuarios(id)          -- resolvido via map na importação
dia date not null                                 -- dia LOCAL da entrada (regra fixada no R1)
entrada timestamptz null                          -- dateIn normalizado
saida timestamptz null                            -- dateOut normalizado
entrada_raw text / saida_raw text                 -- string crua da API (auditoria do parser)
status_origem text not null                       -- APPROVED|PENDING|REPROVED
excluido_origem boolean not null default false    -- Punch.excluded
editado_origem boolean not null default false     -- Punch.edited/adjust (qualquer flag de edição)
pendente_metade text null                         -- pendingType: ENTRADA|SAIDA|AMBOS
tz_origem text not null                           -- enum do employee usado na normalização
origem_modificado_em timestamptz null             -- Punch.lastModifiedDate
importado_em timestamptz not null default now()
atualizado_em timestamptz not null default now()  -- trigger padrão (delta-pull futuro, Fase B)
```
Minimização LGPD: **não** entram GPS/localização, foto, NSR, CPF/PIS, e-mail, device — só o
necessário para conciliar. Índices: `(tecnico_id, dia)`, `unique(tangerino_punch_id)`.
RLS Fase C: select admin/gestor_axis; escrita só service_role. (Fase B acrescenta select
`tecnico_id = auth.uid()` — fora deste portão.)

**`ponto_sync_execucoes`** — trilha de execução:
```
id uuid pk · iniciado_em · terminado_em
tipo text (delta|janela7d|carga_historica)
cursor_anterior bigint · cursor_novo bigint       -- millis
paginas int · novas int · atualizadas int · descartadas_sem_vinculo int
status text (ok|erro|parcial) · erro_sanitizado text
```

**`ponto_config`** — parâmetros ajustáveis sem deploy (linha única ou chave/valor):
tolerância de **início** (min), **término** (min), **duração** (min), janela de busca do almoço
(default 10:00–15:00), duração mínima de gap considerada (default 15 min), retenção do espelho
(default 12 meses). Editável só por admin; valores iniciais entram **após a calibração** (§5).

## 4. Inferência do intervalo de almoço (pessoa-dia)

Entrada: os registros de `ponto_marcacoes` do (tecnico, dia), `status_origem='APPROVED'`,
não excluídos, ordenados por `entrada`.

1. **Dia são:** ≥2 registros completos (entrada e saída presentes, `pendente_metade` null) e sem
   sobreposição entre pares → candidatos a almoço = gaps entre `saida[n]` e `entrada[n+1]`.
2. **Rótulo do almoço:** o gap que **intersecta o intervalo previsto da escala**
   (`startMainInterval`/`endMainInterval`, consultado 1×/colaborador e cacheado em memória da
   execução) — ou, sem escala disponível, o **maior gap dentro da janela configurada**
   (default 10:00–15:00 local) com duração ≥ mínima configurada.
3. **Múltiplas pausas:** só o gap rotulado vira "almoço do ponto"; os demais aparecem no detalhe
   do dia como pausas adicionais (informativo, sem status próprio na Fase C).
4. **Resultado por dia:** `(almoco_ponto_inicio, almoco_ponto_fim, qualidade)` onde qualidade ∈
   `ok | incompleto | inconclusivo`:
   - `incompleto`: **par sem saída (`saida` null) — critério DIRETO, comprovado no
     reconhecimento de 22/07: a API retorna `dateOut: null` com `pendingType: null`, ou seja,
     ponto incompleto é determinado pela AUSÊNCIA de saída, nunca apenas por `pendingType`** —
     além de nº ímpar de metades (`pendente_metade` ≠ null), par cruzando meia-noite e pares
     sobrepostos/duplicados após dedup;
   - `inconclusivo`: registro `PENDING` cobrindo a janela do almoço, ou nenhum gap na janela em
     dia com um único par longo (pode ser almoço não batido — vira tipologia, não qualidade).
5. **Checagem defensiva de P2:** se a escala do colaborador vier com `preAssignedInterval=true`,
   o dia é marcado `inconclusivo` com motivo "intervalo pré-assinalado na escala" — protege a
   conciliação de comparar contra intervalo não-medido (mesmo P2 dizendo que não é o caso hoje).

A inferência roda **no servidor** (função SQL ou na própria Edge ao final do sync), materializada
por dia tocado — a tela não calcula nada.

## 5. Carga histórica + calibração das tolerâncias

**PR-C3 — primeira carga (30–60 dias):**
- Execução manual controlada da mesma Edge em modo `carga_historica`: varre por **janelas de 7
  dias** (`startDateInMillis`/`endDateInMillis`), páginas de 200, pausa de ~1s entre páginas
  (conservador até a Sólides responder sobre rate limit), registrando cada janela em
  `ponto_sync_execucoes`. Reexecutável (idempotente por `tangerino_punch_id`).
- **Gate de reconhecimento (R1–R3) precisa estar fechado antes** — o parser de fuso é definitivo.

**Calibração (dentro do PR-C3, entregável = números na `ponto_config` + nota no estudo):**
- Cruzar `almocos` (declarado SR) × inferência do ponto no período comum; medir distribuição de
  `Δinicio`, `Δtermino`, `Δduracao` (mediana, p75, p90, p95).
- Proposta de corte: âmbar além do **p90** de cada delta, com **piso de 5 min** (não alertar ruído
  de carimbo) e **teto de 30 min** (não engolir divergência grosseira mesmo que o p90 venha alto).
  Três tolerâncias independentes — o SR declara início com precisão de carimbo mas duração "1h
  redonda" em 64% dos casos (amostra de 66), então espera-se tolerância de duração ≠ de início.
- Os números finais são **decisão da gestão** sobre a proposta calibrada — apresentados no gate C3.

## 6. Tipologia, severidade e tela

**Status por pessoa-dia ativo** (âncora: participação em `vw_participacoes_dia`; pré-orçamento
fora do recorte na Fase C — decisão do estudo):

| Status | Severidade | Cor/tratamento |
|---|---|---|
| `conciliado` | — | verde, colapsado por padrão |
| `divergente_duracao` | **alta** (impacta horas faturáveis) | âmbar, topo da lista |
| `ponto_sem_sr` (intervalo batido, SR sem almoço) | **alta** (almoço não descontado no SR) | âmbar |
| `sr_sem_ponto` (SR declara, ponto sem intervalo inferível) | média | âmbar |
| `divergente_horario` (início/término deslocados, duração ok) | baixa | âmbar claro |
| `sem_vinculo` | operacional | seção própria no topo ("configurar vínculo") |
| `incompleto` / `inconclusivo` | informativo | cinza, com motivo ("batida ímpar", "PENDING", …) |
| `fora_recorte` (ponto sem atividade SR) | nenhuma | oculto por padrão (filtro opcional) — férias/escritório **não são divergência** |

**Tela (portal, read-only):** página nova no padrão da Jornada/lentes — filtros período + técnico;
KPIs (dias conciliados / divergentes / incompletos / sem vínculo); linha por pessoa-dia com
almoço SR (horários + artefato de origem) × ponto (intervalo inferido + qualidade), status com
chip de cor; drill-down mostra os pares do dia e as pausas adicionais. Cards âmbar no padrão
`devol-alert` do Painel. **Sem botão de correção**: qualquer ajuste segue o fluxo humano de hoje
(editar RAT auditado / devolver ao técnico). A tela não escreve nada.

## 7. LGPD, perfis e retenção

- **Finalidade declarada:** conferência operacional de intervalo de almoço em dias de atividade
  de campo — não é instrumento de desconto automático (texto fixo na tela).
- **Minimização:** só colaboradores vinculados; só campos necessários (§3); recorte de exibição
  pessoa-dia ativo; sem localização/foto/biometria/PIS/CPF no espelho.
- **Acesso:** RLS admin/gestor_axis; `security_invoker` em toda view (regra F17, com redeclaração
  em todo `create or replace`); técnico não vê ponto de ninguém na Fase C.
- **Retenção:** espelho com purga mensal além da janela configurada (default 12 meses; cron da
  casa) — o registro legal permanece íntegro no Tangerino.
- **Token:** Function Secret apenas; provisionamento manual no Dashboard; erro sanitizado.

## 8. Plano em PRs pequenos — gates e smoke (branch própria + PR cada um)

| PR | Conteúdo | Gate de entrada | Smoke de saída |
|---|---|---|---|
| **C1 — fundação + reconhecimento** | migração das 4 tabelas (RLS deny-by-default) + Edge `ponto-sync` (GET-only, delta+janela7d, sem cron ainda) + provisionamento manual do secret | aprovação deste desenho | execução manual da Edge: R1/R2/R3 documentados; espelho recebe marcações reais; `ponto_sync_execucoes` com contagens; **zero** rotas de escrita no código (revisão de PR confere) |
| **C2 — vínculos** | tela admin de vínculo (sugestão por CPF em memória, confirmação carimbada) | C1 mergeado | 15 técnicos vinculados ou justificados; `sem_vinculo` zerado para ativos |
| **C3 — carga histórica + calibração** | modo `carga_historica`; relatório de deltas; proposta de tolerâncias | R1–R3 fechados; C2 completo | 30–60 dias importados sem erro; distribuição de Δ apresentada; gestão fixa tolerâncias na `ponto_config` |
| **C4 — conciliação + tela** | inferência materializada + status/tipologia + página do portal + agendamento do cron diário (`0125`-style, Vault) | tolerâncias aprovadas no gate C3 | conferência manual de ~10 dias variados (1 de cada status) contra o portal Tangerino; tela sem nenhuma via de escrita; cron roda 2 dias seguidos com `ok` |

Cada PR: commits pequenos, spec/`ENGINE` intocados, sem SW bump (app não muda na Fase C),
verificação descrita no corpo do PR (regra da casa).

**Rollback (em qualquer ponto):** `cron.unschedule('ponto-sync-diario')` → sync para; tela mostra
"sincronizado até <data>"; Edge pode ser removida; em último caso `drop` das 4 tabelas — **nada do
fluxo vivo (RAT, `almocos`, faturamento, Jornada) depende delas**. Fase C é side-car puro.

## 9. Riscos residuais (aceitos neste portão)

1. **Fuso não documentado** — mitigado por R1 antes da carga; espelho guarda o cru para reprocesso.
2. **Rate limit desconhecido** — mitigação: páginas pequenas + pausa + backoff; pergunta formal à
   Sólides continua aberta (Q3 do estudo); pior caso: carga histórica mais lenta.
3. **`lastUpdate` com semântica diferente do esperado** — mitigado pela janela D-7 diária
   (correções tardias chegam mesmo sem delta confiável) e por R3.
4. **`excluded` sem semântica** — mitigado por R2 + flag no espelho (excluído nunca entra na
   inferência).
5. **Disciplina de batida** (P1 é regra, não garantia) — dias sem batida viram `sr_sem_ponto`/
   `incompleto`; é exatamente o que a gestão quer enxergar, não um defeito da integração.

---
*Portão: aprovando este desenho, a implementação começa pelo PR-C1. Nenhuma linha de código,
migração, cron ou secret foi criada por este documento.*
