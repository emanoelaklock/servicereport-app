# Trilha Comercial — Pré-orçamento → Orçamento → Tarefa (OS)

**Documento de encerramento (gate C8, 19/07/2026).** Referência operacional e
técnica da trilha comercial implantada nos gates C0–C7. Nada aqui altera
comportamento; o script de integridade é somente leitura.

---

## 1 · O que é

Rastreabilidade completa e imutável do fluxo comercial:

```
Pré-orçamento (levantamento do técnico, app de campo)
   └─► Orçamento (editor do Gestão Comercial)   [orcamentos.pre_orcamento_id]
          └─► Tarefa/OS (execução no SR)        [tarefas.orcamento_id]
```

- **Vínculos canônicos**: só os dois FKs acima. `orcamentos.tarefa_id` é legado
  e não é usado pela trilha. Nunca há inferência por texto, número ou data.
- **Snapshot do levantamento** (`orcamentos.levantamento_snapshot`, jsonb):
  capturado **no servidor** no INSERT do orçamento com pré. Três estados:
  | `origem_captura` | badge no editor | significado |
  |---|---|---|
  | *(ausente)* | — (rodapé "Snapshot capturado em…") | captura original no INSERT |
  | `backfill_historico` | **Consolidado retroativamente** | consolidado pelo backfill C5a (`consolidado_em`); reflete o estado disponível no backfill, não o original |
  | `correcao_manual` | **Vínculo corrigido** | recapturado numa correção justificada do elo (`corrigido_em`) |
- **Eventos imutáveis** (`trilha_comercial_eventos`, sem FK rígida — sobrevivem
  a exclusões; UPDATE/DELETE bloqueados por trigger):
  `orcamento_criado_de_pre` · `elo_corrigido` · `elo_removido` ·
  `tarefa_gerada` · `tarefa_resincronizada` · `tarefa_removida` ·
  `baseline_pre_orcamento` · `baseline_orcamento_tarefa` (baselines = vínculos
  históricos consolidados no backfill, **não** operações observadas na data).
- **Atomicidade**: evento e mutação nascem NA MESMA transação (triggers em
  `tarefas`; RPCs transacionais). Falha no evento desfaz a operação.
- **Separação da F1**: a trilha comercial não toca `origem_tipo`,
  `tarefa_origem_id`, `rat_origem_id` nem `tarefa_origem_eventos`.

## 2 · Inventário (estado em produção, 19/07/2026)

**Migrations aplicadas e registradas** (`supabase_migrations.schema_migrations`):

| Arquivo | Registro | Conteúdo |
|---|---|---|
| `0115_trilha_comercial_fundacao.sql` | 20260719192000 | snapshot server-side · tabela de eventos · validação de cliente (FOR UPDATE) · triggers de elo e de tarefa · RPCs sincronizar/remover |
| `0116_trilha_navegacao_rpcs.sql` | 20260719214500 | `trilha_da_tarefa` / `trilha_do_pre` (cadeia por tela, id de orçamento condicionado ao papel) |
| `0117_trilha_backfill_baseline.sql` | 20260719213000 | backfill controlado: 7 snapshots retroativos + 12 baselines (manifesto no arquivo) |
| `0118_trilha_timeline_rpc.sql` | 20260719224500 | `trilha_timeline` (3 âncoras, só leitura) |
| `0119_trilha_correcao_manual.sql` | 20260719234500 | correção assistida: expected obrigatório, marca `correcao_manual`, `corrigir_elo_candidatos`; assinatura antiga removida |

**Triggers (6, todos habilitados)**: `trg_trilha_orc_valida` ·
`trg_trilha_orc_evento` (orcamentos) · `trg_trilha_pre_cliente`
(pre_orcamentos) · `trg_trilha_tarefa_ins` · `trg_trilha_tarefa_del` (tarefas)
· `trg_tce_imutavel` (eventos).

