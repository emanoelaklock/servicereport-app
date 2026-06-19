/* ═══════════════════════════════════════════════
   Service Report — rat-lista.js
   Busca GLOBAL de RATs (banco todo) — aba "Lista" da seção RAT. Só leitura + atalho.
   Consulta a view vw_rats_busca no servidor (ilike na coluna `busca`, que inclui o
   conteúdo do respostas) com filtros + paginação ("Carregar mais"). Cor do status =
   status_tarefa (marca) com texto legível; clique abre a Tarefa na aba RATs com a RAT.
   Exposto como window.RatListaApp.
═══════════════════════════════════════════════ */
(function () {
  const sb = () => getSupabase()
  const PAGE = 50
  const filtros = { busca: '', cliente: '', tecnico: '', status: '', de: '', ate: '' }
  let corStatus = {}, labelStatus = {}, clientes = [], offset = 0, total = 0
  const osNo = (n) => n == null ? '—' : String(n).padStart(5, '0')
  const corDe = (st) => corStatus[st] || '#48506A'
  const dmy = (s) => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—'

  async function init() {
    const [st, us, cl] = await Promise.all([
      sb().from('status_tarefa').select('chave,label,cor,ordem,ativo').order('ordem'),
      sb().rpc('sr_usuarios'),
      sb().from('clientes').select('nome').eq('oculto', false).order('nome'),   // só Empresas visíveis (mesma regra de Tarefas/Orçamentos), não o catálogo Omie oculto
    ])
    corStatus = {}; labelStatus = {}
    for (const s of (st.data || [])) { corStatus[s.chave] = s.cor; labelStatus[s.chave] = s.label }
    clientes = [...new Set((cl.data || []).map(c => c.nome).filter(Boolean))]
    // selects
    document.getElementById('rlf-status').innerHTML = '<option value="">Todos</option>' +
      Object.keys(corStatus).map(ch => `<option value="${esc(ch)}">${esc(labelStatus[ch] || ch)}</option>`).join('')
    const tecs = (us.data || []).filter(u => u.role === 'tecnico_campo' && u.ativo).map(u => u.nome).filter(Boolean).sort((a, b) => a.localeCompare(b))
    document.getElementById('rlf-tecnico').innerHTML = '<option value="">Todos</option>' + tecs.map(t => `<option>${esc(t)}</option>`).join('')
    bind()
    buscar()   // primeira página (sem filtro) = RATs mais recentes
  }

  function bind() {
    const CAMPOS = { 'rlf-busca': 'busca', 'rlf-cliente': 'cliente', 'rlf-tecnico': 'tecnico', 'rlf-status': 'status', 'rlf-de': 'de', 'rlf-ate': 'ate' }
    const aplicar = () => { for (const [id, k] of Object.entries(CAMPOS)) { const el = document.getElementById(id); if (el) filtros[k] = el.value.trim() } buscar() }
    document.getElementById('rlf-buscar').onclick = aplicar
    document.querySelectorAll('#rlf-busca, #rlf-cliente').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aplicar() } }))
    document.getElementById('rlf-limpar').onclick = () => {
      for (const id of Object.keys(CAMPOS)) { const el = document.getElementById(id); if (el) el.value = '' }
      Object.keys(filtros).forEach(k => filtros[k] = '')
      buscar()
    }
    const advT = document.getElementById('rlf-adv-toggle'), adv = document.getElementById('rlf-adv')
    advT.onclick = () => { const ab = adv.hasAttribute('hidden'); if (ab) adv.removeAttribute('hidden'); else adv.setAttribute('hidden', ''); advT.setAttribute('aria-expanded', String(ab)) }
    document.getElementById('rl-more').onclick = () => carregarPagina(false)
    // combobox de Cliente (todos os clientes)
    const cin = document.getElementById('rlf-cliente'), clist = document.getElementById('rlf-cliente-list')
    const abrir = () => {
      const termo = cin.value.trim().toLowerCase()
      const opts = clientes.filter(c => !termo || c.toLowerCase().includes(termo)).slice(0, 60)
      clist.innerHTML = opts.length ? opts.map(c => `<div class="rc-combo-opt" data-c="${esc(c)}">${esc(c)}</div>`).join('') : '<div class="rc-combo-empty">Nenhum cliente</div>'
      clist.hidden = false
    }
    cin.addEventListener('focus', abrir)
    cin.addEventListener('input', abrir)
    clist.addEventListener('mousedown', (e) => { const o = e.target.closest('.rc-combo-opt'); if (!o) return; e.preventDefault(); cin.value = o.dataset.c; clist.hidden = true })
    cin.addEventListener('blur', () => setTimeout(() => { clist.hidden = true }, 130))
    cin.addEventListener('keydown', (e) => { if (e.key === 'Escape') clist.hidden = true })
  }

  function buscar() { carregarPagina(true) }

  const TABELA = '<table class="cc-list"><thead><tr><th>Nº</th><th>Cliente</th><th>Status</th><th>Técnico</th><th>Data</th></tr></thead><tbody id="rl-list"></tbody></table>'

  async function carregarPagina(reset) {
    const panel = document.getElementById('rl-panel'), more = document.getElementById('rl-more')
    if (reset) { offset = 0; panel.innerHTML = TABELA }
    const f = filtros
    let q = sb().from('vw_rats_busca').select('*', { count: 'exact' })
    if (f.busca) q = q.ilike('busca', '%' + f.busca.toLowerCase() + '%')
    if (f.cliente) q = q.ilike('cliente_nome', '%' + f.cliente + '%')
    if (f.tecnico) q = q.ilike('colaboradores', '%' + f.tecnico + '%')
    if (f.status) q = q.eq('tarefa_status', f.status)
    if (f.de) q = q.gte('dia_rat', f.de)
    if (f.ate) q = q.lte('dia_rat', f.ate)
    q = q.order('dia_rat', { ascending: false, nullsFirst: false }).range(offset, offset + PAGE - 1)
    const { data, count, error } = await q
    if (error) { panel.innerHTML = `<div class="rl-empty" style="color:var(--re)">Erro ao buscar: ${esc(error.message)}</div>`; more.style.display = 'none'; return }
    total = count == null ? (data || []).length : count
    const rows = data || []
    offset += rows.length
    if (reset && !rows.length) {
      panel.innerHTML = '<div class="rl-empty">Nenhuma RAT encontrada para esses filtros.</div>'
    } else {
      const tbody = document.getElementById('rl-list')
      tbody.insertAdjacentHTML('beforeend', rows.map(rowHTML).join(''))
      tbody.querySelectorAll('.row-click[data-novo]').forEach(el => { el.removeAttribute('data-novo'); el.onclick = () => abrir(el.dataset.rat, el.dataset.tarefa) })
    }
    document.getElementById('rl-count').textContent = total ? `${total} RAT${total === 1 ? '' : 's'} encontrada${total === 1 ? '' : 's'}${offset < total ? ` · mostrando ${offset}` : ''}` : ''
    more.style.display = offset < total ? '' : 'none'
  }

  function rowHTML(r) {
    const cor = corDe(r.tarefa_status)
    const ratNo = r.tarefa_numero != null ? osNo(r.tarefa_numero) + (r.rat_seq != null ? '/' + String(r.rat_seq).padStart(2, '0') : '') : '—'
    const sub = [r.pedido_compra ? 'PC ' + esc(r.pedido_compra) : '', r.orcamento_numero ? 'Orç ' + esc(r.orcamento_numero) : ''].filter(Boolean).join(' · ')
    return `<tr class="row-click" data-novo data-rat="${esc(r.id)}" data-tarefa="${esc(r.tarefa_id || '')}">
      <td class="cc-num">${esc(ratNo)}</td>
      <td>
        <div class="cc-cli">${esc(r.cliente_nome || '—')}</div>
        ${sub ? `<div class="rl-sub">${sub}</div>` : ''}
        ${r.orientacao ? `<div class="cc-ori" title="${esc(r.orientacao)}">${esc(r.orientacao)}</div>` : ''}
      </td>
      <td><span class="st-pill" style="background:${cor}1A;color:${corTextoLegivel(cor)}">${esc(labelStatus[r.tarefa_status] || r.tarefa_status || '—')}</span></td>
      <td>${esc(r.colaboradores || '—')}</td>
      <td>${dmy(r.dia_rat)}</td>
    </tr>`
  }

  function abrir(ratId, tarefaId) {
    if (tarefaId) location.href = `tarefa.html?t=${encodeURIComponent(tarefaId)}&aba=rats&rat=${encodeURIComponent(ratId)}`
    else location.href = `rat.html?id=${encodeURIComponent(ratId)}`
  }

  window.RatListaApp = { init }
})()
