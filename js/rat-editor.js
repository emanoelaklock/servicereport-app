/* ═══════════════════════════════════════════════
   Service Report — rat-editor.js
   Editor AUDITADO de RAT, compartilhado entre rat.html (página dedicada)
   e a aba RATs do detalhe da Tarefa (edição direta no card).
   Concentra o estado da edição (técnicos/produtos/fotos), o diff das
   alterações, o modal de motivo e a chamada da Edge Function rat-editar —
   uma única implementação para não haver caminho de edição sem auditoria.
   A página fornece: container da edição, lista de usuários e callback pós-salvar.
   Requer no HTML da página: modal-motivo (ids mot-sel / mot-det / mot-det-wrap /
   mot-resumo / mot-confirmar / mot-cancelar / mot-x).
═══════════════════════════════════════════════ */
window.RatEditor = (() => {

  // cfg: { sb: () => supabase, getUsuarios: () => [...sr_usuarios ativos],
  //        container: () => HTMLElement (onde o corpo em edição está renderizado),
  //        onSaved: async () => {} (recarregar a tela após salvar) }
  function criar(cfg) {
    const st = {
      det: null,
      ratTecs: [], ratTecsOrig: [],   // participantes (set de trabalho × base do diff)
      prodDel: new Set(), prodAdd: [],
      fotoDel: new Set(), fotoAdd: [],
      buscaT: null, pendentes: [],
    }
    const cont = () => cfg.container()
    const usuarios = () => cfg.getUsuarios() || []
    const nomeTec = (id) => { const u = usuarios().find(x => x.id === id); return u ? u.nome : (id || '—') }
    // Avatar com foto do Portal (componente padrão); iniciais como fallback.
    const avTec = (u) => { const f = (typeof avatarUrl === 'function') ? avatarUrl(u && u.foto_url) : ''; return f ? `<img src="${esc(f)}" alt="">` : esc(String((u && u.nome) || '—').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase()) }

    // Prepara uma nova edição: zera o estado e carrega os participantes atuais.
    async function iniciar(det) {
      st.det = det
      st.prodDel = new Set(); st.prodAdd = []; st.fotoDel = new Set(); st.fotoAdd = []
      const { data } = await cfg.sb().from('rat_tecnicos').select('tecnico_id,inicio,fim').eq('rat_id', det.r.id)
      st.ratTecs = data || []; st.ratTecsOrig = (data || []).map(x => ({ ...x }))
    }

    // ── Editor de TÉCNICOS (participantes) — só re-renderiza sua própria seção ──
    function tecEditorInner() {
      const atuais = st.ratTecs.map(t => usuarios().find(u => u.id === t.tecnico_id) || { id: t.tecnico_id, nome: nomeTec(t.tecnico_id) })
      const disp = usuarios().filter(u => u.role === 'tecnico_campo' && !st.ratTecs.some(t => t.tecnico_id === u.id)).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
      return `<div class="rd-sec-t">Técnicos responsáveis</div>
        <div class="rp-tecs">${atuais.length
          ? atuais.map(u => `<span class="rp-tec"><span class="rp-av">${avTec(u)}</span><span class="rp-tnm">${esc(u.nome)}</span><button type="button" class="rp-tecx" data-tecdel="${esc(u.id)}" title="Remover">×</button></span>`).join('')
          : '<span class="dim">Nenhum técnico — adicione abaixo.</span>'}</div>
        ${disp.length ? `<div class="rp-pick-l">Adicionar técnico:</div><div class="rp-tecpick">${disp.map(u => `<button type="button" class="rp-tecopt" data-tecadd="${esc(u.id)}"><span class="rp-av">${avTec(u)}</span><span class="rp-tnm">${esc(u.nome)}</span></button>`).join('')}</div>` : ''}`
    }
    function tecnicosHTML() { return `<div class="rd-sec" data-rated-tecs>${tecEditorInner()}</div>` }
    function bindTecEditor() {
      const wrap = cont().querySelector('[data-rated-tecs]'); if (!wrap) return
      const redo = () => { wrap.innerHTML = tecEditorInner(); bindTecEditor() }
      wrap.querySelectorAll('[data-tecdel]').forEach(b => b.onclick = () => { st.ratTecs = st.ratTecs.filter(t => t.tecnico_id !== b.dataset.tecdel); redo() })
      wrap.querySelectorAll('[data-tecadd]').forEach(b => b.onclick = () => { const id = b.dataset.tecadd; if (id && !st.ratTecs.some(t => t.tecnico_id === id)) { st.ratTecs.push({ tecnico_id: id, inicio: null, fim: null }); redo() } })
    }

    // ── Auto-ajuste das textareas + condicionais ao vivo (almoço/pausa/deslocamento → Sim) ──
    function bindEditExtras() {
      const body = cont()
      const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px' }
      body.querySelectorAll('textarea.rd-edit').forEach(ta => { grow(ta); ta.addEventListener('input', () => grow(ta)) })
      const reapply = (clear) => {
        RatView.aplicarCondicionais(body, st.det.campos)
        if (clear) body.querySelectorAll('[data-cwrap]').forEach(w => { if (w.style.display === 'none') { const inp = w.querySelector('[data-campo]'); if (inp && inp.value) inp.value = '' } })
      }
      body.querySelectorAll('select[data-campo]').forEach(s => s.addEventListener('change', () => reapply(true)))
      reapply(false)
    }

    // ── Editor de PRODUTOS (qty/remover/adicionar) ──
    function bindProdEditor() {
      const body = cont()
      body.querySelectorAll('[data-matdel]').forEach(b => b.onclick = () => {
        const id = b.dataset.matdel, tr = body.querySelector(`[data-matrow="${id}"]`)
        if (st.prodDel.has(id)) { st.prodDel.delete(id); if (tr) tr.style.opacity = '' }
        else { st.prodDel.add(id); if (tr) tr.style.opacity = '.4' }
      })
      body.querySelectorAll('[data-newdel]').forEach(b => b.onclick = () => { st.prodAdd = st.prodAdd.filter(p => p.uid !== b.dataset.newdel); const tr = body.querySelector(`[data-newrow="${b.dataset.newdel}"]`); if (tr) tr.remove() })
      const busca = body.querySelector('#rd-prodbusca'), res = body.querySelector('#rd-prodres')
      if (busca && res) busca.oninput = () => {
        clearTimeout(st.buscaT); const q = busca.value.trim()
        if (q.length < 2) { res.hidden = true; return }
        st.buscaT = setTimeout(async () => {
          const { data } = await cfg.sb().from('produtos').select('id,codigo,descricao,preco_venda').or(`codigo.ilike.%${q}%,descricao.ilike.%${q}%`).limit(20)
          const list = data || []
          res.innerHTML = list.length ? list.map(p => `<div class="rd-prodopt" data-pid="${esc(p.id)}">${esc(p.codigo || '')} · ${esc(p.descricao || '')}</div>`).join('') : '<div class="rd-prodopt dim">Nada encontrado</div>'
          res.hidden = false
          res.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => { const p = list.find(x => x.id === el.dataset.pid); if (p) addProduto(p); res.hidden = true; busca.value = '' })
        }, 250)
      }
    }
    function addProduto(p) {
      const uid = 'n' + Date.now() + '_' + st.prodAdd.length
      st.prodAdd.push({ uid, produto_id: p.id, codigo: p.codigo, descricao: p.descricao, preco: Number(p.preco_venda) || 0, quantidade: 1 })
      const tb = cont().querySelector('#rd-prodbody')
      if (tb) { tb.insertAdjacentHTML('beforeend', `<tr data-newrow="${esc(uid)}"><td>${esc(p.codigo || '')} · ${esc(p.descricao || '')}</td><td class="num"><input class="rd-qtd" data-newqtd="${esc(uid)}" type="number" step="any" min="0" value="1"></td><td class="num">${(Number(p.preco_venda) || 0).toFixed(2)}</td><td class="num">—</td><td class="num"><button type="button" class="rd-matdel" data-newdel="${esc(uid)}" title="Remover">×</button></td></tr>`); bindProdEditor() }
    }

    // ── Editor de FOTOS (adicionar via upload / remover / legenda) ──
    function bindFotoEditor() {
      const body = cont()
      body.querySelectorAll('[data-fotodel]').forEach(b => b.onclick = () => {
        const id = b.dataset.fotodel, fig = body.querySelector(`[data-fotorow="${id}"]`)
        if (st.fotoDel.has(id)) { st.fotoDel.delete(id); if (fig) fig.style.opacity = '' } else { st.fotoDel.add(id); if (fig) fig.style.opacity = '.4' }
      })
      body.querySelectorAll('[data-newfotodel]').forEach(b => b.onclick = () => { st.fotoAdd = st.fotoAdd.filter(p => p.uid !== b.dataset.newfotodel); const fig = body.querySelector(`[data-fotonew="${b.dataset.newfotodel}"]`); if (fig) fig.remove() })
      const inp = body.querySelector('#rd-fotoinput')
      if (inp) inp.onchange = async () => { for (const f of Array.from(inp.files)) await subirFoto(f); inp.value = '' }
    }
    async function subirFoto(file) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
      const path = `rats/${st.det.r.id}/adm-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`
      const { error } = await cfg.sb().storage.from('rat-anexos').upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' })
      if (error) return toast('Erro ao subir foto: ' + error.message, 'err')
      const uid = 'f' + Date.now() + '_' + st.fotoAdd.length
      st.fotoAdd.push({ uid, path, legenda: '' })
      const cfotos = cont().querySelector('#rd-fotos'); const prev = URL.createObjectURL(file)
      if (cfotos) cfotos.insertAdjacentHTML('beforeend', `<figure class="det-foto" data-fotonew="${esc(uid)}"><img src="${prev}" alt=""><button type="button" class="rd-fotodel" data-newfotodel="${esc(uid)}" title="Remover">×</button><input class="rd-fotonewleg" data-fotonewleg="${esc(uid)}" placeholder="legenda"></figure>`)
      bindFotoEditor()
    }

    // Liga todos os editores após a página renderizar o corpo em modo edição.
    function bind() { bindTecEditor(); bindProdEditor(); bindFotoEditor(); bindEditExtras() }

    // ── Diff completo da edição (campos, produtos, técnicos, fotos) ──
    function coletarAlteracoes() {
      const c = cont(), alt = []
      const { respostas } = RatView.coletarEdicao(c, st.det), orig = st.det.r.respostas || {}
      for (const k of Object.keys(respostas)) {
        if (String(respostas[k] ?? '') !== String(orig[k] ?? '')) alt.push({ alvo: 'campo', operacao: 'update', campo: k, valor_novo: respostas[k] })
      }
      for (const m of (st.det.mats || [])) {
        if (st.prodDel.has(m.id)) { alt.push({ alvo: 'produto', operacao: 'delete', chave: m.id }); continue }
        const qEl = c.querySelector(`[data-matqtd="${m.id}"]`), pEl = c.querySelector(`[data-mat="${m.id}"]`)
        const v = {}
        if (qEl && Number(qEl.value) !== Number(m.quantidade)) v.quantidade = Number(qEl.value)
        if (pEl && pEl.value !== '' && Number(pEl.value) !== Number(m.preco)) v.preco_unitario = Number(pEl.value)
        if (Object.keys(v).length) alt.push({ alvo: 'produto', operacao: 'update', chave: m.id, valor_novo: v })
      }
      for (const p of st.prodAdd) {
        const qEl = c.querySelector(`[data-newqtd="${p.uid}"]`)
        alt.push({ alvo: 'produto', operacao: 'insert', valor_novo: { produto_id: p.produto_id || null, codigo_produto: p.codigo || null, descricao: p.descricao, quantidade: qEl ? Number(qEl.value) : (Number(p.quantidade) || 0), preco_unitario: p.preco ?? null } })
      }
      const orT = new Set(st.ratTecsOrig.map(x => x.tecnico_id)), atT = new Set(st.ratTecs.map(x => x.tecnico_id))
      for (const id of atT) if (!orT.has(id)) alt.push({ alvo: 'tecnico', operacao: 'insert', chave: id })
      for (const id of orT) if (!atT.has(id)) alt.push({ alvo: 'tecnico', operacao: 'delete', chave: id })
      // fotos existentes: remover ou mudar legenda
      for (const f of (st.det.fotos || [])) {
        if (!f.id) continue
        if (st.fotoDel.has(f.id)) { alt.push({ alvo: 'foto', operacao: 'delete', chave: f.id }); continue }
        const lEl = c.querySelector(`[data-fotoleg="${f.id}"]`)
        if (lEl && (lEl.value || '') !== (f.legenda || '')) alt.push({ alvo: 'foto', operacao: 'update', chave: f.id, valor_novo: { legenda: lEl.value } })
      }
      // fotos adicionadas (já subidas no storage; manda o path + legenda)
      for (const p of st.fotoAdd) {
        const lEl = c.querySelector(`[data-fotonewleg="${p.uid}"]`)
        alt.push({ alvo: 'foto', operacao: 'insert', valor_novo: { url: p.path, legenda: lEl ? lEl.value : '' } })
      }
      return alt
    }

    // ── Salvar: monta o diff, pede o MOTIVO e envia pela Edge Function rat-editar ──
    function salvar() {
      const alt = coletarAlteracoes()
      if (!alt.length) { toast('Nada foi alterado.', 'info'); return }
      abrirMotivo(alt)
    }
    function abrirMotivo(alt) {
      st.pendentes = alt
      const modal = document.getElementById('modal-motivo')
      document.getElementById('mot-resumo').textContent = `${alt.length} alteração(ões) nesta RAT.`
      const sel = document.getElementById('mot-sel'); sel.value = ''
      const detWrap = document.getElementById('mot-det-wrap'), detEl = document.getElementById('mot-det')
      if (detEl) detEl.value = ''
      if (detWrap) detWrap.style.display = 'none'
      // "Outro" revela (e exige) a descrição — senão a edição fica sem explicação no histórico.
      sel.onchange = () => { if (detWrap) detWrap.style.display = (sel.value === 'outro') ? 'block' : 'none' }
      const fechar = () => modal.classList.remove('open')
      const bx = document.getElementById('mot-x'); if (bx) bx.onclick = fechar
      const bc = document.getElementById('mot-cancelar'); if (bc) bc.onclick = fechar
      modal.classList.add('open')
      document.getElementById('mot-confirmar').onclick = async () => {
        const motivo = sel.value
        if (!motivo) return toast('Escolha o motivo do ajuste.', 'err')
        const motivoDetalhe = detEl ? detEl.value.trim() : ''
        if (motivo === 'outro' && !motivoDetalhe) { if (detEl) detEl.focus(); return toast('Descreva o motivo (Outro).', 'err') }
        fechar()
        await chamarEditar({ rat_id: st.det.r.id, motivo, motivo_detalhe: motivoDetalhe || null, alteracoes: st.pendentes })
      }
    }
    async function chamarEditar(payload) {
      const { data, error } = await cfg.sb().functions.invoke('rat-editar', { body: payload })
      let msg = null
      if (error) { msg = error.message; try { if (error.context) { const j = await error.context.json(); if (j?.error) msg = j.error } } catch (e) {} }
      else if (data && data.error) msg = data.error
      if (msg) return toast('Não foi possível salvar: ' + msg, 'err')
      toast('RAT atualizada.', 'ok')
      await cfg.onSaved()
    }

    return { iniciar, tecnicosHTML, bind, salvar }
  }

  return { criar }
})()
