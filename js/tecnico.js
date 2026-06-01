/* ═══════════════════════════════════════════════
   Service Report — tecnico.js
   App de campo (PWA): formulário de RAT local-first.
   Fluxo: seleciona cliente + tipo de serviço (carrega o formulário do tipo) →
   preenche questionário dinâmico → ≥1 foto → assinatura → salva via DBLocal
   como 'salvo_local'. A subida (→ confirmado) é o passo 5 (sync.js).

   Dependências: utils.js (esc), supabase-client.js (getSupabase/getUserRole),
   auth.js (SESSION, toast), db-local.js (window.DBLocal).
   Exposto como window.TecnicoApp.
═══════════════════════════════════════════════ */
(function () {
  const D = () => window.DBLocal
  const REF_KEY = 'sr_ref_v1'

  let ref = { clientes: [], tipos: [], formularios: {} }   // formularios: { [id]: {nome,campos} }
  let tecnico = { id: null, nome: null }
  let cur = null            // RAT em edição: { client_uuid, campos: [] }
  let sig = null            // controlador do canvas de assinatura

  // ─────────────────────────── Init ───────────────────────────
  async function init() {
    const { data: { user } } = await getSupabase().auth.getUser()
    tecnico.id = user?.id || null
    const u = await getUserRole().catch(() => null)
    tecnico.nome = u?.nome || user?.email?.split('@')[0] || 'Técnico'
    const ftn = document.getElementById('ft-nome'); if (ftn) ftn.textContent = tecnico.nome

    bind()
    await carregarRef()
    await renderLista()
  }

  function bind() {
    document.getElementById('btn-nova').onclick = novaRat
    document.getElementById('btn-cancelar').onclick = cancelar
    document.getElementById('btn-salvar').onclick = salvar
    document.getElementById('f-tipo').onchange = onTipoChange
  }

  // ───────────────────── Dados de referência ─────────────────────
  // Online: busca do Supabase e cacheia (localStorage) para uso offline.
  // Offline: usa o cache.
  async function carregarRef() {
    try {
      const sb = getSupabase()
      const [cli, tip, forms] = await Promise.all([
        sb.from('clientes').select('id,nome,documento').order('nome'),
        sb.from('tipos_servico').select('id,nome,formulario_id,ativo').eq('ativo', true).order('nome'),
        sb.from('formulario_modelos').select('id,nome,campos').eq('ativo', true),
      ])
      if (cli.error || tip.error || forms.error) throw (cli.error || tip.error || forms.error)
      ref.clientes = cli.data || []
      ref.tipos = tip.data || []
      ref.formularios = {}
      ;(forms.data || []).forEach(f => { ref.formularios[f.id] = f })
      localStorage.setItem(REF_KEY, JSON.stringify(ref))
    } catch (e) {
      const cache = localStorage.getItem(REF_KEY)
      if (cache) { ref = JSON.parse(cache); toast('Offline — usando cadastros salvos.', 'info') }
      else { toast('Sem conexão e sem cadastros em cache.', 'err') }
    }
    // popula selects
    const selC = document.getElementById('f-cliente')
    selC.innerHTML = '<option value="">Selecione…</option>' +
      ref.clientes.map(c => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join('')
    const selT = document.getElementById('f-tipo')
    selT.innerHTML = '<option value="">Selecione…</option>' +
      ref.tipos.map(t => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')
  }

  // ─────────────────────────── Lista ───────────────────────────
  const BADGE = {
    rascunho:   { cls: 's-fi', txt: 'Rascunho' },
    salvo_local:{ cls: 's-rv', txt: 'Salvo no aparelho' },
    na_fila:    { cls: 's-ai', txt: 'Na fila' },
    enviando:   { cls: 's-ct', txt: 'Enviando…' },
    confirmado: { cls: 's-en', txt: 'Confirmado' },
    erro:       { cls: 's-rm', txt: 'Erro' },
  }
  function badge(status) {
    const b = BADGE[status] || { cls: 's-sc', txt: status }
    return `<span class="badge ${b.cls}"><span class="dot"></span>${esc(b.txt)}</span>`
  }

  async function renderLista() {
    const rats = await D().listarRats()
    const box = document.getElementById('lista-rats')
    if (!rats.length) {
      box.innerHTML = '<p class="dim" style="padding:14px 2px">Nenhuma RAT no aparelho. Toque em “+ Nova RAT”.</p>'
      return
    }
    box.innerHTML = rats.map(r => `
      <div class="rat-card" data-uuid="${esc(r.client_uuid)}">
        <div class="rat-card-top">
          <span class="rat-cli">${esc(r.cliente_nome || 'Sem cliente')}</span>
          ${badge(r.sync_status)}
        </div>
        <div class="rat-meta">
          <span>${esc(r.tipo_servico_nome || '—')}</span>
          <span>${fdt(r.criado_em, { withTime: true })}</span>
        </div>
      </div>`).join('')
    box.querySelectorAll('.rat-card').forEach(el => {
      el.onclick = () => abrirExistente(el.dataset.uuid)
    })
  }

  // ─────────────────────────── Form ───────────────────────────
  function mostrar(secao) {
    document.getElementById('view-lista').style.display = secao === 'lista' ? 'block' : 'none'
    document.getElementById('view-form').style.display = secao === 'form' ? 'block' : 'none'
  }

  async function novaRat() {
    const rat = await D().novoRat({})
    cur = { client_uuid: rat.client_uuid, campos: [] }
    document.getElementById('f-cliente').value = ''
    document.getElementById('f-tipo').value = ''
    document.getElementById('campos-container').innerHTML = ''
    document.getElementById('form-titulo').textContent = 'Nova RAT'
    mostrar('form')
  }

  async function abrirExistente(client_uuid) {
    const rat = await D().obterRat(client_uuid)
    if (!rat) return
    cur = { client_uuid, campos: [] }
    document.getElementById('form-titulo').textContent = 'Editar RAT'
    document.getElementById('f-cliente').value = rat.cliente_id || ''
    document.getElementById('f-tipo').value = rat.tipo_servico_id || ''
    await onTipoChange()
    // repopula respostas
    if (rat.respostas) {
      for (const [k, v] of Object.entries(rat.respostas)) {
        const el = document.querySelector(`[data-campo="${CSS.escape(k)}"]`)
        if (el) el.value = v
      }
    }
    mostrar('form')
  }

  async function onTipoChange() {
    const tipoId = document.getElementById('f-tipo').value
    const cont = document.getElementById('campos-container')
    const tipo = ref.tipos.find(t => t.id === tipoId)
    cur.campos = []
    if (!tipo) { cont.innerHTML = ''; return }
    const form = tipo.formulario_id ? ref.formularios[tipo.formulario_id] : null
    if (!form) { cont.innerHTML = '<p class="dim">Este tipo de serviço ainda não tem formulário configurado.</p>'; return }
    cur.campos = form.campos || []
    cont.innerHTML = ''
    for (const c of cur.campos) cont.appendChild(renderCampo(c))
    // ativar assinatura, se houver
    const sc = cont.querySelector('canvas.sig-pad')
    if (sc) { sig = initSignature(sc); sig.resize() }
    // thumbnails de fotos existentes
    await refreshThumbs()
  }

  function renderCampo(c) {
    const wrap = document.createElement('div')
    wrap.className = 'fg campo'
    const req = c.obrigatorio ? ' <span style="color:var(--re)">*</span>' : ''
    const label = `<label>${esc(c.label)}${req}</label>`

    if (c.tipo === 'texto') {
      wrap.innerHTML = `${label}<textarea data-campo="${esc(c.id)}" data-tipo="texto" placeholder="…"></textarea>`
    } else if (c.tipo === 'numero') {
      wrap.innerHTML = `${label}<input type="number" inputmode="decimal" data-campo="${esc(c.id)}" data-tipo="numero"/>`
    } else if (c.tipo === 'selecao') {
      const ops = (c.opcoes || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="selecao"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'foto') {
      wrap.innerHTML = `${label}
        <div class="foto-box">
          <input type="file" accept="image/*" capture="environment" multiple id="foto-input" style="display:none">
          <button type="button" class="btn" id="btn-foto">📷 Adicionar foto</button>
          <div class="thumbs" id="thumbs"></div>
        </div>`
      // bind após inserir no DOM
      setTimeout(() => {
        const inp = wrap.querySelector('#foto-input')
        wrap.querySelector('#btn-foto').onclick = () => inp.click()
        inp.onchange = () => adicionarFotos(inp.files)
      }, 0)
    } else if (c.tipo === 'assinatura') {
      wrap.innerHTML = `${label}
        <div class="sig-wrap">
          <canvas class="sig-pad"></canvas>
          <button type="button" class="btn btn-sm sig-clear" id="btn-sig-limpar">Limpar</button>
        </div>`
      setTimeout(() => { wrap.querySelector('#btn-sig-limpar').onclick = () => sig && sig.clear() }, 0)
    } else {
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto"/>`
    }
    return wrap
  }

  // ─────────────────────────── Fotos ───────────────────────────
  async function adicionarFotos(fileList) {
    const files = Array.from(fileList || [])
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      await D().adicionarFoto(cur.client_uuid, f, f.name)
    }
    await refreshThumbs()
  }
  async function refreshThumbs() {
    const box = document.getElementById('thumbs')
    if (!box) return
    const fotos = await D().listarFotos(cur.client_uuid)
    box.innerHTML = fotos.map(f => {
      const src = f.url || URL.createObjectURL(f.blob)
      return `<div class="thumb"><img src="${src}" alt=""><button type="button" class="thumb-x" data-id="${esc(f.id)}">×</button></div>`
    }).join('')
    box.querySelectorAll('.thumb-x').forEach(b => {
      b.onclick = async (e) => { e.stopPropagation(); await D().removerFoto(b.dataset.id); await refreshThumbs() }
    })
  }

  // ───────────────────── Assinatura (canvas) ─────────────────────
  function initSignature(canvas) {
    const ctx = canvas.getContext('2d')
    let drawing = false, dirty = false
    function resize() {
      const r = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, r.width * dpr)
      canvas.height = Math.max(1, r.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1B2A4A'
    }
    function pt(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    canvas.addEventListener('pointerdown', e => { drawing = true; const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.setPointerCapture(e.pointerId); e.preventDefault() })
    canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); dirty = true; e.preventDefault() })
    canvas.addEventListener('pointerup', () => { drawing = false })
    return {
      resize,
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false },
      isEmpty() { return !dirty },
      dataURL() { return canvas.toDataURL('image/png') },
    }
  }

  // ─────────────────────────── Salvar ───────────────────────────
  function coletarRespostas() {
    const respostas = {}
    let faltando = []
    for (const c of cur.campos) {
      if (c.tipo === 'foto' || c.tipo === 'assinatura') continue
      const el = document.querySelector(`[data-campo="${CSS.escape(c.id)}"]`)
      const v = el ? String(el.value || '').trim() : ''
      if (c.obrigatorio && !v) faltando.push(c.label)
      if (v) respostas[c.id] = v
    }
    return { respostas, faltando }
  }

  async function salvar() {
    if (!cur) return
    const cliId = document.getElementById('f-cliente').value
    const tipoId = document.getElementById('f-tipo').value
    if (!cliId) return toast('Selecione o cliente.', 'err')
    if (!tipoId) return toast('Selecione o tipo de serviço.', 'err')

    const { respostas, faltando } = coletarRespostas()
    const temFotoCampo = cur.campos.some(c => c.tipo === 'foto')
    const temAssinaturaCampo = cur.campos.some(c => c.tipo === 'assinatura')
    const fotoObrig = cur.campos.some(c => c.tipo === 'foto' && c.obrigatorio)
    const assinaturaObrig = cur.campos.some(c => c.tipo === 'assinatura' && c.obrigatorio)

    const fotos = await D().listarFotos(cur.client_uuid)
    if (faltando.length) return toast('Preencha: ' + faltando.join(', '), 'err')
    if (fotoObrig && fotos.length === 0) return toast('Anexe ao menos uma foto.', 'err')

    let assinatura_local = null
    const temAssinatura = sig && !sig.isEmpty()
    if (assinaturaObrig && !temAssinatura) return toast('Capture a assinatura.', 'err')
    if (temAssinatura) assinatura_local = sig.dataURL()

    const cli = ref.clientes.find(c => c.id === cliId)
    const tipo = ref.tipos.find(t => t.id === tipoId)

    await D().salvarRat(cur.client_uuid, {
      cliente_id: cliId,
      cliente_nome: cli?.nome || null,
      tipo_servico_id: tipoId,
      tipo_servico_nome: tipo?.nome || null,
      formulario_id: tipo?.formulario_id || null,
      tecnico_id: tecnico.id,
      tecnico_nome: tecnico.nome,
      data_tarefa: new Date().toISOString(),
      respostas,
      questionario_ok: faltando.length === 0,
      tem_assinatura: !!temAssinatura,
      assinatura_local,
    })
    await D().definirStatus(cur.client_uuid, D().STATUS.SALVO_LOCAL, 'salvo pelo técnico')
    toast('RAT salva no aparelho.', 'ok')
    cur = null; sig = null
    mostrar('lista')
    await renderLista()
  }

  async function cancelar() {
    // Descarta rascunho vazio (sem cliente, sem fotos) para não acumular lixo.
    if (cur) {
      const rat = await D().obterRat(cur.client_uuid)
      const fotos = await D().listarFotos(cur.client_uuid)
      const vazio = rat && rat.sync_status === D().STATUS.RASCUNHO && !rat.cliente_id && fotos.length === 0
      if (vazio) await D().removerRat(cur.client_uuid)
    }
    cur = null; sig = null
    mostrar('lista')
    await renderLista()
  }

  window.TecnicoApp = { init }
})()
