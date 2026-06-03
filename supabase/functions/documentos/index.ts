// Edge Function: documentos (#4.5)
//  action 'pdf'                     → gera PDF (pré-orçamento OU orçamento) e devolve base64.
//  action 'pre_orcamento_concluido' → gera PDF do pré-orçamento + e-mail ao comercial (Resend), idempotente.
// PDF no SERVIDOR (pdf-lib, sem headless browser). Mesmo template, 2 modos: orçamento tem preço/totais.
// E-mail: só pré-orçamento → comercial@tsrv (best-effort; não bloqueia o PDF). Orçamento nunca dispara e-mail.
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1?target=deno"
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const OFFICE = ["admin", "gestor_axis", "comercial"]

const EMP = {
  nome: Deno.env.get("EMPRESA_NOME") || "Traders Service",
  cnpj: Deno.env.get("EMPRESA_CNPJ") || "",
  ie: Deno.env.get("EMPRESA_IE") || "",
  im: Deno.env.get("EMPRESA_IM") || "",
  endereco: Deno.env.get("EMPRESA_ENDERECO") || "",
  telefone: Deno.env.get("EMPRESA_TELEFONE") || "",
}

const BRL = (n: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0)
const QTD = (n: number) => {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : v.toLocaleString("pt-BR", { maximumFractionDigits: 3 })
}
function agoraFmt(): string {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value
  return `${p.day}/${p.month}/${p.year} às ${p.hour}:${p.minute}`
}

type Item = { descricao: string; unidade?: string | null; quantidade: number; preco_unitario: number }
type DocData = {
  numero: number | string; dataFmt: string; geradoPor: string;
  cliente: { nome?: string | null; documento?: string | null; endereco?: string | null };
  descricao?: string | null; servicos: Item[]; produtos: Item[]; condicao_pagamento?: string | null;
}

