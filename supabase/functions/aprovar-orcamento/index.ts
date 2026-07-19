// Edge Function: aprovar-orcamento (#4.4 / #5.2)
// Aprova um orçamento e GERA (ou RE-SINCRONIZA) a Tarefa (OS interna) — server-side
// porque o papel `comercial` não tem RLS de escrita em public.tarefas.
// REGRA: a Tarefa só é gerada se o orçamento tiver SERVIÇO (descrição ou valor de serviço).
// Orçamento só de produtos é aprovado sem gerar OS.
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const OFFICE = ["admin", "gestor_axis", "comercial"]

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
    const { data: prof } = await admin.from("usuarios").select("role").eq("id", uid).single()
    const { data: pa } = await admin.from("portal_acessos").select("role_chave").eq("usuario_id", uid).eq("app_chave", "gestao_comercial").maybeSingle()
    const canEdit = OFFICE.includes(prof?.role || "") || ["Administrador", "Gestor", "Comercial"].includes(pa?.role_chave || "")
    if (!canEdit) return json({ error: "apenas escritório (comercial/admin/gestor)" }, 403)

    const body = await req.json().catch(() => ({}))
    const id = body.id
    if (!id) return json({ error: "id obrigatorio" }, 400)

    const { data: o, error: oerr } = await admin.from("orcamentos")
      .select("id,cliente_id,status,arquivado,servico_descricao,servico_valor").eq("id", id).single()
    if (oerr || !o) return json({ error: "orçamento não encontrado" }, 404)
    if (o.arquivado) return json({ error: "orçamento arquivado — desarquive antes de aprovar" }, 400)
    if (!o.cliente_id) return json({ error: "orçamento sem cliente" }, 400)

    // Marca aprovado (congela) — só sai de rascunho/enviado.
    if (o.status !== "aprovado") {
      const up = await admin.from("orcamentos")
        .update({ status: "aprovado", data_resposta: new Date().toISOString().slice(0, 10) })
        .eq("id", id)
      if (up.error) return json({ error: "falha ao aprovar: " + up.error.message }, 500)
    }

    // REGRA: só gera Tarefa (OS) se houver serviço (descrição OU valor de serviço).
    const temServico = (String(o.servico_descricao || "").trim() !== "") || (Number(o.servico_valor) > 0)
    if (!temServico) {
      return json({ ok: true, sem_servico: true })
    }

    // C2b (trilha comercial): mutação e evento na MESMA transação — a RPC única no
    // banco gera OU ressincroniza a Tarefa (consolidação da Orçada incluída) e o
    // evento nasce dentro dela (tarefa_gerada via trigger; tarefa_resincronizada
    // só quando algo mudou de fato). A edge não executa operação e auditoria em
    // chamadas separadas; falha na RPC = nada persistido.
    const { data: sync, error: serr } = await admin.rpc("sincronizar_tarefa_orcamento", {
      p_orcamento: id, p_ator: uid, p_motivo: "Aprovação do orçamento (aprovar-orcamento)",
    })
    if (serr) return json({ error: "falha ao gerar/sincronizar a Tarefa: " + serr.message }, 500)
    if (sync?.acao === "gerada") {
      return json({ ok: true, tarefa_id: sync.tarefa_id, tarefa_numero: sync.tarefa_numero, materiais_orcados: sync.materiais })
    }
    return json({
      ok: true, already: true, resynced: true, alterou: sync?.alterou === true,
      tarefa_id: sync?.tarefa_id, tarefa_numero: sync?.tarefa_numero, materiais_orcados: sync?.materiais,
    })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
