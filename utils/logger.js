const BRAND = "DFS TECH API";

function stamp() {
  return new Date().toISOString();
}

function format(level, args) {
  return [`[${stamp()}]`, `[${BRAND}]`, `[${level}]`, ...args];
}

function info(...args) {
  console.log(...format("INFO", args));
}

function warn(...args) {
  console.warn(...format("WARN", args));
}

function error(...args) {
  console.error(...format("ERROR", args));
}

module.exports = {
  BRAND,
  info,
  warn,
  error
};
