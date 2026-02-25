const { loadUsers, ensureAllUsersSaaS, saveUsers, findUserByApiKey } = require("../services/userStore");
const { checkRateLimit, resetMonthlyQuota, checkQuota } = require("../services/quota");

function getApiKey(req) {
  const headerKey = req.headers["x-api-key"];
  if (headerKey && String(headerKey).trim()) {
    return String(headerKey).trim();
  }
  const queryKey = req.query?.apikey;
  if (queryKey && String(queryKey).trim()) {
    return String(queryKey).trim();
  }
  return "";
}

function attachApiKey(req, _res, next) {
  const apiKey = getApiKey(req);
  req.apiKey = apiKey;

  // Compatibilidade com rotas legadas que usam req.query.apikey.
  req.query = req.query || {};
  if (apiKey && !req.query.apikey) {
    req.query.apikey = apiKey;
  }

  next();
}

function jsonError(res, status, message, data = {}) {
  return res.status(status).json({
    success: false,
    message,
    data
  });
}

function requireApiKey(req, res, next) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return jsonError(res, 401, "API key obrigatória.");
  }

  const users = ensureAllUsersSaaS(loadUsers());
  const found = findUserByApiKey(users, apiKey);
  if (!found) {
    return jsonError(res, 403, "API key inválida.");
  }

  const { user, apiKeyRecord } = found;
  if (apiKeyRecord && apiKeyRecord.status !== "active") {
    return jsonError(res, 403, "API key bloqueada.", { status: apiKeyRecord.status });
  }

  const limitResult = checkRateLimit(apiKey, apiKeyRecord?.rate_limit || 60);
  if (!limitResult.ok) {
    return jsonError(res, 429, limitResult.message);
  }

  resetMonthlyQuota(user);
  const quota = checkQuota(user, apiKeyRecord);
  if (!quota.ok) {
    return jsonError(res, 402, quota.message);
  }

  saveUsers(users);

  req.apiKey = apiKey;
  req.apiUser = user;
  req.apiKeyRecord = apiKeyRecord;
  return next();
}

module.exports = {
  getApiKey,
  attachApiKey,
  requireApiKey
};
