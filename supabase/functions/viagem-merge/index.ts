// Edge Function: viagem-merge
// Finalização COLABORATIVA da viagem (deslocamento modelo novo: pai + trechos).
// Qualquer técnico A BORDO (não só quem criou) pode lançar/finalizar a viagem. O RLS de
// `deslocamentos` só deixa o criador gravar; por isso a escrita do app passa por aqui, com
// service role, depois de autorizar que o chamador está a bordo (ou é o criador / escritório).
//
// MERGE POR UNIÃO (mesmo espírito da RAT colaborativa):
//  - trechos casados por `id`; campo vazio no servidor é preenchido com o que veio do aparelho;
//  - HORAS (saída/chegada/refeição): se os dois lados têm valor DIFERENTE → mantém o do servidor
//    e REGISTRA o conflito em deslocamentos.conflito pro admin — nunca sobrescreve em silêncio;
//  - demais campos do trecho (rota/veículo/GPS): correção livre (o último a finalizar vence);
//  - `criado_por` é PRESERVADO (quem está a bordo nunca "rouba" a dona da viagem);
//  - o conjunto/ordem dos trechos é o do aparelho que finalizou; trecho do servidor que sumiu do
//    roteiro e tinha hora lançada vira conflito antes de ser removido (cascade limpa as sub-tabelas).
//
// Sub-tabelas (a-bordo / tarefas / almoço): UNIÃO (só acrescenta; não remove no v1).
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const OFFICE = ["admin", "gestor_axis"]
// Horas: divergência = conflito (mantém servidor).
const TS_FIELDS = ["saida_em", "chegada_em"]               // timestamptz
const HORA_FIELDS = ["almoco_inicio", "almoco_fim"]        // time (HH:MM)
// Demais campos do trecho: correção livre (incoming vence quando presente).
const LIVRE_FIELDS = [
  "origem", "destino", "destino_local_id", "destino_cliente_id", "tarefa_id", "data",
  "veiculo_id", "nota_transporte",
  "saida_lat", "saida_lng", "saida_precisao", "chegada_lat", "chegada_lng", "chegada_precisao",
]

const eqTs = (a: string | null, b: string | null) =>
  (!a && !b) || (!!a && !!b && new Date(a).getTime() === new Date(b).getTime())