**RPCs (7)**: `trilha_snapshot_pre(uuid)` · `sincronizar_tarefa_orcamento(uuid,uuid,text)`
· `remover_tarefa_orcamento(uuid,uuid,text)` · `trilha_da_tarefa(uuid)` ·
`trilha_do_pre(uuid)` · `trilha_timeline(text,uuid)` ·
`corrigir_elo_pre_orcamento(uuid,uuid,text,uuid)` (+ `corrigir_elo_candidatos(uuid)`).
A assinatura antiga `corrigir_elo_pre_orcamento(uuid,uuid,text)` **não existe**.

**Edges**: `aprovar-orcamento` **v8** · `reabrir-orcamento` **v2** — ambas são
cascas finas sobre as RPCs (mutação+evento numa transação; nunca gravam evento).

**Service Workers**: SR `sr-shell-v665` (portal/app de campo). Gestão
Comercial: **sem** service worker.

**Frontends**: SR `tarefa.html`/`js/tarefa.js` (card Trilha comercial +
Histórico comercial) · `tecnico.html`/`js/tecnico.js` (seção no pré) ·
`js/trilha-nav.js` (URLs centrais + estados). Comercial `js/levantamento-bloco.js`
(bloco C3 com 3 badges) · `js/deeplink.js` (`?orc=`) · `js/orcamentos.js`
(deep-link + correção de vínculo) · modal `#modal-elo`.

## 3 · Matriz final de permissões

| Superfície | Técnico de campo | Admin/Gestor SR | GC Administrador/Gestor/Comercial | GC Visualizador | Sem papel | anon |
|---|---|---|---|---|---|---|
| `trilha_da_tarefa` / `trilha_do_pre` (cadeia) | ✅ (sem `orcamento_id` → sem link) | ✅ | ✅ (com `orcamento_id` p/ rota) | ✅ | ❌ SEM_PERMISSAO | ❌ sem grant |
| `trilha_timeline` (histórico interno) | ❌ SEM_PERMISSAO | ✅ | ✅ | ✅¹ | ❌ | ❌ |
| `corrigir_elo_candidatos` / `corrigir_elo_pre_orcamento` | ❌ | ✅² | ✅ | ❌ SEM_PERMISSAO | ❌ | ❌ |
| `sincronizar_tarefa_orcamento` / `remover_tarefa_orcamento` | ❌ (service_role/edges) | ❌ | ❌ | ❌ | ❌ | ❌ |
| SELECT em `trilha_comercial_eventos` (RLS) | ❌ | ✅ (app_role admin/gestor/comercial) | ✅ | ✅ | ❌ | ❌ |
| INSERT/UPDATE/DELETE em eventos | ❌ para todos os papéis de app (só triggers/RPCs como owner; UPDATE/DELETE bloqueados até para o owner pelo trigger de imutabilidade) | | | | | |
| Botão "Corrigir vínculo" (UI) | — (sem acesso ao editor) | — | ✅ | oculto | — | — |
| Preços/valores | **nunca** chegam ao técnico por nenhuma superfície da trilha | | | | | |

¹ via acesso `gestao_comercial` (qualquer role_chave) na autorização da timeline.
² `app_role() ∈ {admin, gestor_axis, comercial}` do SR.
Toda autorização é **no servidor** (security definer + checagem interna com
`coalesce`); o frontend nunca envia `cliente_id` nem escreve FK.

## 4 · Roteiro operacional — correção de vínculo pré↔orçamento

Quem pode: Administrador/Gestor/Comercial do Gestão Comercial (ou office SR).

1. Abrir o orçamento no **Gestão Comercial** (busca ou deep-link `?orc=<id>`).
2. No campo **Origem**, clicar **"Corrigir vínculo…"**.
3. O modal lista **somente** levantamentos do mesmo cliente (derivado no
   servidor). Escolher: um pré (vincular/substituir) ou **Remover vínculo**.
