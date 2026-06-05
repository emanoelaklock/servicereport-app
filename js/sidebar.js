/* ═══════════════════════════════════════════════
   Service Report — sidebar.js  (adaptado de axisinventory-app)
   HTML da sidebar + toggle + mobile.
   Nav adaptada para o módulo Service Report; visual/lógica reaproveitados.
═══════════════════════════════════════════════ */

function renderSidebar(paginaAtiva) {
  const container = document.getElementById('sidebar-container')
  if (!container) return

  const SVG = {
    painel:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
    relatorios:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    orcamentos:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><line x1="10" y1="7" x2="14" y2="7"/><line x1="10" y1="11" x2="14" y2="11"/><line x1="10" y1="15" x2="12" y2="15"/></svg>`,
    concil:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    tarefas:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/><path d="M9 15l2 2 4-4"/></svg>`,
    config:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  }

  const a = paginaAtiva

  container.innerHTML = `
<aside class="sidebar" id="sidebar">
  <button class="sb-toggle" onclick="toggleSidebar()" title="Expandir/recolher">
    <svg id="sb-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
  </button>
  <div class="sb-brand">
    <div class="sb-logo-icon">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    </div>
    <div>
      <div class="sb-brand-text">Service Report</div>
      <div class="sb-brand-sub">Atendimento técnico</div>
    </div>
  </div>
  <nav class="sb-nav">

    <a class="sb-item${a==='painel'?' on':''}" href="painel.html">
      ${SVG.painel}<span class="sb-label">Painel</span>
    </a>

    <div class="sb-section">Comercial</div>

    <a class="sb-item${a==='orcamentos'?' on':''}" href="orcamentos.html">
      ${SVG.orcamentos}<span class="sb-label">Orçamentos</span>
    </a>

    <div class="sb-section">Execução</div>

    <a class="sb-item${a==='conciliacao'?' on':''}" href="conciliacao.html">
      ${SVG.tarefas}<span class="sb-label">Tarefas</span>
    </a>

    <div class="sb-section">Sistema</div>

    <a class="sb-item${a==='config'?' on':''}" href="configuracoes.html">
      ${SVG.config}<span class="sb-label">Configurações</span>
    </a>

  </nav>
  <div class="sb-bottom">
    <div class="sb-user" onclick="fazerLogout()" title="Sair">
      <div class="sb-avatar" id="sb-avatar">—</div>
      <div class="sb-user-info">
        <div class="sb-user-name" id="sb-user-name">—</div>
        <div class="sb-user-role" id="sb-user-role">—</div>
      </div>
    </div>
  </div>
</aside>

<!-- Overlay mobile (fecha sidebar ao clicar fora) -->
<div class="sb-overlay" id="sb-overlay" onclick="closeMobileSidebar()"></div>

<!-- Botão hamburger mobile -->
<button class="sb-mobile-btn" id="sb-mobile-btn" onclick="toggleMobileSidebar()" aria-label="Menu">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
</button>`
}

// Toggle colapso da sidebar (desktop)
let _sidebarCollapsed = false
function toggleSidebar() {
  _sidebarCollapsed = !_sidebarCollapsed
  document.getElementById('sidebar').classList.toggle('collapsed', _sidebarCollapsed)
  const a = document.getElementById('sb-arrow')
  if (a) a.innerHTML = _sidebarCollapsed
    ? '<polyline points="9 18 15 12 9 6"/>'
    : '<polyline points="15 18 9 12 15 6"/>'
}

// Mobile sidebar
function toggleMobileSidebar() {
  const sb = document.getElementById('sidebar')
  const ov = document.getElementById('sb-overlay')
  if (!sb) return
  const isOpen = sb.classList.contains('mobile-open')
  sb.classList.toggle('mobile-open', !isOpen)
  if (ov) ov.classList.toggle('open', !isOpen)
}
function closeMobileSidebar() {
  const sb = document.getElementById('sidebar')
  const ov = document.getElementById('sb-overlay')
  if (sb) sb.classList.remove('mobile-open')
  if (ov) ov.classList.remove('open')
}
// Fechar sidebar ao navegar no mobile
document.addEventListener('click', function(e) {
  if (window.innerWidth <= 768 && e.target.closest) {
    const link = e.target.closest('a.sb-item, a.sb-subitem')
    if (link) closeMobileSidebar()
  }
})
