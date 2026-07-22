# Fase D — Jornada oficial Tangerino × atividade operacional do SR — ESTUDO (portão)

> Ampliação da frente de ponto (ver `docs/integracao-tangerino-estudo.md` e
> `docs/ponto-fase-c-desenho.md`). A frente deixa de ser "só almoço": o Tangerino passa a dar os
> **limites oficiais da jornada** (entrada · início do almoço · fim do almoço · saída) e o SR
> sobrepõe nessa linha do tempo **todos os eventos operacionais** — o saldo é o
> **"Tempo não classificado"**. **Nada implementado** — este documento para no portão.

## 0. Princípios fixados (herdam e ampliam os da Fase C)

- **Terminologia obrigatória:** "Tempo não classificado" ou "Tempo sem atividade registrada no
  SR". **Proibido** rotular automaticamente como "ocioso", "improdutivo" ou "fora de
  atendimento". **Ausência de RAT não comprova ausência de trabalho** — texto fixo na tela.
- **Fontes:** Tangerino = fonte **oficial** dos limites da jornada e do intervalo; SR = fonte das
  atividades operacionais. Nenhum sistema altera o outro; divergência é **exibida, nunca
  compensada em silêncio**.
- **Uso vedado:** este dado **não** alimenta punição, desconto ou avaliação de desempenho
  automática. É instrumento de visibilidade operacional para conversa humana.
- Invariantes de segurança da Fase C valem integralmente (token só em Function Secret, GET-only,
  navegador nunca fala com a API, `almocos` intocada).

## 1. Por que a Fase D é barata: ela nasce da Fase C

O espelho `ponto_marcacoes` da Fase C **já guarda todos os pares do dia** (cada registro Punch é
um trecho trabalhado `entrada→saída`), não só o almoço. Logo:

- **Jornada oficial líquida = união dos pares do dia** — o almoço (e qualquer outro intervalo) é
  exatamente o que **não** está nos pares. Não há importação nova, não há endpoint novo, não há
  mudança no sync. A Fase D é **camada de cálculo + visualização** sobre dados que a C já traz.
- Limites do dia: `entrada_oficial = min(entrada)`, `saida_oficial = max(saida)` dos pares sãos;
  intervalo oficial = gaps entre pares (o principal rotulado pela regra da Fase C §4).

## 2. Inventário dos eventos operacionais do SR (fonte × confiabilidade)

| Evento | Fonte (hoje) | Início/fim | Confiabilidade | Nota |
|---|---|---|---|---|
| RAT em execução (tarefa cliente) | `vw_participacoes_dia` ramo `rat` (`rat_tecnicos.inicio/fim` com fallback `respostas.hora_inicio/termino`) | ✅ | **Alta** (carimbo de hora; horas por técnico) | por pessoa, já no fuso local |
| Deslocamento ida/retorno (do dia, na RAT) | ramos `desloc_dia` da view (`desloc_inicial/final_ida` e `_retorno`) | ✅ | Alta | ambos=Não é estado válido |
| Viagem (trechos, entre clientes) | ramo `deslocamento` da view (`deslocamento_trechos.saida_em/chegada_em` + técnicos a bordo) | ✅ | Alta | timestamptz reais |
| Pausa (não-almoço) | `respostas.pausa_inicio/pausa_termino` + motivo | ✅ | Média (**raro em produção**: 4 RATs, 3 completas) | pausa em tempo real persiste no servidor (trigger 0072) |
| Almoço declarado SR | `almocos` (pessoa/dia) | ✅ | Alta | comparação, não recorte — o recorte usa o intervalo **oficial** |
| Improdutiva registrada | RAT `status='improdutiva'` + `hora_inicio/termino` (tempo no local) + deslocamento | ✅ | Alta (4/4 com horas em produção) | é atividade operacional (verde), não "não classificado" |
| Pré-orçamento em campo | `pre_orcamentos` (participação sintética hoje só no cliente da Jornada) | ✅ | Média | server-side exige ramo na view ou união no cálculo D |
| **Tarefa interna** | **não existe fonte confiável hoje** — `jornada_segmentos` ("dia contínuo") tem **1 registro em produção** (06/06, sem fim) | ⚠️ | **Inexistente na prática** | lacuna assumida: atividade interna vai aparecer como "não classificado" até existir registro (a classificação manual do §6 é a ponte) |

