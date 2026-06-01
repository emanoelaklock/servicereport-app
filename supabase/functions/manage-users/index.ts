// Edge Function: manage-users
// Gestão de usuários do Service Report. Só admin pode chamar.
// Cria login (auth) + perfil (public.usuarios), reseta senha e exclui usuário.
// Usa service_role APENAS no servidor; valida o JWT do chamador e o papel admin.
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const ROLES = ["admin", "gestor_axis", "tecnico_campo"]

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const url = Deno.env.get("SUPABASE_URL")!
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    const admin = createClient(url, service, { auth: { persistSession: false } })

    // Identifica o chamador pelo JWT e confere se é admin
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "")
    const { data: ud, error: uerr } = await admin.auth.getUser(token)
    if (uerr || !ud?.user) return json({ error: "nao autenticado" }, 401)
    const callerId = ud.user.id
    const { data: prof } = await admin.from("usuarios").select("role").eq("id", callerId).single()
    if (!prof || prof.role !== "admin") return json({ error: "apenas admin" }, 403)

    const body = await req.json()
    const action = body.action

    if (action === "create") {
      const { email, senha, nome, role } = body
      if (!email || !senha || !nome || !ROLES.includes(role)) return json({ error: "dados invalidos" }, 400)
      const { data: created, error: cerr } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true, user_metadata: { nome, role },
      })
      if (cerr) return json({ error: cerr.message }, 400)
      const uid = created.user.id
      const { error: perr } = await admin.from("usuarios").upsert({ id: uid, nome, email, role, ativo: true })
      if (perr) return json({ error: perr.message }, 400)
      return json({ ok: true, id: uid })
    }

    if (action === "reset_password") {
      const { user_id, senha } = body
      if (!user_id || !senha) return json({ error: "dados invalidos" }, 400)
      const { error } = await admin.auth.admin.updateUserById(user_id, { password: senha })
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === "delete") {
      const { user_id } = body
      if (!user_id) return json({ error: "dados invalidos" }, 400)
      if (user_id === callerId) return json({ error: "nao pode excluir a si mesmo" }, 400)
      await admin.from("tarefas").update({ tecnico_id: null }).eq("tecnico_id", user_id)
      await admin.from("usuarios").delete().eq("id", user_id)
      const { error } = await admin.auth.admin.deleteUser(user_id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: "acao desconhecida" }, 400)
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
