import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { soDigitos, sugerirVinculo, qsEmployerFindAll, unirColaboradores }
  from '../_shared/tangerino-logic.mjs';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const EMPLOYER_BASE = 'https://employer.tangerino.com.br';

// CORS restrito: origem EXATA do Hub. Sem wildcard. Ambiente local só entra por config
// explícita (PORTAL_LOCAL_ORIGIN), nunca por '*'. Métodos POST/OPTIONS; Vary: Origin.
const ORIGENS = ['https://portal-tross.vercel.app', Deno.env.get('PORTAL_LOCAL_ORIGIN') || '']
  .filter(Boolean);
function corsPara(origin: string): Record<string, string> {
  const base: Record<string, string> = { 'Vary': 'Origin' };
  if (ORIGENS.includes(origin)) {
    base['Access-Control-Allow-Origin'] = origin;
    base['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    base['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  return base;
}

function slug(s: string) {
  return (s || 'user').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

// ── colaboradores do Tangerino (read-only; token só do Secret) ────────────────
// Reusa as puras compartilhadas (qsEmployerFindAll, unirColaboradores). Retorna a lista
// unida [{ id, name, cpf, externalId, fired }] — o CPF fica SÓ no servidor.
async function getEmployerPage(page: number, somenteDemitidos: boolean, token: string): Promise<any> {
  const res = await fetch(
    `${EMPLOYER_BASE}/employee/find-all?${qsEmployerFindAll(page, 200, somenteDemitidos)}`,
    { method: 'GET', headers: { Authorization: token } });
  if (!res.ok) throw new Error(`Tangerino respondeu HTTP ${res.status}`);
  return await res.json();
}
async function coletar(somenteDemitidos: boolean, token: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < 20; page++) {
    const body = await getEmployerPage(page, somenteDemitidos, token);
    const content = Array.isArray(body?.content) ? body.content : [];
    out.push(...content);
    if (body?.last === true || content.length === 0) break;
  }
  return out;
}
async function colaboradoresTangerino(token: string): Promise<any[]> {
  const ativos = await coletar(false, token);
  const demitidos = await coletar(true, token);
  const uniao = unirColaboradores(ativos, demitidos);
  if ('erro' in uniao) throw new Error(uniao.erro);
  return uniao.colaboradores;
}
// employeeIds já vinculados a ALGUM usuário; opcional: excluir o do próprio usuário editado.
async function empregadosVinculados(excetoUsuario?: string): Promise<Map<number, string>> {
  const { data } = await admin.from('ponto_colaboradores_map')
    .select('tecnico_id,tangerino_employee_id').eq('ativo', true);
  const m = new Map<number, string>();
  for (const r of data || []) {
    if (excetoUsuario && r.tecnico_id === excetoUsuario) continue;
    m.set(Number(r.tangerino_employee_id), r.tecnico_id);
  }
  return m;
}
// employeeIds marcados FORA DO ESCOPO (decisão manual auditada). Não são "disponíveis" para
// novo vínculo e nunca devem ser sugeridos — o servidor já bloqueia o INSERT (trigger
// tg_ponto_map_valida_escopo); aqui só evitamos oferecê-los na UI. A validação final
// permanece obrigatória mesmo com este filtro.
async function empregadosForaEscopo(): Promise<Set<number>> {
  const { data } = await admin.from('ponto_fora_escopo').select('tangerino_employee_id');
  return new Set<number>((data || []).map((r: any) => Number(r.tangerino_employee_id)));
}
const sanit = (c: any) => ({ employeeId: c.id, nome: c.name ?? null, inativo: c.fired === true });

Deno.serve(async (req) => {
  const cors = corsPara(req.headers.get('Origin') || '');
  const json = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    if (!token) return json(401, { error: 'Não autenticado.' });
    const { data: ures, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !ures?.user) return json(401, { error: 'Sessão inválida.' });
    const { data: me } = await admin.from('usuarios').select('role').eq('id', ures.user.id).single();
    if (!me || me.role !== 'admin') return json(403, { error: 'Apenas administradores.' });

    const b = await req.json();
    const action = b.action;

    if (action === 'create') {
      const mode = b.login_mode || 'email_senha';
      let email = String(b.email || '').trim().toLowerCase();
      if (mode === 'usuario_senha') {
        const uname = String(b.usuario || b.email || slug(b.nome)).toLowerCase().replace(/[^a-z0-9._-]/g, '');
        if (!uname) return json(400, { error: 'Informe um nome de usuário.' });
        email = uname.includes('@') ? uname : `${uname}@tsrv.interno`;
      }
      if (!email) return json(400, { error: 'Informe o e-mail.' });
      if (!b.senha || String(b.senha).length < 6) return json(400, { error: 'Senha mínima de 6 caracteres.' });
      if (!b.nome) return json(400, { error: 'Informe o nome completo.' });

      const { data: c, error: cerr } = await admin.auth.admin.createUser({
        email, password: b.senha, email_confirm: true, user_metadata: { nome: b.nome },
      });
      if (cerr) return json(400, { error: cerr.message });
      const id = c.user!.id;
      const { error: ierr } = await admin.from('usuarios').upsert({
        id, nome: b.nome, email, role: b.role || 'colaborador', ativo: b.ativo ?? true,
        cpf: b.cpf || null, cargo: b.cargo || null, telefone: b.telefone || null,
        foto: b.foto || null, login_mode: mode, must_change_password: b.must_change ?? true,
      });
      if (ierr) { await admin.auth.admin.deleteUser(id); return json(400, { error: ierr.message }); }
      // "Participa da integração com o Tangerino" (0129): novo usuário NASCE false (default
      // da coluna); marcar no cadastro passa pelo setter oficial → auditoria com o admin
      // verificado como ator (nunca gravação direta sem trilha).
      if (b.tangerino_elegivel === true) {
        const { error: eEl } = await admin.rpc('sr_set_tangerino_elegivel', {
          p_usuario: id, p_valor: true, p_ator: ures.user.id,
        });
        if (eEl) return json(400, { error: eEl.message });
      }
      // NUNCA cria vínculo no create — vínculo é ação explícita separada (tangerino_vincular).
      return json(200, { ok: true, id, email });
    }

    if (action === 'update') {
      if (!b.id) return json(400, { error: 'id obrigatório.' });
      const patch: Record<string, unknown> = {};
      for (const k of ['nome', 'cpf', 'cargo', 'telefone', 'foto', 'login_mode', 'role', 'ativo']) {
        if (k in b) patch[k] = b[k];
      }
      const { error } = await admin.from('usuarios').update(patch).eq('id', b.id);
      if (error) return json(400, { error: error.message });
      if (typeof b.ativo === 'boolean') {
        await admin.auth.admin.updateUserById(b.id, { ban_duration: b.ativo ? 'none' : '876000h' }).catch(() => {});
      }
      // tangerino_elegivel NUNCA entra no patch direto: só pelo setter oficial (0129), que
      // audita valor anterior/novo com o admin verificado como ator. Desmarcar usuário com
      // vínculo ativo é bloqueado pelo banco — o erro volta ao chamador, nunca silencioso.
      if (typeof b.tangerino_elegivel === 'boolean') {
        const { error: eEl } = await admin.rpc('sr_set_tangerino_elegivel', {
          p_usuario: b.id, p_valor: b.tangerino_elegivel, p_ator: ures.user.id,
        });
        if (eEl) return json(400, { error: eEl.message });
      }
      return json(200, { ok: true });
    }

    if (action === 'reset_password') {
      if (!b.id || !b.senha || String(b.senha).length < 6) return json(400, { error: 'id e senha (6+) obrigatórios.' });
      const { error } = await admin.auth.admin.updateUserById(b.id, { password: b.senha });
      if (error) return json(400, { error: error.message });
      await admin.from('usuarios').update({ must_change_password: true }).eq('id', b.id);
      return json(200, { ok: true });
    }

    // ── VÍNCULO TANGERINO (fluxo do cadastro do Hub) ──────────────────────────
    // Token só do Secret. Resposta NUNCA carrega CPF/PIS/externalId/token/payload bruto.
    const tkn = Deno.env.get('TANGERINO_TOKEN') || '';

    // status_usuario: elegibilidade + vínculo atual (para pré-carregar a edição).
    if (action === 'tangerino_status_usuario') {
      if (!b.usuarioId) return json(400, { error: 'usuarioId obrigatório.' });
      const { data, error } = await admin.rpc('sr_status_vinculo_usuario', { p_usuario: b.usuarioId });
      if (error) return json(400, { error: error.message });
      const row = Array.isArray(data) ? data[0] : data;
      return json(200, {
        elegivel: row?.tangerino_elegivel === true,
        vinculo: row?.employee_id != null ? { employeeId: row.employee_id } : null,
      });
    }

    // colaboradores: disponíveis + sanitizados ({ employeeId, nome, inativo }).
    if (action === 'tangerino_colaboradores') {
      if (!b.usuarioId) return json(400, { error: 'usuarioId obrigatório.' });
      if (!tkn) return json(503, { error: 'Integração Tangerino não provisionada.' });
      const todos = await colaboradoresTangerino(tkn);
      const vinc = await empregadosVinculados(b.usuarioId);   // exclui os de OUTROS; mantém o do próprio
      const fora = await empregadosForaEscopo();              // fora do escopo nunca é "disponível"
      const incluirInativos = b.incluirInativos === true;     // opção histórica explícita
      const lista = todos
        .filter((c: any) => !vinc.has(Number(c.id)) && !fora.has(Number(c.id)))
        .filter((c: any) => incluirInativos || c.fired !== true)
        .map(sanit)
        .sort((a: any, z: any) => String(a.nome || '').localeCompare(String(z.nome || '')));
      return json(200, { colaboradores: lista });
    }

    // sugestao: correspondência por CPF calculada NO SERVIDOR; nunca vincula.
    if (action === 'tangerino_sugestao') {
      if (!b.usuarioId) return json(400, { error: 'usuarioId obrigatório.' });
      if (!tkn) return json(503, { error: 'Integração Tangerino não provisionada.' });
      const { data: u } = await admin.from('usuarios').select('id,cpf').eq('id', b.usuarioId).single();
      if (!u) return json(404, { error: 'Usuário não encontrado.' });
      const todos = await colaboradoresTangerino(tkn);
      const vinc = await empregadosVinculados(b.usuarioId);
      const fora = await empregadosForaEscopo();              // fora do escopo nunca é sugerido
      const cand = todos.find((c: any) =>
        !vinc.has(Number(c.id)) && !fora.has(Number(c.id)) && sugerirVinculo(c, [u]) != null);   // reusa a pura compartilhada
      return json(200, { sugestao: cand ? sanit(cand) : null });
    }

    // vincular: recebe SÓ { usuarioId, employeeId } (+ permitirInativo, intenção do admin).
    // A Edge RECONSULTA o colaborador no Tangerino e deriva no servidor externalId, situação,
    // nome, disponibilidade e a ORIGEM (via sugerirVinculo). Nada de colaborador vem do browser.
    if (action === 'tangerino_vincular') {
      if (!b.usuarioId || b.employeeId == null) return json(400, { error: 'usuarioId e employeeId obrigatórios.' });
      if (!tkn) return json(503, { error: 'Integração Tangerino não provisionada.' });
      const employeeId = Number(b.employeeId);
      const { data: u } = await admin.from('usuarios').select('id,cpf,tangerino_elegivel').eq('id', b.usuarioId).single();
      if (!u) return json(404, { error: 'Usuário não encontrado.' });
      if (u.tangerino_elegivel !== true) return json(400, { error: 'Usuário não está marcado como elegível para o Tangerino.' });

      const todos = await colaboradoresTangerino(tkn);
      const colab = todos.find((c: any) => Number(c.id) === employeeId);
      if (!colab) return json(404, { error: 'Colaborador não encontrado no Tangerino.' });
      if (colab.fired === true && b.permitirInativo !== true) {
        return json(400, { error: 'Colaborador inativo — ative a opção histórica para vincular.' });
      }
      const vinc = await empregadosVinculados(b.usuarioId);
      if (vinc.has(employeeId)) return json(409, { error: 'Este colaborador já está vinculado a outro usuário.' });

      // origem e externalId derivados NO SERVIDOR (nunca do browser)
      const s = sugerirVinculo(colab, [u]);              // { origem: 'externalId'|'cpf' } ou null
      const origem = s ? s.origem : 'manual';
      const externalId = colab.externalId ?? null;
      const { error } = await admin.rpc('sr_vincular_colaborador', {
        p_usuario: b.usuarioId, p_employee_id: employeeId,
        p_external_id: externalId, p_origem: origem, p_ator: ures.user.id,
      });
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true, vinculo: sanit(colab), origem });
    }

    if (action === 'tangerino_desvincular') {
      if (!b.usuarioId) return json(400, { error: 'usuarioId obrigatório.' });
      const { error } = await admin.rpc('sr_desvincular_colaborador', {
        p_usuario: b.usuarioId, p_ator: ures.user.id,
      });
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Ação desconhecida: ' + action });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message || e) });
  }
});
