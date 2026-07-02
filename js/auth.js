/* ═══════════════════════════════════════════════
   Service Report — auth.js  (adaptado de axisinventory-app)
   Autenticação centralizada via Supabase.
   Dependências (carregar nesta ordem ANTES):
     utils.js (esc) · supabase-client.js (SURL/AKEY/getSupabase/roleHome/ROLE_LABEL)
   Adaptações vs. inventário:
     - init do client veio para supabase-client.js (projeto Traders Apps)
     - perfil lido de usuarios.role (não .perfil)
     - roteamento por papel; cada página declara window.PAGE_ALLOWED
═══════════════════════════════════════════════ */

var SESSION = null
var PERFIL = null

// Utilitários HTTP (pages que fazem fetch REST direto)
var hAuth = () => ({
  'apikey': AKEY,
  'Authorization': `Bearer ${SESSION?.access_token}`,
  'Content-Type': 'application/json'
})
var chk401 = r => {
  if (r.status === 401) {
    getSupabase().auth.signOut()
    toast('Sessão expirada.', 'err')
    setTimeout(() => location.href = 'login.html', 1200)
    throw new Error('Sessão expirada')
  }
  return r
}

// Toast global (depende de #tc no DOM e de esc() do utils.js)
let _tid = 0
var toast = (msg, tipo = 'info', dur = 4000) => {
  const tc = document.getElementById('tc')
  if (!tc) { console.warn('Toast:', msg); return }
  const el = document.createElement('div')
  el.className = `toast ${tipo}`
  el.innerHTML = `<span>${esc(msg)}</span>`
  el.id = `t${++_tid}`
  tc.appendChild(el)
  setTimeout(() => el.remove(), dur)
}

// Login com email/senha
var fazerLogin = async () => {
  const email = document.getElementById('l-email')?.value.trim()
  const senha = document.getElementById('l-senha')?.value
  const btn = document.getElementById('btn-login')
  const msg = document.getElementById('login-msg')

  if (!email || !senha) { toast('Preencha email e senha.', 'err'); return }
  if (!navigator.onLine) {
    if (msg) msg.innerHTML = `<div style="padding:9px 12px;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;border-radius:7px;font-size:13px">Sem conexão. O primeiro acesso precisa de internet; depois o app abre offline automaticamente.</div>`
    return
  }
  if (btn) { btn.textContent = 'Entrando…'; btn.disabled = true }
  if (msg) msg.innerHTML = ''

  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password: senha })
    if (error) throw error
    SESSION = data.session
    // Heartbeat de login explícito (sessionStorage some quando o app é FECHADO; sobrevive a reload).
    // O app do técnico usa isso pra exigir login de novo após fechar o app.
    try { sessionStorage.setItem('sr_app_alive', '1') } catch (e) { /* nada */ }
    await _posLogin(SESSION)
  } catch (e) {
    if (msg) msg.innerHTML = `<div style="padding:9px 12px;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;border-radius:7px;font-size:13px">${esc(e.message)}</div>`
  } finally {
    if (btn) { btn.textContent = 'Entrar'; btn.disabled = false }
  }
}

