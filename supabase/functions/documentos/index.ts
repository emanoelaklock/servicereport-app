// Edge Function: documentos (#4.5 + redesign do PDF do orçamento)
//  action 'pdf'                     → gera PDF (pré-orçamento OU orçamento) e devolve base64.
//  action 'pre_orcamento_concluido' → gera PDF do pré-orçamento + e-mail ao comercial (Resend), idempotente.
// PDF no SERVIDOR (pdf-lib, sem headless browser). Layout reproduz docs/mockups/orcamento-pdf.html
// (fonte Helvetica — pdf-lib não embute Inter sem bundlar a TTF). Variantes condicionais:
// completo / só serviço / só materiais / pré-orçamento (sem valores nem pagamento).
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
const env = (k: string, d = "") => Deno.env.get(k) || d

// Dados da empresa via EMPRESA_* (defaults = dados reais da TSRV, para o PDF já sair certo).
const EMP = {
  nome: env("EMPRESA_NOME", "Traders Service"),
  tagline: env("EMPRESA_TAGLINE", "Infraestrutura · Redes · Segurança Eletrônica"),
  razao: env("EMPRESA_RAZAO", "Traders Service Soluções em Tecnologia LTDA"),
  cnpj: env("EMPRESA_CNPJ", "10.923.494/0001-30"),
  ie: env("EMPRESA_IE", "255882904"),
  im: env("EMPRESA_IM", "96456"),
  endereco: env("EMPRESA_ENDERECO", "Rua Dona Francisca, 8300 — Via Trieste, Prédio 01/02"),
  endereco2: env("EMPRESA_ENDERECO2", "Perini Business Park · Joinville-SC · 89219-600"),
  telefone: env("EMPRESA_TELEFONE", "(47) 3025-2660"),
  email: env("EMPRESA_EMAIL", "comercial@tsrv.com.br"),
  cidade: env("EMPRESA_CIDADE", "Joinville-SC"),
  validade: env("EMPRESA_VALIDADE", "15 dias"),
}

