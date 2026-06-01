# Service Report

Módulo de **Relatório de Atendimento Técnico (RAT)**, faturamento e conciliação de material. Primeiro módulo do portal **Traders Apps** (HTML/CSS/JS puro + Supabase + Vercel).

## Stack
- HTML + CSS + JS puro, **sem frameworks**
- Supabase (Postgres + Auth + Storage) — projeto `Traders Apps`
- PWA para o app do técnico (offline-first)
- Design system **Bold** (`theme.css`, Space Grotesk, sidebar `#1a1814`) reaproveitado do repo `axisinventory-app`

## Backend (Supabase)
- Projeto: **Traders Apps** (`iwufrqmzcvaiyzynodkg`, região sa-east-1)
- URL/chave: ver `js/supabase-client.js` (publishable key — segura no client)
- Schema aplicado: migration `service_report_slice1` (fatia 1)

### Decisões de schema (fatia 1)
- **Auth/perfis reusam a tabela `usuarios`** já existente no portal (`role` ∈ `admin` / `gestor_axis` / `tecnico_campo`, ligada a `auth.users`). **Não** existe tabela `tecnicos`; `tarefas.tecnico_id → usuarios(id)`.
- **Equipamentos**: o portal já tem `equipamentos_axis`. Não criamos `equipamentos`. O vínculo equipamento↔RAT é **deferido** (fora da fatia 1): `tarefas.equipamento_id` é `uuid` anulável **sem FK** (futuro FK → `equipamentos_axis`).
- **Contratos** também deferidos: `tarefas.contrato_id` é `uuid` anulável sem FK.
- Tabelas criadas: `clientes`, `produtos`, `tipos_servico`, `formulario_modelos`, `tarefas`, `relatorio_fotos`, `materiais`, `sync_eventos`, `sync_log` + view `vw_conciliacao`.
- **RLS por perfil** (não os placeholders `auth_all_*`): função `app_role()` lê `usuarios.role` via `auth.uid()`. `tecnico_campo` só lê/grava as próprias `tarefas` (e fotos/materiais/eventos delas) e lê os cadastros de referência; `admin`/`gestor_axis` têm acesso total; `sync_log` só admin.

## Perfis de acesso
- **tecnico_campo** → entra direto no formulário de RAT (PWA de campo); não vê o portal.
- **admin / gestor_axis** → portal (painel diário, relatórios, faturar).

## Estrutura
```
index.html            redireciona para login.html
login.html            login do back-office  ✅
painel.html           painel diário (admin/gestor)  ✅ shell
relatorios.html       lista + botão Faturar (admin/gestor)  ✅ shell
tecnico.html          PWA: app de campo / RAT (tecnico_campo)  ✅ shell
manifest.webmanifest  PWA  ✅
service-worker.js     shell offline (raiz, escopo "/")  ✅
css/theme.css         design Bold (copiado de axisinventory-app)  ✅
js/utils.js           helpers (copiado de axisinventory-app)  ✅
js/auth.js            auth + roteamento por papel (adaptado)  ✅
js/sidebar.js         sidebar Bold + nav Service Report (adaptado)  ✅
js/supabase-client.js init único do Supabase (Traders Apps)  ✅
js/db-local.js        IndexedDB (RATs + fotos + eventos)  ✅
js/tecnico.js         formulário de RAT (app de campo)  ✅
js/sync.js            sincronização Supabase + Storage + sync_eventos  ✅
assets/icon.svg       ícone do app
```

Storage: bucket privado **`rat-anexos`** (fotos/assinaturas) com policies por perfil — técnico só acessa objetos sob sua própria pasta (`<auth.uid>/...`). `tarefas.recebido_em` é carimbado por trigger no servidor (ACK que vira `confirmado`).

Dados de exemplo no banco (marcados **TESTE**): `Cliente Exemplo (TESTE)` e `Formulário de exemplo (TESTE)` (campos texto/seleção/número/foto/assinatura) ligado ao tipo `Manutencao corretiva`.

Padrão de carregamento das páginas (igual ao inventário): `theme.css` → `@supabase/supabase-js@2` (UMD, cria `window.supabase`) → `utils.js` → `supabase-client.js` → `auth.js` → `sidebar.js` → script da página. Cada página declara `window.PAGE_ALLOWED` (papéis que podem permanecer); quem não pode é roteado para sua home.

## Fundação — concluída
- Arquivos base reaproveitados do `axisinventory-app` (não recriados): `theme.css`, `utils.js`, e `auth.js`/`sidebar.js` adaptados.
- Login + sessão + roteamento por `usuarios.role` operando.
- PWA instalável com shell offline (service worker na raiz).

### Próximos passos (fatia 1)
6. Contadores do painel diário · 7. Lista de relatórios + botão Faturar.

### Setup / teste
Servir a raiz por HTTP (service worker e módulos não funcionam em `file://`). Ex.: `npx serve` ou `python -m http.server`, depois abrir `login.html`. Criar um usuário no Supabase Auth do projeto Traders Apps e a linha correspondente em `usuarios` (`id` = auth uid, `role` = `admin`/`gestor_axis`/`tecnico_campo`).
