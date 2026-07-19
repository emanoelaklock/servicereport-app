/* ═══════════════════════════════════════════════
   Trilha comercial · C4/C4b — helper CENTRAL da navegação.
   1) URLs internas/oficiais: toda URL da trilha nasce AQUI, com validação
      ESTRITA de UUID — nunca inferência por número textual, nunca template
      montando URL na mão. id inválido → null (o chamador rende texto sem link).
   2) Estados NÃO bloqueantes: decisão pura (estadoTrilha) + render seguro
      (renderEstado, via createElement/textContent) compartilhados pelas duas
      telas — sem falha silenciosa. A mensagem de "sem acesso" é neutra: não
      revela IDs nem números.
   O id de orçamento vindo da RPC serve EXCLUSIVAMENTE à rota (a interface
   nunca o exibe).
═══════════════════════════════════════════════ */
(function () {
  'use strict'
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // domínio oficial FIXO do editor de orçamentos (Gestão Comercial) — nunca
  // derivado de dado, query string ou configuração do cliente
  const COMERCIAL_URL = 'https://comercialapp.vercel.app/'

  // detalhe da tarefa no portal (deep-link já suportado por tarefa.html: ?t=)
  function urlTarefa(id) {
    return UUID_RE.test(String(id || '')) ? 'tarefa.html?t=' + encodeURIComponent(id) : null
  }
  // editor do orçamento no Comercial — rota por ID interno, jamais por número
  function urlOrcamento(id) {
    return UUID_RE.test(String(id || '')) ? COMERCIAL_URL + '?orc=' + encodeURIComponent(id) : null
  }

  const MSG = {
    vazio: 'Nenhum orçamento gerado.',
    offline: 'Trilha comercial indisponível enquanto estiver offline.',
    falha: 'Não foi possível carregar.',
    sem_acesso: 'Trilha comercial disponível apenas para usuários autorizados.',
  }

  // Decisão PURA do estado do bloco (testável no harness):
  //   offline > sem_acesso > falha > vazio > ok
  function estadoTrilha(ctx) {
    ctx = ctx || {}
    if (ctx.online === false) return { tipo: 'offline', msg: MSG.offline }
    if (ctx.error) {
      const m = String(ctx.error.message || '') + ' ' + String(ctx.error.code || '')
      if (m.indexOf('SEM_PERMISSAO') >= 0 || m.indexOf('42501') >= 0) {
        return { tipo: 'sem_acesso', msg: MSG.sem_acesso }   // neutra — sem IDs/números
      }
      return { tipo: 'falha', msg: MSG.falha, retry: true }
    }
    if (ctx.vazio) return { tipo: 'vazio', msg: MSG.vazio }
    return { tipo: 'ok' }
  }

  // Render seguro do estado + retry APENAS do bloco (nunca da tela inteira)
  function renderEstado(el, st, retry) {
    if (!el || !st) return
    el.textContent = ''
    const s = document.createElement('span')
    s.className = 'muted'
    s.textContent = st.msg || ''
    el.appendChild(s)
    if (st.retry && typeof retry === 'function') {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'btn btn-sm'
      b.style.marginLeft = '8px'
      b.textContent = 'Tentar novamente'
      b.onclick = retry
      el.appendChild(b)
    }
  }

  window.TrilhaNav = { urlTarefa, urlOrcamento, estadoTrilha, renderEstado, MSG, UUID_RE, COMERCIAL_URL }
})()
