/* ═══════════════════════════════════════════════
   Service Report — configuracoes.js
   Back-office (admin/gestor): construtor de formulários (questionários)
   + gestão de tipos de serviço (vínculo com formulário + efeito de inventário).
   Dependências: utils.js, supabase-client.js, auth.js (toast).
   Exposto como window.ConfigApp.
═══════════════════════════════════════════════ */
(function () {
  let formularios = []
  let tipos = []
  let editFormId = null   // id do formulário em edição (null = novo)
  let editTipoId = null

  const TIPOS_CAMPO = ['texto', 'texto_longo', 'numero', 'data', 'hora', 'selecao', 'tecnico', 'tecnicos', 'veiculo', 'produtos', 'foto', 'assinatura']
  const TIPO_LABEL = {
    texto: 'Texto curto', texto_longo: 'Texto longo', numero: 'Número', data: 'Data', hora: 'Hora',
    selecao: 'Seleção (opções)', tecnico: 'Técnico (único)', tecnicos: 'Técnicos (vários)',
    veiculo: 'Veículo', produtos: 'Produtos utilizados', foto: 'Fotos', assinatura: 'Assinatura',
  }
  const TIPO_ICON = {
    texto: '🔤', texto_longo: '📝', numero: '#️⃣', data: '📅', hora: '⏰',
    selecao: '☑️', tecnico: '👤', tecnicos: '👥', veiculo: '🚗', produtos: '📦', foto: '📷', assinatura: '✍️',
  }
  // Operadores das condições (regras de exibição). valor=false → não precisa de valor.
  const COND_OPS = [
    { v: 'igual', t: 'é igual a', valor: true },
    { v: 'diferente', t: 'é diferente de', valor: true },
    { v: 'contem', t: 'contém', valor: true },
    { v: 'preenchido', t: 'está preenchido', valor: false },
    { v: 'vazio', t: 'está vazio', valor: false },
  ]
  let _rowSeq = 0
  let veiculos = []
  let editVeicId = null
  const EFEITOS = ['nenhum', 'marcar_locado', 'devolver_estoque', 'marcar_manutencao']

  const slug = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '').replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'campo'

  let usuarios = []
  let editUserId = null
  const ROLES = ['admin', 'gestor_axis', 'tecnico_campo', 'comercial']

  function mostrarSecao(sec) {
    const map = { usuarios: 'card-usuarios', formularios: 'sec-formularios', tipos: 'sec-tipos', veiculos: 'sec-veiculos', clientes: 'sec-clientes', produtos: 'sec-produtos', omie: 'sec-omie' }
    document.querySelectorAll('.cfg-section').forEach(el => { el.style.display = 'none' })
    const el = document.getElementById(map[sec]); if (el) el.style.display = ''
    document.querySelectorAll('.cfg-tab').forEach(t => t.classList.toggle('on', t.dataset.sec === sec))
  }

  async function init() {
    await carregar()
    document.getElementById('btn-novo-form').onclick = () => abrirForm(null)
    document.getElementById('btn-novo-tipo').onclick = () => abrirTipo(null)
    document.getElementById('btn-novo-veic').onclick = () => abrirVeiculo(null)
    montarTipoPicker()
    document.getElementById('btn-add-campo').onclick = (e) => { e.stopPropagation(); document.getElementById('cf-tipo-pick').classList.toggle('open') }
    document.addEventListener('click', () => document.getElementById('cf-tipo-pick')?.classList.remove('open'))
    // pré-visualização ao vivo reage a qualquer alteração nos campos
    const cb = document.getElementById('campos-build')
    cb.addEventListener('input', agendarPreview)
    cb.addEventListener('change', agendarPreview)
    document.getElementById('btn-omie-test').onclick = testarOmie
    document.getElementById('btn-omie-sync').onclick = sincronizarOmie
    carregarOmieLog()
    const bc = document.getElementById('busca-cli'); if (bc) bc.oninput = debounce(() => { cliPage = 0; buscarClientes(bc.value.trim()) }, 300)
    document.getElementById('cli-prev').onclick = () => { if (cliPage > 0) { cliPage--; buscarClientes(bc.value.trim()) } }
    document.getElementById('cli-next').onclick = () => { cliPage++; buscarClientes(bc.value.trim()) }
    document.getElementById('btn-nova-empresa').onclick = novaEmpresa
    document.getElementById('cc-cnpj-buscar').onclick = buscarCNPJ
    const bp = document.getElementById('busca-prod'); if (bp) bp.oninput = debounce(() => buscarProdutos(bp.value.trim()), 300)
    const ca = document.getElementById('chkall-cli'); if (ca) ca.onclick = () => document.querySelectorAll('#tbody-cli .row-chk').forEach(c => { c.checked = ca.checked })
    const pa = document.getElementById('chkall-prod'); if (pa) pa.onclick = () => document.querySelectorAll('#tbody-prod .row-chk').forEach(c => { c.checked = pa.checked })
    document.getElementById('bulk-cli-excluir').onclick = () => excluirSelecionados('cliente')
    document.getElementById('bulk-prod-ocultar').onclick = () => ocultarSelecionados('produto', true)
    document.getElementById('bulk-prod-mostrar').onclick = () => ocultarSelecionados('produto', false)
    document.getElementById('bulk-prod-excluir').onclick = () => excluirSelecionados('produto')
    buscarClientes(''); buscarProdutos('')
    document.querySelectorAll('.cfg-tab').forEach(t => { t.onclick = () => mostrarSecao(t.dataset.sec) })
    const isAdmin = (typeof PERFIL !== 'undefined' && PERFIL === 'admin')
    if (isAdmin) {
      document.getElementById('tab-usuarios').style.display = ''
      document.getElementById('btn-novo-user').onclick = () => abrirUsuario(null)
      await carregarUsuarios()
    }
    mostrarSecao(isAdmin ? 'usuarios' : 'formularios')
  }

  async function carregar() {
    const sb = getSupabase()
    const [f, t, v] = await Promise.all([
      sb.from('formulario_modelos').select('id,nome,campos,ativo').order('nome'),
      sb.from('tipos_servico').select('id,nome,formulario_id,efeito_inventario,ativo').order('nome'),
      sb.from('veiculos').select('id,modelo,placa,ativo').order('modelo'),
    ])
    formularios = f.error ? [] : (f.data || [])
    tipos = t.error ? [] : (t.data || [])
    veiculos = v.error ? [] : (v.data || [])
    if (f.error) toast('Erro ao carregar formulários: ' + f.error.message, 'err')
    renderFormularios(); renderTipos(); renderVeiculos()
  }

  // ───────────────────── Formulários ─────────────────────
  function renderFormularios() {
    const tb = document.getElementById('tbody-form')
    if (!formularios.length) { tb.innerHTML = '<tr><td colspan="4" class="dim" style="text-align:center;padding:20px">Nenhum formulário.</td></tr>'; return }
    tb.innerHTML = formularios.map(f => `
      <tr>
        <td>${esc(f.nome)}</td>
        <td>${(f.campos || []).length} campo(s)</td>
        <td>${f.ativo ? '<span class="badge s-en"><span class="dot"></span>Ativo</span>' : '<span class="dim">Inativo</span>'}</td>
        <td><div class="acts" style="opacity:1"><button class="ab ab-v" data-edit="${esc(f.id)}">Editar</button></div></td>
      </tr>`).join('')
    tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => abrirForm(b.dataset.edit))
  }

  function abrirForm(id) {
    editFormId = id
    const f = id ? formularios.find(x => x.id === id) : null
    document.getElementById('form-titulo').textContent = id ? 'Editar formulário' : 'Novo formulário'
    document.getElementById('cf-nome').value = f ? f.nome : ''
    document.getElementById('cf-ativo').checked = f ? !!f.ativo : true
    const box = document.getElementById('campos-build'); box.innerHTML = ''
    const campos = (f && f.campos) || []
    if (campos.length) { campos.forEach(addCampoRow); restaurarCondicoes() }
    else addCampoRow()
    atualizarEmpty()
    renderPreview()
    abrir('modal-form')
  }

  // Seletor de tipo (ícones) ao adicionar campo.
  function montarTipoPicker() {
    const pick = document.getElementById('cf-tipo-pick'); if (!pick) return
    pick.innerHTML = TIPOS_CAMPO.map(t =>
      `<button type="button" class="cf-tipo-opt" data-tipo="${t}"><span class="ic">${TIPO_ICON[t] || '•'}</span>${esc(TIPO_LABEL[t] || t)}</button>`).join('')
    pick.querySelectorAll('.cf-tipo-opt').forEach(b => b.onclick = () => {
      pick.classList.remove('open')
      addCampoRow({ tipo: b.dataset.tipo })
      atualizarEmpty(); renderPreview()
    })
  }

  function atualizarEmpty() {
    const has = document.querySelectorAll('#campos-build .campo-wrap').length > 0
    const e = document.getElementById('campos-empty'); if (e) e.style.display = has ? 'none' : 'block'
  }

  function addCampoRow(campo) {
    const box = document.getElementById('campos-build')
    const row = document.createElement('div')
    row.className = 'campo-wrap'
    row._key = 'r' + (++_rowSeq)
    if (campo && campo.id) row.dataset.id = campo.id
    const tipo0 = (campo && campo.tipo) || 'texto'
    const opts = TIPOS_CAMPO.map(t => `<option value="${t}"${tipo0 === t ? ' selected' : ''}>${TIPO_LABEL[t] || t}</option>`).join('')
    row.innerHTML = `
      <div class="fld-h">
        <button type="button" class="fld-collapse" title="Recolher / expandir">▼</button>
        <span class="fld-ic">${TIPO_ICON[tipo0] || '•'}</span>
        <span class="fld-move"><button type="button" class="fld-up" title="Subir">▲</button><button type="button" class="fld-down" title="Descer">▼</button></span>
        <select class="cb-tipo">${opts}</select>
        <span class="fld-summary"></span>
        <span class="spacer"></span>
        <label class="fld-obrig"><input type="checkbox" class="cb-obrig"${campo && campo.obrigatorio ? ' checked' : ''}> Obrigatório</label>
        <button type="button" class="fld-cond-btn cb-cond" title="Mostrar só em certas condições">⚙ Condicional</button>
        <button type="button" class="fld-del cb-del" title="Remover campo">🗑</button>
      </div>
      <input class="cb-label" placeholder="Pergunta / rótulo do campo" value="${campo ? esc(campo.label || '') : ''}">
      <input class="cb-opcoes" placeholder="Opções separadas por vírgula (ex.: Sim, Não)" value="${campo && campo.opcoes ? esc(campo.opcoes.join(', ')) : ''}">
      <div class="cond-panel">
        <div class="cond-head">Mostrar este campo quando
          <select class="cond-logica"><option value="E">TODAS (E)</option><option value="OU">QUALQUER (OU)</option></select>
          das regras:</div>
        <div class="cond-regras"></div>
        <button type="button" class="btn btn-sm cond-add">+ regra</button>
      </div>`
    box.appendChild(row)

    const tipoSel = row.querySelector('.cb-tipo')
    const opcoesInp = row.querySelector('.cb-opcoes')
    const labelInp = row.querySelector('.cb-label')
    const ic = row.querySelector('.fld-ic')
    const sum = row.querySelector('.fld-summary')
    const refreshMeta = () => {
      ic.textContent = TIPO_ICON[tipoSel.value] || '•'
      opcoesInp.style.display = tipoSel.value === 'selecao' ? '' : 'none'
      sum.textContent = labelInp.value.trim() || '(sem rótulo)'
    }
    tipoSel.onchange = refreshMeta
    labelInp.oninput = () => { sum.textContent = labelInp.value.trim() || '(sem rótulo)' }
    refreshMeta()
    row.querySelector('.fld-collapse').onclick = () => row.classList.toggle('collapsed')
    row.querySelector('.cb-del').onclick = () => { row.remove(); atualizarEmpty(); renderPreview() }
    row.querySelector('.fld-up').onclick = () => { const p = row.previousElementSibling; if (p) box.insertBefore(row, p); renderPreview() }
    row.querySelector('.fld-down').onclick = () => { const n = row.nextElementSibling; if (n) box.insertBefore(n, row); renderPreview() }
    const cbCond = row.querySelector('.cb-cond')
    const panel = row.querySelector('.cond-panel')
    cbCond.onclick = () => { const open = panel.classList.toggle('open'); cbCond.classList.toggle('on', open) }
    panel.querySelector('.cond-add').onclick = () => { addRegraRow(panel, row); renderPreview() }
    row._condPending = (campo && campo.cond) || null
  }

  // Preenche o select de "campo de referência" de uma regra com os demais campos.
  function popularCampoSelect(select, exceptRow, keep) {
    const rows = Array.from(document.querySelectorAll('#campos-build .campo-wrap'))
    const cur = keep != null ? keep : select.value
    select.innerHTML = '<option value="">— campo —</option>' + rows.filter(r => r !== exceptRow).map(r => {
      const lbl = (r.querySelector('.cb-label').value || '').trim() || '(sem rótulo)'
      return `<option value="${r._key}">${esc(lbl)}</option>`
    }).join('')
    if (cur) select.value = cur
  }

  function addRegraRow(panel, ownerRow, regra) {
    const box = panel.querySelector('.cond-regras')
    const r = document.createElement('div')
    r.className = 'cond-regra'
    const opOpts = COND_OPS.map(o => `<option value="${o.v}"${regra && regra.op === o.v ? ' selected' : ''}>${o.t}</option>`).join('')
    r.innerHTML = `
      <select class="cr-campo"></select>
      <select class="cr-op">${opOpts}</select>
      <input class="cr-valor" placeholder="valor" value="${regra && regra.valor != null ? esc(regra.valor) : ''}">
      <button type="button" class="ab ab-d cr-del">×</button>`
    box.appendChild(r)
    const campoSel = r.querySelector('.cr-campo')
    const opSel = r.querySelector('.cr-op')
    const valorInp = r.querySelector('.cr-valor')
    popularCampoSelect(campoSel, ownerRow)
    campoSel.onfocus = () => popularCampoSelect(campoSel, ownerRow)
    const toggleValor = () => { const o = COND_OPS.find(x => x.v === opSel.value); valorInp.style.display = (o && o.valor) ? '' : 'none' }
    opSel.onchange = toggleValor; toggleValor()
    r.querySelector('.cr-del').onclick = () => { r.remove(); agendarPreview() }
    return r
  }

  // Após todas as linhas existirem, restaura as condições salvas (resolve id → _key).
  function restaurarCondicoes() {
    const rows = Array.from(document.querySelectorAll('#campos-build .campo-wrap'))
    const idToKey = {}
    rows.forEach(r => { if (r.dataset.id) idToKey[r.dataset.id] = r._key })
    rows.forEach(row => {
      const cond = row._condPending
      if (!cond || !cond.regras || !cond.regras.length) return
      const panel = row.querySelector('.cond-panel')
      panel.querySelector('.cond-logica').value = cond.logica === 'OU' ? 'OU' : 'E'
      cond.regras.forEach(rg => {
        const rr = addRegraRow(panel, row, { op: rg.op, valor: rg.valor })
        popularCampoSelect(rr.querySelector('.cr-campo'), row, idToKey[rg.campo] || '')
      })
      panel.classList.add('open')
      row.querySelector('.cb-cond').classList.add('on')
    })
  }

  function coletarCampos(incluirVazios) {
    const rows = Array.from(document.querySelectorAll('#campos-build .campo-wrap'))
    const usados = new Set()
    const info = []
    rows.forEach(row => {
      row._id = null
      const label = (row.querySelector('.cb-label').value || '').trim()
      if (!label && !incluirVazios) return
      const tipo = row.querySelector('.cb-tipo').value
      const obrigatorio = row.querySelector('.cb-obrig').checked
      let id = row.dataset.id || (label ? slug(label) : row._key)
      while (usados.has(id)) id = id + '_' + (usados.size + 1)
      usados.add(id); row._id = id
      const campo = { id, label, tipo, obrigatorio }
      if (tipo === 'selecao') campo.opcoes = row.querySelector('.cb-opcoes').value.split(',').map(s => s.trim()).filter(Boolean)
      info.push({ row, campo })
    })
    const keyToId = {}; rows.forEach(r => { if (r._id) keyToId[r._key] = r._id })
    const campos = []
    for (const { row, campo } of info) {
      const logica = row.querySelector('.cond-logica').value === 'OU' ? 'OU' : 'E'
      const regras = []
      row.querySelectorAll('.cond-regra').forEach(rr => {
        const refId = keyToId[rr.querySelector('.cr-campo').value]
        if (!refId) return
        const op = rr.querySelector('.cr-op').value
        const opDef = COND_OPS.find(o => o.v === op)
        if (opDef && opDef.valor) {
          const valor = rr.querySelector('.cr-valor').value.trim()
          if (!valor) return
          regras.push({ campo: refId, op, valor })
        } else {
          regras.push({ campo: refId, op })
        }
      })
      if (regras.length) campo.cond = { logica, regras }
      campos.push(campo)
    }
    return campos
  }

  // ─────────────── Pré-visualização ao vivo (como o técnico vê) ───────────────
  const agendarPreview = debounce(() => renderPreview(), 200)
  const cssE = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&')

  function lerPreviewRespostas() {
    const r = {}
    document.querySelectorAll('#form-preview [data-pcampo]').forEach(el => { r[el.dataset.pcampo] = el.value })
    document.querySelectorAll('#form-preview [data-pmulti]:checked').forEach(chk => {
      r[chk.dataset.pmulti] = (r[chk.dataset.pmulti] ? r[chk.dataset.pmulti] + ', ' : '') + chk.value
    })
    return r
  }
  function renderPreview() {
    const box = document.getElementById('form-preview'); if (!box) return
    const campos = coletarCampos(true)
    const prev = lerPreviewRespostas()
    if (!campos.length) { box.innerHTML = '<div class="pv-empty">Adicione campos para ver a pré-visualização.</div>'; return }
    box.innerHTML = campos.map(c => previewCampoHtml(c, prev[c.id])).join('')
    box.oninput = () => avaliarPreview(campos)
    box.onchange = () => avaliarPreview(campos)
    avaliarPreview(campos)
  }
  function previewCampoHtml(c, val) {
    val = val == null ? '' : val
    const req = c.obrigatorio ? ' <span class="req">*</span>' : ''
    const lbl = `<label>${esc(c.label || '(sem rótulo)')}${req}</label>`
    const d = `data-pcampo="${esc(c.id)}"`
    let inner = ''
    switch (c.tipo) {
      case 'texto': inner = `<input type="text" ${d} value="${esc(val)}">`; break
      case 'texto_longo': inner = `<textarea ${d}>${esc(val)}</textarea>`; break
      case 'numero': inner = `<input type="number" ${d} value="${esc(val)}">`; break
      case 'data': inner = `<input type="date" ${d} value="${esc(val)}">`; break
      case 'hora': inner = `<input type="time" ${d} value="${esc(val)}">`; break
      case 'selecao': {
        const ops = (c.opcoes || []).map(o => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')
        inner = `<select ${d}><option value="">Selecione…</option>${ops}</select>`; break
      }
      case 'tecnico': inner = `<select ${d}><option value="">Selecione…</option><option>Técnico A</option><option>Técnico B</option></select>`; break
      case 'tecnicos': inner = `<div class="pv-multi"><label><input type="checkbox" data-pmulti="${esc(c.id)}" value="Técnico A"> Técnico A</label><label><input type="checkbox" data-pmulti="${esc(c.id)}" value="Técnico B"> Técnico B</label></div>`; break
      case 'veiculo': inner = `<select ${d}><option value="">Selecione…</option><option>Modelo (placa)</option></select>`; break
      case 'produtos': inner = '<div class="pv-ph">📦 Produtos do catálogo + quantidade</div>'; break
      case 'foto': inner = '<div class="pv-ph">📷 Adicionar fotos</div>'; break
      case 'assinatura': inner = '<div class="pv-ph">✍️ Área de assinatura</div>'; break
      default: inner = `<input type="text" ${d} value="${esc(val)}">`
    }
    return `<div class="pv-campo" data-pfield="${esc(c.id)}">${lbl}${inner}</div>`
  }
  function pvValor(id, campos) {
    const c = campos.find(x => x.id === id); if (!c) return ''
    if (c.tipo === 'tecnicos') return Array.from(document.querySelectorAll(`#form-preview [data-pmulti="${cssE(id)}"]:checked`)).map(x => x.value).join(', ')
    const el = document.querySelector(`#form-preview [data-pcampo="${cssE(id)}"]`)
    return el ? String(el.value || '').trim() : ''
  }
  function pvAvaliar(c, campos, visivel) {
    const cond = c.cond
    if (!cond || !cond.regras || !cond.regras.length) return true
    const res = cond.regras.map(rg => {
      const val = (visivel[rg.campo] === false) ? '' : pvValor(rg.campo, campos)
      const alvo = String(rg.valor == null ? '' : rg.valor)
      switch (rg.op) {
        case 'igual': return val === alvo
        case 'diferente': return val !== alvo
        case 'contem': return val.toLowerCase().includes(alvo.toLowerCase())
        case 'preenchido': return val.trim() !== ''
        case 'vazio': return val.trim() === ''
        default: return true
      }
    })
    return cond.logica === 'OU' ? res.some(Boolean) : res.every(Boolean)
  }
  function avaliarPreview(campos) {
    const visivel = {}; campos.forEach(c => { visivel[c.id] = true })
    for (let p = 0; p <= campos.length; p++) {
      let changed = false
      for (const c of campos) { const v = pvAvaliar(c, campos, visivel); if (v !== visivel[c.id]) { visivel[c.id] = v; changed = true } }
      if (!changed) break
    }
    campos.forEach(c => { const w = document.querySelector(`#form-preview [data-pfield="${cssE(c.id)}"]`); if (w) w.style.display = visivel[c.id] ? '' : 'none' })
  }

  async function salvarForm() {
    const nome = document.getElementById('cf-nome').value.trim()
    if (!nome) return toast('Dê um nome ao formulário.', 'err')
    const campos = coletarCampos()
    if (!campos.length) return toast('Adicione ao menos um campo com rótulo.', 'err')
    const ativo = document.getElementById('cf-ativo').checked
    const sb = getSupabase()
    let res
    if (editFormId) res = await sb.from('formulario_modelos').update({ nome, campos, ativo }).eq('id', editFormId)
    else res = await sb.from('formulario_modelos').insert({ nome, campos, ativo })
    if (res.error) return toast('Erro ao salvar: ' + res.error.message, 'err')
    toast('Formulário salvo.', 'ok')
    fechar('modal-form')
    await carregar()
  }

  // ───────────────────── Tipos de serviço ─────────────────────
  function nomeFormulario(id) { const f = formularios.find(x => x.id === id); return f ? f.nome : '—' }

  function renderTipos() {
    const tb = document.getElementById('tbody-tipo')
    if (!tipos.length) { tb.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:20px">Nenhum tipo.</td></tr>'; return }
    tb.innerHTML = tipos.map(t => `
      <tr>
        <td>${esc(t.nome)}</td>
        <td>${esc(nomeFormulario(t.formulario_id))}</td>
        <td>${esc(t.efeito_inventario)}</td>
        <td>${t.ativo ? '<span class="badge s-en"><span class="dot"></span>Ativo</span>' : '<span class="dim">Inativo</span>'}</td>
        <td><div class="acts" style="opacity:1"><button class="ab ab-v" data-edit="${esc(t.id)}">Editar</button></div></td>
      </tr>`).join('')
    tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => abrirTipo(b.dataset.edit))
  }

  function abrirTipo(id) {
    editTipoId = id
    const t = id ? tipos.find(x => x.id === id) : null
    document.getElementById('tipo-titulo').textContent = id ? 'Editar tipo de serviço' : 'Novo tipo de serviço'
    document.getElementById('ct-nome').value = t ? t.nome : ''
    const selF = document.getElementById('ct-form')
    selF.innerHTML = '<option value="">— sem formulário —</option>' +
      formularios.map(f => `<option value="${esc(f.id)}"${t && t.formulario_id === f.id ? ' selected' : ''}>${esc(f.nome)}</option>`).join('')
    const selE = document.getElementById('ct-efeito')
    selE.innerHTML = EFEITOS.map(e => `<option value="${e}"${t && t.efeito_inventario === e ? ' selected' : ''}>${e}</option>`).join('')
    document.getElementById('ct-ativo').checked = t ? !!t.ativo : true
    abrir('modal-tipo')
  }

  async function salvarTipo() {
    const nome = document.getElementById('ct-nome').value.trim()
    if (!nome) return toast('Dê um nome ao tipo de serviço.', 'err')
    const payload = {
      nome,
      formulario_id: document.getElementById('ct-form').value || null,
      efeito_inventario: document.getElementById('ct-efeito').value,
      ativo: document.getElementById('ct-ativo').checked,
    }
    const sb = getSupabase()
    let res
    if (editTipoId) res = await sb.from('tipos_servico').update(payload).eq('id', editTipoId)
    else res = await sb.from('tipos_servico').insert(payload)
    if (res.error) return toast('Erro ao salvar: ' + res.error.message, 'err')
    toast('Tipo de serviço salvo.', 'ok')
    fechar('modal-tipo')
    await carregar()
  }

  // ───────────────────── Veículos ─────────────────────
  function renderVeiculos() {
    const tb = document.getElementById('tbody-veic')
    if (!tb) return
    if (!veiculos.length) { tb.innerHTML = '<tr><td colspan="4" class="dim" style="text-align:center;padding:20px">Nenhum veículo.</td></tr>'; return }
    tb.innerHTML = veiculos.map(v => `
      <tr>
        <td>${esc(v.modelo || '—')}</td>
        <td>${esc(v.placa || '—')}</td>
        <td>${v.ativo ? '<span class="badge s-en"><span class="dot"></span>Ativo</span>' : '<span class="dim">Inativo</span>'}</td>
        <td><div class="acts" style="opacity:1"><button class="ab ab-v" data-edit="${esc(v.id)}">Editar</button></div></td>
      </tr>`).join('')
    tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => abrirVeiculo(b.dataset.edit))
  }

  function abrirVeiculo(id) {
    editVeicId = id
    const v = id ? veiculos.find(x => x.id === id) : null
    document.getElementById('veic-titulo').textContent = id ? 'Editar veículo' : 'Novo veículo'
    document.getElementById('cv-modelo').value = v ? (v.modelo || '') : ''
    document.getElementById('cv-placa').value = v ? (v.placa || '') : ''
    document.getElementById('cv-ativo').checked = v ? !!v.ativo : true
    abrir('modal-veic')
  }

  async function salvarVeiculo() {
    const modelo = document.getElementById('cv-modelo').value.trim()
    const placa = document.getElementById('cv-placa').value.trim()
    const ativo = document.getElementById('cv-ativo').checked
    if (!modelo && !placa) return toast('Informe modelo e/ou placa.', 'err')
    const payload = { modelo, placa, ativo }
    const sb = getSupabase()
    const res = editVeicId
      ? await sb.from('veiculos').update(payload).eq('id', editVeicId)
      : await sb.from('veiculos').insert(payload)
    if (res.error) return toast('Erro ao salvar: ' + res.error.message, 'err')
    toast('Veículo salvo.', 'ok')
    fechar('modal-veic'); await carregar()
  }

  // ───────────────────── Usuários (admin) ─────────────────────
  // Criação de login e reset de senha vão pela Edge Function (service_role);
  // edição de papel/ativo/nome é UPDATE direto (RLS usuarios_admin_update).
  async function chamarFn(body) {
    const { data, error } = await getSupabase().functions.invoke('manage-users', { body })
    if (error) {
      let msg = error.message
      try { const j = await error.context.json(); if (j && j.error) msg = j.error } catch (_) {}
      throw new Error(msg)
    }
    if (data && data.error) throw new Error(data.error)
    return data
  }

  async function carregarUsuarios() {
    const { data, error } = await getSupabase().from('usuarios').select('id,nome,email,role,ativo').order('nome')
    usuarios = error ? [] : (data || [])
    if (error) toast('Erro ao carregar usuários: ' + error.message, 'err')
    renderUsuarios()
  }

  function renderUsuarios() {
    const tb = document.getElementById('tbody-user')
    if (!usuarios.length) { tb.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:20px">Nenhum usuário.</td></tr>'; return }
    tb.innerHTML = usuarios.map(u => `
      <tr>
        <td>${esc(u.nome || '—')}</td>
        <td>${esc(u.email || '—')}</td>
        <td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
        <td>${u.ativo ? '<span class="badge s-en"><span class="dot"></span>Ativo</span>' : '<span class="dim">Inativo</span>'}</td>
        <td><div class="acts" style="opacity:1"><button class="ab ab-v" data-edit="${esc(u.id)}">Editar</button></div></td>
      </tr>`).join('')
    tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => abrirUsuario(b.dataset.edit))
  }

  function abrirUsuario(id) {
    editUserId = id
    const u = id ? usuarios.find(x => x.id === id) : null
    document.getElementById('user-titulo').textContent = id ? 'Editar usuário' : 'Novo usuário'
    const em = document.getElementById('cu-email')
    em.value = u ? (u.email || '') : ''
    em.readOnly = !!id
    document.getElementById('cu-nome').value = u ? (u.nome || '') : ''
    document.getElementById('cu-role').innerHTML = ROLES.map(r => `<option value="${r}"${u && u.role === r ? ' selected' : ''}>${esc(ROLE_LABEL[r] || r)}</option>`).join('')
    document.getElementById('cu-ativo').checked = u ? !!u.ativo : true
    document.getElementById('cu-senha').value = ''
    document.getElementById('cu-senha-label').textContent = id ? 'Nova senha (opcional)' : 'Senha'
    document.getElementById('btn-excluir-user').style.display = id ? '' : 'none'
    abrir('modal-user')
  }

  async function salvarUsuario() {
    const email = document.getElementById('cu-email').value.trim()
    const nome = document.getElementById('cu-nome').value.trim()
    const role = document.getElementById('cu-role').value
    const ativo = document.getElementById('cu-ativo').checked
    const senha = document.getElementById('cu-senha').value
    if (!nome) return toast('Informe o nome.', 'err')
    if (!ROLES.includes(role)) return toast('Papel inválido.', 'err')
    try {
      if (!editUserId) {
        if (!email || !senha) return toast('E-mail e senha são obrigatórios.', 'err')
        await chamarFn({ action: 'create', email, senha, nome, role })
        toast('Usuário criado.', 'ok')
      } else {
        const { error } = await getSupabase().from('usuarios').update({ nome, role, ativo }).eq('id', editUserId)
        if (error) throw error
        if (senha) await chamarFn({ action: 'reset_password', user_id: editUserId, senha })
        toast('Usuário atualizado.', 'ok')
      }
      fechar('modal-user'); await carregarUsuarios()
    } catch (e) { toast('Erro: ' + e.message, 'err') }
  }

  async function excluirUsuario() {
    if (!editUserId) return
    if (!confirm('Excluir este usuário? Esta ação não pode ser desfeita.')) return
    try {
      await chamarFn({ action: 'delete', user_id: editUserId })
      toast('Usuário excluído.', 'ok')
      fechar('modal-user'); await carregarUsuarios()
    } catch (e) { toast('Erro: ' + e.message, 'err') }
  }

  // ───────────────────── Integração Omie ─────────────────────
  async function omieFn(action) {
    const { data, error } = await getSupabase().functions.invoke('omie-sync', { body: { action } })
    if (error) {
      let m = error.message
      try { const j = await error.context.json(); if (j && j.error) m = j.error } catch (_) {}
      throw new Error(m)
    }
    if (data && data.error) throw new Error(data.error)
    return data
  }
  async function testarOmie() {
    const el = document.getElementById('omie-result'); el.textContent = 'Testando conexão…'
    try {
      const r = await omieFn('test')
      el.textContent = 'Conexão OK' + (r.empresas != null ? ` (empresas: ${r.empresas})` : '')
      toast('Conexão Omie OK.', 'ok')
    } catch (e) { el.textContent = 'Erro: ' + e.message; toast('Erro: ' + e.message, 'err') }
  }
  async function sincronizarOmie() {
    const el = document.getElementById('omie-result')
    const btn = document.getElementById('btn-omie-sync'); btn.disabled = true
    try {
      // Integração de CLIENTES desativada — empresas são cadastro manual.
      el.textContent = 'Sincronizando produtos…'
      const p = await omieFn('produtos')
      el.textContent = `Concluído: ${p.produtos} produtos. (Clientes/empresas: cadastro manual — sync desativado.)`
      toast('Produtos sincronizados.', 'ok')
      await carregarOmieLog()
    } catch (e) { el.textContent = 'Erro: ' + e.message; toast('Erro: ' + e.message, 'err') }
    finally { btn.disabled = false }
  }
  async function carregarOmieLog() {
    const el = document.getElementById('omie-last'); if (!el) return
    const { data } = await getSupabase().from('sync_log').select('inicio,fim,registros,status,detalhe')
      .eq('fonte', 'omie').order('inicio', { ascending: false }).limit(1)
    const l = (data || [])[0]
    el.textContent = l ? `Última sincronização: ${fdt(l.fim || l.inicio, { withTime: true })} · ${l.status} · ${l.detalhe || ''}` : 'Nenhuma sincronização ainda.'
  }

  // ───────────────────── Clientes (cadastro, origem Omie) ─────────────────────
  let cliPage = 0
  const CLI_PG = 50
  async function buscarClientes(q) {
    const from = cliPage * CLI_PG
    let query = getSupabase().from('clientes').select('id,nome,documento,endereco,oculto,sync_omie', { count: 'exact' })
      // esconde só os "excluídos" (oculto + não reimporta) — filtra no servidor, antes do limite
      .or('oculto.is.false,oculto.is.null,sync_omie.is.null,sync_omie.neq.false')
      .order('nome').range(from, from + CLI_PG - 1)
    if (q) { const qq = q.replace(/[%,()]/g, '').trim(); if (qq) query = query.or(`nome.ilike.%${qq}%,documento.ilike.%${qq}%`) }
    const { data, error, count } = await query
    renderCadastro('cli', error ? [] : (data || []), 'cliente')
    const total = count || 0, fim = Math.min(from + CLI_PG, total)
    const info = document.getElementById('cli-pag-info'); if (info) info.textContent = total ? `${total ? from + 1 : 0}–${fim} de ${total}` : 'nenhuma empresa'
    const prev = document.getElementById('cli-prev'), next = document.getElementById('cli-next')
    if (prev) prev.disabled = cliPage === 0
    if (next) next.disabled = fim >= total
  }
  async function buscarProdutos(q) {
    let query = getSupabase().from('produtos').select('id,codigo,descricao,unidade,ativo,oculto').order('descricao').limit(50)
    if (q) query = query.or(`descricao.ilike.%${q}%,codigo.ilike.%${q}%`)
    const { data, error } = await query
    renderCadastro('prod', error ? [] : (data || []), 'produto')
  }
  function renderCadastro(kind, rows, tipo) {
    const tb = document.getElementById(kind === 'cli' ? 'tbody-cli' : 'tbody-prod')
    if (!tb) return
    const cols = kind === 'cli' ? 4 : 6
    const chkAll = document.getElementById(kind === 'cli' ? 'chkall-cli' : 'chkall-prod'); if (chkAll) chkAll.checked = false
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="${cols}" class="dim" style="text-align:center;padding:20px">Nada encontrado.</td></tr>`; return }
    tb.innerHTML = rows.map(r => {
      const chk = `<td><input type="checkbox" class="row-chk" value="${esc(r.id)}"></td>`
      if (kind === 'cli') {
        // Empresas: Editar + Excluir (sem Status nem Ocultar)
        const acoes = `<div class="acts" style="opacity:1"><button class="ab ab-c" data-edit="${esc(r.id)}">Editar</button><button class="ab ab-d" data-del="${esc(r.id)}">Excluir</button></div>`
        return `<tr>${chk}<td>${esc(r.nome || '—')}</td><td>${esc(r.documento || '—')}</td><td>${acoes}</td></tr>`
      }
      let status
      if (r.oculto) status = '<span class="dim">Oculto</span>'
      else if (!r.ativo) status = '<span class="dim">Inativo</span>'
      else status = '<span class="badge s-en"><span class="dot"></span>Visível</span>'
      const acoes = `<div class="acts" style="opacity:1">
          <button class="ab ab-c" data-toggle="${esc(r.id)}" data-oc="${r.oculto ? 1 : 0}">${r.oculto ? 'Mostrar' : 'Ocultar'}</button>
          <button class="ab ab-d" data-del="${esc(r.id)}">Excluir</button>
        </div>`
      return `<tr>${chk}<td>${esc(r.codigo || '—')}</td><td>${esc(r.descricao || '—')}</td><td>${esc(r.unidade || '—')}</td><td>${status}</td><td>${acoes}</td></tr>`
    }).join('')
    tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editarCliente(b.dataset.edit))
    tb.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleOculto(tipo, b.dataset.toggle, b.dataset.oc === '1'))
    tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => excluirCadastro(tipo, b.dataset.del))
  }

  function idsSelecionados(kind) {
    return Array.from(document.querySelectorAll(`#${kind === 'cli' ? 'tbody-cli' : 'tbody-prod'} .row-chk:checked`)).map(c => c.value)
  }
  async function ocultarSelecionados(tipo, oculto) {
    const kind = tipo === 'cliente' ? 'cli' : 'prod'
    const ids = idsSelecionados(kind)
    if (!ids.length) return toast('Selecione ao menos um item.', 'err')
    const { error } = await getSupabase().from(tipo === 'cliente' ? 'clientes' : 'produtos').update({ oculto }).in('id', ids)
    if (error) return toast('Erro: ' + error.message, 'err')
    toast(`${ids.length} ${oculto ? 'ocultado(s)' : 'exibido(s)'}.`, 'ok')
    recarregaCadastro(tipo)
  }
  async function excluirSelecionados(tipo) {
    const kind = tipo === 'cliente' ? 'cli' : 'prod'
    const ids = idsSelecionados(kind)
    if (!ids.length) return toast('Selecione ao menos um item.', 'err')
    if (tipo === 'cliente') {
      if (!confirm(`Excluir ${ids.length} cliente(s)? Somem do app e o Omie não os reimporta na sincronização.`)) return
      const { error } = await getSupabase().from('clientes').update({ oculto: true, sync_omie: false }).in('id', ids)
      if (error) return toast('Erro: ' + error.message, 'err')
      toast(`${ids.length} cliente(s) excluído(s) — não serão reimportados.`, 'ok')
      return recarregaCadastro(tipo)
    }
    if (!confirm(`Excluir ${ids.length} ${tipo}(s)? Itens em uso por RAT são mantidos. O Omie pode reimportar.`)) return
    const sb = getSupabase()
    // descobre quais estão em uso (não dá pra excluir por FK) e exclui o resto
    const usados = new Set()
    if (tipo === 'cliente') { const { data } = await sb.from('rats').select('cliente_id').in('cliente_id', ids); (data || []).forEach(r => usados.add(r.cliente_id)) }
    else { const { data } = await sb.from('materiais').select('produto_id').in('produto_id', ids); (data || []).forEach(r => usados.add(r.produto_id)) }
    const deletaveis = ids.filter(id => !usados.has(id))
    if (deletaveis.length) {
      const { error } = await sb.from(tipo === 'cliente' ? 'clientes' : 'produtos').delete().in('id', deletaveis)
      if (error) return toast('Erro: ' + error.message, 'err')
    }
    const mantidos = ids.length - deletaveis.length
    toast(`${deletaveis.length} excluído(s)${mantidos ? `, ${mantidos} em uso mantido(s)` : ''}.`, 'ok')
    recarregaCadastro(tipo)
  }
  function recarregaCadastro(tipo) {
    if (tipo === 'cliente') buscarClientes((document.getElementById('busca-cli').value || '').trim())
    else buscarProdutos((document.getElementById('busca-prod').value || '').trim())
  }
  async function toggleOculto(tipo, id, oculto) {
    const tabela = tipo === 'cliente' ? 'clientes' : 'produtos'
    const { error } = await getSupabase().from(tabela).update({ oculto: !oculto }).eq('id', id)
    if (error) return toast('Erro: ' + error.message, 'err')
    toast(!oculto ? `${tipo} ocultado.` : `${tipo} exibido.`, 'ok')
    recarregaCadastro(tipo)
  }
  async function excluirCadastro(tipo, id) {
    if (tipo === 'cliente') {
      if (!confirm('Excluir este cliente? Ele some do app e o Omie não o reimporta na sincronização.')) return
      const { error } = await getSupabase().from('clientes').update({ oculto: true, sync_omie: false }).eq('id', id)
      if (error) return toast('Erro: ' + error.message, 'err')
      toast('Cliente excluído — não será reimportado.', 'ok')
      return recarregaCadastro(tipo)
    }
    if (!confirm(`Excluir este ${tipo}? O Omie pode reimportá-lo na próxima sincronização — para sumir de vez do app, use Ocultar.`)) return
    const { error } = await getSupabase().from('produtos').delete().eq('id', id)
    if (error) return toast(error.code === '23503' ? `${tipo} em uso por uma RAT — use Ocultar.` : 'Erro: ' + error.message, 'err')
    toast(`${tipo} excluído.`, 'ok')
    recarregaCadastro(tipo)
  }

  function toggleModalidadeCli() {
    const isHora = document.getElementById('cc-modalidade').value === 'por_hora'
    document.getElementById('cc-vh-wrap').style.display = isHora ? '' : 'none'
    document.getElementById('cc-dc-wrap').style.display = isHora ? 'flex' : 'none'
  }
  const formatCNPJ = (s) => { s = (s || '').replace(/\D/g, '').slice(0, 14); return s.length === 14 ? s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : s }
  function novaEmpresa() {
    document.getElementById('cc-modal-tt').textContent = 'Nova empresa'
    document.getElementById('cc-id').value = ''
    document.getElementById('cc-nome').value = ''
    document.getElementById('cc-documento').value = ''
    document.getElementById('cc-endereco').value = ''
    document.getElementById('cc-modalidade').value = ''
    document.getElementById('cc-vh').value = ''
    document.getElementById('cc-dc').checked = false
    document.getElementById('cc-modalidade').onchange = toggleModalidadeCli
    toggleModalidadeCli()
    abrir('modal-cli')
  }
  // Auto-preenche pelo CNPJ (BrasilAPI, pública/CORS).
  async function buscarCNPJ() {
    const raw = (document.getElementById('cc-documento').value || '').replace(/\D/g, '')
    if (raw.length !== 14) return toast('Digite um CNPJ com 14 dígitos.', 'err')
    const btn = document.getElementById('cc-cnpj-buscar'); const old = btn.textContent; btn.disabled = true; btn.textContent = 'Buscando…'
    try {
      const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + raw)
      if (!r.ok) throw new Error('CNPJ não encontrado')
      const d = await r.json()
      document.getElementById('cc-documento').value = formatCNPJ(raw)
      const nm = d.nome_fantasia || d.razao_social || ''
      if (nm) document.getElementById('cc-nome').value = nm
      const cep = d.cep ? String(d.cep).replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2') : ''
      const rua = [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' ')
      const linha = [[rua, d.numero].filter(Boolean).join(', '), d.bairro, [d.municipio, d.uf].filter(Boolean).join('/'), cep].filter(Boolean).join(' · ')
      if (linha.trim()) document.getElementById('cc-endereco').value = linha
      toast('Dados do CNPJ preenchidos.', 'ok')
    } catch (e) { toast('Não foi possível buscar o CNPJ: ' + (e.message || e), 'err') }
    finally { btn.disabled = false; btn.textContent = old }
  }
  async function editarCliente(id) {
    const { data, error } = await getSupabase().from('clientes').select('id,nome,documento,endereco,modalidade_padrao,valor_hora_padrao,dia_continuo').eq('id', id).single()
    if (error || !data) return toast('Erro ao carregar cliente.', 'err')
    document.getElementById('cc-modal-tt').textContent = 'Editar empresa'
    document.getElementById('cc-id').value = data.id
    document.getElementById('cc-nome').value = data.nome || ''
    document.getElementById('cc-documento').value = data.documento || ''
    document.getElementById('cc-endereco').value = data.endereco || ''
    document.getElementById('cc-modalidade').value = data.modalidade_padrao || ''
    document.getElementById('cc-vh').value = data.valor_hora_padrao != null ? data.valor_hora_padrao : ''
    document.getElementById('cc-dc').checked = !!data.dia_continuo
    document.getElementById('cc-modalidade').onchange = toggleModalidadeCli
    toggleModalidadeCli()
    abrir('modal-cli')
  }
  async function salvarCliente() {
    const id = document.getElementById('cc-id').value
    const nome = document.getElementById('cc-nome').value.trim()
    if (!nome) return toast('Informe o nome.', 'err')
    const mod = document.getElementById('cc-modalidade').value || null
    const dados = {
      nome,
      documento: document.getElementById('cc-documento').value.trim() || null,
      endereco: document.getElementById('cc-endereco').value.trim() || null,
      modalidade_padrao: mod,
      valor_hora_padrao: mod === 'por_hora' ? (Number(document.getElementById('cc-vh').value) || null) : null,
      dia_continuo: mod === 'por_hora' ? document.getElementById('cc-dc').checked : false,
      sync_omie: false,   // trava: cadastro/edição manual não é sobrescrito pelo Omie
    }
    const sb = getSupabase()
    const { error } = id
      ? await sb.from('clientes').update(dados).eq('id', id)
      : await sb.from('clientes').insert(dados)
    if (error) return toast('Erro ao salvar: ' + error.message, 'err')
    toast(id ? 'Empresa salva.' : 'Empresa cadastrada.', 'ok')
    fechar('modal-cli')
    recarregaCadastro('cliente')
  }

  const abrir = (id) => document.getElementById(id).classList.add('open')
  const fechar = (id) => document.getElementById(id).classList.remove('open')

  window.ConfigApp = { init, salvarForm, salvarTipo, salvarVeiculo, salvarUsuario, excluirUsuario, editarCliente, salvarCliente, fechar }
})()
