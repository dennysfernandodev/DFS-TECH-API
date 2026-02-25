const express = require("express");
const { requireAdmin } = require("../middleware/auth");
const { getApiKey } = require("../middleware/apikey");
const { loadUsers, saveUsers, ensureAllUsersSaaS, setApiKeyStatus, loadBots, saveBots, randomId } = require("../services/userStore");
const n8n = require("../services/n8n");
const { info, warn } = require("../utils/logger");
const {
  getPlans,
  resolvePlan,
  loadPayments,
  savePayments,
  createCheckoutPreference,
  fetchPaymentDetails,
  resolvePaymentId,
  applyCreditsForApprovedPayment,
  pauseUserByApiKey
} = require("../services/billing");

const router = express.Router();

function ok(res, message, data = {}, status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function fail(res, message, status = 400, data = {}) {
  return res.status(status).json({ success: false, message, data });
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "sim" || v === "yes";
  }
  return false;
}

function resolveMpStatus(body) {
  const candidates = [
    body?.status,
    body?.data?.status,
    body?.payment?.status,
    body?.resource?.status,
    body?.action
  ];
  const found = candidates.find((v) => typeof v === "string" && v.trim());
  return found ? found.trim().toLowerCase() : "unknown";
}

function applyWebhook(req, res) {
  const payload = req.body || {};
  const eventType = payload.type || payload.topic || "unknown";
  const users = ensureAllUsersSaaS(loadUsers());
  const paymentId = resolvePaymentId(payload, req);
  const fallbackStatus = resolveMpStatus(payload);
  const fallbackApiKey = String(payload.api_key || payload.external_reference || payload.user_api_key || "").trim();

  // Webhook Mercado Pago completo: pega detalhes do pagamento e aplica créditos.
  if (paymentId) {
    fetchPaymentDetails(paymentId)
      .then((paymentData) => {
        const paymentStatus = String(paymentData?.status || "").toLowerCase();
        const payments = loadPayments();
        const paymentKey = String(paymentId);
        const already = payments[paymentKey];
        let result = { ok: false, message: "Evento processado sem alterações", data: {} };

        if (paymentStatus === "approved") {
          if (already?.credited === true) {
            result = {
              ok: true,
              message: "Pagamento aprovado já processado anteriormente",
              data: { payment_id: paymentId }
            };
          } else {
            result = applyCreditsForApprovedPayment(users, paymentData);
            if (result.ok) {
              payments[paymentKey] = {
                payment_id: paymentId,
                status: paymentStatus,
                credited: true,
                processed_at: new Date().toISOString(),
                data: result.data
              };
            }
          }
        } else {
          const apiKey = String(paymentData?.metadata?.api_key || paymentData?.external_reference || fallbackApiKey || "").trim();
          if (apiKey) {
            pauseUserByApiKey(users, apiKey);
          }
          payments[paymentKey] = {
            payment_id: paymentId,
            status: paymentStatus || fallbackStatus,
            credited: false,
            processed_at: new Date().toISOString()
          };
          result = {
            ok: true,
            message: "Pagamento não aprovado. API key pausada.",
            data: { payment_id: paymentId, status: paymentStatus || fallbackStatus }
          };
        }

        savePayments(payments);
        saveUsers(users);
        info("Webhook Mercado Pago processado", {
          eventType,
          paymentId,
          status: paymentStatus || fallbackStatus
        });
        if (!result.ok) {
          return fail(res, result.message, 400, result.data || {});
        }
        return ok(res, result.message, {
          eventType,
          payment_id: paymentId,
          status: paymentStatus || fallbackStatus,
          ...result.data
        });
      })
      .catch((err) => {
        warn("Falha ao processar webhook Mercado Pago", {
          eventType,
          paymentId,
          error: err?.response?.data || err?.message || String(err)
        });
        return fail(res, "Falha ao processar webhook do Mercado Pago", 500, {
          eventType,
          payment_id: paymentId,
          error: err?.message || "Erro desconhecido"
        });
      });
    return;
  }

  // Compatibilidade antiga por api_key/status sem payment id.
  const status = fallbackStatus;
  const apiKey = fallbackApiKey;
  if (!apiKey) {
    warn("Webhook recebido sem payment id e sem api_key", { eventType, status });
    return ok(res, "Webhook processado sem vincular usuário", { eventType, status });
  }

  let updated = false;
  for (const user of Object.values(users)) {
    const hasKey = user.apikey === apiKey || (user.api_keys || []).some((k) => k.key === apiKey);
    if (!hasKey) continue;

    user.subscription_status = status === "approved" ? "approved" : "paused";
    setApiKeyStatus(user, status === "approved" ? "active" : "paused");
    updated = true;
  }

  if (updated) {
    saveUsers(users);
    info("Webhook Mercado Pago aplicado", { eventType, status, apiKey });
    return ok(res, "Webhook aplicado com sucesso", { eventType, status, apiKey });
  }

  return fail(res, "API key do webhook não encontrada", 404, { apiKey, eventType, status });
}