**Critério de admissão de um evento no cálculo:** ter início **e** fim confiáveis no dia. Evento
sem fim (timer aberto, trecho sem chegada) entra como **pendente** — aparece na linha do tempo
com marcação própria, mas **não soma** em nenhum total até fechar.

## 3. Modelo unificado da linha do tempo

Evento canônico (materializado por pessoa-dia, no servidor):

```
{ tecnico_id, dia, categoria, inicio, fim, fonte, artefato_tipo, artefato_id, confiavel bool }
categoria ∈ { desloc, cliente, interno, pausa_sr, intervalo_oficial, nao_classificado,
              classificado_manual, fora_jornada, inconsistencia }
```

**Prioridade em sobreposições** (cada minuto conta **uma vez**; categoria de maior prioridade
vence a atribuição — a sobreposição em si vira indicador, nunca soma dupla):

1. `cliente` (RAT/tarefa em execução — inclui improdutiva)
2. `desloc` (ida/retorno/trecho de viagem)
3. `interno` (quando existir fonte)
4. `pausa_sr`

Racional: se o técnico apontou execução e deslocamento no mesmo minuto, o minuto é de execução e a
sobreposição aparece no indicador de inconsistências (alimenta o alerta de sobreposição já
existente da Jornada — 0122). `intervalo_oficial` não disputa: ele é recorte da jornada, não
atividade.

## 4. Regra matemática (formal)

Para cada pessoa-dia com vínculo e ponto são:

```
PARES     = pares oficiais do dia (ponto_marcacoes sãos: APPROVED, não excluídos, com entrada+fim)
J_LIQ     = ∪ PARES                          -- jornada oficial líquida (almoço já excluído por construção)
EVENTOS   = eventos SR confiáveis do dia (§2), cada um recortado: e ∩ J_LIQ
OPER      = ∪ (EVENTOS recortados)           -- união sem dupla contagem
NAO_CLASS = J_LIQ − OPER − TRANSIÇÕES        -- saldo
FORA      = eventos SR − J_LIQ               -- atividade fora da jornada oficial (exibida à parte)
```

- **Transições (tolerância de micro-gaps):** buraco entre dois eventos operacionais adjacentes com
  duração ≤ `T_gap` (config; proposta inicial 5 min, calibrável) **não** vira "não classificado" —
  é transição natural (guardar ferramenta, estacionar). Buracos > `T_gap` entram no saldo.
- **Não classificado é sempre um conjunto de intervalos concretos** (com início/fim), não só um
  total — é o que permite a classificação manual (§6) e a linha do tempo honesta.
- Aritmética de intervalos com resolução de **1 minuto**, no fuso local fixado pelo R1 da Fase C.

## 5. Indicadores (dia e mês)

Por pessoa-dia (mês = Σ dos dias + médias):

| Indicador | Fórmula |
|---|---|
| Jornada oficial líquida | `|J_LIQ|` |
| Tempo em RAT/tarefa (cliente) | `|minutos atribuídos a cliente|` |
| Tempo em deslocamento | `|minutos atribuídos a desloc|` |
| Tempo em atividade interna | `|minutos atribuídos a interno|` (0 até existir fonte) |
| Pausas registradas (SR) | `|minutos atribuídos a pausa_sr|` |
| Tempo operacional total | `|OPER|` |
| **Tempo não classificado** | `|NAO_CLASS|` |
| Cobertura da jornada | `|OPER| / |J_LIQ|` (%) |
| Eventos fora da jornada | `|FORA|` (contagem + minutos; inclui trabalho após a saída oficial) |
| Sobreposições/inconsistências | minutos com >1 categoria disputando + lista dos casos |
| Classificado manualmente | `|classificado_manual|` por motivo (§6) |

## 6. Classificação manual do tempo não classificado (sem tocar o ponto)

Tabela nova `ponto_tempo_classificacoes` (a única escrita humana da Fase D):

```
id · tecnico_id · dia · inicio · fim         -- recorte dentro de um intervalo não classificado
motivo enum: aguardando_liberacao | retirada_material | reuniao | apoio_tecnico |
             administrativo | deslocamento_nao_registrado | pausa | outro
detalhe text (obrigatório se 'outro') · classificado_por uuid · classificado_em timestamptz
```

