// Serviço de quota/rate limit preparado para SaaS.
// Mantém estado de rate limit em memória e quota mensal no objeto do usuário.

const KEY_WINDOW_MS = 60 * 1000;
const rateState = new Map();

function currentMonthStamp(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function resetMonthlyQuota(user, date = new Date()) {
  const nowMonth = currentMonthStamp(date);
  if (user.quota_month !== nowMonth) {
    user.quota_month = nowMonth;
    user.quota_used = 0;
    return true;
  }
  return false;
}

function checkRateLimit(apiKey, rateLimitPerMin = 60) {
  const limit = Number(rateLimitPerMin) > 0 ? Number(rateLimitPerMin) : 60;
  const now = Date.now();
  const existing = rateState.get(apiKey);

  if (!existing || (now - existing.windowStart) >= KEY_WINDOW_MS) {
    rateState.set(apiKey, { windowStart: now, count: 1 });
    return { ok: true };
  }

  if (existing.count >= limit) {
    return { ok: false, message: `Rate limit excedido para a API key (${limit}/min).` };
  }

  existing.count += 1;
  return { ok: true };
}

function checkQuota(user, apiKeyRecord) {
  const subscriptionStatus = String(user.subscription_status || "approved").toLowerCase();
  if (!["approved", "active"].includes(subscriptionStatus)) {
    return { ok: false, message: "Assinatura inativa. Regularize o pagamento para continuar." };
  }

  if (user.ilimitado === true) {
    return { ok: true };
  }

  const quotaLimit = Number(apiKeyRecord?.quota_limit ?? user.request ?? 10);
  const used = Number(user.quota_used || 0);
  if (used >= quotaLimit) {
    return { ok: false, message: "Quota mensal excedida para este usuário." };
  }

  return { ok: true };
}

function incrementUsage(user) {
  user.quota_used = Number(user.quota_used || 0) + 1;
  return user.quota_used;
}

module.exports = {
  incrementUsage,
  checkQuota,
  resetMonthlyQuota,
  checkRateLimit,
  currentMonthStamp
};