4. Escrever **justificativa objetiva** (mín. 5 caracteres) — cite a evidência
   que liga o levantamento ao orçamento (ex.: "escopo idem: 02 pontos de rede
   SJP08, confirmado por <pessoa> em <data>"). A justificativa fica **eterna**
   no evento.
5. **Confirmar** (o resumo da transição é exibido). A correção é transacional:
   recaptura o snapshot (badge **Vínculo corrigido**), grava **um** evento
   imutável com vínculo e snapshot anteriores, e valida cliente/concorrência.
6. Se aparecer **"vínculo foi alterado por outra sessão"**: a lista recarrega —
   revisar e decidir de novo (nunca aplica às cegas).
7. Conferir: badge no bloco do levantamento + evento no **Histórico comercial**
   da(s) OS(s) da cadeia.

**Caso pendente — Pré 2 → Orçamento 260013** (VALMET - JOINVILLE; pré
concluído 22/06 não orçado; orçamento de 23/06 sem pré): elegível pela
ferramenta, **aguardando confirmação humana objetiva** de que o escopo do
levantamento corresponde ao orçamento. Quando confirmado, executar o roteiro
acima citando a evidência na justificativa. *(Intocado até lá.)*

## 5 · Script de integridade (somente leitura)

`supabase/checks/trilha_integridade.sql` — rodar inteiro no SQL Editor a
qualquer momento. 12 verificações (i01–i12): snapshots completos e com marcas
consistentes, evento para todo vínculo, cliente coerente, imutabilidade,
triggers/RPCs presentes, permissões fechadas, censos informativos.

**Primeira execução oficial (19/07/2026): 12/12 OK** —
`normal=0 backfill=7 correcao=0` snapshots ·
`baseline_orcamento_tarefa=5 · baseline_pre_orcamento=7 · elo_corrigido=3 ·
elo_removido=1 · orcamento_criado_de_pre=1 · tarefa_gerada=2 ·
tarefa_removida=2` (21 eventos; os operacionais são dos smokes rotulados
`[SMOKE C6a]`/`[SMOKE C7]`) · 9 eventos órfãos legítimos (orçamentos de smoke
excluídos — referência lógica preservada por design).

## 6 · Validação em campo (registro pendente)

A seção **"Trilha comercial"** do pré-orçamento no app do técnico foi validada
por RPC com claims de técnico real (ids de orçamento nulos ✓, sem preços ✓) e
por harness, mas **ainda não foi vista por um técnico logado em campo** (as
janelas rodaram com sessões administrativas). Registrar aqui a primeira
validação real:

- [ ] **Data/técnico**: ______ / ______
- [ ] Abrir um pré **já orçado** (badge "Orçado") no app de campo, online →
      a seção "Trilha comercial" aparece com os orçamentos do levantamento
      (número + status + OS quando houver), **sem valores**.
- [ ] Orçamento aparece como **texto sem link** (técnico não tem rota p/ editor).
- [ ] Offline → a seção mostra "Trilha comercial indisponível enquanto estiver
      offline." e o app segue normal.
- [ ] Pré novo/local → "Nenhum orçamento gerado."
- Anotar qualquer divergência e abrir correção via gate próprio.

## 7 · Como as coisas falham (por design)

- Troca de elo sem justificativa → `TRILHA_SEM_JUSTIFICATIVA` (trigger).
- Cliente divergente (qualquer direção, qualquer momento) →
  `TRILHA_CLIENTE_DIVERGENTE` (com FOR UPDATE serializando concorrência).
- Snapshot editado direto → `TRILHA_SNAPSHOT_IMUTAVEL`.
- Evento alterado/excluído → `TRILHA_AUDITORIA_IMUTAVEL`.
- Correção com tela desatualizada → `CONFLITO_VINCULO` (mesmo se o destino
  coincidir com o estado atual).
- Timeline/correção sem papel → `SEM_PERMISSAO`; anon → sem grant.
