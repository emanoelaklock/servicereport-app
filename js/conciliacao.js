/* ═══════════════════════════════════════════════
   Service Report — conciliacao.js  (#5.3)
   Tela admin: lista de Tarefas + conciliação de material (5 colunas).
   Admin edita a coluna "Levada" e adiciona materiais (catálogo ou avulso).
   Orçada vem do orçamento; Utilizada vem das RATs do técnico (view).
═══════════════════════════════════════════════ */
const ConciliacaoApp = (() => {
  const sb = () => getSupabase()
  let user = { id: null }
  let ref = { produtos: [], tecnicos: [], tipos: [], equip: [] }
  let tarefas = []           // lista de tarefas
  let cliNomes = {}          // cliente_id -> nome
  let tecNomes = {}          // tecnico_id -> nome
  let orcNo = {}             // orcamento_id -> numero
  let divPorTarefa = {}      // tarefa_id -> nº de linhas com divergência
  let filtro = 'todas'
  let cur = null             // tarefa aberta
  let linhas = []            // conciliação da tarefa atual

  const STATUS_LABEL = {
    aguardando_execucao: 'Aguardando execução', em_execucao: 'Em execução',
    concluida: 'Concluída', concluida_pendencia: 'Concluída c/ pendência',
    devolvida: 'Devolvida', aprovada_faturamento: 'Aprovada p/ faturamento', faturada: 'Faturada',
  }
  const SIT = {
    ok:            { t: 'OK',               cls: 's-ok' },
    devolver:      { t: 'Devolver',         cls: 's-dev' },
    sem_orcada:    { t: 'Fora da proposta', cls: 's-fora' },
    falta_estoque: { t: 'Faltou levar',     cls: 's-falta' },
    acima_orcado:  { t: 'Acima do orçado',  cls: 's-acima' },
  }
  const qtd = (n) => {
    const v = Number(n) || 0
    return Number.isInteger(v) ? String(v) : v.toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  }
  const dmy = (iso) => { if (!iso) return '—'; const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const unid = (l) => l.unidade ? ` <span class="u">${esc(l.unidade)}</span>` : ''
  const osNo = (n) => n != null ? String(n).padStart(5, '0') : '—'
  const equipLabel = (e) => `${e.modelo || e.tipo || 'Equipamento'}${e.serial ? ' · S/N ' + e.serial : ''}${e.part_number ? ' · PN ' + e.part_number : ''}`
  const fmtSize = (n) => { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }

  async function init() {
    const { data: { user: u } } = await sb().auth.getUser()
    user.id = u?.id || null
    const [prod, tec, tip, eq] = await Promise.all([
      sb().from('produtos').select('id,codigo,descricao,unidade,preco_venda').eq('ativo', true).eq('oculto', false).order('descricao'),
      sb().from('usuarios').select('id,nome').eq('role', 'tecnico_campo').eq('ativo', true).order('nome'),
      sb().from('tipos_servico').select('id,nome').eq('ativo', true).order('nome'),
      sb().from('equipamentos_axis').select('id,tipo,part_number,modelo,serial').order('modelo'),
    ])
    ref.produtos = prod.data || []
    ref.tecnicos = tec.data || []
    ref.tipos = tip.data || []
    ref.equip = eq.data || []
    tecNomes = {}; for (const t of ref.tecnicos) tecNomes[t.id] = t.nome
    document.getElementById('cc-d-tecnico').innerHTML = '<option value="">— não atribuído —</option>' + ref.tecnicos.map(t => `<option value="${esc(t.id)}">${esc(t.nome || '(sem nome)')}</option>`).join('')
    document.getElementById('cc-d-tipo').innerHTML = '<option value="">— selecione —</option>' + ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome || '')}</option>`).join('')
    bind()
    await carregarTarefas()
    mostrar('lista')
    renderLista()
  }

  function bind() {
    document.getElementById('btn-voltar').onclick = () => { cur = null; mostrar('lista'); carregarTarefas().then(renderLista) }
    document.querySelectorAll('#cc-filtros .chip').forEach(ch => ch.onclick = () => {
      filtro = ch.dataset.f
      document.querySelectorAll('#cc-filtros .chip').forEach(c => c.classList.toggle('on', c === ch))
      renderLista()
    })
    const bt = document.getElementById('busca-tarefa')
    if (bt) bt.oninput = debounce(() => renderLista(), 200)
    document.getElementById('cc-add-btn').onclick = adicionarMaterial
    document.getElementById('cc-d-salvar').onclick = salvarDados
    document.getElementById('cc-eq-btn').onclick = vincularEquip
    document.getElementById('cc-anx-btn').onclick = () => document.getElementById('cc-anx-input').click()
    document.getElementById('cc-anx-input').onchange = (e) => adicionarAnexos(e.target.files)
    attachAutocomplete(
      document.getElementById('cc-add-busca'),
      document.getElementById('cc-add-prod'),
      document.getElementById('cc-add-list'),
      ref.produtos,
      p => ({ id: p.id, label: `${p.codigo ? p.codigo + ' · ' : ''}${p.descricao}`,
              html: `<div class="ac-prod"><span class="ac-cod">${esc(p.codigo || '—')}</span><span class="ac-desc">${esc(p.descricao || '')}</span></div>` }),
      () => { document.getElementById('cc-add-desc').value = '' },
    )
    attachAutocomplete(
      document.getElementById('cc-eq-busca'),
      document.getElementById('cc-eq-sel'),
      document.getElementById('cc-eq-list'),
      ref.equip,
      e => ({ id: e.id, label: equipLabel(e),
              html: `<div class="ac-prod"><span class="ac-desc">${esc(e.modelo || e.tipo || '—')}</span><span class="ac-cod">${esc(e.serial ? 'S/N ' + e.serial : (e.part_number ? 'PN ' + e.part_number : ''))}</span></div>` }),
      null,
    )
  }

  // Autocomplete (mesmo padrão dos demais módulos).
  function attachAutocomplete(busca, hidden, list, items, fmt, onPick) {
    function render(q) {
      const nq = normStr(q)
      if (!nq) { list.classList.remove('open'); list.innerHTML = ''; return }
      const matches = []
      for (const it of items) {
        const f = fmt(it)
        if (normStr(f.label).includes(nq)) { matches.push(f); if (matches.length >= 30) break }
      }
      if (!matches.length) { list.innerHTML = '<div class="ac-empty">Nada encontrado</div>'; list.classList.add('open'); return }
      list.innerHTML = matches.map(m => `<div class="ac-item" data-id="${esc(m.id)}">${m.html || esc(m.label)}</div>`).join('')
      list.classList.add('open')
      list.querySelectorAll('.ac-item').forEach(el => {
        el.onmousedown = (e) => {
          e.preventDefault()
          if (hidden) hidden.value = el.dataset.id
          const m = matches.find(x => String(x.id) === el.dataset.id)
          busca.value = m ? m.label : ''
          list.classList.remove('open')
          if (onPick) onPick(el.dataset.id)
        }
      })
    }
    busca.oninput = () => { if (hidden) hidden.value = ''; render(busca.value) }
    busca.onfocus = () => { if (busca.value) render(busca.value) }
    busca.onblur = () => { setTimeout(() => list.classList.remove('open'), 150) }
  }

  // ─────────────────────────── Lista ───────────────────────────
  async function carregarTarefas() {
    const { data: ts, error } = await sb().from('tarefas')
      .select('id,numero,status,criado_em,data_agendada,orcamento_id,cliente_id,tecnico_id,orientacao,observacoes,pedido_compra,tipo_servico_id')
      .order('numero', { ascending: false })
    if (error) { toast('Erro ao carregar tarefas: ' + error.message, 'err'); tarefas = []; return }
    tarefas = ts || []
    const ids = [...new Set(tarefas.map(t => t.cliente_id).filter(Boolean))]
    cliNomes = {}
    if (ids.length) { const { data: cs } = await sb().from('clientes').select('id,nome').in('id', ids); for (const c of cs || []) cliNomes[c.id] = c.nome }
    const oids = [...new Set(tarefas.map(t => t.orcamento_id).filter(Boolean))]
    orcNo = {}
    if (oids.length) { const { data: os } = await sb().from('orcamentos').select('id,numero').in('id', oids); for (const o of os || []) orcNo[o.id] = o.numero }
    divPorTarefa = {}
    const { data: vc } = await sb().from('vw_conciliacao_tarefa').select('tarefa_id,situacao')
    for (const r of vc || []) { if (r.situacao && r.situacao !== 'ok') divPorTarefa[r.tarefa_id] = (divPorTarefa[r.tarefa_id] || 0) + 1 }
  }

  function renderLista() {
    const box = document.getElementById('lista-box')
    const q = normStr(document.getElementById('busca-tarefa').value || '')
    let rows = tarefas
    if (filtro === 'divergencia') rows = rows.filter(t => divPorTarefa[t.id])
    else if (filtro !== 'todas') rows = rows.filter(t => t.status === filtro)
    if (q) rows = rows.filter(t => normStr(cliNomes[t.cliente_id] || '').includes(q) || String(t.numero || '').includes(q))
    if (!rows.length) { box.innerHTML = '<div class="cc-empty">Nenhuma tarefa encontrada.</div>'; return }
    box.innerHTML = `<table class="cc-list"><thead><tr>
        <th>Nº</th><th>Cliente</th><th>Status</th><th>Técnico</th><th>Agenda</th><th>Conciliação</th>
      </tr></thead><tbody>${rows.map(t => {
        const d = divPorTarefa[t.id] || 0
        const concil = d ? `<span class="pill pill-warn">${d} divergência${d > 1 ? 's' : ''}</span>` : '<span class="pill pill-ok">OK</span>'
        const tec = t.tecnico_id ? esc(tecNomes[t.tecnico_id] || '—') : '<span class="pill pill-warn">atribuir</span>'
        return `<tr class="row-click" data-id="${esc(t.id)}">
          <td class="cc-num">${osNo(t.numero)}</td>
          <td>${esc(cliNomes[t.cliente_id] || '—')}</td>
          <td><span class="st">${esc(STATUS_LABEL[t.status] || t.status || '—')}</span></td>
          <td>${tec}</td>
          <td>${t.data_agendada ? dmy(t.data_agendada) : '<span class="st">—</span>'}</td>
          <td>${concil}</td>
        </tr>`
      }).join('')}</tbody></table>`
    box.querySelectorAll('.row-click').forEach(tr => tr.onclick = () => abrirTarefa(tr.dataset.id))
  }

  // ─────────────────────────── Detalhe ───────────────────────────
  async function abrirTarefa(id) {
    const t = tarefas.find(x => x.id === id); if (!t) return
    cur = { id, numero: t.numero, status: t.status, cliente_nome: cliNomes[t.cliente_id] || '—', equip: [], anexos: [] }
    document.getElementById('cc-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-docno').textContent = cur.numero != null ? `Tarefa Nº ${osNo(cur.numero)}` : ''
    document.getElementById('cc-badge').textContent = STATUS_LABEL[cur.status] || cur.status || ''
    // Card "Dados da Tarefa"
    document.getElementById('cc-d-cliente').textContent = cur.cliente_nome
    document.getElementById('cc-d-orc').textContent = t.orcamento_id ? `Orçamento Nº ${orcNo[t.orcamento_id] ?? '—'}` : 'Criada direto (sem orçamento)'
    document.getElementById('cc-d-status').textContent = STATUS_LABEL[cur.status] || cur.status || '—'
    document.getElementById('cc-d-tipo').value = t.tipo_servico_id || ''
    document.getElementById('cc-d-tecnico').value = t.tecnico_id || ''
    document.getElementById('cc-d-data').value = t.data_agendada || ''
    document.getElementById('cc-d-pc').value = t.pedido_compra || ''
    document.getElementById('cc-d-orientacao').value = t.orientacao || ''
    document.getElementById('cc-d-obs').value = t.observacoes || ''
    document.getElementById('cc-d-hint').textContent = t.tecnico_id ? '' : 'Atribua um técnico e agende para a Tarefa aparecer no app do técnico.'
    limparAdd()
    document.getElementById('cc-eq-busca').value = ''; document.getElementById('cc-eq-sel').value = ''
    await Promise.all([carregarLinhas(), carregarEquip(), carregarAnexos()])
    mostrar('detalhe')
  }

  async function salvarDados() {
    if (!cur || !cur.id) return
    const patch = {
      tipo_servico_id: document.getElementById('cc-d-tipo').value || null,
      tecnico_id: document.getElementById('cc-d-tecnico').value || null,
      data_agendada: document.getElementById('cc-d-data').value || null,
      pedido_compra: document.getElementById('cc-d-pc').value.trim() || null,
      orientacao: document.getElementById('cc-d-orientacao').value.trim() || null,
      observacoes: document.getElementById('cc-d-obs').value.trim() || null,
    }
    const up = await sb().from('tarefas').update(patch).eq('id', cur.id)
    if (up.error) return toast('Erro ao salvar: ' + up.error.message, 'err')
    // atualiza cache local p/ a lista refletir sem novo fetch
    const t = tarefas.find(x => x.id === cur.id)
    if (t) Object.assign(t, patch)
    document.getElementById('cc-d-hint').textContent = patch.tecnico_id ? '' : 'Atribua um técnico e agende para a Tarefa aparecer no app do técnico.'
    toast('Dados da Tarefa salvos.', 'ok')
  }

  // ───────────────────── Equipamentos relacionados ─────────────────────
  async function carregarEquip() {
    const { data, error } = await sb().from('tarefa_equipamentos').select('equipamento_id').eq('tarefa_id', cur.id)
    cur.equip = error ? [] : (data || []).map(r => r.equipamento_id)
    renderEquip()
  }
  function renderEquip() {
    const box = document.getElementById('cc-eq-chips')
    if (!cur.equip || !cur.equip.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhum equipamento vinculado.</span>'; return }
    box.innerHTML = cur.equip.map(id => {
      const e = ref.equip.find(x => x.id === id) || {}
      const sub = e.serial ? 'S/N ' + e.serial : (e.part_number ? 'PN ' + e.part_number : '')
      return `<span class="cc-chip"><span>${esc(e.modelo || e.tipo || 'Equipamento')}</span>${sub ? `<span class="cc-chip-sub">${esc(sub)}</span>` : ''}<button class="x" data-eq="${esc(id)}" title="Remover">×</button></span>`
    }).join('')
    box.querySelectorAll('[data-eq]').forEach(b => b.onclick = () => removerEquip(b.dataset.eq))
  }
  async function vincularEquip() {
    const id = document.getElementById('cc-eq-sel').value
    if (!id) return toast('Selecione um equipamento na busca.', 'err')
    if ((cur.equip || []).includes(id)) return toast('Equipamento já vinculado.', 'err')
    const ins = await sb().from('tarefa_equipamentos').insert({ tarefa_id: cur.id, equipamento_id: id })
    if (ins.error) return toast('Erro: ' + ins.error.message, 'err')
    document.getElementById('cc-eq-busca').value = ''; document.getElementById('cc-eq-sel').value = ''
    await carregarEquip()
  }
  async function removerEquip(id) {
    const d = await sb().from('tarefa_equipamentos').delete().eq('tarefa_id', cur.id).eq('equipamento_id', id)
    if (d.error) return toast('Erro: ' + d.error.message, 'err')
    await carregarEquip()
  }

  // ───────────────────── Anexos ─────────────────────
  async function carregarAnexos() {
    const { data, error } = await sb().from('tarefa_anexos').select('*').eq('tarefa_id', cur.id).order('criado_em')
    cur.anexos = error ? [] : (data || [])
    renderAnexos()
  }
  function renderAnexos() {
    const box = document.getElementById('cc-anx-list')
    if (!cur.anexos || !cur.anexos.length) { box.innerHTML = '<span class="cc-empty-sm">Nenhum anexo.</span>'; return }
    box.innerHTML = cur.anexos.map(a => `<div class="cc-anx-item"><span>📄</span><a class="nome" data-anx="${esc(a.id)}">${esc(a.nome)}</a><span class="sz">${fmtSize(a.tamanho)}</span><button class="x" data-del="${esc(a.id)}" title="Remover">×</button></div>`).join('')
    box.querySelectorAll('[data-anx]').forEach(el => el.onclick = () => baixarAnexo(el.dataset.anx))
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removerAnexo(b.dataset.del))
  }
  async function adicionarAnexos(files) {
    if (!cur || !cur.id || !files || !files.length) return
    for (const f of files) {
      const ext = (f.name.split('.').pop() || 'bin').toLowerCase()
      const path = `tarefas/${cur.id}/${crypto.randomUUID()}.${ext}`
      const up = await sb().storage.from('rat-anexos').upload(path, f, { contentType: f.type || undefined })
      if (up.error) { toast('Erro ao enviar ' + f.name + ': ' + up.error.message, 'err'); continue }
      const ins = await sb().from('tarefa_anexos').insert({ tarefa_id: cur.id, nome: f.name, url: path, mime: f.type || null, tamanho: f.size, criado_por: user.id })
      if (ins.error) toast('Erro ao registrar ' + f.name + ': ' + ins.error.message, 'err')
    }
    document.getElementById('cc-anx-input').value = ''
    toast('Anexos enviados.', 'ok')
    await carregarAnexos()
  }
  async function baixarAnexo(id) {
    const a = (cur.anexos || []).find(x => x.id === id); if (!a) return
    const { data, error } = await sb().storage.from('rat-anexos').createSignedUrl(a.url, 120)
    if (error) return toast('Erro ao abrir: ' + error.message, 'err')
    window.open(data.signedUrl, '_blank')
  }
  async function removerAnexo(id) {
    const a = (cur.anexos || []).find(x => x.id === id); if (!a) return
    if (!confirm('Remover este anexo?')) return
    await sb().storage.from('rat-anexos').remove([a.url]).catch(() => {})
    const d = await sb().from('tarefa_anexos').delete().eq('id', id)
    if (d.error) return toast('Erro: ' + d.error.message, 'err')
    await carregarAnexos()
  }

  async function carregarLinhas() {
    const { data, error } = await sb().from('vw_conciliacao_tarefa').select('*').eq('tarefa_id', cur.id)
    linhas = error ? [] : (data || [])
    linhas.sort((a, b) => (a.situacao === 'ok' ? 1 : 0) - (b.situacao === 'ok' ? 1 : 0) || (a.descricao || '').localeCompare(b.descricao || ''))
    if (error) toast('Erro ao carregar conciliação: ' + error.message, 'err')
    renderLinhas()
  }

  function renderLinhas() {
    const tb = document.getElementById('cc-tbody')
    if (!linhas.length) {
      tb.innerHTML = '<tr><td colspan="6" class="cc-empty">Sem materiais nesta tarefa. Adicione abaixo.</td></tr>'
    } else {
      tb.innerHTML = linhas.map((l, i) => {
        const sit = SIT[l.situacao] || { t: l.situacao, cls: '' }
        const fora = l.situacao === 'sem_orcada'
        return `<tr class="${fora ? 'row-fora' : ''}">
          <td class="cc-mat"><div class="cc-desc">${esc(l.descricao || '—')}</div>${l.codigo_produto ? `<div class="cc-cod">${esc(l.codigo_produto)}</div>` : ''}</td>
          <td class="num">${Number(l.qtd_orcada) > 0 ? qtd(l.qtd_orcada) + unid(l) : '<span class="dash">—</span>'}</td>
          <td class="num"><input class="cc-lev num" type="number" inputmode="decimal" min="0" step="any" value="${Number(l.qtd_levada) > 0 ? l.qtd_levada : ''}" data-i="${i}" placeholder="0"></td>
          <td class="num">${Number(l.qtd_utilizada) > 0 ? qtd(l.qtd_utilizada) + unid(l) : '<span class="dash">—</span>'}</td>
          <td class="num ${Number(l.qtd_devolvida) < 0 ? 'neg' : ''}">${qtd(l.qtd_devolvida) + unid(l)}</td>
          <td><span class="sit ${sit.cls}">${esc(sit.t)}</span></td>
        </tr>`
      }).join('')
      tb.querySelectorAll('.cc-lev').forEach(inp => inp.onchange = () => salvarLevada(Number(inp.dataset.i), inp.value))
    }
    renderStats()
  }

  // Resumo de custo (Orçado × Utilizado → faturamento) e devoluções (→ estoque).
  function renderStats() {
    const box = document.getElementById('cc-stats')
    if (!linhas.length) { box.innerHTML = ''; return }
    let custoOrcado = 0, custoUtil = 0, devValor = 0, devItens = 0, div = 0
    for (const l of linhas) {
      const p = Number(l.preco_unitario) || 0
      custoOrcado += (Number(l.qtd_orcada) || 0) * p
      custoUtil   += (Number(l.qtd_utilizada) || 0) * p
      const d = Number(l.qtd_devolvida) || 0
      if (d > 0) { devItens++; devValor += d * p }
      if (l.situacao !== 'ok') div++
    }
    const delta = custoUtil - custoOrcado
    const dcls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    const dtxt = delta > 0 ? `↑ ${money(delta)} acima do orçado`
               : delta < 0 ? `↓ ${money(-delta)} abaixo do orçado` : 'igual ao orçado'
    box.innerHTML = `
      <div class="stat"><div class="k">Custo orçado</div><div class="v">${money(custoOrcado)}</div><div class="d flat">o que foi vendido</div></div>
      <div class="stat"><div class="k">Custo utilizado</div><div class="v">${money(custoUtil)}</div><div class="d ${dcls}">${dtxt}</div></div>
      <div class="stat"><div class="k">A devolver ao estoque</div><div class="v">${money(devValor)}</div><div class="d flat">${devItens} item(ns)</div></div>
      <div class="stat ${div ? 'warn' : ''}"><div class="k">Divergências</div><div class="v">${div}</div><div class="d flat">${div ? 'revisar linhas' : 'tudo conciliado'}</div></div>`
  }

  async function salvarLevada(i, val) {
    const l = linhas[i]; if (!l) return
    const v = Number(val) || 0
    let err
    if (l.tm_id) {
      err = (await sb().from('tarefa_materiais').update({ qtd_levada: v }).eq('id', l.tm_id)).error
    } else {
      // linha "fora da proposta" (sem orçada) — cria a linha de material p/ registrar a levada
      err = (await sb().from('tarefa_materiais').insert({
        tarefa_id: cur.id, produto_id: l.produto_id || null, codigo_produto: l.codigo_produto || null,
        descricao: l.descricao || '(sem descrição)', unidade: l.unidade || null,
        preco_unitario: 0, qtd_orcada: 0, qtd_levada: v, origem: 'avulso',
      })).error
    }
    if (err) return toast('Erro ao salvar Levada: ' + err.message, 'err')
    toast('Levada atualizada.', 'ok')
    await carregarLinhas()
  }

  async function adicionarMaterial() {
    const pid = document.getElementById('cc-add-prod').value
    const desc = document.getElementById('cc-add-desc').value.trim()
    const qv = Number(document.getElementById('cc-add-qtd').value) || 0
    const p = ref.produtos.find(x => x.id === pid)
    const descricao = p ? p.descricao : desc
    if (!descricao) return toast('Selecione um produto ou digite uma descrição avulsa.', 'err')
    if (!qv || qv <= 0) return toast('Informe a quantidade levada.', 'err')
    const ins = await sb().from('tarefa_materiais').insert({
      tarefa_id: cur.id,
      produto_id: p ? p.id : null,
      codigo_produto: p ? p.codigo : null,
      descricao,
      unidade: p ? p.unidade : null,
      preco_unitario: p ? (Number(p.preco_venda) || 0) : 0,
      qtd_orcada: 0, qtd_levada: qv, origem: 'avulso',
    })
    if (ins.error) {
      if (ins.error.code === '23505') return toast('Esse material já está na lista — edite a Levada na linha.', 'err')
      return toast('Erro: ' + ins.error.message, 'err')
    }
    limparAdd()
    toast('Material adicionado.', 'ok')
    await carregarLinhas()
  }

  function limparAdd() {
    document.getElementById('cc-add-busca').value = ''
    document.getElementById('cc-add-prod').value = ''
    document.getElementById('cc-add-desc').value = ''
    document.getElementById('cc-add-qtd').value = ''
  }

  function mostrar(sec) {
    document.getElementById('view-lista').style.display = sec === 'lista' ? 'block' : 'none'
    document.getElementById('view-detalhe').style.display = sec === 'detalhe' ? 'block' : 'none'
    document.getElementById('topbar-title').textContent = sec === 'detalhe' ? 'Tarefa' : 'Tarefas'
    const badge = document.getElementById('cc-badge')
    if (sec !== 'detalhe') { badge.style.display = 'none'; document.getElementById('cc-docno').textContent = '' }
    else badge.style.display = ''
  }

  return { init }
})()
