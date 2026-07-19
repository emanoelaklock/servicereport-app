// Edge Function: reabrir-orcamento
// Reabre um orçamento aprovado para revisão e REMOVE a Tarefa (OS) gerada na
// aprovação (server-side, pois o papel comercial não tem RLS de escrita em tarefas).
// Bloqueia se a Tarefa já tem RAT (execução iniciada).
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

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
    const uid = ud.user.id

    // Autorização: papel global do SR (admin/gestor/comercial) OU acesso de edição no app Gestão Comercial
    const { data: prof } = await admin.from("usuarios").select("role").eq("id", uid).single()
    const { data: pa } = await admin.from("portal_acessos").select("role_chave").eq("usuario_id", uid).eq("app_chave", "gestao_comercial").maybeSingle()
    const canEdit = ["admin", "gestor_axis", "comercial"].includes(prof?.role || "")
      || ["Administrador", "Gestor", "Comercial"].includes(pa?.role_chave || "")
    if (!canEdit) return json({ error: "sem permissão para reabrir" }, 403)

    const body = await req.json().catch(() => ({}))
    const id = body.id
    if (!id) return json({ error: "id obrigatorio" }, 400)

    const { data: o, error: oerr } = await admin.from("orcamentos").select("id,status").eq("id", id).single()
    if (oerr || !o) return json({ error: "orçamento não encontrado" }, 404)

    // Tarefa vinculada a este orçamento
    const { data: t } = await admin.from("tarefas").select("id,numero").eq("orcamento_id", id).maybeSingle()
    let tarefa_removida: number | null = null
    if (t) {
      // Execução iniciada? (RAT existente) → não dá para reabrir sem perder execução
      const { data: rat } = await admin.from("rats").select("id").eq("tarefa_id", t.id).limit(1).maybeSingle()
      if (rat) return json({ error: `A Tarefa (OS) Nº ${t.numero} já tem RAT/execução iniciada. Não é possível reabrir esta proposta.` }, 409)
      // C2b (trilha comercial): desvínculo legado + delete + evento tarefa_removida
      // numa ÚNICA transação (RPC única; o evento nasce no trigger BEFORE DELETE).
      // A RPC revalida a regra de RAT atomicamente (fecha a corrida do check acima).
      const { data: rem, error: rerr } = await admin.rpc("remover_tarefa_orcamento", {
        p_orcamento: id, p_ator: uid, p_motivo: "Reabertura do orçamento — Tarefa (OS) removida",
      })
      if (rerr) {
        if ((rerr.message || "").includes("TAREFA_COM_RAT"))
          return json({ error: `A Tarefa (OS) Nº ${t.numero} já tem RAT/execução iniciada. Não é possível reabrir esta proposta.` }, 409)
        return json({ error: "Falha ao remover a Tarefa: " + rerr.message }, 500)
      }
      tarefa_removida = rem?.removida ? rem.tarefa_numero : null
    }

    const up = await admin.from("orcamentos").update({ status: "rascunho", data_resposta: null }).eq("id", id)
    if (up.error) return json({ error: "falha ao reabrir: " + up.error.message }, 500)

    return json({ ok: true, tarefa_removida })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
