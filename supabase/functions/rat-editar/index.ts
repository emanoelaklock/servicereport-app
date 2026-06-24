// Edge Function: rat-editar
// Edição de RAT preenchida, SÓ pelo ADMIN (não gestor, não comercial), com AUDITORIA e RESTORE.
// Impõe a segurança no SERVIDOR (não só na UI): checa app_role()='admin' via portal_acessos.
//
// Dois modos:
//  A) editar  → body { rat_id, motivo, alteracoes:[{alvo,operacao,chave,campo,valor_novo}] }
//  B) restaurar → body { restaurar_id }   (id de uma linha de rat_edicoes; reaplica o inverso)
//
// Regras:
//  - Tarefa já com OS no Omie (status 'aprovada_faturamento' ou 'faturada') → BLOQUEIA alterações
//    FINANCEIRAS (técnicos, produtos, horários) pra não divergir do documento fiscal já emitido.
//    Campos NÃO-financeiros (serviço executado, observações, situação, fotos) seguem editáveis.
//  - motivo é 1 por LOTE (gravado igual em todas as linhas do save). Obrigatório.
//  - Cada alteração vira uma linha em rat_edicoes (valor_antigo p/ restaurar; nunca apaga rastro).
//  - Recalcula rats.tempo_trabalhado a partir das respostas (mesma fórmula do §8.1) e marca
//    rats.ajustada_gestao. As horas da Jornada e a conciliação recalculam ao vivo (views).
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const MOTIVOS = ["esquecimento_tecnico", "completacao", "mudanca_processo", "pedido_cliente", "outro"]
const FATURADO_LOCK = ["aprovada_faturamento", "faturada"]   // tem OS no Omie → trava o financeiro
const TIME_FIELDS = ["hora_inicio", "hora_termino", "desloc_inicial_ida", "desloc_final_ida",
  "desloc_inicial_retorno", "desloc_final_retorno", "almoco_inicio", "almoco_termino",
  "pausa_inicio", "pausa_termino"]

