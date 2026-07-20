# PDF Engine — F1: extração do motor (spec)

**Status:** em implementação (branch `feat/pdf-engine-f1`) · **Escopo:** somente F1.
F2 (orçamento no comercial-app), F3 (pré-orçamento) e a Edge Function `documentos`
**não** fazem parte desta fase e não podem ser alteradas por ela.

## Objetivo

Extrair o motor vetorial de PDF do SR (`js/pdf-tarefa.js`, pdfmake v0.2.12) para um
módulo compartilhado entre SR e comercial-app, **sem nenhuma mudança visual ou
funcional nos PDFs atuais do SR**. O RAT continua sendo template do SR; o motor
passa a viver no repositório privado **`tsrv-pdf-engine`**.

## Decisões aprovadas

1. Repo privado `tsrv-pdf-engine` (GitHub), compartilhado por **release/tag semver**.
2. Sincronização **automatizada** (`scripts/sync-pdf-engine.ps1`); a cópia vendorizada
   em `js/shared-pdf/` **nunca é editada à mão** — toda mudança nasce no repo do motor
   e chega por bump explícito de tag.
3. `js/shared-pdf/ENGINE_MANIFEST.json` registra `version` (tag) + **SHA-256 de cada
   arquivo sincronizado**; `scripts/check-pdf-engine.ps1` acusa qualquer divergência.
4. API pública **inalterada**: `window.PdfTarefa.gerar(m)` — `tarefa.js` e
   `rat-page.js` não mudam.
5. Service worker: novos arquivos entram no `SHELL` e o `CACHE` recebe bump.

## Corte motor × template

**Motor (`js/shared-pdf/pdf-engine.js`, global `window.PdfEngine`)** — extração
*verbatim* de `pdf-tarefa.js`, parametrizada por `PdfEngine.create(cfg)`:

- `cfg.vendorPath` — caminho do pdfmake/vfs (SR: `js/vendor/`); o loader lazy e o
  short-circuit por `window.pdfMake` são preservados.
- `cfg.theme` — tokens de cor (AZ, BLUE, GREEN, INK, GRAY, MUTED, LINE, BG, ZEBRA),
  geometria (PAGE_W/H, MARG, TOPM, BOTM, CW, BOTTOM) e fonte padrão. Defaults =
  valores atuais do SR, byte-idênticos.
- `cfg.deps.fmtMin` — única dependência externa do motor (usada por `durStr`).

Conteúdo do motor: loader; `imgParaPdf`/`carregarImg` (canvas, JPEG q0.85, cover 4:3);
`mapaParaPdf` (tiles Esri + pino); builders (`sec`, `pill`, `field`, `grid`, `secGrid`,
`statCards`, `tabela`, `textBox`, `secBloco`, `tabelaFluida`, `cel`, `celNum`,
`fotoLayout`, `fotoRows`, `fotosSection`); formatadores neutros (`fmtDataBR`,
`minutosDe`, `durStr`, `money`, `luminancia`); `prepararImagens(m)` (loop sequencial
fotos/assinatura/anexos/mapa, respeitando `m.flags.cliente`); medição de continuações
(`renderLayout`, `trocaImgs`, `medirBlocos`, `calcularContinuacoes(m, buildDoc)` — o
`docDefinition` vira **callback** do template); saída (`download(dd, arquivo)` e
`getBlob(dd)` — novo, para testes e usos futuros).

**Template (`js/pdf-tarefa.js`)** — permanece no SR, reduzido a: `capa`,
`capaTabelas`, `anexosSection`, `corpoRat`, `docDefinition` e a orquestração
`gerar(m)`. Continua usando `RatView` diretamente (statusInfo, tempoRat,
tipoNomeRat, campoVisivel) — acoplamento de template, não de motor.

**Contrato do modelo `m`** (inalterado): `{ numeroFmt, headerRight, arquivo, selo,
flags{cliente,valores,conciliacao,zerados}, motivoImprodutiva(fn), orientacaoGeral,
capa|null, dets[] }`. Os perfis Cliente/Interno continuam data-driven via `m.flags`.

## Fixtures congelados (antes da extração)

Modelos `m` reais capturados do app em produção, com imagens embutidas como dataURL
para tornar a geração determinística:

- Casos: **04753** (caso crítico de paginação citado no spec), **04826** (PoC do
  layout) e casos representativos adicionais (com capa Cliente e Interno, RAT
  avulsa, improdutiva se houver, com/sem GPS, com fotos e anexos).
- **Sanitização**: fotos e assinatura são substituídas na captura por placeholders
  sintéticos **com as mesmas dimensões em pixels** (o layout depende de contagem e
  dimensões, não do conteúdo). Textos de negócio são mantidos (necessários para a
  paginação byte-idêntica). Um único fixture mantém GPS real para exercitar o mapa.
- O callback `motivoImprodutiva` não é serializável: o fixture guarda o modelo sem
  ele e o harness reatacha `RatView.motivoImprodutivaLabel`.
- Local: `test/fixtures/` no repo `tsrv-pdf-engine` (privado).

## Gate obrigatório (critério de aceite da F1)

Para **cada fixture × perfil**, o harness (`test/golden.html` no repo do motor) gera
o PDF com o **legado congelado** (cópia de `pdf-tarefa.js` pré-refactor +
`rat-view.js`) e com o **motor novo + template novo**, e compara:

1. **Comparação binária com normalização apenas de metadados variáveis** —
   `/CreationDate`, `/ModDate` e `/ID` são zerados em ambos; todo o resto deve ser
   **byte-idêntico**. (O harness intercepta `download` para capturar os bytes; os
   dois lados rodam na mesma sessão do mesmo navegador — canvas/JPEG determinísticos.)
2. Em divergência: **comparação visual por página** (render via pdf.js + diff de
   pixels) para localizar a causa.
3. **Nenhum avanço** se conteúdo, paginação, fotos ou perfis Cliente/Interno mudarem.

## Mudanças no SR (branch `feat/pdf-engine-f1`)

- `js/shared-pdf/pdf-engine.js` + `ENGINE_MANIFEST.json` (sincronizados, nunca editados).
- `js/pdf-tarefa.js` refatorado para template fino (API preservada).
- `tarefa.html` e `rat.html`: `<script src="js/shared-pdf/pdf-engine.js">` antes de
  `js/pdf-tarefa.js`.
- `service-worker.js`: `js/shared-pdf/pdf-engine.js` no `SHELL` + bump do `CACHE`.
- `scripts/sync-pdf-engine.ps1` e `scripts/check-pdf-engine.ps1`.
- `js/vendor/pdfmake.min.js` e `vfs_fonts.js` permanecem onde estão (já no SW);
  o manifest também registra seus hashes (o vendor é parte do contrato do motor).

## Regras permanentes (pós-F1)

- Mudança no motor: PR no `tsrv-pdf-engine` → golden verde (SR **e**, após F2,
  comercial) → tag semver → bump explícito no app consumidor (sync + commit).
- Atualizar o motor num app **nunca** exige deploy do outro.
- Bump de tag no SR exige: rodar sync, rodar check, bump do `CACHE` do SW, gate verde.