// Carrega perfil, aplica roteamento por papel e inicializa UI pós-sessão
const _posLogin = async (session) => {
  SESSION = session

  // Perfil via REST direto (usuarios.role no Traders Apps).
  // Offline-first: cacheia o perfil no login; se a rede falhar, usa o cache do último acesso.
  const PCACHE = 'sr_perfil_' + session.user.id
  let u = {}, offlineSemRede = false
  try {
    // Papel do SR vem de portal_acessos (Portal) via RPC sr_perfil — não de usuarios.role.
    const r = await fetch(`${SURL}/rest/v1/rpc/sr_perfil`, { method: 'POST', headers: hAuth(), body: '{}' })
    const d = await r.json()
    u = (Array.isArray(d) ? d[0] : d) || {}
    if (u.role) { try { localStorage.setItem(PCACHE, JSON.stringify({ role: u.role, nome: u.nome, ativo: u.ativo, cargo: u.cargo, foto_url: u.foto_url })) } catch (e) {} }
  } catch (e) {
    offlineSemRede = true
    try { const c = localStorage.getItem(PCACHE); if (c) u = JSON.parse(c) } catch (e2) {}
  }
  PERFIL = u.role || null
  const nome = u.nome || session.user.email?.split('@')[0] || '?'

  // Conta sem cadastro em usuarios ou inativa → barra acesso.
  // Offline sem cache de perfil: não dá para validar → manda para login (precisa de 1 acesso online).
  if (!PERFIL || (u.ativo === false && !offlineSemRede)) {
    await getSupabase().auth.signOut()
    toast(PERFIL ? 'Conta inativa.' : 'Sem acesso ao Service Report. Solicite no Portal.', 'err')
    const ls = document.getElementById('login-screen')
    if (ls) ls.style.display = 'block'
    return
  }

  // Roteamento por papel. Cada página declara window.PAGE_ALLOWED (papéis que podem ficar).
  // login.html usa PAGE_ALLOWED = [] → qualquer logado é mandado para sua home.
  const home = roleHome(PERFIL)
  const allowed = window.PAGE_ALLOWED
  if (Array.isArray(allowed) && !allowed.includes(PERFIL)) {
    location.href = home
    return
  }

  // Revela UI
  const sidebar = document.querySelector('.sidebar')
  const loginScreen = document.getElementById('login-screen')
  const appScreen = document.getElementById('app-screen') || document.getElementById('app')
  if (sidebar) sidebar.style.display = 'flex'
  if (loginScreen) loginScreen.style.display = 'none'
  if (appScreen) appScreen.style.display = 'block'

  // Callback da página (renderSidebar / carga de dados)
  if (typeof onPostLogin === 'function') await onPostLogin()

  // Avatar/nome/perfil na sidebar (após renderSidebar)
  const avatar = document.getElementById('sb-avatar')
  const userName = document.getElementById('sb-user-name')
  const userRole = document.getElementById('sb-user-role')
  if (avatar) { const f = avatarUrl(u.foto_url); avatar.innerHTML = f ? `<img src="${esc(f)}" alt="">` : (nome[0] || '?').toUpperCase() }
  if (userName) userName.textContent = nome
  if (userRole) { const rl = ROLE_LABEL[PERFIL] || PERFIL || '—'; userRole.textContent = u.cargo ? `${u.cargo} · ${rl}` : rl }
}

// ─── SIGNED_OUT: navegação condicional (fix — irmão do bug v498) ───────────────
// O supabase-js emite SIGNED_OUT tanto no logout real quanto numa falha de refresh de token
// (comum no PWA Android em rede instável). O handler antigo navegava pro login em QUALQUER
// SIGNED_OUT → tela branca / deslogue / loop tecnico↔login no meio do encerramento. Agora a
// navegação é condicional: distingue logout intencional de transitório, nunca desloga offline,
// e não navega no meio de operação crítica (encerramento/sync).
var _logoutIntencional = false   // "Sair" / logout forçado explícito → SIGNED_OUT esperado
var _navegandoLogin = false      // single-shot: decisão de ir pro login já tomada (anti-loop)
var _recheckPendente = false     // SIGNED_OUT chegou durante op crítica → re-avaliar ao fim dela
var _criticalDepth = 0           // nº de operações críticas em curso (Commit 2 marca as 3 rajadas)

// Marca que o PRÓXIMO SIGNED_OUT é intencional (fazerLogout aqui; forcarLogout do tecnico.js no Commit 2).
window.srMarcarLogoutIntencional = () => { _logoutIntencional = true }
// Guard de operação crítica — Commit 2 chama begin/end em volta de salvar()/concluirTarefa()/syncAll.
window.srCriticalBegin = () => { _criticalDepth++ }
window.srCriticalEnd = () => {
  _criticalDepth = Math.max(0, _criticalDepth - 1)
  // Passo 4: ao fim da op crítica, um SIGNED_OUT adiado é RE-AVALIADO pelos MESMOS 5 passos
  // (em especial o 5: debounce + getSession). NUNCA navega direto aqui.
  if (_criticalDepth === 0 && _recheckPendente) { _recheckPendente = false; avaliarSignedOut() }
}

