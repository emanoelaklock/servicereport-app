# Plano — Varredura/recuperação do banco legado `service_report`

> **Status:** aprovado em conceito (aguardando). NÃO implementar antes de:
> 1. os 3 patches de `fix/tecnico-sessao-banco-e-ui` entrarem em produção, e
> 2. aprovação formal deste plano.
>
> Implementação irá em branch própria: **`fix/recuperar-banco-legado`**.

## Contexto (o bug que originou isso)
Antes do Patch 1, o `init()` do app do técnico resolvia o usuário via `getUser()` (chamada de
rede). Num soluço de conexão / token renovando, `getUser()` voltava `null` → o app caía no
banco legado `service_report` em vez do `service_report_u_<uid>`. Se o técnico **criou ou editou
uma RAT enquanto via a lista vazia**, esse trabalho ficou gravado no banco legado e **não subiu**.

O servidor está íntegro (nada foi perdido lá). O risco é apenas de **trabalho local preso no
legado** de algum aparelho. Esta varredura recupera isso.

## Objetivo
Em cada aparelho, detectar trabalho **não sincronizado** preso no banco legado `service_report`
e migrá-lo pro banco do usuário logado `service_report_u_<uid>`, disparando `syncAll()` pra subir
— sem perder nada e **sem misturar dados de usuários diferentes**.

## Princípios que NÃO podem ser violados (CLAUDE.md)
- **Nunca apagar trabalho não-sincronizado** → a varredura **não deleta** nada do legado (só copia).
- **Não misturar dados entre técnicos** (risco de faturamento) → migra **só** o que é do usuário
  logado (guarda de propriedade).
- **Nunca sobrescrever em silêncio** → nunca clobbera um registro mais novo já existente; o que
  for ambíguo é **logado/sinalizado**, não descartado.
- **Idempotente** → rodar de novo não duplica (dedup por chave + checagem de presença).

## O que conta como "preso"
Qualquer registro com `sync_status` ∈ {`rascunho`, `salvo_local`, `na_fila`, `enviando`, `erro`}
(tudo que **não** é `confirmado`). `confirmado` já está no servidor → ignora.

## Guarda de propriedade (CRÍTICO — aparelho compartilhado)
O legado pode conter dados **pré-isolamento** de OUTRO técnico (antes de `service_report_u_<uid>`
existir). Migrar isso pro usuário errado é contaminação grave de faturamento. Regra:
- **RATs / segmentos / deslocamentos / pré-orçamentos:** migra só se o campo de dono
  (`tecnico_id`/equivalente) **== uid atual**.
- **Filhos (`fotos`, `materiais`, `eventos`):** seguem o pai — migra só os de RATs migradas
  (por `rat_uuid`/`rat_id`).
- Registro **sem dono** ou de **outro** técnico → **NÃO migra**; entra no relatório como
  "ignorado (outro/sem dono)".

> ⚠️ **Bloqueador por store:** sem confirmar o campo de dono de um store, esse store **não é
> migrado** (fail-safe). Ver "Pontos a confirmar" #1.

## Object stores (db-local.js, DB_VERSION 6)
| Store | const | keyPath | Campo de dono | Observação |
|---|---|---|---|---|
| `rats` | `ST_RATS` | `client_uuid` | `tecnico_id` ✅ | pai |
| `fotos` | `ST_FOTOS` | `id` | (via `rat_uuid`) | filho de RAT |
| `materiais` | `ST_MATERIAIS` | `id` | (via `rat_uuid`) | filho de RAT |
| `eventos` | `ST_EVENTOS` | `id` | (via `client_uuid`) | trilha da RAT |
| `segmentos` | `ST_SEGMENTOS` | `id` | **confirmar** | jornada |
| `deslocamentos` | `ST_DESLOC` | `id` | **confirmar** | pernoite |
| `preorcamentos` | `ST_PREORC` | `client_uuid` | **confirmar** | pré-orçamento |
| `preorc_itens` | `ST_PREORC_ITENS` | `id` | (via `preorc_uuid`) | filho de pré-orç. |
| `tarefas_local` | `ST_TAREFAS` | `id` | **confirmar** | tarefa offline |

