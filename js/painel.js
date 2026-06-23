/* ═══════════════════════════════════════════════
   Service Report — painel.js
   Painel diário (back-office): contadores + últimas RATs.
   Dependências: utils.js, supabase-client.js, auth.js (toast).
   Exposto como window.PainelApp.
═══════════════════════════════════════════════ */
(function () {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v) }

  async function init() {
    const sb = getSupabase()
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    const isoHoje = hoje.toISOString()
    const cont = (q) => q.then(r => r.error ? '—' : r.count)

    const [hojeC, pendC, fatC, fatHojeC, svC] = await Promise.all([
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).gte('data_tarefa', isoHoje)),
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).eq('status', 'Concluído com Pendências')),
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).eq('faturado', false).eq('relatorio_completo', true)),
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).eq('faturado', true).gte('data_faturamento', isoHoje)),
      cont(sb.from('vw_alerta_desloc_sem_volta').select('*', { count: 'exact', head: true })),   // conferência (leitura): dias técnico×dia com ida sem volta
    ])
    set('kpi-hoje', hojeC); set('kpi-pend', pendC); set('kpi-faturar', fatC); set('kpi-fat-hoje', fatHojeC); set('kpi-sem-volta', svC)
    // conferência: o cartão só aparece quando há dias a verificar (>0). 0 ou '—' (erro/RLS) = escondido (sem ruído)
    const svCard = document.getElementById('kpi-sem-volta-card'); if (svCard) svCard.style.display = (typeof svC === 'number' && svC > 0) ? '' : 'none'

    await carregarPendExec(sb)
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