router.get("/api/billing/plans", (_req, res) => {
  return ok(res, "Planos disponíveis", { plans: getPlans() });
});

router.post("/api/billing/checkout", async (req, res) => {
  try {
    const apiKey = getApiKey(req) || String(req.body?.apikey || "").trim();
    const planInput = req.body?.planId || req.body?.plan || req.body?.price;
    const plan = resolvePlan(planInput);
    if (!apiKey) return fail(res, "API key obrigatória para checkout", 401);
    if (!plan) return fail(res, "Plano inválido. Use: starter_10, basic_25, pro_50, elite_100", 400);

    const users = ensureAllUsersSaaS(loadUsers());
    const found = Object.values(users).find((u) => u.apikey === apiKey || (u.api_keys || []).some((k) => k.key === apiKey));
    if (!found) return fail(res, "API key não encontrada", 404);

    const preference = await createCheckoutPreference(req, {
      plan,
      apiKey,
      user: found
    });

    return ok(res, "Checkout Mercado Pago criado", {
      plan,
      preference_id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point
    });
  } catch (err) {
    return fail(res, "Erro ao gerar checkout no Mercado Pago", 500, {
      error: err?.response?.data || err.message
    });
  }
});

router.post("/billing/webhook", applyWebhook);
router.post("/api/billing/webhook", applyWebhook);

// Compatibilidade com endpoint legado.
router.post("/configuracaoAdm", async (req, res) => {
  try {
    const { token, nome, apikey, request, adm, foto, level, vip, ilimitado } = req.body || {};
    if (!token) return fail(res, "Token não informado", 401);
    if (!nome) return fail(res, "Nome obrigatório", 400);

    const users = ensureAllUsersSaaS(loadUsers());
    const adminUser = Object.values(users).find((u) => u.apikey === token && u.adm === true);
    if (!adminUser) return fail(res, "Sem permissão", 403);

    const user = users[nome];
    if (!user) return fail(res, "Usuário não encontrado", 404);

    if (apikey !== undefined) user.apikey = apikey;
    if (foto !== undefined) user.foto = foto;
    if (level !== undefined) user.level = level;
    if (request !== undefined) user.request = request;
    if (adm !== undefined) user.adm = toBoolean(adm);
    if (vip !== undefined) user.vip = toBoolean(vip);
    if (ilimitado !== undefined) user.ilimitado = toBoolean(ilimitado);

    saveUsers(users);
    return ok(res, "Configurações atualizadas com sucesso");
  } catch (err) {
    return fail(res, "Erro interno", 500, { details: err.message });
  }
});

router.post("/admin/bots", requireAdmin, async (req, res) => {
  try {
    const { user_id, name, templateId } = req.body || {};
    if (!user_id || !name) {
      return fail(res, "user_id e name são obrigatórios", 400);
    }

    const workflow = await n8n.createWorkflow(templateId);
    const bots = loadBots();
    const bot = {
      id: randomId("bot"),
      user_id,
      name,
      n8n_workflow_id: workflow.workflowId,
      status: "active",
      created_at: new Date().toISOString()
    };
    bots.push(bot);
    saveBots(bots);

    return ok(res, "Bot criado", bot, 201);
  } catch (err) {
    return fail(res, "Erro ao criar bot", 500, { error: err.message });
  }
});

router.post("/admin/bots/:id/pause", requireAdmin, async (req, res) => {
  const bots = loadBots();
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return fail(res, "Bot não encontrado", 404);

  await n8n.deactivateWorkflow(bot.n8n_workflow_id);
  bot.status = "paused";
  saveBots(bots);
  return ok(res, "Bot pausado", bot);
});

router.post("/admin/bots/:id/activate", requireAdmin, async (req, res) => {
  const bots = loadBots();
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return fail(res, "Bot não encontrado", 404);

  await n8n.activateWorkflow(bot.n8n_workflow_id);
  bot.status = "active";
  saveBots(bots);
  return ok(res, "Bot ativado", bot);
});

module.exports = router;
