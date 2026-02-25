const { loadUsers } = require("../services/userStore");

function requireSession(req, res, next) {
  const username = req.signedCookies?.username;
  if (!username) {
    return res.redirect("/login");
  }

  const users = loadUsers();
  const user = users[username];
  if (!user) {
    return res.redirect("/login");
  }

  req.currentUser = user;
  req.currentUsername = username;
  return next();
}

function requireAdmin(req, res, next) {
  const username = req.signedCookies?.username;
  if (!username) {
    return res.status(401).json({ success: false, message: "Sessão inválida", data: {} });
  }

  const users = loadUsers();
  const user = users[username];
  if (!user || user.adm !== true) {
    return res.status(403).json({ success: false, message: "Acesso negado", data: {} });
  }

  req.currentUser = user;
  req.currentUsername = username;
  return next();
}

module.exports = {
  requireSession,
  requireAdmin
};
