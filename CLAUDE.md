# CLAUDE.md — Service Report (Traders Service)

Regras do projeto que você (Claude Code) deve seguir em **toda** sessão. Leia antes de editar.

## O que é
**Service Report (SR)** — sistema de atendimento técnico em campo (Tarefas/OS, RATs, material, faturamento) da **Traders Service (TSRV)**, Joinville/SC. Usuários: técnicos em campo (app mobile) e administração/gestão (portal desktop).

## Stack
- **Frontend:** HTML/CSS/JS **puro** (sem framework). Não introduzir React/Vue/etc.
- **Backend:** **Supabase** (Postgres + Auth + Edge Functions em Deno).
- **Deploy:** Vercel.
- **Offline-first é requisito**, não detalhe: o técnico trabalha sem sinal (clientes remotos).

## Fonte da verdade
- **`docs/service-report-spec-completo.md` é a especificação oficial.** Em dúvida de regra de negócio, consulte-a. Não invente comportamento que contradiga o spec.
- Mockups de referência visual em **`docs/mockups/`**.
- Se você achar que o spec está errado ou incompleto, **avise e proponha** — não decida sozinho mudar a regra.

## Design system (obrigatório)
- CSS: `design-system-tecnico.css` (app de campo) e `design-system-admin.css` (portal). Não criar estilos soltos; usar as classes/tokens existentes.
- Fonte **Manrope**.
- Paleta (cor = significado): vermelho `#E5403A` (erro/pendência grave) · laranja `#F4861F` (deslocamento) · amarelo `#F7B81E` (atenção/aviso) · **verde `#179A47`** (ok/execução) · azul `#1E8AE0` (info) · roxo `#8E45B5` · **rosa `#D63384`** (status "Em pausa" — swap da migração 0073 — e relatórios).
- **Ícones sempre SVG de linha — nunca emoji.**
- Avatares de pessoas usam o **componente com foto** já existente (foto do Portal).

## Princípios de arquitetura (não violar)
- **Identidade offline = `client_uuid`** gerado no aparelho. Números "oficiais" (RAT `{tarefa}/{seq}`, nº de Tarefa) são atribuídos **pelo servidor no sync**, não no cliente.
- **Tempo é da pessoa, não do documento.** Horas são por técnico (trechos de participação), somadas entre artefatos do dia.
- **Almoço é por pessoa/dia**, contado **uma vez** (dedup no servidor) — nunca por RAT.
- **Material é da RAT (lançado uma vez)** — nunca duplicar por técnico. Arredondamento (teto) acontece **na Tarefa**, não na RAT; o técnico aponta decimal salvo como digitado.
- **RAT colaborativa:** uma RAT por `(tarefa, dia)`. Id determinístico via **UUIDv5 de (tarefa_id, dia)** pros aparelhos convergirem; sub-tabelas com **`created_by`**; merge por **união**; conflito (dois lançam o mesmo) é **marcado pro admin, nunca somado em silêncio**.
- **"Concluída" é reservado ao serviço (Tarefa).** A RAT diária fecha como "registrado". Encerrar a RAT ≠ concluir o serviço.
- **Modalidade de faturamento mora no contrato/obra**, não no cliente; o técnico nunca escolhe modalidade.
- Trabalho não-sincronizado **nunca é apagado** sem ação explícita.

## Segurança
- Segredos (Omie, Resend, **Tangerino** `TANGERINO_TOKEN`, etc.) **só** como secrets/env da Edge Function no Supabase. **Nunca** no código do app, no repositório ou em texto. Use `Deno.env.get(...)`.
- Não logar credenciais nem dados pessoais em URL/query.

## Como trabalhar neste repo
- **Planeje antes de editar.** Em tarefa grande, use plan mode e me mostre o plano antes de tocar em arquivo.
- **Commits pequenos, um de cada vez.** Nunca empilhar vários commits e só então mostrar. Commite e aguarde revisão antes do próximo.
- **Verifique cada commit:** rode/teste o que mexeu e diga o que verificou. Em **migração de dados**, explique o que pode dar errado e como testou (não perder histórico).
- **Pacote pesado vai em branch própria** (ex.: `feat/...`), não direto na `main` (que está no ar no Vercel).
- Mudou comportamento? **Atualize o spec** correspondente.

## NÃO FAZER (decisões já tomadas — não reintroduzir)
- Não rastreamento contínuo de GPS, **sem km/odômetro** (GPS só pontual nos eventos).
- Não despesas de viagem, não trechos multimodais, não assinatura do cliente, não app/portal do cliente, não chat interno.
- Não construir o "módulo Viagem" rico antes da jornada contínua.
- Não duplicar material por técnico; não exigir login de todos os técnicos numa RAT.
- Não mexer em faturamento/Omie a não ser quando o pacote de faturamento for explicitamente pedido.

## Contexto útil
- Orçamentos foram migrados pra um app próprio (**comercial-app**) — não estão mais no SR.
- Edge Functions já no ar: `omie-sync`, `aprovar-orcamento`, `reabrir-orcamento`, `documentos` (PDF+Resend), `melhorar-texto` (IA, desktop-only), `manage-users`, `portal-usuarios`, `notify-push`, `orcamento-importar-fotos`, `viagem-merge` (finalização colaborativa da viagem).
- Pessoas: **Thaís** (gestão do SR/estoque), **Francisco** (almoxarifado).