const mm = (s: string | null) => { if (!s) return null; const p = String(s).slice(0, 5).split(":"); const h = +p[0], i = +p[1]; return (isNaN(h) || isNaN(i)) ? null : h * 60 + i }
const dur = (a: string | null, b: string | null) => { const x = mm(a), y = mm(b); if (x == null || y == null) return 0; let d = y - x; if (d < 0) d += 1440; return d }
// Tempo trabalhado (min) — ESPELHA rat-view.calcTempoDe (mesma regra do app do técnico).
// NOVO: execução + ida + retorno (que existiram) − almoço − pausa.
// LEGADO (só a chave `deslocamento`): janela única ida_inicial→retorno_final − almoço − pausa
//   (a execução já está DENTRO da janela; NÃO somar exec por cima). Retorna null se não dá pra
//   calcular (aí o chamador preserva o tempo_trabalhado atual).
function calcTempo(r: Record<string, any>): number | null {
  r = r || {}
  const alm = dur(r.almoco_inicio, r.almoco_termino), pau = dur(r.pausa_inicio, r.pausa_termino)
  const temNovo = (r.desloc_ida != null && r.desloc_ida !== "") || (r.desloc_retorno != null && r.desloc_retorno !== "")
  if (temNovo) {
    const exec = (r.hora_inicio && r.hora_termino) ? dur(r.hora_inicio, r.hora_termino) : 0
    const ida = r.desloc_ida === "Sim" ? dur(r.desloc_inicial_ida, r.desloc_final_ida) : 0
    const ret = r.desloc_retorno === "Sim" ? dur(r.desloc_inicial_retorno, r.desloc_final_retorno) : 0
    if (!r.hora_inicio && !ida && !ret) return null
    const t = exec + ida + ret - alm - pau
    return t < 0 ? 0 : t
  }
  let ini: string | null, fim: string | null
  if (r.deslocamento === "Sim") { ini = r.desloc_inicial_ida; fim = r.desloc_final_retorno }
  else { ini = r.hora_inicio; fim = r.hora_termino }
  const a = mm(ini), b = mm(fim)
  if (a == null || b == null) return null
  let bruto = b - a; if (bruto < 0) bruto += 1440
  const t = bruto - alm - pau
  return t < 0 ? 0 : t
}
const ehFinanceira = (a: { alvo: string, campo?: string }) =>
  a.alvo === "tecnico" || a.alvo === "produto" || (a.alvo === "campo" && TIME_FIELDS.includes(a.campo || ""))

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

    // SÓ ADMIN — mesma fonte do app_role() (portal_acessos.role_chave do service_report).
    const { data: pa } = await admin.from("portal_acessos").select("role_chave")
      .eq("usuario_id", uid).eq("app_chave", "service_report").maybeSingle()
    if ((pa?.role_chave || "") !== "admin") return json({ error: "apenas administrador pode editar RATs" }, 403)
    const { data: prof } = await admin.from("usuarios").select("nome").eq("id", uid).maybeSingle()
    const atorNome = prof?.nome || null

    const body = await req.json().catch(() => ({}))

    // ───────────────── B) RESTAURAR ─────────────────
    if (body.restaurar_id) {
      const { data: ed } = await admin.from("rat_edicoes").select("*").eq("id", body.restaurar_id).maybeSingle()
      if (!ed) return json({ error: "edição não encontrada" }, 404)
      const log = await aplicarRestore(admin, ed)
      await admin.from("rat_edicoes").insert({
        rat_id: ed.rat_id, tarefa_id: ed.tarefa_id, alvo: ed.alvo, operacao: "restore",
        chave: ed.chave, campo: ed.campo, valor_antigo: ed.valor_novo, valor_novo: ed.valor_antigo,
        motivo: ed.motivo, ator: uid, ator_nome: atorNome,
      })
      await recalcTempoEMarca(admin, ed.rat_id, uid)
      return json({ ok: true, restaurado: log })
    }

    // ───────────────── A) EDITAR (lote) ─────────────────
    const ratId = body.rat_id
    const motivo = body.motivo
    const alteracoes = Array.isArray(body.alteracoes) ? body.alteracoes : []
    if (!ratId) return json({ error: "rat_id obrigatorio" }, 400)
    if (!MOTIVOS.includes(motivo)) return json({ error: "motivo obrigatorio e válido" }, 400)
    if (!alteracoes.length) return json({ error: "nada a alterar" }, 400)

    const { data: rat } = await admin.from("rats")
      .select("id,tarefa_id,respostas,tarefa:tarefas(status)").eq("id", ratId).maybeSingle()
    if (!rat) return json({ error: "RAT não encontrada" }, 404)
    const tarefaStatus = (rat as any).tarefa?.status || ""
    const travado = FATURADO_LOCK.includes(tarefaStatus)
    if (travado && alteracoes.some(ehFinanceira)) {
      return json({ error: `Tarefa ${tarefaStatus === "faturada" ? "faturada" : "aprovada p/ faturamento"} — não dá pra editar técnicos, produtos ou horários (mudaria o valor já no Omie). Só campos não-financeiros (serviço, observações, fotos).` }, 409)
    }

    const respostas = Object.assign({}, (rat as any).respostas || {})
    let mexeuResp = false, mexeuTec = false
    const logs: any[] = []

    for (const a of alteracoes) {
      if (a.alvo === "campo") {
        const antigo = respostas[a.campo] ?? null
        respostas[a.campo] = a.valor_novo
        mexeuResp = true
        logs.push({ alvo: "campo", operacao: "update", chave: a.campo, campo: a.campo, valor_antigo: antigo, valor_novo: a.valor_novo })
      } else if (a.alvo === "tecnico" && a.operacao === "insert") {
        await admin.from("rat_tecnicos").upsert({ rat_id: ratId, tecnico_id: a.chave, inicio: a.valor_novo?.inicio || null, fim: a.valor_novo?.fim || null }, { onConflict: "rat_id,tecnico_id" })
        mexeuTec = true
        logs.push({ alvo: "tecnico", operacao: "insert", chave: a.chave, valor_antigo: null, valor_novo: a.valor_novo || { tecnico_id: a.chave } })
      } else if (a.alvo === "tecnico" && a.operacao === "delete") {
        const { data: cur } = await admin.from("rat_tecnicos").select("tecnico_id,inicio,fim").eq("rat_id", ratId).eq("tecnico_id", a.chave).maybeSingle()
        await admin.from("rat_tecnicos").delete().eq("rat_id", ratId).eq("tecnico_id", a.chave)
        mexeuTec = true
        logs.push({ alvo: "tecnico", operacao: "delete", chave: a.chave, valor_antigo: cur || { tecnico_id: a.chave }, valor_novo: null })
      } else if (a.alvo === "produto" && a.operacao === "insert") {
        const row = { rat_id: ratId, origem: "usado", produto_id: a.valor_novo?.produto_id || null, codigo_produto: a.valor_novo?.codigo_produto || null, descricao: a.valor_novo?.descricao || null, quantidade: Number(a.valor_novo?.quantidade) || 0, preco_unitario: a.valor_novo?.preco_unitario != null ? Number(a.valor_novo.preco_unitario) : null }
        const { data: ins } = await admin.from("materiais").insert(row).select("id").single()
        logs.push({ alvo: "produto", operacao: "insert", chave: ins?.id || null, valor_antigo: null, valor_novo: { ...row, id: ins?.id } })
      } else if (a.alvo === "produto" && a.operacao === "update") {
        const { data: cur } = await admin.from("materiais").select("quantidade,preco_unitario,descricao").eq("id", a.chave).maybeSingle()
        const patch: any = {}
        if (a.valor_novo?.quantidade != null) patch.quantidade = Number(a.valor_novo.quantidade)
        if (a.valor_novo?.preco_unitario != null) patch.preco_unitario = Number(a.valor_novo.preco_unitario)
        await admin.from("materiais").update(patch).eq("id", a.chave)
        logs.push({ alvo: "produto", operacao: "update", chave: a.chave, valor_antigo: cur, valor_novo: patch })
      } else if (a.alvo === "produto" && a.operacao === "delete") {
        const { data: cur } = await admin.from("materiais").select("*").eq("id", a.chave).maybeSingle()
        await admin.from("materiais").delete().eq("id", a.chave)
        logs.push({ alvo: "produto", operacao: "delete", chave: a.chave, valor_antigo: cur, valor_novo: null })
      } else if (a.alvo === "foto" && a.operacao === "insert") {
        // front sobe a imagem no storage e manda { url, legenda }; aqui só insere a linha.
        const row = { rat_id: ratId, url: a.valor_novo?.url, legenda: a.valor_novo?.legenda || null }
        const { data: ins } = await admin.from("relatorio_fotos").insert(row).select("id").single()
        logs.push({ alvo: "foto", operacao: "insert", chave: ins?.id || null, valor_antigo: null, valor_novo: { ...row, id: ins?.id } })
      } else if (a.alvo === "foto" && a.operacao === "delete") {
        const { data: cur } = await admin.from("relatorio_fotos").select("*").eq("id", a.chave).maybeSingle()
        await admin.from("relatorio_fotos").delete().eq("id", a.chave)   // remove só a linha; o objeto no storage fica (restore re-insere)
        logs.push({ alvo: "foto", operacao: "delete", chave: a.chave, valor_antigo: cur, valor_novo: null })
      } else if (a.alvo === "foto" && a.operacao === "update") {
        const { data: cur } = await admin.from("relatorio_fotos").select("legenda").eq("id", a.chave).maybeSingle()
        await admin.from("relatorio_fotos").update({ legenda: a.valor_novo?.legenda ?? null }).eq("id", a.chave)
        logs.push({ alvo: "foto", operacao: "update", chave: a.chave, campo: "legenda", valor_antigo: cur?.legenda ?? null, valor_novo: a.valor_novo?.legenda ?? null })
      } else {
        return json({ error: "alteração inválida: " + JSON.stringify(a) }, 400)
      }
    }

    // técnicos mudaram → re-sincroniza o nome exibido (respostas.tecnicos_responsaveis)
    if (mexeuTec) {
      const { data: rts } = await admin.from("rat_tecnicos").select("tecnico_id").eq("rat_id", ratId)
      const ids = (rts || []).map((x: any) => x.tecnico_id)
      if (ids.length) {
        const { data: us } = await admin.from("usuarios").select("id,nome").in("id", ids)
        respostas.tecnicos_responsaveis = (us || []).map((u: any) => u.nome).filter(Boolean).join(", ")
      } else respostas.tecnicos_responsaveis = ""
      mexeuResp = true
    }

    // grava respostas + tempo recalculado + marca de ajuste (uma vez).
    // tempo só é sobrescrito quando dá pra calcular (null = preserva o atual).
    if (mexeuResp) {
      const tt = calcTempo(respostas)
      const patch: any = { respostas, ajustada_gestao: true, ajustada_por: uid, ajustada_em: new Date().toISOString() }
      if (tt != null) patch.tempo_trabalhado = tt
      await admin.from("rats").update(patch).eq("id", ratId)
    } else {
      await admin.from("rats").update({ ajustada_gestao: true, ajustada_por: uid, ajustada_em: new Date().toISOString() }).eq("id", ratId)
    }

    // auditoria — uma linha por alteração, com o MESMO motivo (1 por lote)
    if (logs.length) {
      await admin.from("rat_edicoes").insert(logs.map(l => ({
        rat_id: ratId, tarefa_id: (rat as any).tarefa_id, alvo: l.alvo, operacao: l.operacao,
        chave: l.chave != null ? String(l.chave) : null, campo: l.campo || null,
        valor_antigo: l.valor_antigo ?? null, valor_novo: l.valor_novo ?? null,
        motivo, ator: uid, ator_nome: atorNome,
      })))
    }

    return json({ ok: true, alteracoes: logs.length })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})

