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

  let ref = { clientes: [], tipos: [], formularios: {}, tecnicos: [], veiculos: [], produtos: [] }   // formularios: { [id]: {nome,campos} }
  let tecnico = { id: null, nome: null }
  let cur = null            // RAT em edição: { client_uuid, campos: [] }
  let sig = null            // controlador do canvas de assinatura

  // Título-case: "marcelo oliveira" -> "Marcelo Oliveira"
  const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, m => m.toUpperCase())

  // Autocomplete com busca (listas grandes: clientes/produtos). Sem framework.
  // busca: input texto; hidden: input que guarda o id; list: div de sugestões.
  function attachAutocomplete(busca, hidden, list, items, fmt) {
    function render(q) {
      const nq = normStr(q)
      if (!nq) { list.classList.remove('open'); list.innerHTML = ''; return }
      const matches = []
      for (const it of items) {
        const f = fmt(it)
        if (normStr(f.label).includes(nq)) { matches.push(f); if (matches.length >= 30) break }
      }
      if (!matches.length) { list.innerHTML = '<div class="ac-empty">Nada encontrado</div>'; list.classList.add('open'); return }
      list.innerHTML = matches.map(m => `<div class="ac-item" data-id="${esc(m.id)}">${esc(m.label)}</div>`).join('')
      list.classList.add('open')
      list.querySelectorAll('.ac-item').forEach(el => {
        el.onmousedown = (e) => {
          e.preventDefault()
          hidden.value = el.dataset.id
          const m = matches.find(x => String(x.id) === el.dataset.id)
          busca.value = m ? m.label : ''
          list.classList.remove('open')
        }
      })
    }
    busca.oninput = () => { hidden.value = ''; render(busca.value) }
    busca.onfocus = () => { if (busca.value) render(busca.value) }
    busca.onblur = () => { setTimeout(() => list.classList.remove('open'), 150) }
  }

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
      const [cli, tip, forms, tec, veic, prod] = await Promise.all([
        sb.from('clientes').select('id,nome,documento').order('nome'),
        sb.from('tipos_servico').select('id,nome,formulario_id,ativo').eq('ativo', true).order('nome'),
        sb.from('formulario_modelos').select('id,nome,campos').eq('ativo', true),
        sb.from('usuarios').select('id,nome').eq('role', 'tecnico_campo').eq('ativo', true).order('nome'),
        sb.from('veiculos').select('id,modelo,placa,ativo').eq('ativo', true).order('modelo'),
        sb.from('produtos').select('id,codigo,descricao,unidade,ativo').eq('ativo', true).order('descricao'),
      ])
      if (cli.error || tip.error || forms.error) throw (cli.error || tip.error || forms.error)
      ref.clientes = cli.data || []
      ref.tipos = tip.data || []
      ref.formularios = {}
      ;(forms.data || []).forEach(f => { ref.formularios[f.id] = f })
      ref.tecnicos = tec.error ? [] : (tec.data || [])
      ref.veiculos = veic.error ? [] : (veic.data || [])
      ref.produtos = prod.error ? [] : (prod.data || [])
      localStorage.setItem(REF_KEY, JSON.stringify(ref))
    } catch (e) {
      const cache = localStorage.getItem(REF_KEY)
      if (cache) { ref = JSON.parse(cache); toast('Offline — usando cadastros salvos.', 'info') }
      else { toast('Sem conexão e sem cadastros em cache.', 'err') }
    }
    // cliente: autocomplete (lista grande do Omie)
    attachAutocomplete(
      document.getElementById('f-cliente-busca'),
      document.getElementById('f-cliente'),
      document.getElementById('ac-cliente-list'),
      ref.clientes, c => ({ id: c.id, label: c.nome })
    )
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
          <span>${esc(r.tipo_servico_nome || '—')}${r.status ? ' · ' + esc(r.status) : ''}</span>
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
    document.getElementById('f-cliente-busca').value = ''
    document.getElementById('f-tipo').value = ''
    document.getElementById('f-status').value = 'Em andamento'
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
    document.getElementById('f-cliente-busca').value =
      (ref.clientes.find(c => c.id === rat.cliente_id) || {}).nome || rat.cliente_nome || ''
    document.getElementById('f-tipo').value = rat.tipo_servico_id || ''
    document.getElementById('f-status').value = rat.status || 'Em andamento'
    await onTipoChange()
    // repopula respostas
    if (rat.respostas) {
      for (const c of cur.campos) {
        const v = rat.respostas[c.id]
        if (v == null) continue
        if (c.tipo === 'tecnicos') {
          const sel = new Set(String(v).split(',').map(s => s.trim()))
          document.querySelectorAll(`[data-multi="${CSS.escape(c.id)}"]`).forEach(chk => { chk.checked = sel.has(chk.value) })
        } else {
          const el = document.querySelector(`[data-campo="${CSS.escape(c.id)}"]`)
          if (el) el.value = v
        }
      }
    }
    atualizarTempo()
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
    // recalcula tempo trabalhado ao alterar qualquer campo
    cont.oninput = atualizarTempo
    cont.onchange = atualizarTempo
    atualizarTempo()
    // thumbnails de fotos existentes
    await refreshThumbs()
  }

  function renderCampo(c) {
    const wrap = document.createElement('div')
    wrap.className = 'fg campo'
    const req = c.obrigatorio ? ' <span style="color:var(--re)">*</span>' : ''
    const label = `<label>${esc(c.label)}${req}</label>`

    if (c.tipo === 'texto') {
      wrap.innerHTML = `${label}<input type="text" data-campo="${esc(c.id)}" data-tipo="texto"/>`
    } else if (c.tipo === 'texto_longo') {
      wrap.innerHTML = `${label}<textarea class="ta-longo" data-campo="${esc(c.id)}" data-tipo="texto_longo" placeholder="…"></textarea>`
    } else if (c.tipo === 'data') {
      const hoje = new Date().toISOString().slice(0, 10)
      wrap.innerHTML = `${label}<input type="date" value="${hoje}" data-campo="${esc(c.id)}" data-tipo="data"/>`
    } else if (c.tipo === 'hora') {
      wrap.innerHTML = `${label}<input type="time" data-campo="${esc(c.id)}" data-tipo="hora"/>`
    } else if (c.tipo === 'numero') {
      wrap.innerHTML = `${label}<input type="number" inputmode="decimal" data-campo="${esc(c.id)}" data-tipo="numero"/>`
    } else if (c.tipo === 'selecao') {
      const ops = (c.opcoes || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="selecao"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'tecnico') {
      const ops = (ref.tecnicos || []).map(t => { const n = tcase(t.nome); return `<option value="${esc(n)}"${n === tcase(tecnico.nome) ? ' selected' : ''}>${esc(n)}</option>` }).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="tecnico"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'tecnicos') {
      const checks = (ref.tecnicos || []).map(t => { const n = tcase(t.nome); return `<label><input type="checkbox" data-multi="${esc(c.id)}" value="${esc(n)}"> ${esc(n)}</label>` }).join('')
      wrap.innerHTML = `${label}<div class="multi-chk">${checks || '<span class="dim">Nenhum técnico cadastrado</span>'}</div>`
    } else if (c.tipo === 'veiculo') {
      const ops = (ref.veiculos || []).map(v => { const lbl = `${v.modelo || ''} (${v.placa || ''})`; return `<option value="${esc(lbl)}">${esc(lbl)}</option>` }).join('')
      wrap.innerHTML = `${label}<select data-campo="${esc(c.id)}" data-tipo="veiculo"><option value="">Selecione…</option>${ops}</select>`
    } else if (c.tipo === 'produtos') {
      wrap.innerHTML = `${label}
        <div class="prod-box">
          <div class="prod-add">
            <div class="ac">
              <input type="text" id="prod-busca" placeholder="Buscar produto…" autocomplete="off">
              <input type="hidden" id="prod-sel">
              <div class="ac-list" id="prod-ac-list"></div>
            </div>
            <input type="number" id="prod-qtd" inputmode="decimal" placeholder="Qtd" min="0" step="any">
            <button type="button" class="btn btn-sm" id="prod-add-btn">+ Add</button>
          </div>
          <div class="prod-list" id="prod-list"></div>
        </div>`
      setTimeout(() => {
        attachAutocomplete(
          document.getElementById('prod-busca'),
          document.getElementById('prod-sel'),
          document.getElementById('prod-ac-list'),
          ref.produtos || [], p => ({ id: p.id, label: (p.codigo ? p.codigo + ' - ' : '') + (p.descricao || '') })
        )
        const b = document.getElementById('prod-add-btn'); if (b) b.onclick = adicionarMaterialUI
        refreshMateriais()
      }, 0)
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
      await D().adicionarFoto(cur.client_uuid, f, null)   // legenda preenchida depois, por foto
    }
    await refreshThumbs()
  }
  async function refreshThumbs() {
    const box = document.getElementById('thumbs')
    if (!box) return
    const fotos = await D().listarFotos(cur.client_uuid)
    box.innerHTML = fotos.map(f => {
      const src = f.url || URL.createObjectURL(f.blob)
      return `<div class="thumb-card">
        <div class="thumb"><img src="${src}" alt=""><button type="button" class="thumb-x" data-id="${esc(f.id)}">×</button></div>
        <input type="text" class="thumb-leg" data-legid="${esc(f.id)}" placeholder="Legenda" value="${esc(f.legenda || '')}">
      </div>`
    }).join('')
    box.querySelectorAll('.thumb-x').forEach(b => {
      b.onclick = async (e) => { e.stopPropagation(); await D().removerFoto(b.dataset.id); await refreshThumbs() }
    })
    box.querySelectorAll('.thumb-leg').forEach(inp => {
      inp.onchange = () => D().atualizarLegendaFoto(inp.dataset.legid, inp.value.trim())
    })
  }

  // ── Produtos utilizados (materiais, origem 'usado') ──
  async function adicionarMaterialUI() {
    const pid = document.getElementById('prod-sel').value
    const qtdEl = document.getElementById('prod-qtd')
    const qtd = Number(qtdEl.value)
    if (!pid) return toast('Selecione um produto.', 'err')
    if (!qtd || qtd <= 0) return toast('Informe a quantidade.', 'err')
    const p = (ref.produtos || []).find(x => x.id === pid)
    await D().adicionarMaterial(cur.client_uuid, {
      produto_id: pid, codigo_produto: p ? p.codigo : null, descricao: p ? p.descricao : null,
      unidade: p ? p.unidade : null, quantidade: qtd,
    })
    document.getElementById('prod-sel').value = ''
    document.getElementById('prod-busca').value = ''
    qtdEl.value = ''
    await refreshMateriais()
  }
  async function refreshMateriais() {
    const box = document.getElementById('prod-list')
    if (!box) return
    const mats = await D().listarMateriais(cur.client_uuid)
    if (!mats.length) { box.innerHTML = '<span class="dim">Nenhum produto adicionado.</span>'; return }
    box.innerHTML = mats.map(m => `<div class="prod-item">
      <span>${esc(m.descricao || m.codigo_produto || '—')}</span>
      <span class="prod-qtd">${m.quantidade}${m.unidade ? ' ' + esc(m.unidade) : ''}</span>
      <button type="button" class="thumb-x" data-mid="${esc(m.id)}">×</button>
    </div>`).join('')
    box.querySelectorAll('[data-mid]').forEach(b => { b.onclick = async () => { await D().removerMaterial(b.dataset.mid); await refreshMateriais() } })
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
  // Tempo trabalhado: Sim → (final retorno − inicial ida); Não → (término − início);
  // sempre menos almoço e pausa (min). Resultado em minutos (>= 0).
  const minutosDe = (hhmm) => {
    if (!hhmm) return null
    const [h, m] = String(hhmm).split(':').map(Number)
    if (isNaN(h) || isNaN(m)) return null
    return h * 60 + m
  }
  function calcTempo() {
    const val = (id) => { const el = document.querySelector(`[data-campo="${CSS.escape(id)}"]`); return el ? el.value : '' }
    const desloc = val('deslocamento')
    let ini, fim
    if (desloc === 'Sim') { ini = val('desloc_inicial_ida'); fim = val('desloc_final_retorno') }
    else if (desloc === 'Não') { ini = val('hora_inicio'); fim = val('hora_termino') }
    else return null
    const a = minutosDe(ini), b = minutosDe(fim)
    if (a == null || b == null) return null
    const almoco = Number(val('tempo_almoco')) || 0
    const pausa = Number(val('tempo_pausa')) || 0
    const t = b - a - almoco - pausa
    return t < 0 ? 0 : t
  }
  const fmtMin = (t) => t == null ? '—' : `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}min`
  function atualizarTempo() {
    const el = document.getElementById('f-tempo'); if (el) el.value = fmtMin(calcTempo())
  }

  function coletarRespostas() {
    const respostas = {}
    let faltando = []
    for (const c of cur.campos) {
      if (c.tipo === 'foto' || c.tipo === 'assinatura' || c.tipo === 'produtos') continue
      let v = ''
      if (c.tipo === 'tecnicos') {
        v = Array.from(document.querySelectorAll(`[data-multi="${CSS.escape(c.id)}"]:checked`)).map(x => x.value).join(', ')
      } else {
        const el = document.querySelector(`[data-campo="${CSS.escape(c.id)}"]`)
        v = el ? String(el.value || '').trim() : ''
      }
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
    const produtosObrig = cur.campos.some(c => c.tipo === 'produtos' && c.obrigatorio)
    if (produtosObrig && (await D().listarMateriais(cur.client_uuid)).length === 0) return toast('Adicione ao menos um produto.', 'err')

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
      status: document.getElementById('f-status').value,
      tempo_trabalhado: calcTempo(),
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
    // Tenta sincronizar imediatamente se houver conexão (passo 5).
    if (window.SyncEngine && navigator.onLine) window.SyncEngine.syncAll()
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

  window.TecnicoApp = { init, refresh: renderLista }
})()
