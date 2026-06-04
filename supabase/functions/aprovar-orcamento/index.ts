// Edge Function: aprovar-orcamento (#4.4 / #5.2)
// Aprova um orçamento e GERA (ou RE-SINCRONIZA) a Tarefa (OS interna) — server-side
// porque o papel `comercial` não tem RLS de escrita em public.tarefas.
// Reabrir p/ revisão + editar + reaprovar => re-sincroniza a Orçada e a orientação,
// PRESERVANDO a Levada e os itens avulsos lançados pelo administrativo na conciliação.
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
      .select("id,cliente_id,status,arquivado,servico_descricao").eq("id", id).single()
    if (oerr || !o) return json({ error: "orçamento não encontrado" }, 404)
    if (o.arquivado) return json({ error: "orçamento arquivado — desarquive antes de aprovar" }, 400)
    if (!o.cliente_id) return json({ error: "orçamento sem cliente" }, 400)

    const { data: existente } = await admin.from("tarefas")
      .select("id,numero").eq("orcamento_id", id).maybeSingle()

    // Marca aprovado (congela) — só sai de rascunho/enviado.
    if (o.status !== "aprovado") {
      const up = await admin.from("orcamentos")
        .update({ status: "aprovado", data_resposta: new Date().toISOString().slice(0, 10) })
        .eq("id", id)
      if (up.error) return json({ error: "falha ao aprovar: " + up.error.message }, 500)
    }

    // ----- Monta a Orçada desejada a partir dos itens do orçamento (consolidada por produto) -----
    const { data: itens } = await admin.from("orcamento_itens")
      .select("produto_id,descricao,unidade,quantidade,preco_unitario,tipo")
      .eq("orcamento_id", id)
    const mats = (itens || []).filter((it: any) => it.tipo === "material" || it.tipo === "avulso")
    const pids = [...new Set(mats.map((m: any) => m.produto_id).filter(Boolean))]
    const cod: Record<string, string> = {}, des: Record<string, string> = {}
    if (pids.length) {
      const { data: prods } = await admin.from("produtos").select("id,codigo,descricao").in("id", pids)
      for (const p of prods || []) { cod[p.id] = p.codigo; des[p.id] = p.descricao }
    }
    // match_key igual ao da coluna gerada: produto_id, senão lower(trim(descricao))
    const byKey = new Map<string, any>()
    for (const m of mats) {
      const desc = m.descricao || (m.produto_id ? des[m.produto_id] : null) || "(sem descrição)"
      const key = m.produto_id ? String(m.produto_id) : desc.trim().toLowerCase()
      const qtd = Number(m.quantidade) || 0
      const ex = byKey.get(key)
      if (ex) { ex.qtd_orcada += qtd }
      else byKey.set(key, {
        produto_id: m.produto_id || null,
        codigo_produto: m.produto_id ? (cod[m.produto_id] || null) : null,
        descricao: desc,
        unidade: m.unidade || null,
        preco_unitario: Number(m.preco_unitario) || 0,
        qtd_orcada: qtd,
      })
    }

    if (existente) {
      // ----- RE-SINCRONIZA a Tarefa existente (reabrir → editar → reaprovar) -----
      await admin.from("tarefas").update({ orientacao: o.servico_descricao || null }).eq("id", existente.id)
      const { data: existing } = await admin.from("tarefa_materiais")
        .select("id,match_key,qtd_levada,origem").eq("tarefa_id", existente.id)
      const byMatch = new Map<string, any>((existing || []).map((r: any) => [r.match_key, r]))
      // upsert dos materiais orçados (preserva qtd_levada)
      for (const [key, d] of byKey) {
        const ex = byMatch.get(key)
        if (ex) {
          await admin.from("tarefa_materiais").update({
            qtd_orcada: d.qtd_orcada, preco_unitario: d.preco_unitario,
            descricao: d.descricao, codigo_produto: d.codigo_produto, unidade: d.unidade,
          }).eq("id", ex.id)
        } else {
          await admin.from("tarefa_materiais").insert({ tarefa_id: existente.id, ...d, qtd_levada: 0, origem: "orcamento" })
        }
      }
      // materiais que saíram do orçamento: zera orçada se houve levada, senão remove a linha
      for (const r of existing || []) {
        if (r.origem === "orcamento" && !byKey.has(r.match_key)) {
          if (Number(r.qtd_levada) > 0) await admin.from("tarefa_materiais").update({ qtd_orcada: 0 }).eq("id", r.id)
          else await admin.from("tarefa_materiais").delete().eq("id", r.id)
        }
      }
      return json({ ok: true, already: true, resynced: true, tarefa_id: existente.id, tarefa_numero: existente.numero, materiais_orcados: byKey.size })
    }

    // ----- Cria nova Tarefa + semeia a Orçada -----
    const ins = await admin.from("tarefas").insert({
      orcamento_id: id, cliente_id: o.cliente_id, status: "aguardando_execucao", criado_por: uid,
      orientacao: o.servico_descricao || null,
    }).select("id,numero").single()
    if (ins.error) {
      const { data: ja } = await admin.from("tarefas").select("id,numero").eq("orcamento_id", id).maybeSingle()
      if (ja) return json({ ok: true, already: true, tarefa_id: ja.id, tarefa_numero: ja.numero })
      return json({ error: "falha ao gerar Tarefa: " + ins.error.message }, 500)
    }
    const rows = [...byKey.values()].map((d: any) => ({ tarefa_id: ins.data.id, ...d, qtd_levada: 0, origem: "orcamento" }))
    if (rows.length) {
      const seed = await admin.from("tarefa_materiais").insert(rows)
      if (seed.error) return json({ ok: true, tarefa_id: ins.data.id, tarefa_numero: ins.data.numero, seed_error: seed.error.message })
    }
    return json({ ok: true, tarefa_id: ins.data.id, tarefa_numero: ins.data.numero, materiais_orcados: rows.length })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
