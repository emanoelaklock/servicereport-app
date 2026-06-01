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
  if (btn) { btn.textContent = 'Entrando…'; btn.disabled = true }
  if (msg) msg.innerHTML = ''

  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password: senha })
    if (error) throw error
    SESSION = data.session
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

  // Perfil via REST direto (usuarios.role no Traders Apps)
  const r = await fetch(`${SURL}/rest/v1/usuarios?select=role,nome,ativo&id=eq.${session.user.id}`, {
    headers: hAuth()
  })
  const d = await r.json()
  const u = d[0] || {}
  PERFIL = u.role || null
  const nome = u.nome || session.user.email?.split('@')[0] || '?'

  // Conta sem cadastro em usuarios ou inativa → barra acesso
  if (!PERFIL || u.ativo === false) {
    await getSupabase().auth.signOut()
    toast(PERFIL ? 'Conta inativa.' : 'Usuário sem perfil cadastrado.', 'err')
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
  if (avatar) avatar.textContent = (nome[0] || '?').toUpperCase()
  if (userName) userName.textContent = nome
  if (userRole) userRole.textContent = ROLE_LABEL[PERFIL] || PERFIL || '—'
}

// Logout
var fazerLogout = async () => {
  await getSupabase().auth.signOut()
  SESSION = null; PERFIL = null
  location.href = 'login.html'
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

  // Reagir a mudanças de sessão
  getSupabase().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      location.href = 'login.html'
    } else if (event === 'TOKEN_REFRESHED' && session) {
      SESSION = session
    }
  })
}
