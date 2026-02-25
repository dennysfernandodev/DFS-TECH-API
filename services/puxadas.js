const axios = require("axios");

function normalizeBaseUrl(baseURL) {
  if (!baseURL) return "";
  return String(baseURL).trim().replace(/\/+$/, "");
}

function createPuxadasClient({ baseURL, token, tokenHeader = "Authorization", timeoutMs = 15000 }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseURL);
  if (!normalizedBaseUrl) return null;

  const headers = {
    "User-Agent": "DFSTechAPI/1.0",
    Accept: "application/json, text/plain, */*"
  };

  if (token) {
    const headerName = String(tokenHeader || "Authorization");
    const tokenValue = String(token);
    if (headerName.toLowerCase() === "authorization" && !/^bearer\s+/i.test(tokenValue)) {
      headers[headerName] = `Bearer ${tokenValue}`;
    } else {
      headers[headerName] = tokenValue;
    }
  }

  return axios.create({
    baseURL: normalizedBaseUrl,
    timeout: Number(timeoutMs) || 15000,
    headers
  });
}

function parseUpstreamError(error) {
  if (error.response) {
    return {
      status: error.response.status || 502,
      data: error.response.data || { status: false, erro: "Erro retornado pela API PUXADAS." }
    };
  }
  return {
    status: 502,
    data: {
      status: false,
      erro: "Falha ao conectar com a API PUXADAS.",
      detalhes: error.message || "Erro de rede"
    }
  };
}

async function forwardPuxadasRequest(client, { method, path, query, body }) {
  if (!client) {
    return {
      status: 500,
      data: {
        status: false,
        erro: "Integração PUXADAS não configurada.",
        detalhes: "Defina PUXADAS_BASE_URL e PUXADAS_TOKEN no ambiente."
      }
    };
  }

  const cleanPath = String(path || "").replace(/^\/+/, "");
  const upperMethod = String(method || "GET").toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(upperMethod);

  try {
    const response = await client.request({
      url: `/${cleanPath}`,
      method: upperMethod,
      params: query || {},
      data: hasBody ? (body || {}) : undefined
    });
    return { status: response.status || 200, data: response.data };
  } catch (error) {
    return parseUpstreamError(error);
  }
}

module.exports = {
  createPuxadasClient,
  forwardPuxadasRequest
};
