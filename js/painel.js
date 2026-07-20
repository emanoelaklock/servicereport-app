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
    await Promise.all([carregarDevolvidas(sb, cli), carregarAcompanhamento(sb, cli), carregarPendExec(sb, cli), carregarSobreposicoes(sb)])
  }

  // Sobreposição de horários entre RATs (vw_alerta_sobreposicao — rede de segurança da
  // "passagem de bastão", Fase 1). Só leitura: não trava nem altera horários; a sobreposição
  // pode ser legítima (saiu e voltou). O Painel mostra a janela recente (14 dias, mesma régua
  // da lista do técnico); o histórico completo fica na Jornada.
  async function carregarSobreposicoes(sb) {
    const d = new Date(diaSP() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 14)
    const corte = d.toISOString().slice(0, 10)
    const { data, error } = await sb.from('vw_alerta_sobreposicao')
      .select('*').gte('dia', corte)
      .order('dia', { ascending: false })
    renderSobreposicoes(error ? [] : (data || []))
  }
  function renderSobreposicoes(rows) {
    const box = document.getElementById('sobrep-alerta'); if (!box) return
    if (!rows.length) { box.innerHTML = ''; return }
    const dmy = (s) => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—'
    const hm = (t) => String(t || '—').slice(0, 5)
    const ratNo = (x) => `${x.numero || '—'}${x.rat_seq != null ? '/' + String(x.rat_seq).padStart(2, '0') : ''}`
    const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
    box.innerHTML = `<div class="acomp-alert">
      <div class="acomp-alert-h">${ICON} Horários sobrepostos entre RATs (14 dias) · ${rows.length}</div>
      <div class="devol-alert-grid">${rows.map(r => `
        <a class="acomp-alert-card" href="jornada.html?d=${esc(r.dia)}" title="Abrir a Jornada do dia">
          <div class="dac-no">${esc(r.tecnico_nome || '—')} · ${dmy(r.dia)}</div>
          <div class="dac-cli">RAT ${esc(ratNo(r.rat_a || {}))} × RAT ${esc(ratNo(r.rat_b || {}))}</div>
          <div class="dac-age">Cruzam ${hm(r.conflito_inicio)}–${hm(r.conflito_fim)} · conferir na Jornada</div>
        </a>`).join('')}</div>
    </div>`
  }

  // Acompanhamento: tarefas EM EXECUÇÃO / EM PAUSA paradas há +5 dias (serviço começou e travou).
  // Fonte única na view vw_tarefas_acompanhamento (dias_parada = hoje − última atividade). Só
  // aparece quando houver.
  async function carregarAcompanhamento(sb, cli) {
    const { data, error } = await sb.from('vw_tarefas_acompanhamento')
      .select('id,numero,cliente_id,status,dias_parada')
      .gte('dias_parada', 5)
      .order('dias_parada', { ascending: false })   // mais paradas primeiro
    renderAcompanhamento(error ? [] : (data || []), cli)
  }
  function renderAcompanhamento(rows, cli) {
    const box = document.getElementById('acomp-alerta'); if (!box) return
    if (!rows.length) { box.innerHTML = ''; return }
    const osNo = (n) => n == null ? '—' : String(n).padStart(5, '0')
    const stLabel = (s) => s === 'em_pausa' ? 'Em pausa' : 'Em execução'
    const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
    box.innerHTML = `<div class="acomp-alert">
      <div class="acomp-alert-h">${ICON} Tarefas paradas há +5 dias · ${rows.length}</div>
      <div class="devol-alert-grid">${rows.map(t => `
        <a class="acomp-alert-card" href="tarefa.html?t=${esc(t.id)}" title="Abrir tarefa">
          <div class="dac-no">Tarefa Nº ${esc(osNo(t.numero))}</div>
          <div class="dac-cli">${esc(cli[t.cliente_id] || '—')}</div>
          <div class="dac-age">${esc(stLabel(t.status))} · parada há ${t.dias_parada} dias</div>
        </a>`).join('')}</div>
    </div>`
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
