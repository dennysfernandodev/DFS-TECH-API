const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { findUserByApiKey, setApiKeyStatus } = require("./userStore");

const PAYMENTS_FILE = path.join(__dirname, "..", "data", "payments.json");

const PLAN_CATALOG = {
  starter_10: {
    id: "starter_10",
    name: "Plano Start",
    price: 10,
    requests: 1000
  },
  basic_25: {
    id: "basic_25",
    name: "Plano Basic",
    price: 25,
    requests: 5000
  },
  pro_50: {
    id: "pro_50",
    name: "Plano Pro",
    price: 50,
    requests: 12000
  },
  elite_100: {
    id: "elite_100",
    name: "Plano Elite",
    price: 100,
    requests: 30000
  }
};

function getPlans() {
  return Object.values(PLAN_CATALOG);
}

function resolvePlan(planIdOrPrice) {
  const raw = String(planIdOrPrice || "").trim();
  if (!raw) return null;

  if (PLAN_CATALOG[raw]) {
    return PLAN_CATALOG[raw];
  }

  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber)) {
    return getPlans().find((p) => p.price === asNumber) || null;
  }

  return null;
}

function loadPayments() {
  if (!fs.existsSync(PAYMENTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(PAYMENTS_FILE, "utf8"));
}

function savePayments(payments) {
  fs.mkdirSync(path.dirname(PAYMENTS_FILE), { recursive: true });
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
}

function ensureMpToken() {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!token || !String(token).trim()) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  }
  return String(token).trim();
}

function detectBaseUrl(req) {
  if (process.env.APP_PUBLIC_URL) {
    return String(process.env.APP_PUBLIC_URL).replace(/\/+$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

async function createCheckoutPreference(req, { plan, apiKey, user }) {
  const token = ensureMpToken();
  const baseUrl = detectBaseUrl(req);

  const payload = {
    items: [
      {
        id: plan.id,
        title: `DFS TECH API - ${plan.name}`,
        description: `Crédito de ${plan.requests} requisições`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(plan.price)
      }
    ],
    external_reference: apiKey,
    metadata: {
      api_key: apiKey,
      username: user.username,
      plan_id: plan.id,
      requests_bonus: plan.requests
    },
    auto_return: "approved",
    notification_url: `${baseUrl}/billing/webhook`,
    back_urls: {
      success: `${baseUrl}/planos?payment=success`,
      failure: `${baseUrl}/planos?payment=failure`,
      pending: `${baseUrl}/planos?payment=pending`
    }
  };

  const response = await axios.post("https://api.mercadopago.com/checkout/preferences", payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });

  return response.data;
}

async function fetchPaymentDetails(paymentId) {
  const token = ensureMpToken();
  const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    timeout: 20000
  });
  return response.data;
}

function resolvePaymentId(payload, req) {
  return String(
    payload?.data?.id ||
    payload?.id ||
    payload?.resource?.id ||
    payload?.resource?.split?.("/").pop?.() ||
    req.query?.id ||
    ""
  ).trim();
}

function applyCreditsForApprovedPayment(users, paymentData) {
  const externalRef = String(paymentData?.external_reference || "").trim();
  const metadata = paymentData?.metadata || {};
  const apiKey = String(metadata.api_key || externalRef || "").trim();
  const planId = String(metadata.plan_id || paymentData?.additional_info?.items?.[0]?.id || "").trim();
  const plan = resolvePlan(planId);

  if (!apiKey || !plan) {
    return { ok: false, message: "Pagamento sem api_key/plano válido." };
  }

  const found = findUserByApiKey(users, apiKey);
  if (!found) {
    return { ok: false, message: "Usuário da API key não encontrado." };
  }

  const { user, apiKeyRecord } = found;
  const requestsToAdd = Number(plan.requests);

  user.subscription_status = "approved";
  user.request = Number(user.request || 0) + requestsToAdd;

  if (apiKeyRecord) {
    apiKeyRecord.status = "active";
    apiKeyRecord.quota_limit = Number(apiKeyRecord.quota_limit || 0) + requestsToAdd;
  } else {
    setApiKeyStatus(user, "active");
  }

  return {
    ok: true,
    message: "Créditos adicionados.",
    data: {
      username: found.username,
      apiKey,
      added_requests: requestsToAdd,
      plan_id: plan.id
    }
  };
}

function pauseUserByApiKey(users, apiKey) {
  const found = findUserByApiKey(users, apiKey);
  if (!found) return false;
  found.user.subscription_status = "paused";
  setApiKeyStatus(found.user, "paused");
  return true;
}

module.exports = {
  getPlans,
  resolvePlan,
  loadPayments,
  savePayments,
  createCheckoutPreference,
  fetchPaymentDetails,
  resolvePaymentId,
  applyCreditsForApprovedPayment,
  pauseUserByApiKey
};
