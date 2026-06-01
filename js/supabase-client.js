/* ═══════════════════════════════════════════════
   Service Report — supabase-client.js
   Config + cliente Supabase (projeto "Traders Apps", portal).
   Padrão UMD: requer <script @supabase/supabase-js@2> ANTES (window.supabase).
   Carregar ESTE arquivo ANTES de auth.js (que reusa SURL/AKEY/getSupabase).
═══════════════════════════════════════════════ */

// Projeto Traders Apps — chave anon (legacy JWT). Segura no client (RLS protege os dados).
// Alternativa moderna (publishable): 'sb_publishable_DmZyxvf-35mPPIU8zWsPaw_Mku9P-7l'
var SURL = 'https://iwufrqmzcvaiyzynodkg.supabase.co'
var AKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml3dWZycW16Y3ZhaXl6eW5vZGtnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MzgwMDEsImV4cCI6MjA4ODMxNDAwMX0.y3W12qwkfhKcmGQQ0oSSwgidTJu0Pgl6JF4deE3G0y4'

// Cliente Supabase (lazy, singleton)
let _supabase = null
function getSupabase() {
  if (!_supabase) {
    _supabase = window.supabase.createClient(SURL, AKEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sr_sess' }
    })
  }
  return _supabase
}

// ── Perfis (usuarios.role no Traders Apps) ──
// Espinha dorsal de auth/RLS reusada do portal: admin / gestor_axis / tecnico_campo.
var ROLE_LABEL = {
  admin:        'Administrador',
  gestor_axis:  'Gestor',
  tecnico_campo:'Técnico',
}

// Página inicial por papel (roteamento pós-login).
// tecnico_campo → app de campo (PWA); demais → portal.
function roleHome(role) {
  return role === 'tecnico_campo' ? 'tecnico.html' : 'painel.html'
}

// Papel do usuário logado (consulta direta; a RLS no banco é a fonte da verdade).
async function getUserRole() {
  const { data: { user } } = await getSupabase().auth.getUser()
  if (!user) return null
  const { data, error } = await getSupabase()
    .from('usuarios').select('role,nome,ativo').eq('id', user.id).single()
  if (error) return null
  return data // { role, nome, ativo }
}