async function buildPdf(kind: "pre_orcamento" | "orcamento", d: DocData): Promise<Uint8Array> {
  const withPrice = kind === "orcamento"
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const W = 595.28, H = 841.89, M = 40
  const navy = rgb(0.106, 0.165, 0.290), gray = rgb(0.42, 0.45, 0.5), line = rgb(0.85, 0.87, 0.9), black = rgb(0, 0, 0)

  let page = pdf.addPage([W, H])
  let y = H - M
  const txt = (s: unknown, x: number, yy: number, size: number, f = font, c = black) =>
    page.drawText(String(s ?? ""), { x, y: yy, size, font: f, color: c })
  const wof = (s: unknown, size: number, f = font) => f.widthOfTextAtSize(String(s ?? ""), size)
  const rtxt = (s: unknown, xr: number, yy: number, size: number, f = font, c = black) =>
    txt(s, xr - wof(s, size, f), yy, size, f, c)
  const hr = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.5, color: line })
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M }
  const ensure = (h: number) => { if (y - h < M + 26) newPage() }
  function wrap(s: unknown, size: number, maxW: number, f = font): string[] {
    const words = String(s ?? "").split(/\s+/), lines: string[] = []; let cur = ""
    for (const w of words) { const t = cur ? cur + " " + w : w; if (wof(t, size, f) <= maxW) cur = t; else { if (cur) lines.push(cur); cur = w } }
    if (cur) lines.push(cur); return lines.length ? lines : [""]
  }

  // Cabeçalho da empresa
  txt(EMP.nome, M, y - 6, 16, bold, navy); y -= 22
  const sub = [EMP.cnpj && "CNPJ " + EMP.cnpj, EMP.ie && "IE " + EMP.ie, EMP.im && "IM " + EMP.im].filter(Boolean).join("  ·  ")
  if (sub) { txt(sub, M, y, 8, font, gray); y -= 12 }
  if (EMP.endereco) { txt(EMP.endereco, M, y, 8, font, gray); y -= 12 }
  if (EMP.telefone) { txt("Tel " + EMP.telefone, M, y, 8, font, gray); y -= 12 }
  y -= 6; hr(y); y -= 22

  // Título
  const titulo = (withPrice ? "Orçamento" : "Pré-Orçamento") + " Nº " + d.numero
  txt(titulo, M, y, 14, bold, navy); rtxt(d.dataFmt, W - M, y, 9, font, gray); y -= 24

  // Cliente
  txt("Cliente", M, y, 9, bold, gray); y -= 14
  txt(d.cliente.nome || "—", M, y, 11, bold); y -= 13
  for (const c of [d.cliente.documento, d.cliente.endereco].filter(Boolean)) {
    for (const ln of wrap(c, 9, W - 2 * M)) { txt(ln, M, y, 9, font, gray); y -= 11 }
  }
  y -= 8; hr(y); y -= 18

  // Levantamento (só pré-orçamento)
  if (!withPrice && d.descricao) {
    txt("Levantamento", M, y, 9, bold, gray); y -= 14
    for (const ln of wrap(d.descricao, 10, W - 2 * M)) { ensure(14); txt(ln, M, y, 10); y -= 13 }
    y -= 8; hr(y); y -= 18
  }

  const drawTable = (titulo: string, rows: Item[], hasUnid: boolean) => {
    if (!rows.length) return 0
    ensure(40)
    txt(titulo, M, y, 11, bold, navy); y -= 16
    // colunas
    const vtR = W - M, vuR = W - M - 90, qtdR = withPrice ? vuR - 70 : W - M
    const unidR = hasUnid ? (withPrice ? 110 + M : qtdR - 70) : 0
    const descW = (hasUnid ? unidR - 14 : qtdR - 14) - M - (hasUnid ? 30 : 30)
    // cabeçalho
    txt("Descrição", M, y, 8, bold, gray)
    if (hasUnid) rtxt("Unid.", unidR, y, 8, bold, gray)
    rtxt("Qtd", qtdR, y, 8, bold, gray)
    if (withPrice) { rtxt("Valor unit.", vuR, y, 8, bold, gray); rtxt("Valor total", vtR, y, 8, bold, gray) }
    y -= 5; hr(y); y -= 13
    let tot = 0
    for (const it of rows) {
      const lines = wrap(it.descricao, 9, Math.max(80, descW))
      const rowH = Math.max(13, lines.length * 11)
      ensure(rowH + 4)
      let yy = y
      for (const ln of lines) { txt(ln, M, yy, 9); yy -= 11 }
      if (hasUnid) rtxt(it.unidade || "—", unidR, y, 9, font, gray)
      rtxt(QTD(it.quantidade), qtdR, y, 9)
      if (withPrice) {
        const sub = (Number(it.quantidade) || 0) * (Number(it.preco_unitario) || 0)
        tot += sub
        rtxt(BRL(it.preco_unitario), vuR, y, 9)
        rtxt(BRL(sub), vtR, y, 9)
      }
      y -= rowH + 5; hr(y + 2)
    }
    y -= 10
    return tot
  }

  const totServ = drawTable("Serviços", d.servicos, false)
  const totProd = drawTable("Materiais", d.produtos, true)

  if (withPrice) {
    ensure(70)
    rtxt("Serviços: " + BRL(totServ), W - M, y, 9); y -= 13
    rtxt("Materiais: " + BRL(totProd), W - M, y, 9); y -= 17
    rtxt("TOTAL: " + BRL(totServ + totProd), W - M, y, 13, bold, navy); y -= 22
    if (d.condicao_pagamento) {
      ensure(30)
      txt("Condição de pagamento", M, y, 8, bold, gray); y -= 12
      for (const ln of wrap(d.condicao_pagamento, 9, W - 2 * M)) { txt(ln, M, y, 9); y -= 11 }
    }
  }

  // Rodapé em todas as páginas
  const pages = pdf.getPages()
  const footer = `Gerado em ${d.dataFmt} por ${d.geradoPor}`
  pages.forEach((p, i) => {
    p.drawText(`${footer}   —   ${i + 1}/${pages.length}`, { x: M, y: 22, size: 8, font, color: gray })
  })

  return await pdf.save()
}

