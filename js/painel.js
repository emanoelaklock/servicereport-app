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
    await Promise.all([carregarEnviosPresos(sb), carregarDevolvidas(sb, cli), carregarAcompanhamento(sb, cli), carregarPendExec(sb, cli), carregarSobreposicoes(sb)])
  }

  // Envios presos no aparelho (vw_alerta_rat_fotos_orfas — vigia F23/0139): pasta de fotos no
  // Storage SEM RAT no banco = o sync subiu as fotos e morreu antes do upsert (caso 4806) ou a
  // RAT foi excluída só localmente. A view já desconta pré-orçamento, tombstone e sync em voo
  // (<1h) e devolve 0 linhas fora de admin/gestor_axis (o card simplesmente não aparece).
  async function carregarEnviosPresos(sb) {
    // Revisadas (0141) saem do card: a triagem vale POR ESTADO — se chegar foto NOVA na
    // pasta depois da revisão (ultimo_envio > revisado_em), o item volta pra nova triagem.
    const [vw, rev] = await Promise.all([
      sb.from('vw_alerta_rat_fotos_orfas').select('*').order('ultimo_envio', { ascending: false }),
      sb.from('envio_preso_revisoes').select('rat_client_uuid,revisado_em'),
    ])
    const revMap = {}; (rev.data || []).forEach(v => { revMap[v.rat_client_uuid] = v })
    // erro de carga ≠ "sem alerta" (F15): sumir com o card em silêncio esconderia dado de
    // campo em risco. rows=null sinaliza o erro pro render.
    const pend = vw.error ? null : (vw.data || []).filter(r => {
      const v = revMap[r.rat_client_uuid]
      return !(v && new Date(r.ultimo_envio).getTime() <= new Date(v.revisado_em).getTime())
    })
    renderEnviosPresos(pend, sb)
  }
  const ERRO_CONF = (nome) => `<div style="font-size:12px;color:#B7791F;font-weight:600;padding:6px 2px">⚠ Não foi possível carregar a conferência “${nome}” — recarregue a página.</div>`
  function renderEnviosPresos(rows, sb) {
    const box = document.getElementById('presos-alerta'); if (!box) return
    if (rows === null) { box.innerHTML = ERRO_CONF('Envios presos no aparelho'); return }
    if (!rows.length) { box.innerHTML = ''; return }
    const dmy = (iso) => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—'
    const idade = (iso) => { const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d < 1 ? 'hoje' : d === 1 ? 'há 1 dia' : `há ${d} dias` }
    const ICON = '<svg viewBox="0 0 24 24"><path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6"/><path d="M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    box.innerHTML = `<div class="devol-alert">
      <div class="devol-alert-h">${ICON} Envios presos no aparelho (fotos sem RAT) · ${rows.length}</div>
      <div class="devol-alert-grid">${rows.map((r, i) => `
        <div class="devol-alert-card" title="Fotos no Storage sem RAT correspondente — o envio parou no meio">
          <div class="dac-no">${esc(r.tecnico_nome || 'Técnico desconhecido')}</div>
          <div class="dac-cli">${r.arquivos} foto${r.arquivos > 1 ? 's' : ''} · ${dmy(r.primeiro_envio)}</div>
          <div class="dac-age" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span>RAT não chegou (${esc(idade(r.ultimo_envio))}) · pedir ao técnico pra abrir o app online</span>
            <button type="button" class="btn btn-ghost" data-preso-ok="${i}" style="flex:none;padding:6px 10px;font-size:12px" title="Triagem feita com o técnico — sai do Painel; volta se chegar foto nova">Revisado</button>
          </div>
        </div>`).join('')}</div>
    </div>`
    box.querySelectorAll('[data-preso-ok]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true
      const r = rows[Number(btn.dataset.presoOk)]
      const { data: { user } } = await sb.auth.getUser()
      let nome = null
      if (user) { const u = await sb.from('usuarios').select('nome').eq('id', user.id).maybeSingle(); nome = (u.data || {}).nome || null }
      const { error } = await sb.from('envio_preso_revisoes').upsert({
        rat_client_uuid: r.rat_client_uuid, tecnico_id: r.tecnico_id || null,
        revisado_por: (user && user.id) || null, revisado_nome: nome, revisado_em: new Date().toISOString(),
      })
      if (error) { toast('Erro ao registrar a revisão: ' + error.message, 'err'); btn.disabled = false; return }
      toast('Envio preso revisado — sai do Painel.', 'ok')
      carregarEnviosPresos(sb)
    })
  }

  // Sobreposição de horários entre RATs (vw_alerta_sobreposicao — rede de segurança da
  // "passagem de bastão", Fase 1). Só leitura: não trava nem altera horários; a sobreposição
  // pode ser legítima (saiu e voltou). O Painel mostra a janela recente (14 dias, mesma régua
  // da lista do técnico); o histórico completo fica na Jornada.
  async function carregarSobreposicoes(sb) {
    const d = new Date(diaSP() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 14)
    const corte = d.toISOString().slice(0, 10)
    // Revisadas (0140) saem do card: chave = par de RATs ordenado; a revisão só vale
    // enquanto a janela do conflito for a mesma (horários editados → volta a pendente).
    const [vw, rev] = await Promise.all([
      sb.from('vw_alerta_sobreposicao').select('*').gte('dia', corte).order('dia', { ascending: false }),
      sb.from('sobreposicao_revisoes').select('rat_menor,rat_maior,conflito_inicio,conflito_fim'),
    ])
    const hm = (t) => String(t || '—').slice(0, 5)
    const revMap = {}; (rev.data || []).forEach(v => { revMap[v.rat_menor + '|' + v.rat_maior] = v })
    // erro de carga ≠ "sem sobreposição" (F15): rows=null sinaliza e o card avisa em vez de sumir
    const pend = vw.error ? null : (vw.data || []).filter(r => {
      const a = (r.rat_a || {}).rat_id || '', b = (r.rat_b || {}).rat_id || ''
      const v = revMap[a < b ? a + '|' + b : b + '|' + a]
      return !(v && hm(v.conflito_inicio) === hm(r.conflito_inicio) && hm(v.conflito_fim) === hm(r.conflito_fim))
    })
    renderSobreposicoes(pend, sb)
  }
  function renderSobreposicoes(rows, sb) {
    const box = document.getElementById('sobrep-alerta'); if (!box) return
    if (rows === null) { box.innerHTML = ERRO_CONF('Horários sobrepostos'); return }
    if (!rows.length) { box.innerHTML = ''; return }
    const dmy = (s) => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—'
    const hm = (t) => String(t || '—').slice(0, 5)
    const ratNo = (x) => `${x.numero || '—'}${x.rat_seq != null ? '/' + String(x.rat_seq).padStart(2, '0') : ''}`
    const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
    box.innerHTML = `<div class="acomp-alert">
      <div class="acomp-alert-h">${ICON} Horários sobrepostos entre RATs (14 dias) · ${rows.length}</div>
      <div class="devol-alert-grid">${rows.map((r, i) => `
        <div class="acomp-alert-card" data-nav="${esc(r.dia)}" style="cursor:pointer" title="Abrir a Jornada do dia">
          <div class="dac-no">${esc(r.tecnico_nome || '—')} · ${dmy(r.dia)}</div>
          <div class="dac-cli">RAT ${esc(ratNo(r.rat_a || {}))} × RAT ${esc(ratNo(r.rat_b || {}))}</div>
          <div class="dac-age" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span>Cruzam ${hm(r.conflito_inicio)}–${hm(r.conflito_fim)}</span>
            <button type="button" class="btn btn-ghost" data-ok="${i}" style="flex:none;padding:6px 10px;font-size:12px" title="Conferi — é legítimo; sai do Painel">Revisado</button>
          </div>
        </div>`).join('')}</div>
    </div>`
    box.querySelectorAll('[data-nav]').forEach(el => el.onclick = (e) => {
      if (e.target.closest('[data-ok]')) return
      location.href = 'jornada.html?d=' + encodeURIComponent(el.dataset.nav)
    })
    box.querySelectorAll('[data-ok]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true
      const r = rows[Number(btn.dataset.ok)]
      const [a, b] = [(r.rat_a || {}).rat_id, (r.rat_b || {}).rat_id].sort()
      const { data: { user } } = await sb.auth.getUser()
      let nome = null
      if (user) { const u = await sb.from('usuarios').select('nome').eq('id', user.id).maybeSingle(); nome = (u.data || {}).nome || null }
      const { error } = await sb.from('sobreposicao_revisoes').upsert({
        rat_menor: a, rat_maior: b, dia: r.dia || null,
        conflito_inicio: hm(r.conflito_inicio), conflito_fim: hm(r.conflito_fim),
        revisado_por: (user && user.id) || null, revisado_nome: nome, revisado_em: new Date().toISOString(),
      })
      if (error) { toast('Erro ao registrar a revisão: ' + error.message, 'err'); btn.disabled = false; return }
      toast('Sobreposição revisada.', 'ok')
      carregarSobreposicoes(sb)
    })
  }

  // Acompanhamento: tarefas EM EXECUÇÃO / EM PAUSA paradas há +5 dias (serviço começou e travou).
  // Fonte única na view vw_tarefas_acompanhamento (dias_parada = hoje − última atividade). Só
  // aparece quando houver.
  async function carregarAcompanhamento(sb, cli) {
    const { data, error } = await sb.from('vw_tarefas_acompanhamento')
      .select('id,numero,cliente_id,status,dias_parada')
      .gte('dias_parada', 5)
      .order('dias_parada', { ascending: false })   // mais paradas primeiro
    renderAcompanhamento(error ? null : (data || []), cli)   // null = erro (F15: não sumir em silêncio)
  }
  function renderAcompanhamento(rows, cli) {
    const box = document.getElementById('acomp-alerta'); if (!box) return
    if (rows === null) { box.innerHTML = ERRO_CONF('Tarefas paradas'); return }
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
    renderDevolvidas(error ? null : (data || []), cli)   // null = erro (F15: não sumir em silêncio)
  }
  function renderDevolvidas(rows, cli) {
    const box = document.getElementById('devol-alerta'); if (!box) return
    if (rows === null) { box.innerHTML = ERRO_CONF('Devolvidas sem retorno'); return }
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
    renderPendExec(error ? null : (data || []), cli)   // null = erro (F15: "Nenhuma" mentia)
  }

  function renderPendExec(rows, cli) {
    const box = document.getElementById('pend-exec'); if (!box) return
    const lab = document.getElementById('pend-exec-lab')
    if (lab) lab.textContent = `Tarefas pendentes de execução${rows && rows.length ? ' (' + rows.length + ')' : ''}`
    if (rows === null) { box.innerHTML = '<div class="pe-empty" style="color:#B7791F">⚠ Erro ao carregar as tarefas pendentes — recarregue a página.</div>'; return }
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