- Classificar **não altera** o ponto, não altera `almocos`, não altera RAT — só re-rotula o
  intervalo na visão de cobertura (categoria `classificado_manual`, com o motivo).
- Quem classifica (proposta): gestão sempre; técnico sobre o próprio dia é decisão de produto para
  o portão da implementação (recomendado: começar só gestão, read-only para o técnico).
- Tudo auditável (quem/quando); reclassificação gera histórico (update com trilha, padrão
  `auditoria`).

## 7. Proposta visual — Jornada do Admin ✅ DECISÃO CONSOLIDADA (22/07)

**A integração evolui a tela existente `jornada.html` — não haverá tela nova.** Mockup aprovado:
`docs/mockups/mockup-jornada-conciliacao-tangerino.png`. Elementos fixados:

- **Tabela diária da equipe** (colunas): Jornada líquida oficial · Registrado no SR · Tempo não
  classificado · Cobertura da jornada · Almoço Tangerino × SR · Status do ponto
  (Completo/Incompleto/Sem vínculo/Não importado).
- **Painel do técnico selecionado** (cards): jornada líquida · atendimento ao cliente ·
  deslocamento · atividade interna · almoço oficial · operação registrada · **transição
  tolerada** (total separado, nunca somado como atividade) · tempo não classificado ·
  % de cobertura.
- **Linha do tempo em DUAS camadas:** faixa "TANGERINO — jornada oficial" (períodos oficiais +
  almoço em cinza) sobre a faixa "SERVICE REPORT — atividades registradas" (blocos coloridos).
- A prioridade cliente > deslocamento > interno > pausa é **apenas atribuição visual e composição
  por categoria** — os eventos originais permanecem intactos e sobreposições continuam
  sinalizadas (alerta 0122).
- Gaps pequenos **não desaparecem**: aparecem como "Transição tolerada", com total próprio,
  fora da atividade operacional; limite calibrável com dados reais.
- Texto fixo na tela: **"A ausência de RAT não comprova ausência de trabalho."**
- Classificação manual (D2) registra: intervalo exato · categoria · justificativa · usuário ·
  data/hora · **histórico de alterações** — e nunca modifica o ponto nem os eventos do SR.

Detalhe original da proposta (mantido como referência):
uma barra horizontal 06h–22h por técnico, com blocos:

| Cor | Categoria | Token do design system |
|---|---|---|
| Azul | deslocamento (ida/retorno/trecho) | `#1E8AE0` (info) |
| Verde | RAT/tarefa cliente (inclui improdutiva, com hachura/ícone próprio) | `#179A47` (exec) |
| Roxo | tarefa interna (quando existir fonte) | `#8E45B5` |
| Cinza | intervalo oficial (almoço/intervalos do ponto) | neutro |
| Âmbar | **tempo não classificado** | `#F7B81E` (atenção) |
| Vermelho | **só inconsistência confirmada** (sobreposição real, RAT fora da jornada além da tolerância) | `#E5403A` |

- Limites oficiais (entrada/saída) como marcadores verticais; eventos **fora da jornada**
  desenhados fora dos marcadores com opacidade reduzida (visíveis, não alarmantes).
- Clique num bloco âmbar → painel de classificação manual (§6). Clique em bloco de atividade →
  link para o artefato (RAT/viagem), como os chips atuais da Jornada.
- Ícones SVG de linha, Manrope, tokens existentes — nada de estilo solto (regra da casa).

**Fechamento mensal por técnico** (aba/tela nova, read-only): tabela dias × indicadores do §5,
totais e % de cobertura no rodapé, exportável (padrão das listas do portal). Dias `incompleto`/
`sem_vinculo`/sem ponto aparecem rotulados e **fora das médias** (não distorcem cobertura).

## 8. Casos-limite (regras propostas)

