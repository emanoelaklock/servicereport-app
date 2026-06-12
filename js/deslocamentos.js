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
  const localLbl = (cidade, uf, legado) => [cidade, uf].filter(Boolean).join('/') || legado || '—'
  const mapPin = (lat, lng) => (lat != null && lng != null) ? ` <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="Ver no mapa" style="text-decoration:none">📍</a>` : ''
  function rotaInfo(d) {
    if (d.saida_lat == null || d.chegada_lat == null) return ''
    const url = `https://www.google.com/maps/dir/?api=1&origin=${d.saida_lat},${d.saida_lng}&destination=${d.chegada_lat},${d.chegada_lng}`
    return `<div class="dim" style="font-size:11px;margin-top:3px"><a href="${url}" target="_blank" rel="noopener">🗺️ ver rota (distância no mapa)</a></div>`
  }

  async function init() {
    const [tec, cli, vc] = await Promise.all([
      sb().rpc('sr_usuarios'),   // usuários do SR (papel vindo do Portal); filtra técnicos abaixo
      sb().from('clientes').select('id,nome,oculto,sync_omie'),
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
    await carregar()
  }

  async function carregar() {
    const { data, error } = await sb().from('deslocamentos')
      .select('id,sentido,cliente_id,origem,destino,origem_cidade,origem_uf,destino_cidade,destino_uf,motivo,saida_em,chegada_em,veiculo_id,saida_lat,saida_lng,chegada_lat,chegada_lng,criado_em,deslocamento_tecnicos(tecnico_id),deslocamento_trechos(id,ordem,origem,destino,destino_local_id,data,saida_em,chegada_em,veiculo_id,espelho_legado,cliente_locais(nome,cidade,uf))')
      .order('criado_em', { ascending: false }).limit(300)
    if (error) { toast('Erro: ' + error.message, 'err'); return }
    rows = data || []
    render()
  }
  // trechos do modelo novo (espelho_legado é cópia de registro antigo — fica de fora)
  const trechosDe = (d) => ((d.deslocamento_trechos || []).filter(t => !t.espelho_legado)).sort((a, b) => a.ordem - b.ordem)
  const destinoLbl = (t) => t.cliente_locais ? `${t.cliente_locais.nome}${t.cliente_locais.cidade ? ' · ' + [t.cliente_locais.cidade, t.cliente_locais.uf].filter(Boolean).join('/') : ''}` : (t.destino || '—')
  const dia2 = (s) => s ? s.split('-').reverse().slice(0, 2).join('/') : '—'

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
    if (fSent) lst = lst.filter(d => d.sentido === fSent)
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
    tb.innerHTML = lst.map(d => {
      const nomes = (d.deslocamento_tecnicos || []).map(x => tecNomes[x.tecnico_id]).filter(Boolean).join(', ')
      const ts = trechosDe(d)
      if (ts.length) {
        // modelo novo: viagem com trechos — origem → destino final, datas e veículos usados
        const prim = ts[0], ult = ts[ts.length - 1]
        const veics = [...new Set(ts.map(t => t.veiculo_id).filter(Boolean))].map(veicLbl)
        const datas = ts.map(t => t.data).filter(Boolean).sort()
        const periodo = datas.length ? `${dia2(datas[0])}${datas[datas.length - 1] !== datas[0] ? ' → ' + dia2(datas[datas.length - 1]) : ''}` : ''
        const detalhe = ts.map(t => `<div class="dim" style="font-size:11px">${t.ordem}. ${esc(t.origem || '—')} → ${esc(destinoLbl(t))}${t.data ? ' · ' + dia2(t.data) : ''}</div>`).join('')
        const saida = (ts.find(t => t.saida_em) || {}).saida_em
        const chegada = ts.every(t => t.chegada_em) ? ult.chegada_em : null
        return `<tr>
          <td><span class="d-sent outro">Viagem · ${ts.length} trecho${ts.length > 1 ? 's' : ''}</span>${periodo ? `<div class="dim" style="font-size:11px;margin-top:3px">${esc(periodo)}</div>` : ''}</td>
          <td>${esc(cliNomes[d.cliente_id] || '—')}</td>
          <td>${esc(prim.origem || '—')} → ${esc(destinoLbl(ult))}${detalhe}</td>
          <td>${veics.length ? veics.map(esc).join('<br>') : '—'}</td>
          <td>${esc(nomes || '—')}</td>
          <td>${dt(saida)}</td>
          <td>${chegada ? dt(chegada) : '<span class="p-open">em andamento</span>'}</td>
          <td><span class="d-act"><button class="del" data-del="${esc(d.id)}">Excluir</button></span></td>
        </tr>`
      }
      return `<tr>
        <td><span class="d-sent ${esc(d.sentido)}">${esc(SENT[d.sentido] || d.sentido)}</span></td>
        <td>${esc(cliNomes[d.cliente_id] || '—')}</td>
        <td>${esc(localLbl(d.origem_cidade, d.origem_uf, d.origem))} → ${esc(localLbl(d.destino_cidade, d.destino_uf, d.destino))}${rotaInfo(d)}</td>
        <td>${esc(veicLbl(d.veiculo_id))}</td>
        <td>${esc(nomes || '—')}</td>
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

  return { init, editar, excluir }
})()
