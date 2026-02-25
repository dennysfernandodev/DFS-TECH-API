const express = require("express");
const bcrypt = require("bcrypt");
const sanitize = require("sanitize-html");
const { loadUsers, saveUsers, randomApiKey, ensureAllUsersSaaS, findUserByApiKey } = require("../services/userStore");
const { BRAND, info, error } = require("../utils/logger");
const { requireSession } = require("../middleware/auth");

const router = express.Router();
const REQUESTS_PER_CYCLE = 10;

function ok(res, message, data = {}, status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function fail(res, message, status = 400, data = {}) {
  return res.status(status).json({ success: false, message, data });
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

async function ensurePasswordHash(user, plainCandidate) {
  if (user.password_hash) {
    return bcrypt.compare(String(plainCandidate), String(user.password_hash));
  }

  // Migração automática de legado (senha em texto simples -> hash bcrypt)
  if (user.senha && String(user.senha) === String(plainCandidate)) {
    user.password_hash = await hashPassword(plainCandidate);
    user.senha = "";
    return true;
  }

  return false;
}

router.post("/register", async (req, res) => {
  try {
    let { username, nick, password, email } = req.body;
    if (!username || !nick || !password) {
      return fail(res, "Preencha todos os campos", 400);
    }

    username = sanitize(String(username).trim());
    nick = sanitize(String(nick).trim());
    email = email ? sanitize(String(email).trim()) : `${username}@local.dfstech`;

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return fail(res, "Username inválido", 400);
    }

    const users = ensureAllUsersSaaS(loadUsers());
    if (users[username]) {
      return fail(res, "Usuário já registrado", 400);
    }

    const passwordHash = await hashPassword(password);
    const apikey = randomApiKey();

    users[username] = {
      username,
      nick,
      email,
      senha: "",
      password_hash: passwordHash,
      apikey,
      level: 2,
      foto: "https://files.catbox.moe/lldieg.jpg",
      request: REQUESTS_PER_CYCLE,
      createdAt: new Date().toISOString(),
      created_at: new Date().toISOString(),
      lastRequestResetAt: new Date().toISOString(),
      vip: false,
      ilimitado: false,
      adm: false,
      plan: "free",
      subscription_status: "approved",
      quota_month: new Date().toISOString().slice(0, 7),
      quota_used: 0,
      api_keys: [
        {
          id: `key_${Date.now()}`,
          user_id: `usr_${Date.now()}`,
          key: apikey,
          status: "active",
          rate_limit: 60,
          quota_limit: REQUESTS_PER_CYCLE,
          created_at: new Date().toISOString()
        }
      ]
    };

    saveUsers(users);
    info("Novo usuário registrado:", username);

    res.cookie("username", username, { httpOnly: true, signed: true, sameSite: "Strict" });
    if (wantsHtml(req)) {
      return res.redirect("/login");
    }
    return ok(res, `${BRAND}: usuário registrado com sucesso`, { username, apikey }, 201);
  } catch (err) {
    error("Erro no register:", err.message || err);
    return fail(res, "Erro interno ao registrar usuário", 500);
  }
});

router.post("/login", async (req, res) => {
  try {
    let { username, password } = req.body;
    if (!username || !password) {
      return fail(res, "Nome e senha são obrigatórios", 400);
    }

    username = String(username).trim();
    const users = ensureAllUsersSaaS(loadUsers());
    const user = users[username];

    if (!user) {
      return fail(res, "Usuário ou senha incorretos", 401);
    }

    const valid = await ensurePasswordHash(user, password);
    if (!valid) {
      return fail(res, "Usuário ou senha incorretos", 401);
    }

    saveUsers(users);
    res.cookie("username", username, { httpOnly: true, signed: true, sameSite: "Strict" });
    if (wantsHtml(req)) {
      return res.redirect("/docs");
    }
    return ok(res, "Login realizado com sucesso", { redirect: "/docs" });
  } catch (err) {
    error("Erro no login:", err.message || err);
    return fail(res, "Erro interno ao realizar login", 500);
  }
});

router.get("/api/auth/me", (req, res) => {
  const apiKey = req.apiKey || req.query?.apikey;
  if (!apiKey) {
    return fail(res, "API key obrigatória", 401);
  }

  const users = ensureAllUsersSaaS(loadUsers());
  const found = findUserByApiKey(users, apiKey);
  if (!found) {
    return fail(res, "API key inválida", 403);
  }

  const { username, user, apiKeyRecord } = found;
  return ok(res, "Usuário autenticado", {
    username,
    email: user.email,
    plan: user.plan,
    subscription_status: user.subscription_status,
    quota_month: user.quota_month,
    quota_used: user.quota_used,
    api_key_status: apiKeyRecord?.status || "active"
  });
});

router.get("/api/userinfo", (req, res) => {
  const apiKey = req.apiKey || req.query?.apikey;
  if (!apiKey) {
    return fail(res, "API key obrigatória", 401);
  }

  const users = ensureAllUsersSaaS(loadUsers());
  const found = findUserByApiKey(users, apiKey);
  if (!found) {
    return fail(res, "Usuário não encontrado", 404);
  }

  const { user } = found;
  const { senha, password_hash, ...userSafe } = user;

  if (userSafe.createdAt) {
    const createdDate = new Date(userSafe.createdAt);
    const hoje = new Date();
    const diffDias = Math.floor((hoje - createdDate) / (1000 * 60 * 60 * 24));
    userSafe.diasDesdeCadastro = diffDias;
  }

  return ok(res, "Dados do usuário carregados", userSafe);
});

router.post("/configuracaoPerfil", requireSession, async (req, res) => {
  try {
    const { senha, foto, nome } = req.body || {};
    if (!nome) return fail(res, "O nome do usuário é obrigatório", 400);

    const users = ensureAllUsersSaaS(loadUsers());
    const user = users[nome];
    if (!user) return fail(res, "Usuário não encontrado", 404);

    if (foto && String(foto).trim()) user.foto = String(foto).trim();
    if (senha && String(senha).trim()) {
      user.password_hash = await hashPassword(String(senha).trim());
      user.senha = "";
    }

    saveUsers(users);
    return ok(res, "Configurações atualizadas com sucesso");
  } catch (err) {
    error("Erro em /configuracaoPerfil:", err.message || err);
    return fail(res, "Erro ao atualizar configurações", 500);
  }
});

module.exports = router;
