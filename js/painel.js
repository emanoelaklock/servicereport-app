/* ═══════════════════════════════════════════════
   Service Report — painel.js
   Painel diário (back-office): tarefas pendentes de execução.
   Dependências: utils.js, supabase-client.js, auth.js (toast).
   Exposto como window.PainelApp.
═══════════════════════════════════════════════ */
(function () {
  async function init() {
    const sb = getSupabase()
    const { data: cRows } = await sb.from('clientes').select('id,nome')
    const cli = {}; (cRows || []).forEach(c => { cli[c.id] = c.nome })
    await Promise.all([carregarDevolvidas(sb, cli), carregarPendExec(sb, cli)])
  }

  // Lembrete: devolvidas SEM RETORNO há +1 dia (status devolvida + devolvida_em < now-24h). Só
  // aparece quando houver; devolvida_em null (devoluções pré-lembrete) não entra pela condição.
  async function carregarDevolvidas(sb, cli) {
    const corte = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const { data, error } = await sb.from('tarefas')
      .select('id,numero,cliente_id,devolvida_em')
      .eq('status', 'devolvida').lt('devolvida_em', corte)
      .order('devolvida_em', { ascending: true })   // mais antigas (mais atrasadas) primeiro
    renderDevolvidas(error ? [] : (data || []), cli)
  }
  function renderDevolvidas(rows, cli) {
    const box = document.getElementById('devol-alerta'); if (!box) return
    if (!rows.length) { box.innerHTML = ''; return }
    const osNo = (n) => n == null ? '—' : String(n).padStart(5, '0')
    const idade = (iso) => { const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d <= 1 ? '1 dia' : d + ' dias' }
    const ICON = '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>'
    box.innerHTML = `<div class="devol-alert">
      <div class="devol-alert-h">${ICON} Devolvidas sem retorno há +1 dia · ${rows.length}</div>
      <div class="devol-alert-grid">${rows.map(t => `
        <a class="devol-alert-card" href="tarefa.html?t=${esc(t.id)}" title="Abrir tarefa">
          <div class="dac-no">Tarefa Nº ${esc(osNo(t.numero))}</div>
          <div class="dac-cli">${esc(cli[t.cliente_id] || '—')}</div>
          <div class="dac-age">Devolvida há ${idade(t.devolvida_em)}</div>
        </a>`).join('')}</div>
    </div>`
  }

  // Tarefas aguardando execução (pendentes de execução) — cards Nº / Cliente / Orientação.
  async function carregarPendExec(sb, cli) {
    const { data, error } = await sb.from('tarefas').select('id,numero,cliente_id,orientacao,data_agendada')
      .eq('status', 'aguardando_execucao')
      .order('data_agendada', { ascending: true, nullsFirst: false })
    renderPendExec(error ? [] : (data || []), cli)
  }

  function renderPendExec(rows, cli) {
    const box = document.getElementById('pend-exec'); if (!box) return
    const lab = document.getElementById('pend-exec-lab')
    if (lab) lab.textContent = `Tarefas pendentes de execução${rows.length ? ' (' + rows.length + ')' : ''}`
    if (!rows.length) { box.innerHTML = '<div class="pe-empty">Nenhuma tarefa pendente de execução.</div>'; return }
    const osNo = (n) => n == null ? '—' : String(n).padStart(5, '0')
    box.innerHTML = rows.map((t, i) => `
      <div class="pe-card pe-c${i % 6}" onclick="location.href='tarefa.html?t=${esc(t.id)}'" title="Abrir tarefa">
        <div class="pe-no">Tarefa Nº ${esc(osNo(t.numero))}</div>
        <div class="pe-cli">${esc(cli[t.cliente_id] || '—')}</div>
        <div class="pe-ori">${esc(t.orientacao || 'Sem orientação')}</div>
      </div>`).join('')
  }

  window.PainelApp = { init }
})()
