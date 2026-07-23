import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function slug(s: string) {
  return (s || 'user').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
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

    return json(400, { error: 'Ação desconhecida: ' + action });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message || e) });
  }
});
