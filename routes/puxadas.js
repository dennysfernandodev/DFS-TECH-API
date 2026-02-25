const express = require("express");
const { requireApiKey } = require("../middleware/apikey");

const router = express.Router();

function ok(res, message, data = {}, status = 200) {
  return res.status(status).json({ success: true, message, data });
}

const PUXADAS_TYPES = [
  "cpf","cpf2","cpf3","cpf4","cpf5","srs","score","score2","nacional","cnh","fotorj","rg","rg2",
  "telefone","telefone2","telefone3","tel","tel2","phone","phone2","placa","placa2","placa3","placa4",
  "cnpj","cnpj2","nome","nome2","email","email2","pixconsulta","wifi","cep2","bin","bin2","parentes",
  "chassi","chassi1","renavam","obito","socios","vacinas","pai","cns","abreviado","cpfnacional"
];

router.get("/api/puxadas/health", (req, res) => {
  return ok(res, "Serviço de puxadas disponível", {
    fonte: "puxadas"
  });
});

router.get("/api/puxadas/consulta", (req, res) => {
  return ok(res, "Tipos de consulta carregados", {
    fonte: "puxadas",
    tipos: PUXADAS_TYPES,
    exemplo: "/api/puxadas/consulta/cpf=11396397736&apikey=SUA_APIKEY"
  });
});

// Endpoint auxiliar SaaS sem quebrar endpoints legados.
router.get("/api/puxadas/account", requireApiKey, (req, res) => {
  const user = req.apiUser;
  const key = req.apiKeyRecord;

  return ok(res, "Conta carregada", {
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan,
      subscription_status: user.subscription_status,
      quota_month: user.quota_month,
      quota_used: user.quota_used
    },
    api_key: {
      id: key?.id,
      status: key?.status || "active",
      rate_limit: key?.rate_limit,
      quota_limit: key?.quota_limit
    }
  });
});

module.exports = router;