const BRL = (n: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0)
const QTD = (n: number) => {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : v.toLocaleString("pt-BR", { maximumFractionDigits: 3 })
}
function fmtData(d: Date): string {
  const f = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(d)) p[part.type] = part.value
  return `${p.day}/${p.month}/${p.year}`
}
function fmtMinPdf(min?: number | null): string | null {
  const m = Number(min) || 0; if (m <= 0) return null
  const h = Math.floor(m / 60), mm = m % 60
  return h ? `${h}h${mm ? " " + mm + "min" : ""}` : `${mm}min`
}
// Sanitiza p/ a fonte WinAnsi (Helvetica do pdf-lib): acentos PT-BR (à-ÿ) passam intactos;
// aspas/traços "curvos" do teclado viram ASCII; emoji e qualquer coisa fora do Latin-1 some.
// Sem isso, um caractere fora do WinAnsi faz o pdf-lib LANÇAR e derruba o PDF inteiro.
function san(s: unknown): string {
  return String(s ?? "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•●▪]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "")
}

type Mat = { descricao: string; unidade?: string | null; quantidade: number; preco_unitario: number }
type DocData = {
  kind: "pre_orcamento" | "orcamento"
  numero: number | string
  emissao: string
  geradoPor: string
  cliente: { nome?: string | null; documento?: string | null; endereco?: string | null }
  servicoDescricao?: string | null
  servicoValor: number
  materiais: Mat[]
  prazoExecucao?: string | null
  condicaoPagamento?: string | null
  observacoes?: string | null
  // pré-orçamento: levantamento de campo (o PDF deve mostrar tudo que o técnico levantou)
  estimativa?: string | null
  tempoVisita?: string | null
  visita?: string | null
  deslocamento?: string | null
  fotos?: { bytes: Uint8Array; isPng: boolean }[]
}

async function buildPdf(d: DocData): Promise<Uint8Array> {
  const withPrice = d.kind === "orcamento"
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const W = 595.28, H = 841.89, ML = 45, XR = W - 45
  const navy = rgb(0.106, 0.165, 0.290), ink = rgb(0.114, 0.145, 0.200), gray = rgb(0.42, 0.447, 0.502)
  const line = rgb(0.898, 0.906, 0.922), lineSoft = rgb(0.945, 0.949, 0.957), card = rgb(0.965, 0.973, 0.984), white = rgb(1, 1, 1)

  let page = pdf.addPage([W, H])
  let y = H - 40
  const t = (s: unknown, x: number, yy: number, size: number, f = font, c = ink) => page.drawText(san(s), { x, y: yy, size, font: f, color: c })
  const wof = (s: unknown, size: number, f = font) => f.widthOfTextAtSize(san(s), size)
  const rt = (s: unknown, xr: number, yy: number, size: number, f = font, c = ink) => t(s, xr - wof(s, size, f), yy, size, f, c)
  const ct = (s: unknown, cx: number, yy: number, size: number, f = font, c = ink) => t(s, cx - wof(s, size, f) / 2, yy, size, f, c)
  const rect = (x: number, yy: number, w: number, h: number, c: ReturnType<typeof rgb>) => page.drawRectangle({ x, y: yy, width: w, height: h, color: c })
  const hr = (yy: number, c = line, th = 0.6) => page.drawLine({ start: { x: ML, y: yy }, end: { x: XR, y: yy }, thickness: th, color: c })
  const newPage = () => { page = pdf.addPage([W, H]); y = H - 40 }
  const ensure = (h: number) => { if (y - h < 46) newPage() }
  function wrap(s: unknown, size: number, maxW: number, f = font): string[] {
    const words = String(s ?? "").split(/\s+/), lines: string[] = []; let cur = ""
    for (const w of words) { const tt = cur ? cur + " " + w : w; if (wof(tt, size, f) <= maxW) cur = tt; else { if (cur) lines.push(cur); cur = w } }
    if (cur) lines.push(cur); return lines.length ? lines : [""]
  }
  const sh = (title: string) => { ensure(26); rect(ML, y - 6, 5, 5, navy); t(title, ML + 11, y - 5, 11.5, bold, ink); y -= 20 }

  // ── 1 · Cabeçalho ──
  const y0 = y
  rect(ML, y0 - 31, 31, 31, navy)
  ct("TS", ML + 15.5, y0 - 21, 13, bold, white)
  t(EMP.nome, ML + 41, y0 - 11, 15, bold, ink)
  t(EMP.tagline, ML + 41, y0 - 24, 8, font, gray)
  // bloco da empresa (direita)
  let fy = y0 - 6
  rt(EMP.razao, XR, fy, 8.5, bold, ink); fy -= 11
  rt(`CNPJ ${EMP.cnpj} · IE ${EMP.ie} · IM ${EMP.im}`, XR, fy, 8.5, font, gray); fy -= 11
  rt(EMP.endereco, XR, fy, 8.5, font, gray); fy -= 11
  rt(EMP.endereco2, XR, fy, 8.5, font, gray); fy -= 11
  rt(EMP.telefone, XR, fy, 8.5, font, gray); fy -= 11
  y = Math.min(y0 - 38, fy) - 6
  hr(y, navy, 1.8); y -= 22

  // ── 2 · Proposta ──
  t("Proposta Comercial", ML, y - 4, 25, bold, ink)
  rt(withPrice ? "ORÇAMENTO" : "PRÉ-ORÇAMENTO", XR, y + 6, 9, bold, gray)
  rt(`Nº ${d.numero}`, XR, y - 9, 18, bold, navy)
  y -= 30
  // meta
  const meta: Array<[string, string]> = [["Emissão", d.emissao]]
  if (withPrice) { meta.push(["Validade", EMP.validade]); if (d.prazoExecucao) meta.push(["Prazo de execução", d.prazoExecucao]) }
  let mx = ML
  for (const [k, v] of meta) {
    t(k.toUpperCase(), mx, y, 8, bold, gray)
    t(v, mx, y - 13, 11.5, bold, ink)
    mx += Math.max(110, wof(v, 11.5, bold) + 40)
  }
  y -= 28

  // ── 3 · Cliente ──
  hr(y, line); y -= 16
  t("CLIENTE", ML, y, 8, bold, gray)
  t(d.cliente.nome || "—", ML, y - 16, 15, bold, ink)
  let cy = y
  for (const c of [d.cliente.documento, d.cliente.endereco].filter(Boolean)) {
    for (const ln of wrap(c, 9, 240)) { rt(ln, XR, cy, 9, font, gray); cy -= 12 }
  }
  y -= 30

  const hasServico = !!(d.servicoDescricao && d.servicoDescricao.trim()) || (withPrice && d.servicoValor > 0)
  const hasMateriais = d.materiais.length > 0
  const totMat = d.materiais.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.preco_unitario) || 0), 0)

  // ── 4 · Escopo do serviço ──
  if (hasServico) {
    sh("Escopo do serviço")
    const descLines = wrap(d.servicoDescricao || "", 11, XR - ML - 28)
    const cardH = 14 + descLines.length * 15 + (withPrice ? 30 : 6)
    ensure(cardH + 6)
    rect(ML, y - cardH + 6, XR - ML, cardH, card)
    let sy = y - 8
    for (const ln of descLines) { t(ln, ML + 14, sy, 11, font, rgb(0.231, 0.247, 0.275)); sy -= 15 }
    if (withPrice) {
      sy -= 6; page.drawLine({ start: { x: ML + 14, y: sy + 6 }, end: { x: XR - 14, y: sy + 6 }, thickness: 0.6, color: line })
      t("VALOR DO SERVIÇO", ML + 14, sy - 6, 9, bold, gray)
      rt(BRL(d.servicoValor), XR - 14, sy - 8, 16, bold, ink)
      sy -= 22
    }
    y = sy - 12
  }

  // ── 5 · Materiais ──
  if (hasMateriais) {
    sh("Materiais")
    // colunas
    const totR = XR, vuR = XR - 78, qtdC = withPrice ? vuR - 55 : XR - 30, unC = withPrice ? qtdC - 48 : qtdC - 60
    const descMax = unC - 24 - ML
    t("DESCRIÇÃO", ML, y, 8, bold, gray)
    ct("UN.", unC, y, 8, bold, gray)
    ct("QTD", qtdC, y, 8, bold, gray)
    if (withPrice) { rt("VALOR UNIT.", vuR, y, 8, bold, gray); rt("TOTAL", totR, y, 8, bold, gray) }
    y -= 5; hr(y, line); y -= 14
    for (const m of d.materiais) {
      const lines = wrap(m.descricao || "—", 11, descMax)
      const rowH = Math.max(13, lines.length * 12)
      ensure(rowH + 4)
      let yy = y
      for (const ln of lines) { t(ln, ML, yy, 11, font, ink); yy -= 12 }
      ct(m.unidade || "—", unC, y, 11, font, gray)
      ct(QTD(m.quantidade), qtdC, y, 11, font, ink)
      if (withPrice) {
        rt(BRL(m.preco_unitario), vuR, y, 11, font, gray)
        rt(BRL((Number(m.quantidade) || 0) * (Number(m.preco_unitario) || 0)), totR, y, 11, bold, ink)
      }
      y -= rowH + 5; hr(y + 3, lineSoft)
    }
    y -= 10
  }

  // ── 5b · Levantamento (só pré-orçamento): estimativa, tempo da visita, deslocamento ──
  if (!withPrice && (d.estimativa || d.tempoVisita || d.visita || d.deslocamento)) {
    sh("Levantamento")
    const info: Array<[string, string]> = []
    if (d.estimativa) info.push(["Estimativa de execução", d.estimativa])
    if (d.visita) info.push(["Visita", d.visita])
    if (d.tempoVisita) info.push(["Tempo da visita", d.tempoVisita])
    if (d.deslocamento) info.push(["Deslocamento", d.deslocamento])
    for (const [k, v] of info) {
      ensure(18)
      t(k.toUpperCase(), ML, y, 8, bold, gray)
      for (const ln of wrap(v, 11, XR - ML - 190)) { t(ln, ML + 185, y, 11, font, ink); y -= 14 }
      y -= 4
    }
    y -= 6
  }

  // ── 5c · Observações (pré-orçamento; no orçamento sai no bloco de condições) ──
  if (!withPrice && d.observacoes && d.observacoes.trim()) {
    sh("Observações")
    for (const ln of wrap(d.observacoes, 11, XR - ML)) { ensure(15); t(ln, ML, y, 11, font, rgb(0.29, 0.31, 0.34)); y -= 14 }
    y -= 8
  }

  // ── 5d · Fotos (grade 2 colunas; foto inválida é pulada, nunca derruba o PDF) ──
  if (d.fotos && d.fotos.length) {
    sh("Fotos")
    const gap = 12, cols = 2, cellW = (XR - ML - gap) / cols
    const imgs: Array<{ emb: Awaited<ReturnType<typeof pdf.embedJpg>>; h: number }> = []
    for (const f of d.fotos) {
      try {
        const emb = f.isPng ? await pdf.embedPng(f.bytes) : await pdf.embedJpg(f.bytes)
        imgs.push({ emb, h: emb.height * (cellW / emb.width) })
      } catch (_) { /* foto inválida: pula */ }
    }
    for (let i = 0; i < imgs.length; i += cols) {
      const pair = imgs.slice(i, i + cols)
      const rowH = Math.max(...pair.map(p => p.h))
      ensure(rowH + gap)
      pair.forEach((p, c) => { page.drawImage(p.emb, { x: ML + c * (cellW + gap), y: y - p.h, width: cellW, height: p.h }) })
      y -= rowH + gap
    }
  }

  // ── 6 · Resumo financeiro (só orçamento) ──
  if (withPrice) {
    ensure(96)
    const boxW = 250, bx = XR - boxW
    const rowsRes: Array<[string, string, boolean]> = []
    if (hasServico && hasMateriais) {
      rowsRes.push(["Subtotal · Serviços", BRL(d.servicoValor), false])
      rowsRes.push(["Subtotal · Materiais", BRL(totMat), false])
    }
    for (const [k, v, soft] of rowsRes) {
      t(k, bx, y, 11, font, gray)
      rt(v, XR, y, 11, soft ? font : bold, soft ? gray : ink)
      y -= 18
    }
    y -= 2
    rect(bx, y - 26, boxW, 32, navy)
    t("TOTAL GERAL", bx + 14, y - 8, 10, bold, rgb(0.78, 0.82, 0.88))
    rt(BRL(d.servicoValor + totMat), XR - 14, y - 11, 18, bold, white)
    y -= 40
  }

  // ── 7 · Condições comerciais + Observações (só orçamento) ──
  if (withPrice && (d.condicaoPagamento || d.observacoes)) {
    ensure(70)
    const colW = (XR - ML - 30) / 2, rightX = ML + colW + 30
    const topY = y
    // esquerda
    rect(ML, y - 6, 5, 5, navy); t("Condições comerciais", ML + 11, y - 5, 11.5, bold, ink)
    let ly = y - 24
    const trow = (k: string, v: string) => { t(k, ML, ly, 11, font, gray); rt(v, ML + colW, ly, 11, bold, ink); page.drawLine({ start: { x: ML, y: ly - 8 }, end: { x: ML + colW, y: ly - 8 }, thickness: 0.6, color: lineSoft }); ly -= 22 }
    if (d.condicaoPagamento) trow("Forma de pagamento", d.condicaoPagamento)
    trow("Valor", BRL(d.servicoValor + totMat))
    // direita
    rect(rightX, topY - 6, 5, 5, navy); t("Observações", rightX + 11, topY - 5, 11.5, bold, ink)
    let oy = topY - 24
    for (const ln of wrap(d.observacoes || "—", 11, colW)) { t(ln, rightX, oy, 11, font, rgb(0.29, 0.31, 0.34)); oy -= 14 }
    y = Math.min(ly, oy) - 6
  }

  // ── 8 · Rodapé (todas as páginas) ──
  const pages = pdf.getPages()
  const left = `${EMP.nome} · ${EMP.telefone} · ${EMP.email} · ${EMP.cidade}`
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: ML, y: 34 }, end: { x: XR, y: 34 }, thickness: 0.6, color: line })
    p.drawText(san(left), { x: ML, y: 22, size: 8, font, color: gray })
    const r = `Gerado em ${d.emissao} por ${d.geradoPor} · Página ${i + 1} de ${pages.length}`
    p.drawText(san(r), { x: XR - font.widthOfTextAtSize(san(r), 8), y: 22, size: 8, font, color: gray })
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

    let docData: DocData
    let preorcRow: { numero: number; email_comercial_em?: string | null } | null = null

    if (tipo === "pre_orcamento") {
      const { data: po } = await admin.from("pre_orcamentos").select("*").eq("id", id).single()
      if (!po) return json({ error: "pré-orçamento não encontrado" }, 404)
      const ownerOk = role === "tecnico_campo" && po.tecnico_id === uid
      if (!isOffice && !ownerOk) return json({ error: "sem permissão" }, 403)
      const { data: itens } = await admin.from("pre_orcamento_itens").select("*").eq("pre_orcamento_id", id).order("criado_em")
      const cli = po.cliente_id ? (await admin.from("clientes").select("nome,documento,endereco").eq("id", po.cliente_id).single()).data : null
      preorcRow = po
      // Levantamento de campo (respostas jsonb): estimativa, deslocamento; + tempo da visita.
      const r = (po.respostas || {}) as Record<string, unknown>
      const est = (r.estimativa || null) as { tecnicos?: number; qtd?: number; unidade?: string } | null
      const estTxt = est && ((est.tecnicos || 0) > 0 && (est.qtd || 0) > 0)
        ? `${est.tecnicos} ${(est.tecnicos || 0) > 1 ? "técnicos" : "técnico"} × ${est.qtd} ${est.unidade === "horas" ? ((est.qtd || 0) > 1 ? "horas" : "hora") : ((est.qtd || 0) > 1 ? "dias" : "dia")}`
        : null
      const deslocTxt = r.deslocamento === "Sim"
        ? `Sim · ida ${r.ida || "—"}, retorno ${r.retorno || "—"}`
        : r.deslocamento === "Não" ? "Não" : null
      const visitaTxt = (r.visita_inicio || r.visita_termino)
        ? `${r.visita_inicio || "—"}–${r.visita_termino || "—"}` : null
      // Fotos: baixa do Storage (rat-anexos, privado) via service role. Falha de uma foto é ignorada.
      const fotos: { bytes: Uint8Array; isPng: boolean }[] = []
      const { data: fotosRows } = await admin.from("relatorio_fotos").select("url,criado_em").eq("pre_orcamento_id", id).order("criado_em")
      for (const fr of (fotosRows || []).slice(0, 16)) {
        let path = (fr as { url?: string }).url || ""
        if (!path) continue
        if (path.includes("/object/")) path = path.replace(/^.*\/(?:sign|public|authenticated)\/rat-anexos\//, "").split("?")[0]
        try {
          const dl = await admin.storage.from("rat-anexos").download(path)
          if (dl.data) fotos.push({ bytes: new Uint8Array(await dl.data.arrayBuffer()), isPng: /\.png$/i.test(path) })
        } catch (_) { /* foto indisponível: pula */ }
      }
      docData = {
        kind: "pre_orcamento", numero: po.numero, emissao: fmtData(po.criado_em ? new Date(po.criado_em) : new Date()), geradoPor,
        cliente: { nome: po.cliente_nome || cli?.nome, documento: cli?.documento, endereco: cli?.endereco },
        servicoDescricao: po.descricao, servicoValor: 0,
        materiais: (itens || []).map((m: Mat & { codigo_produto?: string }) => ({
          descricao: m.descricao || (m as { codigo_produto?: string }).codigo_produto || "—",
          unidade: m.unidade, quantidade: Number(m.quantidade) || 0, preco_unitario: 0,
        })),
        estimativa: estTxt, tempoVisita: fmtMinPdf(po.tempo_trabalhado), visita: visitaTxt, deslocamento: deslocTxt,
        observacoes: (r.observacoes as string) || null,
        fotos,
      }
    } else if (tipo === "orcamento") {
      if (!isOffice) return json({ error: "apenas escritório" }, 403)
      const { data: o } = await admin.from("orcamentos").select("*").eq("id", id).single()
      if (!o) return json({ error: "orçamento não encontrado" }, 404)
      const { data: itens } = await admin.from("orcamento_itens").select("*").eq("orcamento_id", id).order("criado_em")
      const cli = o.cliente_id ? (await admin.from("clientes").select("nome,documento,endereco").eq("id", o.cliente_id).single()).data : null
      docData = {
        kind: "orcamento", numero: o.numero, emissao: fmtData(o.data_envio ? new Date(o.data_envio) : (o.criado_em ? new Date(o.criado_em) : new Date())), geradoPor,
        cliente: { nome: cli?.nome, documento: cli?.documento, endereco: cli?.endereco },
        servicoDescricao: o.servico_descricao, servicoValor: Number(o.servico_valor) || 0,
        materiais: (itens || []).filter((i: { tipo: string }) => i.tipo === "material" || i.tipo === "avulso")
          .map((m: Mat) => ({ descricao: m.descricao || "—", unidade: m.unidade, quantidade: Number(m.quantidade) || 0, preco_unitario: Number(m.preco_unitario) || 0 })),
        prazoExecucao: o.prazo_execucao, condicaoPagamento: o.condicao_pagamento, observacoes: o.observacoes,
      }
    } else {
      return json({ error: "tipo inválido (pre_orcamento|orcamento)" }, 400)
    }

    const pdfBytes = await buildPdf(docData)
    const b64 = encodeBase64(pdfBytes)
    const filename = `${docData.kind === "orcamento" ? "Orcamento" : "Pre-Orcamento"}_${docData.numero}.pdf`

    if (action === "pdf") return json({ ok: true, filename, base64: b64 })

    if (action === "pre_orcamento_concluido") {
      if (preorcRow?.email_comercial_em) return json({ ok: true, already: true, filename })
      const to = Deno.env.get("PREORC_EMAIL_TO") || "comercial@tsrv.com.br"
      const html = `<p>Novo pré-orçamento concluído em campo.</p>
        <p><strong>Nº ${docData.numero}</strong> — Cliente: ${docData.cliente.nome || "—"}<br>
        Técnico: ${geradoPor} · ${docData.emissao}</p>
        <p>PDF em anexo.</p>`
      const r = await enviarEmail(to, `Pré-Orçamento Nº ${docData.numero} — ${docData.cliente.nome || ""}`.trim(), html, { filename, content: b64 })
      if (r.ok) {
        await admin.from("pre_orcamentos").update({ email_comercial_em: new Date().toISOString() }).eq("id", id)
        return json({ ok: true, email: "enviado", id: r.id, filename })
      }
      return json({ ok: true, email: "falhou", reason: r.reason, filename })
    }

    return json({ error: "action inválida (pdf|pre_orcamento_concluido)" }, 400)
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