async function enviarEmail(to: string, subject: string, html: string, att: { filename: string; content: string }) {
  const key = Deno.env.get("RESEND_API_KEY")
  if (!key) return { ok: false, reason: "RESEND_API_KEY ausente (e-mail não configurado)" }
  const from = Deno.env.get("EMAIL_FROM") || "Service Report <onboarding@resend.dev>"
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, attachments: [att] }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, reason: (j as { message?: string }).message || ("HTTP " + res.status) }
  return { ok: true, id: (j as { id?: string }).id }
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
    const { data: prof } = await admin.from("usuarios").select("role,nome").eq("id", uid).single()
    const role = prof?.role || ""
    const isOffice = OFFICE.includes(role)
    const geradoPor = prof?.nome || ud.user.email || "Sistema"

    const body = await req.json().catch(() => ({}))
    const action = body.action || "pdf"
    const tipo = body.tipo || (action === "pre_orcamento_concluido" ? "pre_orcamento" : null)
    const id = body.id
    if (!id) return json({ error: "id obrigatorio" }, 400)

    const dataFmt = agoraFmt()

    // ── Carrega dados conforme o tipo, validando autorização ──
    let kind: "pre_orcamento" | "orcamento"
    let docData: DocData
    let preorcRow: { numero: number; cliente_nome?: string | null; email_comercial_em?: string | null } | null = null

    if (tipo === "pre_orcamento") {
      const { data: po } = await admin.from("pre_orcamentos").select("*").eq("id", id).single()
      if (!po) return json({ error: "pré-orçamento não encontrado" }, 404)
      const ownerOk = role === "tecnico_campo" && po.tecnico_id === uid
      if (!isOffice && !ownerOk) return json({ error: "sem permissão" }, 403)
      const { data: itens } = await admin.from("pre_orcamento_itens").select("*").eq("pre_orcamento_id", id).order("criado_em")
      const cli = po.cliente_id ? (await admin.from("clientes").select("nome,documento,endereco").eq("id", po.cliente_id).single()).data : null
      kind = "pre_orcamento"
      preorcRow = po
      docData = {
        numero: po.numero, dataFmt, geradoPor,
        cliente: { nome: po.cliente_nome || cli?.nome, documento: cli?.documento, endereco: cli?.endereco },
        descricao: po.descricao, servicos: [],
        produtos: (itens || []).map((m: Item & { codigo_produto?: string }) => ({
          descricao: m.descricao || (m as { codigo_produto?: string }).codigo_produto || "—",
          unidade: m.unidade, quantidade: Number(m.quantidade) || 0, preco_unitario: 0,
        })),
      }
    } else if (tipo === "orcamento") {
      if (!isOffice) return json({ error: "apenas escritório" }, 403)
      const { data: o } = await admin.from("orcamentos").select("*").eq("id", id).single()
      if (!o) return json({ error: "orçamento não encontrado" }, 404)
      const { data: itens } = await admin.from("orcamento_itens").select("*").eq("orcamento_id", id).order("criado_em")
      const cli = o.cliente_id ? (await admin.from("clientes").select("nome,documento,endereco").eq("id", o.cliente_id).single()).data : null
      const map = (m: Item) => ({ descricao: m.descricao || "—", unidade: m.unidade, quantidade: Number(m.quantidade) || 0, preco_unitario: Number(m.preco_unitario) || 0 })
      kind = "orcamento"
      docData = {
        numero: o.numero, dataFmt, geradoPor,
        cliente: { nome: cli?.nome, documento: cli?.documento, endereco: cli?.endereco },
        servicos: (itens || []).filter((i: { tipo: string }) => i.tipo === "servico").map(map),
        produtos: (itens || []).filter((i: { tipo: string }) => i.tipo === "material" || i.tipo === "avulso").map(map),
        condicao_pagamento: o.condicao_pagamento,
      }
    } else {
      return json({ error: "tipo inválido (pre_orcamento|orcamento)" }, 400)
    }

    const pdfBytes = await buildPdf(kind, docData)
    const b64 = encodeBase64(pdfBytes)
    const filename = `${kind === "orcamento" ? "Orcamento" : "Pre-Orcamento"}_${docData.numero}.pdf`

    // ── Só PDF ──
    if (action === "pdf") {
      return json({ ok: true, filename, base64: b64 })
    }

    // ── Pré-orçamento concluído: e-mail ao comercial (idempotente) ──
    if (action === "pre_orcamento_concluido") {
      if (preorcRow?.email_comercial_em) return json({ ok: true, already: true, filename })
      const to = Deno.env.get("PREORC_EMAIL_TO") || "comercial@tsrv.com.br"
      const html = `<p>Novo pré-orçamento concluído em campo.</p>
        <p><strong>Nº ${docData.numero}</strong> — Cliente: ${docData.cliente.nome || "—"}<br>
        Técnico: ${geradoPor} · ${dataFmt}</p>
        <p>PDF em anexo.</p>`
      const r = await enviarEmail(to, `Pré-Orçamento Nº ${docData.numero} — ${docData.cliente.nome || ""}`.trim(), html, { filename, content: b64 })
      if (r.ok) {
        await admin.from("pre_orcamentos").update({ email_comercial_em: new Date().toISOString() }).eq("id", id)
        return json({ ok: true, email: "enviado", id: r.id, filename })
      }
      // Não bloqueia: tentará de novo no próximo sync (email_comercial_em segue nulo).
      return json({ ok: true, email: "falhou", reason: r.reason, filename })
    }

    return json({ error: "action inválida (pdf|pre_orcamento_concluido)" }, 400)
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
