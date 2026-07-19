/* ═══════════════════════════════════════════════
   Trilha comercial · C4 — geração CENTRALIZADA e validada das URLs internas.
   Toda URL de navegação da trilha nasce AQUI (nenhum template monta URL na mão):
   id inválido (não-UUID) → null, e o chamador rende texto sem link.
   Só telas internas do SR — a trilha não navega para o editor do Comercial
   (gate C4) e o id de orçamento nem chega ao cliente (RPC 0116 não o expõe).
═══════════════════════════════════════════════ */
(function () {
  'use strict'
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  // detalhe da tarefa no portal (deep-link já suportado por tarefa.html: ?t=)
  function urlTarefa(id) {
    return UUID_RE.test(String(id || '')) ? 'tarefa.html?t=' + encodeURIComponent(id) : null
  }

  window.TrilhaNav = { urlTarefa, UUID_RE }
})()
