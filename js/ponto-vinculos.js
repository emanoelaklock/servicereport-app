/* ═══════════════════════════════════════════════
   Service Report — ponto-vinculos.js (Fase C · PR-C2)
   Tela administrativa de vínculos Tangerino ↔ SR (desenho: docs/ponto-fase-c-desenho.md §4).
   Regras cravadas:
   · Consulta de colaboradores SÓ pela Edge ponto-sync (modo 'colaboradores') — o token do
     Tangerino nunca chega ao navegador; a resposta vem sanitizada (sem CPF/PIS/payload).
   · Sugestão (externalId > CPF) é calculada NO SERVIDOR e é só auxílio: pré-seleciona o
     dropdown, mas NADA vincula sem o clique humano do admin.
   · Escrita (vincular/desvincular) direto no ponto_colaboradores_map via RLS: só admin;
     gestor_axis abre a tela em modo somente-consulta. Histórico via trigger (0128).
   · Nome é auxílio visual, nunca chave. NENHUM dado de ponto é importado por esta tela.
═══════════════════════════════════════════════ */
const PontoVinculosApp = (() => {
  const sb = () => getSupabase()
  let usuarios = []        // sr_usuarios ativos (nome/foto p/ exibição e dropdown)
  let colaboradores = []   // Edge (sanitizado)
  let mapa = []            // ponto_colaboradores_map
  let eventos = []         // ponto_vinculo_eventos (30 últimos)
  let souAdmin = false
  let meuId = null
  let filtro = 'todos'

  const uNome = (id) => (usuarios.find((u) => u.id === id) || {}).nome || (id ? String(id).slice(0, 8) + '…' : '—')

  async function init() {
    const { data: { user } } = await sb().auth.getUser()
    meuId = user && user.id
    try { const { data } = await sb().rpc('sr_usuarios'); usuarios = (data || []).filter((u) => u.ativo) } catch (e) { usuarios = [] }
    const eu = usuarios.find((u) => u.id === meuId)
    souAdmin = !!eu && eu.role === 'admin'
    if (!souAdmin) {
      const ro = document.getElementById('pv-ro'); if (ro) ro.style.display = ''
      const th = document.getElementById('pv-th-acao'); if (th) th.textContent = ''
    }
    await carregar()
  }

  function aviso(msg, erro) {
    const el = document.getElementById('pv-aviso')
    el.textContent = msg || ''
    el.classList.toggle('erro', !!erro)
  }

  async function carregar() {
    aviso('Consultando colaboradores no Tangerino…')
    let resp = null
    try {
      // padrão da casa: functions.invoke (JWT da sessão vai sozinho; token do Tangerino
      // fica na Edge — o navegador só recebe a resposta sanitizada)
      const { data, error } = await sb().functions.invoke('ponto-sync', { body: { modo: 'colaboradores' } })
      if (error) throw new Error(error.message || 'falha na função')
      resp = data
      aviso('')
    } catch (e) {
      // erro já vem sanitizado da Edge; nada de header/token em mensagem
      aviso('Erro ao consultar o Tangerino: ' + ((e && e.message) || 'falha de rede'), true)
    }
    colaboradores = (resp && resp.colaboradores) || []
    const { data: m } = await sb().from('ponto_colaboradores_map').select('*')
    mapa = m || []
    const { data: ev } = await sb().from('ponto_vinculo_eventos').select('*').order('em', { ascending: false }).limit(30)
    eventos = ev || []
    render()
  }

  // Status por colaborador: confirmado (no map) · inativo (demitido) · pendente (sugestão) ·
  // sem_correspondencia. O rótulo segue a terminologia da decisão C2.
  function statusDe(c) {
    if (mapa.some((v) => Number(v.tangerino_employee_id) === Number(c.employeeId))) return 'confirmado'
    if (c.demitido) return 'inativo'
    if (c.sugestao) return 'pendente'
    return 'sem_correspondencia'
  }
  const ST = {
    confirmado: { cls: 'b-conf', txt: 'Confirmado' },
    pendente: { cls: 'b-pend', txt: 'Pendente' },
    sem_correspondencia: { cls: 'b-sem', txt: 'Sem correspondência' },
    inativo: { cls: 'b-inat', txt: 'Inativo' },
  }

  function render() {
    const porStatus = { todos: colaboradores.length, confirmado: 0, pendente: 0, sem_correspondencia: 0, inativo: 0 }
    for (const c of colaboradores) porStatus[statusDe(c)]++
    // usuários SR ativos ainda sem vínculo — visão que alimenta o gate da 1ª carga (C3)
    const semVinculoSR = usuarios.filter((u) => !mapa.some((v) => v.tecnico_id === u.id)).length
    const chips = [['todos', 'Todos'], ['confirmado', 'Confirmados'], ['pendente', 'Pendentes'],
      ['sem_correspondencia', 'Sem correspondência'], ['inativo', 'Inativos']]
    document.getElementById('pv-chips').innerHTML = chips.map(([k, l]) =>
      `<button class="pv-chip${filtro === k ? ' on' : ''}" data-f="${k}">${l}<b>${porStatus[k]}</b></button>`).join('') +
      `<span class="pv-chip" style="cursor:default">Usuários SR sem vínculo<b>${semVinculoSR}</b></span>`
    document.querySelectorAll('#pv-chips [data-f]').forEach((b) => { b.onclick = () => { filtro = b.dataset.f; render() } })

    const linhas = colaboradores.filter((c) => filtro === 'todos' || statusDe(c) === filtro)
    const jaVinculados = new Set(mapa.map((v) => v.tecnico_id))
    document.getElementById('pv-tbody').innerHTML = linhas.length ? linhas.map((c) => {
      const st = statusDe(c)
      const vinc = mapa.find((v) => Number(v.tangerino_employee_id) === Number(c.employeeId))
      const origem = vinc ? vinc.origem_sugestao : (c.sugestao ? c.sugestao.origem : null)
      const confPor = vinc ? `${esc(uNome(vinc.vinculado_por))} · ${fdt(vinc.vinculado_em, { withTime: true })}` : '—'
      let acao = ''
      if (souAdmin && vinc) {
        acao = `<button class="b-desv" data-desv="${esc(vinc.tecnico_id)}">Desvincular</button>`
      } else if (souAdmin && !c.demitido) {
        const ops = usuarios.filter((u) => !jaVinculados.has(u.id)).map((u) =>
          `<option value="${esc(u.id)}"${c.sugestao && c.sugestao.tecnicoId === u.id ? ' selected' : ''}>${esc(u.nome)}</option>`).join('')
        acao = `<span class="act"><select data-sel="${esc(String(c.employeeId))}"><option value="">— usuário SR —</option>${ops}</select>
          <button class="b-vinc" data-vinc="${esc(String(c.employeeId))}">Vincular</button></span>`
      }
      return `<tr>
        <td><b>${esc(c.nome || '(sem nome)')}</b><div class="origem">id ${esc(String(c.employeeId))}${c.externalId ? ' · ext ' + esc(String(c.externalId)).slice(0, 12) + '…' : ''}</div></td>
        <td>${vinc ? esc(uNome(vinc.tecnico_id)) : (c.sugestao ? `<span class="origem">sugerido: ${esc(uNome(c.sugestao.tecnicoId))}</span>` : '—')}</td>
        <td><span class="badge ${ST[st].cls}">${ST[st].txt}</span></td>
        <td class="origem">${origem ? esc(origem) : '—'}</td>
        <td class="origem">${confPor}</td>
        <td>${acao}</td>
      </tr>`
    }).join('') : '<tr><td colspan="6" style="color:var(--tx3)">Nenhum colaborador neste filtro.</td></tr>'

    document.querySelectorAll('[data-vinc]').forEach((b) => { b.onclick = () => vincular(Number(b.dataset.vinc)) })
    document.querySelectorAll('[data-desv]').forEach((b) => { b.onclick = () => desvincular(b.dataset.desv) })

    document.getElementById('pv-hist').innerHTML = eventos.length ? eventos.map((e) => {
      const acaoTx = { vinculado: 'vinculou', alterado: 'alterou', desvinculado: 'desvinculou' }[e.acao] || e.acao
      return `<div class="ev"><b>${esc(uNome(e.ator))}</b> ${acaoTx} <b>${esc(uNome(e.tecnico_id))}</b> ↔ colaborador ${esc(String(e.tangerino_employee_id))}${e.origem_sugestao ? ` (origem: ${esc(e.origem_sugestao)})` : ''} — ${fdt(e.em, { withTime: true })}${e.detalhe ? ` · ${esc(e.detalhe)}` : ''}</div>`
    }).join('') : '<div class="ev">Nenhum evento ainda.</div>'
  }

  async function vincular(employeeId) {
    if (!souAdmin) return
    const sel = document.querySelector(`select[data-sel="${employeeId}"]`)
    const tecnicoId = sel && sel.value
    if (!tecnicoId) return toast('Escolha o usuário SR antes de vincular.', 'err')
    const c = colaboradores.find((x) => Number(x.employeeId) === Number(employeeId))
    // origem registrada: se o escolhido É o sugerido, herda a origem da sugestão; senão manual
    const origem = (c && c.sugestao && c.sugestao.tecnicoId === tecnicoId) ? c.sugestao.origem : 'manual'
    const { error } = await sb().from('ponto_colaboradores_map').insert({
      tecnico_id: tecnicoId, tangerino_employee_id: employeeId,
      tangerino_external_id: (c && c.externalId) || null,
      vinculado_por: meuId, origem_sugestao: origem,
    })
    if (error) return toast('Não foi possível vincular: ' + error.message, 'err')
    toast('Vínculo confirmado.', 'ok')
    await carregar()
  }

  async function desvincular(tecnicoId) {
    if (!souAdmin) return
    if (!confirm(`Desvincular ${uNome(tecnicoId)}?\n\nO histórico fica preservado na auditoria; nenhuma marcação de ponto é apagada.`)) return
    const { error } = await sb().from('ponto_colaboradores_map').delete().eq('tecnico_id', tecnicoId)
    if (error) return toast('Não foi possível desvincular: ' + error.message, 'err')
    toast('Vínculo desfeito (auditado).', 'ok')
    await carregar()
  }

  return { init }
})()
