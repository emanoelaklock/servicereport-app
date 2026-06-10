// Edge Function: melhorar-texto
// Reescreve o texto do técnico (RAT) em português correto e profissional,
// usando Claude Haiku 4.5 (Anthropic). A chave da API fica em
// public.app_secrets (chave 'anthropic_api_key') — nunca vai ao aparelho.
// Qualquer usuário autenticado pode chamar; o texto volta para PRÉVIA no app
// (o técnico decide usar ou manter o original).
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import Anthropic from "npm:@anthropic-ai/sdk"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const SYSTEM = `Você revisa textos escritos por técnicos de campo em relatórios de atendimento técnico (RATs) de uma empresa brasileira.
Reescreva o texto do técnico em português correto e profissional, em tom técnico e objetivo.
Regras:
- NÃO invente fatos, medidas, produtos, causas ou conclusões que não estejam no texto original.
- Preserve termos técnicos, códigos, seriais, quantidades e unidades exatamente como foram escritos.
- Corrija ortografia, gramática, pontuação e a organização das frases.
- Se o texto descrever várias ações ou etapas, organize em frases curtas (uma por linha quando fizer sentido).
- Mantenha o texto conciso; não adicione introduções, despedidas nem comentários.
Responda APENAS com o texto reescrito, sem aspas e sem explicações.`

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const url = Deno.env.get("SUPABASE_URL")!
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    const admin = createClient(url, service, { auth: { persistSession: false } })

    // Só usuários autenticados do app
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "")
    const { data: ud, error: uerr } = await admin.auth.getUser(token)
    if (uerr || !ud?.user) return json({ error: "nao autenticado" }, 401)

    const body = await req.json()
    const texto = String(body?.texto || "").trim()
    if (!texto) return json({ error: "texto vazio" }, 400)
    if (texto.length > 4000) return json({ error: "texto muito longo (máx. 4000 caracteres)" }, 400)

    const { data: sec } = await admin.from("app_secrets").select("valor").eq("chave", "anthropic_api_key").maybeSingle()
    const apiKey = sec?.valor
    if (!apiKey) return json({ error: "IA não configurada (falta app_secrets.anthropic_api_key)" }, 500)

    const anthropic = new Anthropic({ apiKey })
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: texto }],
    })
    const out = msg.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("")
      .trim()
    if (!out) return json({ error: "a IA não retornou texto" }, 502)
    return json({ texto: out })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
