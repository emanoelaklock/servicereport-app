/* ═══════════════════════════════════════════════
   Service Report — painel.js
   Painel diário (back-office): contadores + últimas RATs.
   Dependências: utils.js, supabase-client.js, auth.js (toast).
   Exposto como window.PainelApp.
═══════════════════════════════════════════════ */
(function () {
  const SYNC_BADGE = {
    confirmado: { cls: 's-en', txt: 'Confirmado' },
    enviando:   { cls: 's-ct', txt: 'Enviando' },
    na_fila:    { cls: 's-ai', txt: 'Na fila' },
    salvo_local:{ cls: 's-rv', txt: 'Local' },
    erro:       { cls: 's-rm', txt: 'Erro' },
    rascunho:   { cls: 's-fi', txt: 'Rascunho' },
  }
  function syncBadge(s) {
    const b = SYNC_BADGE[s] || { cls: 's-sc', txt: s || '—' }
    return `<span class="badge ${b.cls}"><span class="dot"></span>${esc(b.txt)}</span>`
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v) }

  async function init() {
    const sb = getSupabase()
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    const isoHoje = hoje.toISOString()
    const cont = (q) => q.then(r => r.error ? '—' : r.count)

    const [hojeC, pendC, fatC, fatHojeC] = await Promise.all([
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).gte('data_tarefa', isoHoje)),
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).eq('status', 'Concluído com Pendências')),
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).eq('faturado', false).eq('relatorio_completo', true)),
      cont(sb.from('rats').select('*', { count: 'exact', head: true }).eq('faturado', true).gte('data_faturamento', isoHoje)),
    ])
    set('kpi-hoje', hojeC); set('kpi-pend', pendC); set('kpi-faturar', fatC); set('kpi-fat-hoje', fatHojeC)

    const { data, error } = await sb.from('rats')
      .select('id,cliente_nome,data_tarefa,sync_status,relatorio_completo,faturado')
      .order('data_tarefa', { ascending: false, nullsFirst: false }).limit(8)
    renderRecentes(error ? [] : (data || []))
  }

  function renderRecentes(rows) {
    const box = document.getElementById('recentes')
    if (!box) return
    if (!rows.length) { box.innerHTML = '<p class="dim" style="padding:8px 0">Nenhuma RAT ainda.</p>'; return }
    box.innerHTML = rows.map(r => `
      <div class="rec-row">
        <span class="rec-cli">${esc(r.cliente_nome || '—')}</span>
        <span>${r.relatorio_completo ? '<span class="badge s-en"><span class="dot"></span>Completo</span>' : '<span class="badge s-ai"><span class="dot"></span>Pendente</span>'}</span>
        <span>${syncBadge(r.sync_status)}</span>
        <span class="dim">${fdt(r.data_tarefa, { withTime: true })}</span>
      </div>`).join('')
  }

  window.PainelApp = { init }
})()
