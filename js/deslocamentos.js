/* ═══════════════════════════════════════════════
   Service Report — deslocamentos.js  (visão do admin)
   Lista de trajetos (pernas) filtrável por Técnico · Cliente · Período · Sentido,
   + painel "Quem está fora" (técnico cujo último trajeto é Ida sem Volta).
   Exposto como window.DeslocApp.
═══════════════════════════════════════════════ */
const DeslocApp = (() => {
  const sb = () => getSupabase()
  let tecNomes = {}, cliNomes = {}, veic = {}, rows = []
  const SENT = { ida: 'Ida', volta: 'Volta', outro: 'Outro' }
  const dt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const veicLbl = (id) => veic[id] || '—'
  const mapPin = (lat, lng) => (lat != null && lng != null) ? ` <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="Ver no mapa" style="text-decoration:none">📍</a>` : ''
  function rotaInfo(d) {
    if (d.saida_lat == null || d.chegada_lat == null) return ''
    const url = `https://www.google.com/maps/dir/?api=1&origin=${d.saida_lat},${d.saida_lng}&destination=${d.chegada_lat},${d.chegada_lng}`
    return `<div class="dim" style="font-size:11px;margin-top:3px"><a href="${url}" target="_blank" rel="noopener">🗺️ ver rota (distância no mapa)</a></div>`
  }

  async function init() {
    const [tec, cli, vc] = await Promise.all([
      sb().from('usuarios').select('id,nome').eq('role', 'tecnico_campo').eq('ativo', true).order('nome'),
      sb().from('clientes').select('id,nome'),
      sb().from('veiculos').select('id,modelo,placa'),
    ])
    ;(tec.data || []).forEach(t => { tecNomes[t.id] = t.nome })
    ;(cli.data || []).forEach(c => { cliNomes[c.id] = c.nome })
    ;(vc.data || []).forEach(v => { veic[v.id] = `${v.modelo || ''} (${v.placa || ''})` })
    document.getElementById('d-tec').innerHTML = '<option value="">Técnico: todos</option>' +
      (tec.data || []).map(t => `<option value="${esc(t.id)}">${esc(t.nome || '')}</option>`).join('')
    document.getElementById('d-cli').innerHTML = '<option value="">Cliente: todos</option>' +
      (cli.data || []).slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || '')).map(c => `<option value="${esc(c.id)}">${esc(c.nome || '')}</option>`).join('')
    ;['d-tec', 'd-cli', 'd-sent', 'd-de', 'd-ate'].forEach(id => { document.getElementById(id).onchange = render })
    await carregar()
  }

  async function carregar() {
    const { data, error } = await sb().from('deslocamentos')
      .select('id,sentido,cliente_id,origem,destino,saida_em,chegada_em,veiculo_id,saida_lat,saida_lng,chegada_lat,chegada_lng,deslocamento_tecnicos(tecnico_id)')
      .order('saida_em', { ascending: false }).limit(300)
    if (error) { toast('Erro: ' + error.message, 'err'); return }
    rows = data || []
    render()
  }

  function render() {
    // "Quem está fora": por técnico, o trajeto mais recente (rows já vem desc por saída).
    const ultimo = {}   // tecnico_id -> primeiro (mais recente) trajeto encontrado
    for (const d of rows) for (const x of (d.deslocamento_tecnicos || [])) {
      if (!ultimo[x.tecnico_id]) ultimo[x.tecnico_id] = d
    }
    const fora = Object.entries(ultimo).filter(([, d]) => d.sentido === 'ida')
    const foraBox = document.getElementById('d-fora')
    if (fora.length) {
      const noites = (iso) => { const ms = Date.now() - new Date(iso).getTime(); return Math.max(0, Math.floor(ms / 86400000)) }
      foraBox.style.display = ''
      foraBox.innerHTML = `<h3>⚠ Em viagem (${fora.length}) — Ida sem Volta registrada</h3>` +
        fora.sort((a, b) => new Date(b[1].saida_em) - new Date(a[1].saida_em)).map(([tid, d]) => {
          const n = noites(d.saida_em)
          return `<div class="row"><span class="who">${esc(tecNomes[tid] || '—')}</span><span class="sub">${esc(cliNomes[d.cliente_id] || d.destino || '—')} · saiu ${dt(d.saida_em)}${n ? ` · ${n} noite${n > 1 ? 's' : ''}` : ''}</span></div>`
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
    if (fDe) lst = lst.filter(d => (d.saida_em || '').slice(0, 10) >= fDe)
    if (fAte) lst = lst.filter(d => { const x = (d.saida_em || '').slice(0, 10); return x && x <= fAte })

    document.getElementById('d-count').textContent = `${lst.length} de ${rows.length} trajeto(s)`
    const tb = document.getElementById('d-tbody')
    if (!lst.length) { tb.innerHTML = '<tr><td colspan="7" class="d-empty">Nenhum trajeto para o filtro.</td></tr>'; return }
    tb.innerHTML = lst.map(d => {
      const nomes = (d.deslocamento_tecnicos || []).map(x => tecNomes[x.tecnico_id]).filter(Boolean).join(', ')
      return `<tr>
        <td><span class="d-sent ${esc(d.sentido)}">${esc(SENT[d.sentido] || d.sentido)}</span></td>
        <td>${esc(cliNomes[d.cliente_id] || '—')}</td>
        <td>${esc(d.origem || '—')} → ${esc(d.destino || '—')}${rotaInfo(d)}</td>
        <td>${esc(veicLbl(d.veiculo_id))}</td>
        <td>${esc(nomes || '—')}</td>
        <td>${dt(d.saida_em)}${mapPin(d.saida_lat, d.saida_lng)}</td>
        <td>${dt(d.chegada_em)}${mapPin(d.chegada_lat, d.chegada_lng)}</td>
      </tr>`
    }).join('')
  }

  return { init }
})()