// Instrumentação (Commit 3): loga a decisão do SIGNED_OUT no console E, com SR_AUTH_DEBUG on,
// na TELA via toast — pro técnico ver a decisão no aparelho sem USB/devtools.
// BRANCH de diagnóstico: default on. Desligar/remover na limpeza pré-merge (ver PR).
var SR_AUTH_DEBUG = true
function _authDbg(msg, nivel) {
  ;(nivel === 'warn' ? console.warn : console.info)('[auth] ' + msg)
  if (SR_AUTH_DEBUG && typeof toast === 'function') { try { toast('auth: ' + msg, nivel === 'warn' ? 'err' : '') } catch (e) { /* nada */ } }
}

function _irParaLogin() {
  if (_navegandoLogin) return   // single-shot → mata o loop tecnico↔login
  _navegandoLogin = true
  location.href = 'login.html'
}

// Os 5 passos num único lugar — usados pelo evento SIGNED_OUT E pela re-avaliação pós-op crítica.
async function avaliarSignedOut() {
  // 1) já decidimos ir pro login → nada (anti-loop)
  if (_navegandoLogin) return
  // 2) logout intencional (Sair / forçado) → navega
  if (_logoutIntencional) { _logoutIntencional = false; _authDbg('SIGNED_OUT intencional → login'); _irParaLogin(); return }
  // 3) offline → NUNCA desloga (a sessão local persiste; re-login exige rede)
  if (!navigator.onLine) { _authDbg('SIGNED_OUT suprimido: offline'); return }
  // 4) operação crítica em curso → não navega agora; re-avalia (pelos 5 passos) ao fim
  if (_criticalDepth > 0) { _recheckPendente = true; _authDbg('SIGNED_OUT adiado: operação crítica em curso'); return }
  // 5) online, não-intencional, sem op crítica → pode ser refresh transitório. Debounce + confirma.
  await new Promise(function (r) { setTimeout(r, 1500) })
  if (_navegandoLogin) return
  if (_criticalDepth > 0) { _recheckPendente = true; return }   // op crítica começou no debounce → re-avalia depois
  var confirmadoSemSessao = false
  try {
    var r = await getSupabase().auth.getSession()
    if (!(r && r.data && r.data.session)) confirmadoSemSessao = true
  } catch (e) { /* rede falhou → não dá pra confirmar expiração; na dúvida NÃO desloga */ }
  if (!navigator.onLine) { _authDbg('SIGNED_OUT: caiu offline no debounce → mantém sessão'); return }
  if (!confirmadoSemSessao) { _authDbg('SIGNED_OUT transitório: sessão presente/indefinida → ignora'); return }
  _authDbg('SIGNED_OUT real: sessão expirada → login', 'warn')
  _irParaLogin()
}

// Logout manual ("Sair") — sempre navega (é escolha explícita do usuário).
var fazerLogout = async () => {
  _logoutIntencional = true
  try { await getSupabase().auth.signOut() } catch (e) { /* offline: segue e navega mesmo assim */ }
  SESSION = null; PERFIL = null
  _irParaLogin()
}

// Init: verifica sessão existente
var initAuth = async () => {
  const sidebar = document.querySelector('.sidebar')
  if (sidebar) sidebar.style.display = 'none'

  const { data: { session } } = await getSupabase().auth.getSession()

  if (session) {
    await _posLogin(session)
  } else {
    // Sem sessão — mostrar login se a página tiver (login.html, tecnico.html), senão redirecionar
    const loginScreen = document.getElementById('login-screen')
    if (loginScreen) {
      loginScreen.style.display = 'block'
    } else {
      location.href = 'login.html'
    }
  }

  // Reagir a mudanças de sessão. SIGNED_OUT agora é AVALIADO (não navega incondicionalmente).
  getSupabase().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      avaliarSignedOut()
    } else if (event === 'TOKEN_REFRESHED' && session) {
      SESSION = session
      _recheckPendente = false   // refresh voltou → cancela re-avaliação pendente
    }
  })
}