| Caso | Regra |
|---|---|
| Evento SR sem horário final | pendente: aparece na linha (borda tracejada), não soma; lista "eventos abertos" no rodapé |
| Intervalos SR sobrepostos | união evita dupla contagem; atribuição por prioridade (§3); minutos disputados viram indicador e só ficam **vermelhos** se além da tolerância de sobreposição já usada pelo alerta 0122 |
| RAT iniciada antes / encerrada após a jornada | parte interna conta em OPER; excedente vira `fora_jornada` (âmbar-neutro, nunca vermelho automático) |
| Trabalho após o ponto de saída | `fora_jornada` — **exibido com cuidado** (§9): rotulado "atividade após a saída oficial", nunca "hora extra" (apuração de horas é do ponto, não do SR) |
| Jornada com mais de um intervalo | todos os gaps entre pares viram `intervalo_oficial`; o rotulado como almoço segue a regra da Fase C; os demais são intervalos oficiais comuns |
| Virada de dia | par que cruza 00:00 fica no dia da entrada (regra C); eventos SR seguem o dia da RAT; dia marcado `incompleto` para cobertura se houver corte |
| Ausência de marcação (dia com atividade SR e sem ponto) | dia vira `sem_ponto` — listado à parte; **não** entra em cobertura (não há jornada oficial para cobrir); é sinal para a gestão cobrar a batida (P1 é regra da empresa) |
| Micro-gaps entre atividades | transição ≤ `T_gap` (config, proposta 5 min) não vira não classificado |
| Offline / sincronização tardia | recomputo diário da janela **D-7** (mesma da Fase C) reabsorve RATs que chegaram depois; dias com RAT local ainda não sincronizada são invisíveis ao servidor — a tela exibe o aviso fixo "dados de campo podem chegar com atraso"; fechamento mensal só consolida após D+7 do fim do mês |

## 9. Riscos trabalhistas e de interpretação

1. **"Não classificado" lido como "não trabalhou"** — o maior risco. Mitigações: terminologia
   travada (§0), texto fixo na tela, classificação manual acessível, e a lacuna conhecida de
   fonte para atividade interna (§2) documentada na própria UI ("atividades internas ainda não
   têm registro no SR").
2. **Uso disciplinar do dado** — vedado por princípio (§0); a tela não gera ranking, não compara
   técnicos lado a lado por cobertura, não exporta "lista de piores". O fechamento mensal é por
   técnico individual, para conversa 1:1.
3. **Confusão de papéis entre sistemas** — o SR **não** apura horas legais; "fora da jornada" não
   é hora extra e o texto da tela diz isso. Qualquer efeito de folha continua 100% no Tangerino.
4. **LGPD** — herda a Fase C (minimização, RLS admin/gestor, retenção 12 meses, invoker). A
   classificação manual acrescenta dado de gestão, não dado novo do trabalhador.
5. **Assimetria de qualidade** (ponto medido × SR declarado) — tolerâncias e transições absorvem
   o ruído; a calibração da Fase C (gate C3) alimenta os mesmos parâmetros.

## 10. Fases de implantação (todas read-only no início; depois da C4 estabilizar)

| Fase | Conteúdo | Depende de | Observação |
|---|---|---|---|
| **D1 — cálculo + linha do tempo** (read-only) | materialização pessoa-dia (§3–§4) + faixa visual na Jornada + indicadores diários | C4 em produção ≥ 2 semanas (espelho maduro, tolerâncias calibradas) | zero escrita; 1–2 PRs (cálculo server-side; UI) |
| **D2 — classificação manual** | tabela `ponto_tempo_classificacoes` + painel de classificação | D1 validada pela gestão | única escrita da fase; auditável |
| **D3 — fechamento mensal** | tela mensal por técnico + consolidação D+7 | D1/D2 | export padrão do portal |
| **D4 (futura, fora deste portão)** — fonte para atividade interna | reativar `jornada_segmentos` ou evento leve no app | decisão de produto própria | é a única forma de o roxo existir de verdade; hoje a lacuna é assumida |

**Rollback:** D1/D3 são leitura pura (remover tela/cálculo não afeta nada); D2 é uma tabela
side-car — desativar o painel basta. Nenhuma fase toca `almocos`, RAT, ponto ou faturamento.

---
*Portão: nada deste documento foi implementado. A ordem continua: Fase C (PR-C1..C4) primeiro —
a D reaproveita o mesmo espelho sem importação nova. Aprovações pendentes: este desenho da D e o
da C (`ponto-fase-c-desenho.md`).*
