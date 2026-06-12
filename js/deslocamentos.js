/* ═══════════════════════════════════════════════
   Service Report — deslocamentos.js  (visão do admin)
   Lista de trajetos (pernas) filtrável por Técnico · Cliente · Período · Sentido,
   + painel "Quem está fora" (técnico cujo último trajeto é Ida sem Volta).
   Exposto como window.DeslocApp.
═══════════════════════════════════════════════ */
const DeslocApp = (() => {
  const sb = () => getSupabase()
  let tecNomes = {}, cliNomes = {}, veic = {}, rows = []
  let tecArr = [], cliArr = [], veicArr = []
  const SENT = { ida: 'Ida', volta: 'Volta', outro: 'Outro' }
  const dt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
  const inputToISO = (v) => v ? new Date(v).toISOString() : null
  const veicLbl = (id) => veic[id] || '—'
  // lugares em Title Case (cadastros do Omie vêm em CAIXA ALTA); UF maiúscula
  const tcase = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, m => m.toUpperCase())
  const fmtLugar = (v) => {
    const m = String(v || '').match(/^(.+)\/([A-Za-z]{2})$/)
    return m ? `${tcase(m[1].trim())}/${m[2].toUpperCase()}` : (v || '')
  }
  const localLbl = (cidade, uf, legado) => fmtLugar([cidade, uf].filter(Boolean).join('/') || legado || '') || '—'
  const mapPin = (lat, lng) => (lat != null && lng != null) ? ` <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="Ver no mapa" style="text-decoration:none">📍</a>` : ''
  function rotaInfo(d) {
    if (d.saida_lat == null || d.chegada_lat == null) return ''
    const url = `https://www.google.com/maps/dir/?api=1&origin=${d.saida_lat},${d.saida_lng}&destination=${d.chegada_lat},${d.chegada_lng}`
    return `<div class="dim" style="font-size:11px;margin-top:3px"><a href="${url}" target="_blank" rel="noopener">🗺️ ver rota (distância no mapa)</a></div>`
  }

  async function init() {
    const [tec, cli, vc] = await Promise.all([
      sb().rpc('sr_usuarios'),   // usuários do SR (papel vindo do Portal); filtra técnicos abaixo
      sb().from('clientes').select('id,nome,endereco,oculto,sync_omie'),
      sb().from('veiculos').select('id,modelo,placa'),
    ])
    if (tec.data) tec.data = tec.data.filter(u => u.role === 'tecnico_campo' && u.ativo)
    // visível = mesma regra da tela Empresas (esconde só as "excluídas")
    const visivel = (c) => (c.oculto === false || c.oculto == null) || (c.sync_omie == null || c.sync_omie !== false)
    tecArr = (tec.data || [])
    cliArr = (cli.data || []).filter(visivel).slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
    veicArr = (vc.data || [])
    ;(tec.data || []).forEach(t => { tecNomes[t.id] = t.nome })
    ;(cli.data || []).forEach(c => { cliNomes[c.id] = c.nome })
    ;(vc.data || []).forEach(v => { veic[v.id] = `${v.modelo || ''} (${v.placa || ''})` })
    document.getElementById('d-tec').innerHTML = '<option value="">Técnico: todos</option>' +
      (tec.data || []).map(t => `<option value="${esc(t.id)}">${esc(t.nome || '')}</option>`).join('')
    document.getElementById('d-cli').innerHTML = '<option value="">Cliente: todos</option>' +
      cliArr.map(c => `<option value="${esc(c.id)}">${esc(c.nome || '')}</option>`).join('')
    ;['d-tec', 'd-cli', 'd-sent', 'd-de', 'd-ate'].forEach(id => { document.getElementById(id).onchange = render })
    document.getElementById('dm-x').onclick = fecharModal
    document.getElementById('dm-cancelar').onclick = fecharModal
    document.getElementById('dm-salvar').onclick = salvarEdicao
    document.getElementById('dm-excluir').onclick = () => excluir(document.getElementById('dm-id').value)
    document.getElementById('vm-x').onclick = fecharViagem
    document.getElementById('vm-cancelar').onclick = fecharViagem
    document.getElementById('vm-salvar').onclick = salvarViagem
    document.getElementById('vm-excluir').onclick = () => { const id = document.getElementById('vm-id').value; fecharViagem(); excluir(id) }
    document.getElementById('vm-addleg').onclick = () => { if (!vmCur) return; vmCur.trechos.push(vmNovoTrecho()); renderVmTrechos() }
    document.getElementById('vm-cli').onchange = async (e) => { if (!vmCur) return; vmCur.cliente_id = e.target.value || null; await vmCarregarLocais(); renderVmTrechos() }
    // o campo edita a viagem no celular → a lista se atualiza sozinha
    // (ao voltar o foco, a cada 2 min e em tempo real; pausa enquanto o editor está aberto)
    let recarregaT = null
    const recarrega = () => {
      if (document.hidden || vmCur) return
      clearTimeout(recarregaT)
      recarregaT = setTimeout(() => carregar(), 400)
    }
    document.addEventListener('visibilitychange', recarrega)
    window.addEventListener('focus', recarrega)
    setInterval(recarrega, 120000)
    try {
      sb().channel('adm-desloc')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'deslocamentos' }, recarrega)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'deslocamento_trechos' }, recarrega)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'deslocamento_almocos' }, recarrega)
        .subscribe()
    } catch (e) { /* sem realtime, ficam o foco e o intervalo */ }
    await carregar()
  }

  async function carregar() {
    const { data, error } = await sb().from('deslocamentos')
      .select('id,sentido,cliente_id,origem,destino,origem_cidade,origem_uf,destino_cidade,destino_uf,motivo,saida_em,chegada_em,veiculo_id,saida_lat,saida_lng,chegada_lat,chegada_lng,criado_em,deslocamento_tecnicos(tecnico_id),deslocamento_trechos(id,ordem,origem,destino,destino_local_id,destino_cliente_id,data,saida_em,chegada_em,saida_lat,saida_lng,saida_precisao,chegada_lat,chegada_lng,chegada_precisao,veiculo_id,nota_transporte,espelho_legado,cliente_locais(nome,cidade,uf),trecho_tecnicos(tecnico_id),trecho_direcao(id,tecnico_id,hora_de,hora_ate)),deslocamento_almocos(tecnico_id,dia,inicio,fim)')
      .order('criado_em', { ascending: false }).limit(300)
    if (error) { toast('Erro: ' + error.message, 'err'); return }
    rows = data || []
    render()
  }
  // trechos do modelo novo (espelho_legado é cópia de registro antigo — fica de fora)
  const trechosDe = (d) => ((d.deslocamento_trechos || []).filter(t => !t.espelho_legado)).sort((a, b) => a.ordem - b.ordem)
  // destino explícito: cliente do trecho na frente ("BENTELER · Porto Real/RJ")
  const destinoLbl = (t) => {
    const cli = t.destino_cliente_id ? (cliNomes[t.destino_cliente_id] || '') : ''
    if (t.cliente_locais) {
      const cidade = t.cliente_locais.cidade ? fmtLugar([t.cliente_locais.cidade, t.cliente_locais.uf].filter(Boolean).join('/')) : ''
      return `${cli ? cli + ' · ' : ''}${t.cliente_locais.nome}${cidade ? ' · ' + cidade : ''}`
    }
    const txt = fmtLugar(t.destino) || ''
    if (cli) return `${cli}${txt ? ' · ' + txt : ''}`
    return txt || '—'
  }
  const dia2 = (s) => s ? s.split('-').reverse().slice(0, 2).join('/') : '—'
  // tempo de deslocamento = Σ (chegada − saída) dos trechos − almoço dentro do horário dos trechos do dia
  const fmtHm = (m) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`
  function tempoViagemMin(ts, almRows) {
    let bruto = 0, aberto = false, temTempo = false
    const porDia = {}
    for (const t of (ts || [])) {
      if (!t.saida_em) continue
      temTempo = true
      const a = new Date(t.saida_em).getTime()
      const b = t.chegada_em ? new Date(t.chegada_em).getTime() : Date.now()   // aberto conta até agora
      if (!t.chegada_em) aberto = true
      if (b <= a) continue
      bruto += (b - a) / 60000
      const dia = t.data || String(t.saida_em).slice(0, 10)
      ;(porDia[dia] = porDia[dia] || []).push([a, b])
    }
    // um par de horários por dia (os registros por pessoa repetem o mesmo par)
    const horDia = {}
    for (const r of (almRows || [])) if (r.dia && r.inicio && r.fim && !horDia[r.dia]) horDia[r.dia] = r
    let almoco = 0
    for (const [dia, h] of Object.entries(horDia)) {
      if (!porDia[dia]) continue
      const hh = (t) => String(t).slice(0, 5)
      const ai = new Date(`${dia}T${hh(h.inicio)}:00`).getTime(), af = new Date(`${dia}T${hh(h.fim)}:00`).getTime()
      for (const [a, b] of porDia[dia]) almoco += Math.max(0, Math.min(b, af) - Math.max(a, ai)) / 60000
    }
    return { total: Math.max(0, Math.round(bruto - almoco)), bruto: Math.round(bruto), almoco: Math.round(almoco), aberto, temTempo }
  }

  function render() {
    // "Quem está fora": viagens em andamento (trecho com saída sem chegada / roteiro aberto)
    // + legado: técnico cujo trajeto mais recente é Ida sem Volta.
    const foraMap = {}   // tecnico_id -> { d, desde }
    for (const d of rows) {
      const ts = trechosDe(d)
      if (!ts.length) continue
      const emAndamento = ts.some(t => t.saida_em) && !ts.every(t => t.chegada_em)
      if (!emAndamento) continue
      const desde = (ts.find(t => t.saida_em) || {}).saida_em
      for (const x of (d.deslocamento_tecnicos || [])) if (!foraMap[x.tecnico_id]) foraMap[x.tecnico_id] = { d, desde }
    }
    const ultimo = {}
    for (const d of rows) {
      if (trechosDe(d).length) continue   // modelo novo já tratado acima
      for (const x of (d.deslocamento_tecnicos || [])) if (!ultimo[x.tecnico_id]) ultimo[x.tecnico_id] = d
    }
    for (const [tid, d] of Object.entries(ultimo)) {
      if (d.sentido === 'ida' && !foraMap[tid]) foraMap[tid] = { d, desde: d.saida_em }
    }
    const fora = Object.entries(foraMap)
    const foraBox = document.getElementById('d-fora')
    if (fora.length) {
      const noites = (iso) => { if (!iso) return 0; const ms = Date.now() - new Date(iso).getTime(); return Math.max(0, Math.floor(ms / 86400000)) }
      foraBox.style.display = ''
      foraBox.innerHTML = `<h3>⚠ Em viagem (${fora.length})</h3>` +
        fora.sort((a, b) => new Date(b[1].desde || 0) - new Date(a[1].desde || 0)).map(([tid, f]) => {
          const n = noites(f.desde)
          return `<div class="row"><span class="who">${esc(tecNomes[tid] || '—')}</span><span class="sub">${esc(cliNomes[f.d.cliente_id] || f.d.destino || '—')} · saiu ${dt(f.desde)}${n ? ` · ${n} noite${n > 1 ? 's' : ''}` : ''}</span></div>`
        }).join('')
    } else foraBox.style.display = 'none'

    // Lista filtrada
    const fTec = document.getElementById('d-tec').value
    const fCli = document.getElementById('d-cli').value
    const fSent = document.getElementById('d-sent').value
    const fDe = document.getElementById('d-de').value
    const fAte = document.getElementById('d-ate').value
    let lst = rows
    if (fTec) lst = lst.filter(d => (d.deslocamento_tecnicos || []).some(x => x.tecnico_id === fTec))
    if (fCli) lst = lst.filter(d => d.cliente_id === fCli)
    if (fSent) lst = lst.filter(d => {
      const ts = trechosDe(d)
      if (!ts.length) return fSent === 'legado'
      const emViagem = ts.some(t => t.saida_em) && !ts.every(t => t.chegada_em)
      const fechada = ts.length && ts.every(t => t.chegada_em)
      return fSent === (emViagem ? 'andamento' : (fechada ? 'concluida' : 'planejada'))
    })
    const diaRef = (d) => {
      if (d.saida_em) return d.saida_em.slice(0, 10)
      const ts = trechosDe(d)
      return ((ts.find(t => t.saida_em) || {}).saida_em || '').slice(0, 10) || ((ts[0] || {}).data || '')
    }
    if (fDe) lst = lst.filter(d => diaRef(d) >= fDe)
    if (fAte) lst = lst.filter(d => { const x = diaRef(d); return x && x <= fAte })

    document.getElementById('d-count').textContent = `${lst.length} de ${rows.length} registro(s)`
    const tb = document.getElementById('d-tbody')
    if (!lst.length) { tb.innerHTML = '<tr><td colspan="8" class="d-empty">Nenhum deslocamento para o filtro.</td></tr>'; return }
    const abChip = (tid) => {
      const n = (tecNomes[tid] || '—').trim()
      return `<span class="abchip"><i>${avHtml(tid)}</i>${esc(n.split(/\s+/).slice(0, 2).join(' '))}</span>`
    }
    tb.innerHTML = lst.map(d => {
      const chips = (d.deslocamento_tecnicos || []).map(x => abChip(x.tecnico_id)).join('') || '—'
      const ts = trechosDe(d)
      if (ts.length) {
        // modelo novo: viagem com trechos — origem → destino final, datas e veículos usados
        const prim = ts[0], ult = ts[ts.length - 1]
        const veics = [...new Set(ts.map(t => t.veiculo_id).filter(Boolean))].map(veicLbl)
        const semVeic = [...new Set(ts.filter(t => !t.veiculo_id && t.nota_transporte).map(t => t.nota_transporte))]
        const datas = ts.map(t => t.data).filter(Boolean).sort()
        const periodo = datas.length ? `${dia2(datas[0])}${datas[datas.length - 1] !== datas[0] ? ' → ' + dia2(datas[datas.length - 1]) : ''}` : ''
        const detalhe = ts.map(t => `<div class="dim" style="font-size:11px">${t.ordem}. ${esc(fmtLugar(t.origem) || '—')} → ${esc(destinoLbl(t))}${t.data ? ' · ' + dia2(t.data) : ''}</div>`).join('')
        const saida = (ts.find(t => t.saida_em) || {}).saida_em
        const emViagem = ts.some(t => t.saida_em) && !ts.every(t => t.chegada_em)
        const fechada = ts.every(t => t.chegada_em)
        const chegada = fechada ? ult.chegada_em : null
        const st = emViagem ? '<span class="vst and"><i></i>Em andamento</span>'
          : (fechada ? '<span class="vst con"><i></i>Concluída</span>' : '<span class="vst pla"><i></i>Planejada</span>')
        return `<tr>
          <td><div class="vtipo">Viagem · ${ts.length} trecho${ts.length > 1 ? 's' : ''}</div>${periodo ? `<div class="vper">${esc(periodo)}</div>` : ''}${(() => { const tv = tempoViagemMin(ts, d.deslocamento_almocos); return tv.temTempo ? `<div class="vper">Tempo: <b>${fmtHm(tv.total)}</b>${tv.aberto ? '…' : ''}${tv.almoco ? ' (− almoço)' : ''}</div>` : '' })()}<div style="margin-top:5px">${st}</div></td>
          <td>${esc(cliNomes[d.cliente_id] || '—')}</td>
          <td>${esc(fmtLugar(prim.origem) || '—')} → ${esc(destinoLbl(ult))}${detalhe}</td>
          <td>${veics.length ? veics.map(esc).join('<br>') : (semVeic.length ? `<span class="dim">${esc(semVeic.join(', '))}</span>` : '—')}</td>
          <td>${chips}</td>
          <td>${saida ? dt(saida) : '<span class="dim">não iniciada</span>'}</td>
          <td>${chegada ? dt(chegada) : (emViagem ? '<span class="p-open">em viagem</span>' : '<span class="dim">—</span>')}</td>
          <td><span class="d-act"><button data-edit="${esc(d.id)}">Editar</button><button class="del" data-del="${esc(d.id)}">Excluir</button></span></td>
        </tr>`
      }
      return `<tr>
        <td><span class="d-sent ${esc(d.sentido)}">${esc(SENT[d.sentido] || d.sentido)}</span><div class="vper">trajeto antigo</div></td>
        <td>${esc(cliNomes[d.cliente_id] || '—')}</td>
        <td>${esc(localLbl(d.origem_cidade, d.origem_uf, d.origem))} → ${esc(localLbl(d.destino_cidade, d.destino_uf, d.destino))}${rotaInfo(d)}</td>
        <td>${esc(veicLbl(d.veiculo_id))}</td>
        <td>${chips}</td>
        <td>${dt(d.saida_em)}${mapPin(d.saida_lat, d.saida_lng)}</td>
        <td>${dt(d.chegada_em)}${mapPin(d.chegada_lat, d.chegada_lng)}</td>
        <td><span class="d-act"><button data-edit="${esc(d.id)}">Editar</button><button class="del" data-del="${esc(d.id)}">Excluir</button></span></td>
      </tr>`
    }).join('')
    tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editar(b.dataset.edit))
    tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => excluir(b.dataset.del))
  }

  // ───────────────────── Editar / Excluir (admin) ─────────────────────
  function fecharModal() { document.getElementById('dm-back').classList.remove('open') }
  function editar(id) {
    const d = rows.find(x => x.id === id); if (!d) return
    if (trechosDe(d).length) return editarViagem(d)   // modelo novo → editor de trechos
    document.getElementById('dm-id').value = d.id
    document.getElementById('dm-sentido').value = d.sentido || 'ida'
    document.getElementById('dm-cli').innerHTML = '<option value="">— sem cliente —</option>' +
      cliArr.map(c => `<option value="${esc(c.id)}"${c.id === d.cliente_id ? ' selected' : ''}>${esc(c.nome || '')}</option>`).join('')
    document.getElementById('dm-veiculo').innerHTML = '<option value="">— sem veículo —</option>' +
      veicArr.map(v => `<option value="${esc(v.id)}"${v.id === d.veiculo_id ? ' selected' : ''}>${esc((v.modelo || '') + ' (' + (v.placa || '') + ')')}</option>`).join('')
    const aboard = new Set((d.deslocamento_tecnicos || []).map(x => x.tecnico_id))
    document.getElementById('dm-tecs').innerHTML = tecArr.map(t => `<label><input type="checkbox" value="${esc(t.id)}"${aboard.has(t.id) ? ' checked' : ''}> ${esc(t.nome || '')}</label>`).join('')
    document.getElementById('dm-origem-cidade').value = d.origem_cidade || ''
    document.getElementById('dm-origem-uf').value = d.origem_uf || ''
    document.getElementById('dm-destino-cidade').value = d.destino_cidade || ''
    document.getElementById('dm-destino-uf').value = d.destino_uf || ''
    document.getElementById('dm-saida').value = toLocalInput(d.saida_em)
    document.getElementById('dm-chegada').value = toLocalInput(d.chegada_em)
    document.getElementById('dm-motivo').value = d.motivo || ''
    document.getElementById('dm-back').classList.add('open')
  }
  async function salvarEdicao() {
    const id = document.getElementById('dm-id').value; if (!id) return
    const oCid = document.getElementById('dm-origem-cidade').value.trim(), oUf = document.getElementById('dm-origem-uf').value.trim().toUpperCase()
    const dCid = document.getElementById('dm-destino-cidade').value.trim(), dUf = document.getElementById('dm-destino-uf').value.trim().toUpperCase()
    const compoe = (c, u) => [c, u].filter(Boolean).join('/') || null
    const patch = {
      sentido: document.getElementById('dm-sentido').value,
      cliente_id: document.getElementById('dm-cli').value || null,
      veiculo_id: document.getElementById('dm-veiculo').value || null,
      origem_cidade: oCid || null, origem_uf: oUf || null, destino_cidade: dCid || null, destino_uf: dUf || null,
      origem: compoe(oCid, oUf), destino: compoe(dCid, dUf),
      saida_em: inputToISO(document.getElementById('dm-saida').value),
      chegada_em: inputToISO(document.getElementById('dm-chegada').value),
      motivo: document.getElementById('dm-motivo').value.trim() || null,
    }
    const up = await sb().from('deslocamentos').update(patch).eq('id', id)
    if (up.error) { toast('Erro ao salvar: ' + up.error.message, 'err'); return }
    // Reconcilia técnicos a bordo: apaga os atuais e insere os marcados.
    const tecs = [...document.querySelectorAll('#dm-tecs input:checked')].map(c => c.value)
    await sb().from('deslocamento_tecnicos').delete().eq('deslocamento_id', id)
    if (tecs.length) {
      const it = await sb().from('deslocamento_tecnicos').insert(tecs.map(tid => ({ deslocamento_id: id, tecnico_id: tid })))
      if (it.error) { toast('Trajeto salvo, mas falhou ao atualizar técnicos: ' + it.error.message, 'err') }
    }
    toast('Trajeto atualizado.', 'ok')
    fecharModal()
    await carregar()
  }
  async function excluir(id) {
    if (!id) return
    const d = rows.find(x => x.id === id)
    const desc = d ? `${SENT[d.sentido] || d.sentido} · ${cliNomes[d.cliente_id] || localLbl(d.destino_cidade, d.destino_uf, d.destino)} · ${dt(d.saida_em)}` : ''
    if (!confirm(`Excluir este trajeto?\n${desc}\n\nEsta ação não pode ser desfeita.`)) return
    const del = await sb().from('deslocamentos').delete().eq('id', id)
    if (del.error) { toast('Erro ao excluir: ' + del.error.message, 'err'); return }
    toast('Trajeto excluído.', 'ok')
    fecharModal()
    await carregar()
  }

  // avatar com FOTO do Portal (mesmo componente das RATs/Tarefas); iniciais como fallback
  const avHtml = (tid) => {
    const u = tecArr.find(x => x.id === tid) || {}
    const foto = (typeof avatarUrl === 'function') ? avatarUrl(u.foto_url) : ''
    if (foto) return `<img src="${esc(foto)}" alt="">`
    return esc((u.nome || tecNomes[tid] || '—').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase())
  }

  // ───────────────────── Editar VIAGEM (modelo novo: trechos) ─────────────────────
  let vmCur = null, vmLocais = [], vmAlmocos = []
  let vmAlmHor = {}   // dia → {inicio, fim} (editável pelo admin; grava em deslocamento_almocos)
  const horaMais = (hhmm, min) => { const [h, m] = String(hhmm).split(':').map(Number); if (isNaN(h)) return ''; const t = (h * 60 + (m || 0) + min) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
  const vmAlmRows = () => Object.entries(vmAlmHor).filter(([, h]) => h && h.inicio && h.fim)
    .map(([dia, h]) => ({ dia, inicio: h.inicio, fim: h.fim }))
  // tempo de UM trecho, descontando o almoço do dia que cai dentro dele
  function tempoTrechoMin(t, hor) {
    if (!t || !t.saida_em) return null
    const a = new Date(t.saida_em).getTime()
    const aberto = !t.chegada_em
    const b = aberto ? Date.now() : new Date(t.chegada_em).getTime()
    if (b <= a) return { total: 0, almoco: 0, aberto }
    const dia = t.data || String(t.saida_em).slice(0, 10)
    const h = (hor || {})[dia]
    let alm = 0
    if (h && h.inicio && h.fim) {
      const ai = new Date(`${dia}T${h.inicio}:00`).getTime(), af = new Date(`${dia}T${h.fim}:00`).getTime()
      alm = Math.max(0, Math.min(b, af) - Math.max(a, ai)) / 60000
    }
    return { total: Math.max(0, Math.round((b - a) / 60000 - alm)), almoco: Math.round(alm), aberto }
  }
  // A DATA do trecho é a única fonte de data: saída/chegada são só HORA, ancoradas nela.
  const hhIso = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const isoNoDia = (dia, hhmm, fallbackIso) => {
    if (!hhmm) return null
    const d = dia || (fallbackIso ? new Date(fallbackIso).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10))
    return new Date(`${d}T${hhmm}:00`).toISOString()
  }
  // chegada "antes" da saída = virou o dia (chegou de madrugada) → soma 1 dia
  const ajustaMadrugada = (t) => {
    if (t.saida_em && t.chegada_em && new Date(t.chegada_em) <= new Date(t.saida_em)) {
      t.chegada_em = new Date(new Date(t.chegada_em).getTime() + 86400000).toISOString()
    }
  }
  function renderVmTotal() {
    const box = document.getElementById('vm-total'); if (!box || !vmCur) return
    const { total, bruto, almoco, aberto, temTempo } = tempoViagemMin(vmCur.trechos, vmAlmRows())
    box.innerHTML = temTempo ? `<div class="vm-totcard"><span class="k">Tempo de deslocamento${aberto ? ' · em andamento' : ''}</span><span class="v">${fmtHm(total)}</span>
      <span class="s">${almoco ? `${fmtHm(bruto)} marcados − ${fmtHm(almoco)} de almoço` : 'sem almoço descontado'}${aberto ? ' · trecho aberto contando até agora' : ''}</span></div>` : ''
  }
  // Card editável: um par de horários de almoço por dia da viagem.
  // Ao salvar, vale para todos os técnicos a bordo no dia (dedup no servidor).
  function renderVmAlmoco() {
    const box = document.getElementById('vm-almoco'); if (!box || !vmCur) return
    const dias = [...new Set([...vmCur.trechos.map(t => t.data).filter(Boolean), ...Object.keys(vmAlmHor)])].sort()
    if (!dias.length) { box.innerHTML = ''; return }
    box.innerHTML = `<div class="vm-alm"><div class="ah">Almoço na estrada</div>
      ${dias.map(dia => {
        const h = vmAlmHor[dia] || {}
        return `<div class="adia"><span class="dlbl">${esc(dia2(dia))}</span>
          <div><label>Início</label><input type="time" data-vmaini="${esc(dia)}" value="${esc(h.inicio || '')}"></div>
          <div><label>Término</label><input type="time" data-vmafim="${esc(dia)}" value="${esc(h.fim || '')}"></div>
          ${(h.inicio || h.fim) ? `<button type="button" class="alimpa" data-vmalimpa="${esc(dia)}" title="Limpar almoço do dia">×</button>` : '<span></span>'}
        </div>`
      }).join('')}
      <div class="anota">Vale para todos os técnicos a bordo no dia (quem já tem almoço em outro artefato não duplica — o sistema mantém o 1º). Desconta do tempo quando cai dentro do horário dos trechos.</div>
    </div>`
    box.querySelectorAll('[data-vmaini]').forEach(el => {
      el.onchange = () => {
        const dia = el.dataset.vmaini
        vmAlmHor[dia] = vmAlmHor[dia] || {}
        vmAlmHor[dia].inicio = el.value || null
        if (el.value && (!vmAlmHor[dia].fim || vmAlmHor[dia].fim <= el.value)) vmAlmHor[dia].fim = horaMais(el.value, 60)
        renderVmTrechos()   // cards por trecho descontam o almoço
      }
    })
    box.querySelectorAll('[data-vmafim]').forEach(el => {
      el.onchange = () => {
        const dia = el.dataset.vmafim
        vmAlmHor[dia] = vmAlmHor[dia] || {}
        if (el.value && vmAlmHor[dia].inicio && el.value <= vmAlmHor[dia].inicio) {
          toast('O término do almoço não pode ser antes do início.', 'err')
          vmAlmHor[dia].fim = horaMais(vmAlmHor[dia].inicio, 60)
        } else vmAlmHor[dia].fim = el.value || null
        renderVmTrechos()
      }
    })
    box.querySelectorAll('[data-vmalimpa]').forEach(el => { el.onclick = () => { delete vmAlmHor[el.dataset.vmalimpa]; renderVmTrechos() } })
  }
  const vmUuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
  // cidade/UF extraída do endereço do cliente (Title Case)
  const cidadeDeCli = (c) => {
    const s = String((c && c.endereco) || '')
    const par = s.match(/([A-Za-zÀ-ÿ0-9 .'-]+?)\s*\(([A-Za-z]{2})\)/)
    if (par) return `${tcase(par[1].trim())}/${par[2].toUpperCase()}`
    for (const tok of s.split(/[·,]/)) {
      const m = tok.trim().match(/^(.+?)\/([A-Za-z]{2})$/)
      if (m) return `${tcase(m[1].trim())}/${m[2].toUpperCase()}`
    }
    return ''
  }
  function vmNovoTrecho() {
    const ant = vmCur.trechos[vmCur.trechos.length - 1]
    return {
      id: vmUuid(), origem: ant ? (ant.destino || '') : '', destino: '', destino_local_id: null, destino_cliente_id: null,
      data: ant ? ant.data : null, saida_em: null, chegada_em: null,
      saida_lat: null, saida_lng: null, saida_precisao: null, chegada_lat: null, chegada_lng: null, chegada_precisao: null,
      veiculo_id: ant ? ant.veiculo_id : null, nota_transporte: ant ? ant.nota_transporte : null,
      tecnicos: ant ? [...ant.tecnicos] : [], motoristas: [],
    }
  }
  async function vmCarregarLocais() {
    vmLocais = []
    if (!vmCur || !vmCur.cliente_id) return
    const { data } = await sb().from('cliente_locais').select('id,nome,cidade,uf').eq('cliente_id', vmCur.cliente_id).eq('ativo', true).order('nome')
    vmLocais = data || []
  }
  async function editarViagem(d) {
    vmCur = {
      id: d.id, cliente_id: d.cliente_id || null, motivo: d.motivo || null,
      trechos: trechosDe(d).map(t => ({
        id: t.id, origem: t.origem || '', destino: t.destino || '', destino_local_id: t.destino_local_id || null,
        destino_cliente_id: t.destino_cliente_id || null,
        data: t.data || null, saida_em: t.saida_em || null, chegada_em: t.chegada_em || null,
        saida_lat: t.saida_lat ?? null, saida_lng: t.saida_lng ?? null, saida_precisao: t.saida_precisao ?? null,
        chegada_lat: t.chegada_lat ?? null, chegada_lng: t.chegada_lng ?? null, chegada_precisao: t.chegada_precisao ?? null,
        veiculo_id: t.veiculo_id || null, nota_transporte: t.nota_transporte || null,
        tecnicos: (t.trecho_tecnicos || []).map(x => x.tecnico_id),
        motoristas: (t.trecho_direcao || []).map(m => ({ tecnico_id: m.tecnico_id, hora_de: m.hora_de ? String(m.hora_de).slice(0, 5) : null, hora_ate: m.hora_ate ? String(m.hora_ate).slice(0, 5) : null })),
      })),
    }
    vmAlmocos = d.deslocamento_almocos || []
    vmAlmHor = {}
    for (const r of vmAlmocos) {
      if (r.dia && r.inicio && r.fim && !vmAlmHor[r.dia]) vmAlmHor[r.dia] = { inicio: String(r.inicio).slice(0, 5), fim: String(r.fim).slice(0, 5) }
    }
    document.getElementById('vm-id').value = d.id
    document.getElementById('vm-cli').innerHTML = '<option value="">— sem cliente —</option>' +
      cliArr.map(c => `<option value="${esc(c.id)}"${c.id === vmCur.cliente_id ? ' selected' : ''}>${esc(c.nome || '')}</option>`).join('')
    document.getElementById('vm-motivo').value = vmCur.motivo || ''
    await vmCarregarLocais()
    renderVmTrechos()
    document.getElementById('vm-back').classList.add('open')
  }
  function fecharViagem() { document.getElementById('vm-back').classList.remove('open'); vmCur = null; carregar() }
  function renderVmTrechos() {
    const box = document.getElementById('vm-trechos'); if (!box || !vmCur) return
    box.innerHTML = vmCur.trechos.map((t, i) => {
      const aboard = new Set(t.tecnicos)
      const pool = tecArr.filter(u => aboard.has(u.id)).length ? tecArr.filter(u => aboard.has(u.id)) : tecArr
      const turnos = (t.motoristas || []).map((m, mi) => `<div class="vm-turno">
          <select data-vmdrv="${i}:${mi}">${pool.map(u => `<option value="${esc(u.id)}"${m.tecnico_id === u.id ? ' selected' : ''}>${esc(u.nome || '')}</option>`).join('')}</select>
          <input type="time" data-vmde="${i}:${mi}" value="${esc(m.hora_de || '')}" title="De (vazio = da saída)">
          <input type="time" data-vmate="${i}:${mi}" value="${esc(m.hora_ate || '')}" title="Até (vazio = até a chegada)">
          <button type="button" class="vdel" data-vmdrvdel="${i}:${mi}" title="Remover turno">×</button>
        </div>`).join('')
      return `<div class="vm-leg">
        <div class="vh"><span class="n">${i + 1}</span>Trecho ${i + 1}${vmCur.trechos.length > 1 ? `<button type="button" class="vdel" data-vmdelleg="${i}" title="Remover trecho">×</button>` : ''}</div>
        <div class="vm-cols">
        <div>
          <div class="dm-row">
            <div><label>Origem</label><input type="text" data-vmorig="${i}" value="${esc(t.origem || '')}"></div>
            <div style="max-width:150px"><label>Data</label><input type="date" data-vmdata="${i}" value="${esc(t.data || '')}"></div>
          </div>
          <div style="margin-top:10px"><label>Destino (cliente, local ou texto)</label><select data-vmloc="${i}">
              ${vmLocais.length ? `<optgroup label="Locais da empresa da viagem">${vmLocais.map(l => `<option value="${esc(l.id)}"${t.destino_local_id === l.id ? ' selected' : ''}>${esc(l.nome)}${l.cidade ? ' · ' + esc([l.cidade, l.uf].filter(Boolean).join('/')) : ''}</option>`).join('')}</optgroup>` : ''}
              <optgroup label="Clientes">${cliArr.map(c => `<option value="c:${esc(c.id)}"${!t.destino_local_id && t.destino_cliente_id === c.id ? ' selected' : ''}>${esc(c.nome)}${cidadeDeCli(c) ? ' · ' + esc(cidadeDeCli(c)) : ''}</option>`).join('')}</optgroup>
              <option value=""${!t.destino_local_id && !t.destino_cliente_id ? ' selected' : ''}>Outro lugar (digitar)…</option>
            </select>
            ${!t.destino_local_id ? `<input type="text" data-vmdest="${i}" value="${esc(t.destino || '')}" placeholder="Cidade/UF ou descrição do destino" style="margin-top:6px">` : ''}
          </div>
          <div class="dm-row" style="margin-top:10px">
            <div><label>Saída (hora)</label><input type="time" data-vmsaida="${i}" value="${esc(hhIso(t.saida_em))}"></div>
            <div><label>Chegada (hora)</label><input type="time" data-vmcheg="${i}" value="${esc(hhIso(t.chegada_em))}"></div>
          </div>
          ${(() => { const tt = tempoTrechoMin(t, vmAlmHor); return tt ? `<div class="vm-legtot"><span>Tempo do trecho${tt.aberto ? ' · em andamento' : ''}${tt.almoco ? ` <i>(− ${fmtHm(tt.almoco)} almoço)</i>` : ''}</span><b>${fmtHm(tt.total)}</b></div>` : '' })()}
          <div class="dm-row" style="margin-top:10px">
            <div><label>Veículo</label><select data-vmveic="${i}">
              <option value="">— sem veículo da empresa —</option>
              ${veicArr.map(v => `<option value="${esc(v.id)}"${t.veiculo_id === v.id ? ' selected' : ''}>${esc((v.modelo || '') + ' (' + (v.placa || '') + ')')}</option>`).join('')}
            </select></div>
            <div><label>Sem veículo: como foi?</label><input type="text" data-vmnota="${i}" value="${esc(t.nota_transporte || '')}" placeholder="carona, avião, alugado…"${t.veiculo_id ? ' disabled' : ''}></div>
          </div>
        </div>
        <div>
          <div><label>Técnicos a bordo</label><div class="vm-tecs">
            ${tecArr.map(u => `<button type="button" class="vm-tec${aboard.has(u.id) ? ' on' : ''}" data-vmtec="${i}:${esc(u.id)}">
              <span class="av">${avHtml(u.id)}</span>
              <span class="ti"><span class="nm">${esc(u.nome || '')}</span><span class="rl">${esc(u.cargo ? `${u.cargo} · Técnico` : 'Técnico')}</span></span>
              <span class="ck"></span></button>`).join('')}
          </div></div>
          <div style="margin-top:12px"><label>Direção — quem dirigiu (revezamento; horários vazios = trecho todo)</label>
            ${turnos}
            <button type="button" class="vm-addmini" data-vmdrvadd="${i}">+ Turno de direção</button>
          </div>
        </div>
        </div>
      </div>`
    }).join('')
    const T = vmCur.trechos
    box.querySelectorAll('[data-vmorig]').forEach(el => { el.oninput = () => { T[+el.dataset.vmorig].origem = el.value } })
    box.querySelectorAll('[data-vmdata]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.vmdata]
        t.data = el.value || null
        // re-ancora saída/chegada na nova data (mantém as horas)
        if (t.saida_em) t.saida_em = isoNoDia(t.data, hhIso(t.saida_em), t.saida_em)
        if (t.chegada_em) { t.chegada_em = isoNoDia(t.data, hhIso(t.chegada_em), t.chegada_em); ajustaMadrugada(t) }
        renderVmAlmoco(); renderVmTotal()
      }
    })
    box.querySelectorAll('[data-vmdest]').forEach(el => { el.oninput = () => { T[+el.dataset.vmdest].destino = el.value } })
    box.querySelectorAll('[data-vmloc]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.vmloc]
        if (el.value.startsWith('c:')) {
          // destino = um CLIENTE (a viagem pode visitar vários)
          const c = cliArr.find(x => x.id === el.value.slice(2))
          t.destino_local_id = null
          t.destino_cliente_id = c ? c.id : null
          t.destino = (c && cidadeDeCli(c)) || (c && c.nome) || ''
        } else if (el.value) {
          // destino = Local da empresa da viagem
          const l = vmLocais.find(x => x.id === el.value)
          t.destino_local_id = el.value
          t.destino_cliente_id = vmCur.cliente_id || null
          if (l) t.destino = [l.cidade, l.uf].filter(Boolean).join('/') || l.nome
        } else {
          t.destino_local_id = null
          t.destino_cliente_id = null
        }
        renderVmTrechos()
      }
    })
    box.querySelectorAll('[data-vmsaida]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.vmsaida]
        t.saida_em = isoNoDia(t.data, el.value, t.saida_em)
        ajustaMadrugada(t)
        renderVmTrechos()   // card do trecho + total
      }
    })
    box.querySelectorAll('[data-vmcheg]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.vmcheg]
        t.chegada_em = isoNoDia(t.data, el.value, t.chegada_em)
        ajustaMadrugada(t)
        renderVmTrechos()
      }
    })
    box.querySelectorAll('[data-vmveic]').forEach(el => {
      el.onchange = () => {
        const t = T[+el.dataset.vmveic]
        t.veiculo_id = el.value || null
        if (el.value) t.nota_transporte = null
        else t.motoristas = []
        renderVmTrechos()
      }
    })
    box.querySelectorAll('[data-vmnota]').forEach(el => { el.oninput = () => { T[+el.dataset.vmnota].nota_transporte = el.value.trim() || null } })
    box.querySelectorAll('[data-vmtec]').forEach(el => {
      el.onclick = () => {
        const [i, tid] = el.dataset.vmtec.split(':')
        const t = T[+i]
        const set = new Set(t.tecnicos)
        if (set.has(tid)) { set.delete(tid); t.motoristas = (t.motoristas || []).filter(m => m.tecnico_id !== tid) }
        else set.add(tid)
        t.tecnicos = [...set]
        renderVmTrechos()
      }
    })
    box.querySelectorAll('[data-vmdrv]').forEach(el => { el.onchange = () => { const [i, mi] = el.dataset.vmdrv.split(':').map(Number); T[i].motoristas[mi].tecnico_id = el.value } })
    box.querySelectorAll('[data-vmde]').forEach(el => { el.onchange = () => { const [i, mi] = el.dataset.vmde.split(':').map(Number); T[i].motoristas[mi].hora_de = el.value || null } })
    box.querySelectorAll('[data-vmate]').forEach(el => { el.onchange = () => { const [i, mi] = el.dataset.vmate.split(':').map(Number); T[i].motoristas[mi].hora_ate = el.value || null } })
    box.querySelectorAll('[data-vmdrvdel]').forEach(el => { el.onclick = () => { const [i, mi] = el.dataset.vmdrvdel.split(':').map(Number); T[i].motoristas.splice(mi, 1); renderVmTrechos() } })
    box.querySelectorAll('[data-vmdrvadd]').forEach(el => {
      el.onclick = () => {
        const t = T[+el.dataset.vmdrvadd]
        t.motoristas = t.motoristas || []
        t.motoristas.push({ tecnico_id: t.tecnicos[0] || (tecArr[0] || {}).id, hora_de: null, hora_ate: null })
        renderVmTrechos()
      }
    })
    box.querySelectorAll('[data-vmdelleg]').forEach(el => { el.onclick = () => { T.splice(+el.dataset.vmdelleg, 1); renderVmTrechos() } })
    renderVmAlmoco()
    renderVmTotal()
  }
  async function salvarViagem() {
    if (!vmCur || !vmCur.id) return
    for (let i = 0; i < vmCur.trechos.length; i++) {
      const t = vmCur.trechos[i]
      if (t.veiculo_id && !(t.motoristas || []).length) return toast(`Trecho ${i + 1}: veículo da empresa exige a direção preenchida.`, 'err')
    }
    vmCur.motivo = (document.getElementById('vm-motivo').value || '').trim() || null
    const up = await sb().from('deslocamentos').update({ cliente_id: vmCur.cliente_id || null, motivo: vmCur.motivo }).eq('id', vmCur.id)
    if (up.error) return toast('Erro ao salvar: ' + up.error.message, 'err')
    // substituição completa dos trechos (cascade limpa a-bordo/direção) — preserva GPS capturado
    const del = await sb().from('deslocamento_trechos').delete().eq('deslocamento_id', vmCur.id)
    if (del.error) return toast('Erro ao salvar trechos: ' + del.error.message, 'err')
    const trechos = vmCur.trechos.map((t, i) => ({
      id: t.id || vmUuid(), deslocamento_id: vmCur.id, ordem: i + 1,
      origem: t.origem || null, destino: t.destino || null, destino_local_id: t.destino_local_id || null,
      destino_cliente_id: t.destino_cliente_id || null,
      data: t.data || null, saida_em: t.saida_em || null, chegada_em: t.chegada_em || null,
      saida_lat: t.saida_lat ?? null, saida_lng: t.saida_lng ?? null, saida_precisao: t.saida_precisao ?? null,
      chegada_lat: t.chegada_lat ?? null, chegada_lng: t.chegada_lng ?? null, chegada_precisao: t.chegada_precisao ?? null,
      veiculo_id: t.veiculo_id || null, nota_transporte: t.nota_transporte || null,
    }))
    if (trechos.length) {
      const it = await sb().from('deslocamento_trechos').insert(trechos)
      if (it.error) return toast('Erro ao salvar trechos: ' + it.error.message, 'err')
      const aboard = [], dirs = []
      vmCur.trechos.forEach((t, i) => {
        for (const tid of (t.tecnicos || [])) aboard.push({ trecho_id: trechos[i].id, tecnico_id: tid })
        for (const m of (t.motoristas || [])) dirs.push({ trecho_id: trechos[i].id, tecnico_id: m.tecnico_id, hora_de: m.hora_de || null, hora_ate: m.hora_ate || null })
      })
      if (aboard.length) { const r = await sb().from('trecho_tecnicos').insert(aboard); if (r.error) return toast('Erro (a bordo): ' + r.error.message, 'err') }
      if (dirs.length) { const r = await sb().from('trecho_direcao').insert(dirs); if (r.error) return toast('Erro (direção): ' + r.error.message, 'err') }
    }
    // união a bordo no pai (RLS do técnico + painéis)
    await sb().from('deslocamento_tecnicos').delete().eq('deslocamento_id', vmCur.id)
    const uni = [...new Set(vmCur.trechos.flatMap(t => t.tecnicos || []))]
    if (uni.length) await sb().from('deslocamento_tecnicos').insert(uni.map(tid => ({ deslocamento_id: vmCur.id, tecnico_id: tid })))
    // almoço na estrada (editado pelo admin): um par por dia × técnicos a bordo no dia
    // (o trigger materializa em `almocos` com a dedup de um por pessoa/dia)
    await sb().from('deslocamento_almocos').delete().eq('deslocamento_id', vmCur.id)
    const almRows = []
    for (const { dia, inicio, fim } of vmAlmRows()) {
      const aboard = [...new Set(vmCur.trechos.filter(t => t.data === dia).flatMap(t => t.tecnicos || []))]
      const quem = aboard.length ? aboard : uni
      for (const tid of quem) almRows.push({ deslocamento_id: vmCur.id, tecnico_id: tid, dia, inicio, fim })
    }
    if (almRows.length) {
      const r = await sb().from('deslocamento_almocos').insert(almRows)
      if (r.error) toast('Viagem salva, mas falhou o almoço: ' + r.error.message, 'err')
    }
    toast('Viagem atualizada.', 'ok')
    fecharViagem()
    await carregar()
  }

  return { init, editar, excluir }
})()
