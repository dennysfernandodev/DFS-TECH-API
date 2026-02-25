const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { currentMonthStamp } = require("./quota");

const USERS_FILE = path.join(__dirname, "..", "dono", "users.json");
const BOTS_FILE = path.join(__dirname, "..", "data", "bots.json");

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function randomApiKey() {
  return crypto.randomBytes(18).toString("base64url");
}

function ensureUserSaaSFields(user) {
  if (!user.id) user.id = randomId("usr");
  if (!user.email) user.email = user.username ? `${user.username}@local.dfstech` : "";
  if (!user.plan) user.plan = "free";
  if (!user.subscription_status) user.subscription_status = "approved";
  if (!user.created_at) user.created_at = user.createdAt || new Date().toISOString();
  if (!user.quota_month) user.quota_month = currentMonthStamp();
  if (typeof user.quota_used !== "number") user.quota_used = 0;

  const defaultRate = Number(user.rate_limit || 60);
  const defaultQuota = Number(user.request || 10);

  if (!Array.isArray(user.api_keys)) {
    user.api_keys = [];
  }

  if (user.apikey && !user.api_keys.some((k) => k.key === user.apikey)) {
    user.api_keys.push({
      id: randomId("key"),
      user_id: user.id,
      key: user.apikey,
      status: "active",
      rate_limit: defaultRate,
      quota_limit: defaultQuota,
      created_at: new Date().toISOString()
    });
  }

  if (!Array.isArray(user.bots)) {
    user.bots = [];
  }

  return user;
}

function ensureAllUsersSaaS(users) {
  for (const username of Object.keys(users)) {
    ensureUserSaaSFields(users[username]);
  }
  return users;
}

function findUserByApiKey(users, apiKey) {
  const key = String(apiKey || "");
  for (const [username, user] of Object.entries(users)) {
    if (user.apikey === key) return { username, user, apiKeyRecord: user.api_keys?.find((k) => k.key === key) || null };
    const rec = (user.api_keys || []).find((k) => k.key === key);
    if (rec) return { username, user, apiKeyRecord: rec };
  }
  return null;
}

function setApiKeyStatus(user, status) {
  if (!Array.isArray(user.api_keys)) return;
  for (const keyRecord of user.api_keys) {
    keyRecord.status = status;
  }
}

function loadBots() {
  if (!fs.existsSync(BOTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(BOTS_FILE, "utf8"));
}

function saveBots(bots) {
  fs.mkdirSync(path.dirname(BOTS_FILE), { recursive: true });
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2));
}

module.exports = {
  USERS_FILE,
  BOTS_FILE,
  loadUsers,
  saveUsers,
  randomApiKey,
  ensureUserSaaSFields,
  ensureAllUsersSaaS,
  findUserByApiKey,
  setApiKeyStatus,
  loadBots,
  saveBots,
  randomId
};
