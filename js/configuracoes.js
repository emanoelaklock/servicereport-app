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
  let veiculos = []
  let editVeicId = null
  const EFEITOS = ['nenhum', 'marcar_locado', 'devolver_estoque', 'marcar_manutencao']

  const slug = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '').replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'campo'

  let usuarios = []
  let editUserId = null
  const ROLES = ['admin', 'gestor_axis', 'tecnico_campo']

  function mostrarSecao(sec) {
    const map = { usuarios: 'card-usuarios', formularios: 'sec-formularios', tipos: 'sec-tipos', veiculos: 'sec-veiculos' }
    document.querySelectorAll('.cfg-section').forEach(el => { el.style.display = 'none' })
    const el = document.getElementById(map[sec]); if (el) el.style.display = ''
    document.querySelectorAll('.cfg-tab').forEach(t => t.classList.toggle('on', t.dataset.sec === sec))
  }

  async function init() {
    await carregar()
    document.getElementById('btn-novo-form').onclick = () => abrirForm(null)
    document.getElementById('btn-novo-tipo').onclick = () => abrirTipo(null)
    document.getElementById('btn-novo-veic').onclick = () => abrirVeiculo(null)
    document.getElementById('btn-add-campo').onclick = () => addCampoRow()
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

  const abrir = (id) => document.getElementById(id).classList.add('open')
  const fechar = (id) => document.getElementById(id).classList.remove('open')

  window.ConfigApp = { init, salvarForm, salvarTipo, salvarVeiculo, salvarUsuario, excluirUsuario, fechar }
})()