// Reaplica o INVERSO de uma edição (restore). Cobre os 3 casos.
async function aplicarRestore(admin: any, ed: any) {
  if (ed.operacao === "update" && ed.alvo === "campo") {
    const { data: r } = await admin.from("rats").select("respostas").eq("id", ed.rat_id).maybeSingle()
    const resp = Object.assign({}, r?.respostas || {}); resp[ed.campo] = ed.valor_antigo
    await admin.from("rats").update({ respostas: resp }).eq("id", ed.rat_id)
    return "campo:" + ed.campo
  }
  if (ed.alvo === "tecnico") {
    if (ed.operacao === "delete") { const v = ed.valor_antigo || {}; await admin.from("rat_tecnicos").upsert({ rat_id: ed.rat_id, tecnico_id: v.tecnico_id || ed.chave, inicio: v.inicio || null, fim: v.fim || null }, { onConflict: "rat_id,tecnico_id" }); return "tecnico re-inserido" }
    if (ed.operacao === "insert") { await admin.from("rat_tecnicos").delete().eq("rat_id", ed.rat_id).eq("tecnico_id", ed.chave); return "tecnico removido" }
  }
  if (ed.alvo === "produto") {
    if (ed.operacao === "delete") { const v = ed.valor_antigo || {}; await admin.from("materiais").insert({ id: v.id, rat_id: ed.rat_id, origem: v.origem || "usado", produto_id: v.produto_id || null, codigo_produto: v.codigo_produto || null, descricao: v.descricao || null, quantidade: v.quantidade || 0, preco_unitario: v.preco_unitario ?? null }); return "produto re-inserido" }
    if (ed.operacao === "insert") { await admin.from("materiais").delete().eq("id", ed.chave); return "produto removido" }
    if (ed.operacao === "update") { await admin.from("materiais").update({ quantidade: ed.valor_antigo?.quantidade, preco_unitario: ed.valor_antigo?.preco_unitario }).eq("id", ed.chave); return "produto revertido" }
  }
  if (ed.alvo === "foto") {
    if (ed.operacao === "delete") { const v = ed.valor_antigo || {}; await admin.from("relatorio_fotos").insert({ id: v.id, rat_id: ed.rat_id, url: v.url, legenda: v.legenda || null }); return "foto re-inserida" }
    if (ed.operacao === "insert") { await admin.from("relatorio_fotos").delete().eq("id", ed.chave); return "foto removida" }
    if (ed.operacao === "update") { await admin.from("relatorio_fotos").update({ legenda: ed.valor_antigo }).eq("id", ed.chave); return "legenda revertida" }
  }
  return "nada"
}

// Recalcula tempo_trabalhado da RAT (após restore que mexa em respostas) e mantém a marca.
async function recalcTempoEMarca(admin: any, ratId: string, uid: string) {
  const { data: r } = await admin.from("rats").select("respostas").eq("id", ratId).maybeSingle()
  const tt = calcTempo((r?.respostas) || {})
  const patch: any = { ajustada_gestao: true, ajustada_por: uid, ajustada_em: new Date().toISOString() }
  if (tt != null) patch.tempo_trabalhado = tt
  await admin.from("rats").update(patch).eq("id", ratId)
}
