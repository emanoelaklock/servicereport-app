// Edge Function: aprovar-orcamento (#4.4)
// Aprova um orçamento e GERA a Tarefa (OS interna) — server-side porque o papel
// `comercial` não tem RLS de escrita em public.tarefas. Idempotente: reclicar não
// duplica (índice único parcial uq_tarefas_orcamento + checagem prévia).
// "Congela o orçado": ao virar aprovado, o front bloqueia a edição dos itens.
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
    if (!OFFICE.includes(prof?.role || "")) return json({ error: "apenas escritório (comercial/admin/gestor)" }, 403)

    const body = await req.json().catch(() => ({}))
    const id = body.id
    if (!id) return json({ error: "id obrigatorio" }, 400)

    const { data: o, error: oerr } = await admin.from("orcamentos")
      .select("id,cliente_id,status,arquivado").eq("id", id).single()
    if (oerr || !o) return json({ error: "orçamento não encontrado" }, 404)
    if (o.arquivado) return json({ error: "orçamento arquivado — desarquive antes de aprovar" }, 400)
    if (!o.cliente_id) return json({ error: "orçamento sem cliente" }, 400)

    // Já existe Tarefa para este orçamento? (idempotência)
    const { data: existente } = await admin.from("tarefas")
      .select("id,numero").eq("orcamento_id", id).maybeSingle()

    // Marca aprovado (congela) — só sai de rascunho/enviado.
    if (o.status !== "aprovado") {
      const up = await admin.from("orcamentos")
        .update({ status: "aprovado", data_resposta: new Date().toISOString().slice(0, 10) })
        .eq("id", id)
      if (up.error) return json({ error: "falha ao aprovar: " + up.error.message }, 500)
    }

    if (existente) return json({ ok: true, already: true, tarefa_id: existente.id, tarefa_numero: existente.numero })

    const ins = await admin.from("tarefas").insert({
      orcamento_id: id, cliente_id: o.cliente_id, status: "aguardando_execucao", criado_por: uid,
    }).select("id,numero").single()

    if (ins.error) {
      // corrida: outra requisição criou a Tarefa antes — devolve a existente
      const { data: ja } = await admin.from("tarefas").select("id,numero").eq("orcamento_id", id).maybeSingle()
      if (ja) return json({ ok: true, already: true, tarefa_id: ja.id, tarefa_numero: ja.numero })
      return json({ error: "falha ao gerar Tarefa: " + ins.error.message }, 500)
    }

    // #5.2: semeia a conciliação — copia os materiais do orçamento como "Orçada".
    let materiaisOrcados = 0
    const { data: itens } = await admin.from("orcamento_itens")
      .select("produto_id,descricao,unidade,quantidade,preco_unitario,tipo")
      .eq("orcamento_id", id)
    const mats = (itens || []).filter((it: any) => it.tipo === "material" || it.tipo === "avulso")
    if (mats.length) {
      // códigos/descrições dos produtos do catálogo (fallback de descrição)
      const pids = [...new Set(mats.map((m: any) => m.produto_id).filter(Boolean))]
      const cod: Record<string, string> = {}, des: Record<string, string> = {}
      if (pids.length) {
        const { data: prods } = await admin.from("produtos").select("id,codigo,descricao").in("id", pids)
        for (const p of prods || []) { cod[p.id] = p.codigo; des[p.id] = p.descricao }
      }
      const rows = mats.map((m: any) => ({
        tarefa_id: ins.data.id,
        produto_id: m.produto_id || null,
        codigo_produto: m.produto_id ? (cod[m.produto_id] || null) : null,
        descricao: m.descricao || (m.produto_id ? des[m.produto_id] : null) || "(sem descrição)",
        unidade: m.unidade || null,
        preco_unitario: Number(m.preco_unitario) || 0,
        qtd_orcada: Number(m.quantidade) || 0,
        qtd_levada: 0,
        origem: "orcamento",
      }))
      const seed = await admin.from("tarefa_materiais").insert(rows)
      if (seed.error) {
        // não derruba a aprovação; sinaliza para o front
        return json({ ok: true, tarefa_id: ins.data.id, tarefa_numero: ins.data.numero, seed_error: seed.error.message })
      }
      materiaisOrcados = rows.length
    }
    return json({ ok: true, tarefa_id: ins.data.id, tarefa_numero: ins.data.numero, materiais_orcados: materiaisOrcados })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
