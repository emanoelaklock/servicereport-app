// Edge Function: orcamento-importar-fotos
// Copia as fotos do pré-orçamento de origem para a pasta do orçamento (server-side,
// service role — o comercial não tem acesso de leitura à pasta do técnico).
// Idempotente: usa o caminho preorc-<id_da_foto_origem> e não recopia.
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const OFFICE = ["admin", "gestor_axis"]   // P0 Fase B: papel por-app service_report (era usuarios.role global; 'comercial' nunca casava)
const BUCKET = "rat-anexos"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  const url = Deno.env.get("SUPABASE_URL")!
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  const admin = createClient(url, service, { auth: { persistSession: false } })

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "")
    const { data: ud, error: uerr } = await admin.auth.getUser(token)
    if (uerr || !ud?.user) return json({ error: "nao autenticado" }, 401)
    // Autoriza por portal_acessos do app service_report (P0 Fase B): papel por-app, não usuarios.role
    // (coluna outrora auto-editável — migração 0124). Sem registro no app service_report → 403.
    const { data: acc } = await admin.from("portal_acessos")
      .select("role_chave").eq("usuario_id", ud.user.id).eq("app_chave", "service_report").maybeSingle()
    if (!OFFICE.includes(acc?.role_chave || "")) return json({ error: "apenas escritório" }, 403)

    const body = await req.json().catch(() => ({}))
    const id = body.id
    if (!id) return json({ error: "id obrigatorio" }, 400)

    const { data: o } = await admin.from("orcamentos").select("id,pre_orcamento_id").eq("id", id).single()
    if (!o) return json({ error: "orçamento não encontrado" }, 404)
    if (!o.pre_orcamento_id) return json({ ok: true, importadas: 0, motivo: "orçamento sem pré-orçamento de origem" })

    const { data: src } = await admin.from("relatorio_fotos").select("id,url,legenda").eq("pre_orcamento_id", o.pre_orcamento_id).order("criado_em")
    const { data: ja } = await admin.from("relatorio_fotos").select("url").eq("orcamento_id", id)
    const existentes = new Set((ja || []).map((r: { url: string }) => r.url))

    let importadas = 0
    for (const f of src || []) {
      const ext = (String(f.url).split(".").pop() || "jpg").toLowerCase()
      const novo = `orcamentos/${id}/preorc-${f.id}.${ext}`
      if (existentes.has(novo)) continue
      const cp = await admin.storage.from(BUCKET).copy(f.url, novo)
      if (cp.error) continue
      const ins = await admin.from("relatorio_fotos").insert({ orcamento_id: id, url: novo, legenda: f.legenda || null })
      if (!ins.error) importadas++
    }
    return json({ ok: true, importadas, disponiveis: (src || []).length })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