## Algoritmo (por aparelho, 1x)
1. Resolver uid (garantido pelo Patch 1) e abrir o banco do usuário (via `DBLocal`, já ativo).
2. Abrir o legado `service_report` em conexão **crua e somente leitura**, **sem** passar
   `DB_VERSION` (abre na versão existente; não dispara `onupgradeneeded`/criação de stores).
   Se não existir → no-op (caso da grande maioria dos aparelhos).
3. Para cada store (`rats`→filhos `fotos`/`materiais`/`eventos`; depois `segmentos`,
   `deslocamentos`, `preorcamentos`→`preorc_itens`, `tarefas_local`):
   - Ler todos; filtrar por **não-confirmado** + **guarda de propriedade**.
   - Para cada candidato, conferir no banco do usuário por chave
     (`client_uuid` p/ RATs/preorc, `id` p/ os demais):
     - **ausente** → copia preservando chave/ids;
     - **presente e mais novo** (ou já `confirmado`) no banco do usuário → **pula** (não clobbera);
     - **presente e mais antigo** → atualiza com a lógica do `aplicarDoServidor`
       (pendente local vence).
4. Acumular **relatório**:
   `{ rats, fotos, materiais, eventos, segmentos, deslocamentos, preorc, tarefas, ignorados_outro_dono }`.
5. Se migrou algo → `SyncEngine.syncAll()` pra subir.
6. **Não apaga** o legado. Marca `localStorage['sr_legacy_swept_<uid>'] = '1'` pra não repetir;
   a checagem por presença já torna tudo **idempotente** (rodar de novo não duplica).

## Onde encaixa
- Função nova em `db-local.js` (tem acesso interno ao IndexedDB): `migrarDoLegado(uid)` → retorna
  o relatório. Faz leituras cruas do legado e `put` no banco do usuário preservando ids.
- Chamada em `tecnico.js` no `init()`, **depois** do `isolarPorUsuario(uid)`, guardada por
  `sr_legacy_swept_<uid>` (e exposta como gatilho manual, ex.
  `window.TecnicoApp.recuperarLegado()`, caso a flag já tenha disparado num aparelho específico).
- Toast discreto se recuperou algo ("Recuperamos N itens que não tinham subido").

## Como "detectar quais aparelhos têm trabalho preso"
Não dá pra saber server-side qual aparelho tem dado local. A detecção é **em runtime, por
aparelho**: a varredura roda, recupera e os registros sobem pelo sync. Depois do deploy, dá pra
**monitorar no servidor** registros recém-chegados com `criado_em` antigo (lacuna grande entre
`criado_em` e `recebido_em`) — esse é o sinal de recuperação. Opcional: a função pode registrar
um evento de telemetria com as contagens.

## O que este plano NÃO faz
Não mexe em produção sozinho; não deleta o legado; não migra dado de outro técnico; não
conclui/encerra RAT; não toca faturamento.

## Verificação (quando for executar)
- **Em navegador** (como no smoke-test do Patch 1): semear um legado falso com
  (a) RAT não-confirmada do uid atual → deve migrar e subir;
  (b) RAT de outro `tecnico_id` → **não** migra (entra em "ignorados");
  (c) RAT já existente e mais nova no banco do usuário → **não** é sobrescrita.
- **Servidor:** contagem de não-confirmados por técnico antes/depois; conferir que nada de outro
  dono apareceu.
- Rodar 2x → idempotente (sem duplicar).

## Pontos a confirmar na implementação (BLOQUEADORES)
1. **Campo de dono** em `segmentos`, `deslocamentos`, `preorcamentos`, `tarefas_local`
   (RAT já tem `tecnico_id`). **Sem isso, o store não é migrado.**
2. Abrir IndexedDB sem versão não dispara `onupgradeneeded` no ambiente (Safari iOS incluso).
3. Reusar a lógica de merge do `aplicarDoServidor` p/ "mais novo vence" sem regressão.