const eqHora = (a: string | null, b: string | null) => {
  const h = (x: string | null) => (x ? String(x).slice(0, 5) : "")
  return h(a) === h(b)
}
// Re-ancoragem: mesma hora de relógio em dias diferentes (múltiplo exato de 24h).
// Brasil sem DST desde 2019 — offset fixo -03:00 dá o dia local sem dependências.
const mesmoRelogio = (a: string, b: string) => {
  const d = (new Date(a).getTime() - new Date(b).getTime()) % 86400000
  return ((d + 86400000) % 86400000) === 0
}
const diaLocalBR = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10)
const diaMais1 = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
// chave de um conflito p/ dedup (retry do aparelho não pode re-empilhar a mesma divergência)
const chaveConflito = (c: any) => {
  const norm = (v: unknown) => {
    if (v == null) return ""
    if (typeof v === "object") return JSON.stringify(v)
    const d = new Date(String(v))
    return isNaN(d.getTime()) ? String(v).slice(0, 5) : String(d.getTime())
  }
  return `${c.trecho_ordem}|${c.campo}|${norm(c.servidor)}|${norm(c.recebido)}`
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
    const { data: prof } = await admin.from("usuarios").select("role").eq("id", uid).single()
    const office = OFFICE.includes(prof?.role || "")

    const body = await req.json().catch(() => ({}))
    const trip = body.trip || body
    if (!trip?.id) return json({ error: "id da viagem obrigatorio" }, 400)
    const incoming = Array.isArray(trip.trechos) ? trip.trechos : []
    if (!incoming.length) return json({ error: "viagem sem trechos" }, 400)

    // ---- carrega a viagem existente + autoriza ----
    const { data: ex } = await admin.from("deslocamentos")
      .select("id,criado_por,conflito").eq("id", trip.id).maybeSingle()
    const isNew = !ex

    if (!isNew && !office && uid !== ex!.criado_por) {
      const { data: ab } = await admin.from("deslocamento_tecnicos")
        .select("tecnico_id").eq("deslocamento_id", trip.id).eq("tecnico_id", uid).maybeSingle()
      let aboard = !!ab
      if (!aboard) {
        const { data: ab2 } = await admin.from("trecho_tecnicos")
          .select("tecnico_id, deslocamento_trechos!inner(deslocamento_id)")
          .eq("tecnico_id", uid).eq("deslocamento_trechos.deslocamento_id", trip.id).maybeSingle()
        aboard = !!ab2
      }
      if (!aboard) return json({ error: "sem permissao: voce nao esta a bordo desta viagem" }, 403)
    }
    const criadoPor = isNew ? uid : ex!.criado_por

    // ---- snapshot dos trechos do servidor (antes de qualquer escrita) ----
    const { data: exTrechosRaw } = await admin.from("deslocamento_trechos")
      .select("id,ordem," + [...TS_FIELDS, ...HORA_FIELDS, ...LIVRE_FIELDS].join(","))
      .eq("deslocamento_id", trip.id)
    const exTrechos = exTrechosRaw || []
    const exById = new Map<string, any>(exTrechos.map((t: any) => [t.id, t]))
    const incomingIds = new Set(incoming.map((t: any) => t.id))

    const conflitos: any[] = []
    const nowISO = new Date().toISOString()

    // ---- pai: upsert preservando criado_por ----
    const upParent = await admin.from("deslocamentos").upsert({
      id: trip.id, sentido: "outro", cliente_id: trip.cliente_id || null,
      motivo: trip.motivo || null, observacoes: trip.observacoes || null, criado_por: criadoPor,
    }, { onConflict: "id" })
    if (upParent.error) return json({ error: "falha no pai: " + upParent.error.message }, 500)

    // ---- trecho do servidor que SUMIU do roteiro: vira conflito se tinha hora, depois é removido ----
    const orfaos = exTrechos.filter((t: any) => !incomingIds.has(t.id))
    for (const t of orfaos) {
      if (t.saida_em || t.chegada_em) {
        conflitos.push({
          trecho_ordem: t.ordem, campo: "trecho_removido",
          servidor: { saida_em: t.saida_em || null, chegada_em: t.chegada_em || null },
          recebido: null, por: uid, em: nowISO,
        })
      }
    }
    if (orfaos.length) {
      const del = await admin.from("deslocamento_trechos").delete()
        .in("id", orfaos.map((t: any) => t.id))
      if (del.error) return json({ error: "falha ao remover trecho: " + del.error.message }, 500)
    }

    // ---- libera o espaço de `ordem` (UNIQUE deslocamento_id,ordem) p/ permitir reordenação ----
    const sobreviventes = exTrechos.filter((t: any) => incomingIds.has(t.id))
    if (sobreviventes.length) {
      for (const t of sobreviventes) {
        const b = await admin.from("deslocamento_trechos")
          .update({ ordem: (t.ordem || 0) + 1000 }).eq("id", t.id)
        if (b.error) return json({ error: "falha ao reordenar: " + b.error.message }, 500)
      }
    }

    // ---- merge + upsert dos trechos do roteiro recebido ----
    for (let i = 0; i < incoming.length; i++) {
      const t = incoming[i]
      const cur = exById.get(t.id)
      const row: any = { id: t.id, deslocamento_id: trip.id, ordem: t.ordem || (i + 1) }

      // limpeza EXPLÍCITA declarada pelo app (t._limpar): distingue "limpei o campo" de
      // "não mexi" — sem isso, null incoming é no-op e a limpeza reverte no pull.
      // Só campos livre/hora são limpáveis (saída/chegada não têm fluxo de limpeza no app).
      const limpa = new Set<string>((Array.isArray(t._limpar) ? t._limpar : [])
        .filter((x: unknown) => typeof x === "string" && ([...HORA_FIELDS, ...LIVRE_FIELDS] as string[]).includes(x as string)))

      if (!cur) {
        for (const f of [...TS_FIELDS, ...HORA_FIELDS, ...LIVRE_FIELDS]) row[f] = t[f] ?? null
      } else {
        // dia-alvo do trecho (data é campo livre: incoming vence) — juiz da re-ancoragem
        const dataAlvo: string | null = (t.data !== undefined && t.data !== null) ? t.data : (cur.data ?? null)
        const mergeHora = (f: string, eq: (a: any, b: any) => boolean) => {
          const sv = cur[f] ?? null, iv = t[f] ?? null
          if (!iv && sv && limpa.has(f)) { row[f] = null; return }   // limpeza explícita: aceita
          if (sv && iv && !eq(sv, iv)) {
            // Re-ancoragem NÃO é disputa: mesma hora de relógio e o incoming cai no dia do
            // trecho (chegada pode ser dia+1 — madrugada). Caso real V-0003: o aparelho mandou
            // a saída corrigida pro dia certo e o servidor manteve a âncora errada.
            const reancora = TS_FIELDS.includes(f) && dataAlvo && mesmoRelogio(iv, sv) &&
              (f === "saida_em"
                ? diaLocalBR(iv) === dataAlvo
                : (diaLocalBR(iv) === dataAlvo || diaLocalBR(iv) === diaMais1(dataAlvo)))
            if (reancora) { row[f] = iv; return }
            conflitos.push({ trecho_ordem: row.ordem, campo: f, servidor: sv, recebido: iv, por: uid, em: nowISO })
            row[f] = sv                       // conflito: mantém o do servidor
          } else row[f] = sv ?? iv            // união: preenche o vazio
        }
        for (const f of TS_FIELDS) mergeHora(f, eqTs)
        for (const f of HORA_FIELDS) mergeHora(f, eqHora)
        for (const f of LIVRE_FIELDS) row[f] = (t[f] !== undefined && t[f] !== null) ? t[f] : (limpa.has(f) ? null : (cur[f] ?? null))
      }

      const up = await admin.from("deslocamento_trechos").upsert(row, { onConflict: "id" })
      if (up.error) return json({ error: "falha no trecho: " + up.error.message }, 500)
    }

    // ---- a-bordo por trecho: UNIÃO (só acrescenta)… ----
    const aboardRows: any[] = []
    for (const t of incoming) for (const tid of (t.tecnicos || [])) aboardRows.push({ trecho_id: t.id, tecnico_id: tid })
    if (aboardRows.length) {
      const r = await admin.from("trecho_tecnicos").upsert(aboardRows, { onConflict: "trecho_id,tecnico_id", ignoreDuplicates: true })
      if (r.error) return json({ error: "falha a-bordo: " + r.error.message }, 500)
    }
    // …EXCETO remoção explícita (t._tec_remover): quem foi tirado de propósito no app sai do
    // trecho (sem isso a união re-adicionaria pra sempre e horas/noites iriam pra quem não estava).
    for (const t of incoming) {
      const rem = (Array.isArray(t._tec_remover) ? t._tec_remover : [])
        .filter((x: unknown) => typeof x === "string")
        .filter((x: string) => !(t.tecnicos || []).includes(x))   // re-adicionado vence a remoção
      if (rem.length) {
        const r = await admin.from("trecho_tecnicos").delete().eq("trecho_id", t.id).in("tecnico_id", rem)
        if (r.error) return json({ error: "falha a-bordo(rem): " + r.error.message }, 500)
      }
    }

    // ---- direção por trecho: substitui a direção dos trechos recebidos (autorada em conjunto) ----
    const trechoIds = incoming.map((t: any) => t.id)
    if (trechoIds.length) {
      const delDir = await admin.from("trecho_direcao").delete().in("trecho_id", trechoIds)
      if (delDir.error) return json({ error: "falha direcao(del): " + delDir.error.message }, 500)
      const dirs: any[] = []
      for (const t of incoming) for (const m of (t.motoristas || [])) {
        dirs.push({ trecho_id: t.id, tecnico_id: m.tecnico_id, hora_de: m.hora_de || null, hora_ate: m.hora_ate || null })
      }
      if (dirs.length) {
        const r = await admin.from("trecho_direcao").insert(dirs)
        if (r.error) return json({ error: "falha direcao: " + r.error.message }, 500)
      }
    }

    // ---- a-bordo no pai (dá leitura via RLS): união + poda de quem saiu de TODOS os trechos ----
    const uni = [...new Set(incoming.flatMap((t: any) => t.tecnicos || []))]
    if (uni.length) {
      const r = await admin.from("deslocamento_tecnicos")
        .upsert(uni.map((tid) => ({ deslocamento_id: trip.id, tecnico_id: tid })),
          { onConflict: "deslocamento_id,tecnico_id", ignoreDuplicates: true })
      if (r.error) return json({ error: "falha tecnicos pai: " + r.error.message }, 500)
    }
    // participação é DERIVADA dos trechos: pai não pode reter quem não está em nenhum
    const { data: abAtual } = await admin.from("trecho_tecnicos")
      .select("tecnico_id, deslocamento_trechos!inner(deslocamento_id)")
      .eq("deslocamento_trechos.deslocamento_id", trip.id)
    const emTrecho = [...new Set((abAtual || []).map((x: any) => x.tecnico_id))]
    const podaQ = admin.from("deslocamento_tecnicos").delete().eq("deslocamento_id", trip.id)
    const poda = emTrecho.length ? await podaQ.not("tecnico_id", "in", `(${emTrecho.join(",")})`) : await podaQ
    if (poda.error) return json({ error: "falha tecnicos pai(poda): " + poda.error.message }, 500)

    // ---- tarefas referenciadas (união) ----
    const tarefas = [...new Set([...(trip.tarefas || []), ...incoming.map((t: any) => t.tarefa_id).filter(Boolean)])]
    if (tarefas.length) {
      const r = await admin.from("deslocamento_tarefas")
        .upsert(tarefas.map((tid) => ({ deslocamento_id: trip.id, tarefa_id: tid })),
          { onConflict: "deslocamento_id,tarefa_id", ignoreDuplicates: true })
      if (r.error) return json({ error: "falha tarefas: " + r.error.message }, 500)
    }

    // ---- almoço por pessoa/dia (upsert dedup por PK deslocamento_id,tecnico_id,dia) ----
    if ((trip.almocos || []).length) {
      const r = await admin.from("deslocamento_almocos")
        .upsert((trip.almocos || []).map((a: any) => ({
          deslocamento_id: trip.id, tecnico_id: a.tecnico_id, dia: a.dia, inicio: a.inicio, fim: a.fim,
        })), { onConflict: "deslocamento_id,tecnico_id,dia" })
      if (r.error) return json({ error: "falha almoco: " + r.error.message }, 500)
    }

    // ---- conflito: anexa às divergências já existentes e tira a revisão (admin reconfere).
    //      DEDUP: retry do aparelho com o mesmo payload não re-empilha a mesma divergência
    //      (caso real V-0007: 4 syncs = 4 cópias) nem re-derruba a revisão à toa. ----
    if (conflitos.length) {
      const prev = Array.isArray(ex?.conflito) ? ex!.conflito : []
      const vistos = new Set(prev.map(chaveConflito))
      const novos = conflitos.filter((c) => !vistos.has(chaveConflito(c)))
      if (novos.length) {
        const up = await admin.from("deslocamentos")
          .update({ conflito: [...prev, ...novos], revisado: false }).eq("id", trip.id)
        if (up.error) return json({ error: "falha conflito: " + up.error.message }, 500)
      }
    }

    // devolve o atualizado_em pro app guardar (cursor de pull)
    const { data: fin } = await admin.from("deslocamentos")
      .select("atualizado_em").eq("id", trip.id).maybeSingle()
    return json({ ok: true, id: trip.id, atualizado_em: fin?.atualizado_em || null, conflitos: conflitos.length })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
