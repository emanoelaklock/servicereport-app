/* ═══════════════════════════════════════════════
   Service Report — sidebar.js  (adaptado de axisinventory-app)
   HTML da sidebar + toggle + mobile.
   Nav adaptada para o módulo Service Report; visual/lógica reaproveitados.
═══════════════════════════════════════════════ */

function renderSidebar(paginaAtiva) {
  const container = document.getElementById('sidebar-container')
  if (!container) return

  const SVG = {
    painel:        `<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/></svg>`,
    orcamentos:    `<svg viewBox="0 0 24 24"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>`,
    tarefas:       `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
    rat:           `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 15h5M8 18h3"/></svg>`,
    jornada:       `<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>`,
    deslocamentos: `<svg viewBox="0 0 24 24"><path d="M3 17h2m14 0h2M5 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm10 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/><path d="M5 17V8a1 1 0 0 1 1-1h8l4 4v6"/></svg>`,
    config:        `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7 7 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.8 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.8 3h5l.8-3a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z"/></svg>`,
  }
  const a = paginaAtiva
  const item = (key, href, label, cor) =>
    `<a class="nav c-${cor}${a === key ? ' on' : ''}" href="${href}"><span class="ni">${SVG[key]}</span>${label}</a>`

  container.innerHTML = `
<aside class="side">
  <div class="brand"><div class="mk">SR</div><div><div class="nm">Service Report</div><div class="sb">Atendimento técnico</div></div></div>

  <div class="ngrp">Painel</div>
  ${item('painel', 'painel.html', 'Painel', 'blue')}

  <div class="ngrp">Execução</div>
  ${item('tarefas', 'tarefa.html', 'Tarefas', 'green')}
  ${item('rat', 'rat-calendario.html', 'RAT', 'blue')}
  ${item('jornada', 'jornada.html', 'Jornada', 'amber')}
  ${item('deslocamentos', 'deslocamentos.html', 'Deslocamentos', 'orange')}

  <div class="ngrp">Sistema</div>
  ${item('config', 'configuracoes.html', 'Configurações', 'gray')}

  <div class="foot" onclick="fazerLogout()" title="Sair" style="cursor:pointer">
    <div class="av" id="sb-avatar">—</div>
    <div style="flex:1"><div class="nm" id="sb-user-name">—</div><div class="rl" id="sb-user-role">—</div></div>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#9aa3b2" stroke-width="2" style="flex:none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
  </div>
</aside>`
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
