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

  const TIPOS_CAMPO = ['texto', 'texto_longo', 'numero', 'data', 'hora', 'selecao', 'foto', 'assinatura']
  const EFEITOS = ['nenhum', 'marcar_locado', 'devolver_estoque', 'marcar_manutencao']

  const slug = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '').replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'campo'

  async function init() {
    await carregar()
    document.getElementById('btn-novo-form').onclick = () => abrirForm(null)
    document.getElementById('btn-novo-tipo').onclick = () => abrirTipo(null)
    document.getElementById('btn-add-campo').onclick = () => addCampoRow()
  }

  async function carregar() {
    const sb = getSupabase()
    const [f, t] = await Promise.all([
      sb.from('formulario_modelos').select('id,nome,campos,ativo').order('nome'),
      sb.from('tipos_servico').select('id,nome,formulario_id,efeito_inventario,ativo').order('nome'),
    ])
    formularios = f.error ? [] : (f.data || [])
    tipos = t.error ? [] : (t.data || [])
    if (f.error) toast('Erro ao carregar formulários: ' + f.error.message, 'err')
    renderFormularios(); renderTipos()
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
    if (campos.length) campos.forEach(addCampoRow)
    else addCampoRow()
    abrir('modal-form')
  }

  function addCampoRow(campo) {
    const box = document.getElementById('campos-build')
    const row = document.createElement('div')
    row.className = 'campo-row'
    row.dataset.id = (campo && campo.id) || ''
    const opts = TIPOS_CAMPO.map(t => `<option value="${t}"${campo && campo.tipo === t ? ' selected' : ''}>${t}</option>`).join('')
    row.innerHTML = `
      <input class="cb-label" placeholder="Pergunta / rótulo" value="${campo ? esc(campo.label || '') : ''}">
      <select class="cb-tipo">${opts}</select>
      <input class="cb-opcoes" placeholder="opções (vírgula)" value="${campo && campo.opcoes ? esc(campo.opcoes.join(', ')) : ''}">
      <label class="cb-obrig-l"><input type="checkbox" class="cb-obrig"${campo && campo.obrigatorio ? ' checked' : ''}> obrig.</label>
      <button type="button" class="ab ab-d cb-del">×</button>`
    const tipoSel = row.querySelector('.cb-tipo')
    const opcoesInp = row.querySelector('.cb-opcoes')
    const toggleOpcoes = () => { opcoesInp.style.display = tipoSel.value === 'selecao' ? '' : 'none' }
    tipoSel.onchange = toggleOpcoes; toggleOpcoes()
    row.querySelector('.cb-del').onclick = () => row.remove()
    box.appendChild(row)
  }

  function coletarCampos() {
    const rows = Array.from(document.querySelectorAll('#campos-build .campo-row'))
    const usados = new Set()
    const campos = []
    for (const r of rows) {
      const label = r.querySelector('.cb-label').value.trim()
      if (!label) continue
      const tipo = r.querySelector('.cb-tipo').value
      const obrigatorio = r.querySelector('.cb-obrig').checked
      // id estável: preserva o existente; senão gera do label, garantindo unicidade
      let id = r.dataset.id || slug(label)
      while (usados.has(id)) id = id + '_' + (usados.size + 1)
      usados.add(id)
      const campo = { id, label, tipo, obrigatorio }
      if (tipo === 'selecao') {
        campo.opcoes = r.querySelector('.cb-opcoes').value.split(',').map(s => s.trim()).filter(Boolean)
      }
      campos.push(campo)
    }
    return campos
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

  const abrir = (id) => document.getElementById(id).classList.add('open')
  const fechar = (id) => document.getElementById(id).classList.remove('open')

  window.ConfigApp = { init, salvarForm, salvarTipo, fechar }
})()
