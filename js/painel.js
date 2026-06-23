/* ═══════════════════════════════════════════════
   Service Report — painel.js
   Painel diário (back-office): tarefas pendentes de execução.
   Dependências: utils.js, supabase-client.js, auth.js (toast).
   Exposto como window.PainelApp.
═══════════════════════════════════════════════ */
(function () {
  async function init() {
    await carregarPendExec(getSupabase())
  }

  // Tarefas aguardando execução (pendentes de execução) — cards Nº / Cliente / Orientação.
  async function carregarPendExec(sb) {
    const [tRes, cRes] = await Promise.all([
      sb.from('tarefas').select('id,numero,cliente_id,orientacao,data_agendada')
        .eq('status', 'aguardando_execucao')
        .order('data_agendada', { ascending: true, nullsFirst: false }),
      sb.from('clientes').select('id,nome'),
    ])
    const cli = {}; (cRes.data || []).forEach(c => { cli[c.id] = c.nome })
    renderPendExec(tRes.error ? [] : (tRes.data || []), cli)
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
