// Edge Function: omie-sync (Fase 1 — clientes + produtos)
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const OMIE_BASE = "https://app.omie.com.br/api/v1"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Omie devolve texto com entidades HTML (ex.: 3/4&quot;). Decodifica (&amp; por último).
const dec = (s: any): any => s == null ? s : String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

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
    const { data: prof } = await admin.from("usuarios").select("role").eq("id", ud.user.id).single()
    if (!prof || !["admin", "gestor_axis"].includes(prof.role)) return json({ error: "apenas admin/gestor" }, 403)

    const KEY = Deno.env.get("OMIE_APP_KEY") || Deno.env.get("APP_KEY")
    const SECRET = Deno.env.get("OMIE_APP_SECRET") || Deno.env.get("APP_SECRET")
    if (!KEY) return json({ error: "Secret da app_key nao encontrado (OMIE_APP_KEY ou APP_KEY)." }, 400)
    if (!SECRET) return json({ error: "Secret da app_secret nao encontrado (OMIE_APP_SECRET ou APP_SECRET)." }, 400)

    async function omie(modulo: string, call: string, param: unknown) {
      let lastErr = ""
      for (let attempt = 0; attempt < 6; attempt++) {
        let res: Response
        try {
          res = await fetch(`${OMIE_BASE}/${modulo}/`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ call, app_key: KEY, app_secret: SECRET, param: [param] }),
          })
        } catch (e) { lastErr = String(e); await sleep(800 * 2 ** attempt); continue }
        if ([429, 500, 502, 503].includes(res.status)) { lastErr = `HTTP ${res.status}`; await sleep(1000 * 2 ** attempt); continue }
        let j: any
        try { j = await res.json() } catch (_e) { lastErr = "json invalido"; await sleep(800 * 2 ** attempt); continue }
        if (j && j.faultstring) {
          if (/aguarde|bloquead|consumo|excedid|limite|tente novamente|425/i.test(j.faultstring)) { lastErr = j.faultstring; await sleep(1500 * 2 ** attempt); continue }
          throw new Error(j.faultstring)
        }
        return j
      }
      throw new Error("Omie rate limit / falha transitoria: " + lastErr)
    }

    async function syncClientes(): Promise<number> {
      let pagina = 1, total = 1, n = 0
      do {
        const r = await omie("geral/clientes", "ListarClientes", { pagina, registros_por_pagina: 50, apenas_importado_api: "N" })
        total = r.total_de_paginas || 1
        const rows = (r.clientes_cadastro || []).map((c: any) => ({
          omie_cliente_id: String(c.codigo_cliente_omie),
          nome: dec(c.razao_social || c.nome_fantasia || "(sem nome)"),
          documento: c.cnpj_cpf || null,
          endereco: dec([c.endereco, c.endereco_numero, c.bairro, c.cidade, c.estado, c.cep].filter(Boolean).join(", ")) || null,
        }))
        if (rows.length) { const up = await admin.from("clientes").upsert(rows, { onConflict: "omie_cliente_id" }); if (up.error) throw up.error; n += rows.length }
        pagina++; await sleep(300)
      } while (pagina <= total && pagina <= 200)
      return n
    }

    async function syncProdutos(): Promise<number> {
      let pagina = 1, total = 1, n = 0
      do {
        const r = await omie("geral/produtos", "ListarProdutos", { pagina, registros_por_pagina: 50, filtrar_apenas_omiepdv: "N" })
        total = r.total_de_paginas || 1
        const rows = (r.produto_servico_cadastro || []).map((p: any) => ({
          omie_produto_id: String(p.codigo_produto),
          codigo: p.codigo || null,
          descricao: dec(p.descricao || "(sem descricao)"),
          unidade: p.unidade || null,
          ativo: p.inativo !== "S",
        }))
        if (rows.length) { const up = await admin.from("produtos").upsert(rows, { onConflict: "omie_produto_id" }); if (up.error) throw up.error; n += rows.length }
        pagina++; await sleep(300)
      } while (pagina <= total && pagina <= 200)
      return n
    }

    const body = await req.json().catch(() => ({}))
    const action = body.action || "all"

    if (action === "test") {
      const r = await omie("geral/empresas", "ListarEmpresas", { pagina: 1, registros_por_pagina: 1 })
      return json({ ok: true, empresas: r.total_de_registros ?? null })
    }

    let cli = 0, prod = 0
    if (action === "clientes" || action === "all") cli = await syncClientes()
    if (action === "produtos" || action === "all") prod = await syncProdutos()
    await admin.from("sync_log").insert({ fonte: "omie", fim: new Date().toISOString(), registros: cli + prod, status: "ok", detalhe: `clientes:${cli} produtos:${prod}` })
    return json({ ok: true, clientes: cli, produtos: prod })
  } catch (e) {
    try { await admin.from("sync_log").insert({ fonte: "omie", fim: new Date().toISOString(), status: "erro", detalhe: String((e as Error)?.message || e) }) } catch (_) {}
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
