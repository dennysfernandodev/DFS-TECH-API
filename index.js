global.bla = process.cwd();
global.api = process.cwd();
global.__path = process.cwd();

//★・・・・・・★・・・ MÓDULOS ・・・★・・・・・・★
const express = require("express");
const fetch = require('node-fetch');
const path = require("path");
const fs = require("fs");
const ejs = require('ejs');
const axios = require('axios');
const chalk = require('chalk')
const request = require('request');
const multer = require('multer');
const FormData = require('form-data');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { pipeline } = require('stream');
const https = require('https');
const http = require('http');
const url = require('url');
const ytdl = require('@distube/ytdl-core');
const PImage = require("pureimage");
const ffmpeg = require("fluent-ffmpeg");
const popcat = require('popcat-wrapper');
const bodyParser = require('body-parser');
const cheerio = require('cheerio'); 
const { Jimp } = require("jimp");
const { Readable } = require("stream");
const { YoutubeTranscript } = require('youtube-transcript'); 
//const { createCanvas, loadImage, registerFont } = require('canvas')
//const GIFEncoder = require("gifencoder")
let sharp = null;
try {
  sharp = require("sharp");
} catch (_err) {
  sharp = null;
}
const emojiRegex = require('emoji-regex'); 
const Vibrant = require("node-vibrant/node");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const sanitize = require('sanitize-html');
const rateLimit = require("express-rate-limit");
const { createPuxadasClient, forwardPuxadasRequest } = require("./services/puxadas.js");
const { attachApiKey, getApiKey } = require("./middleware/apikey");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const puxadasRoutes = require("./routes/puxadas");
const {
  loadUsers: loadUsersFromStore,
  saveUsers: saveUsersToStore,
  ensureAllUsersSaaS,
  findUserByApiKey,
  randomApiKey
} = require("./services/userStore");
const { incrementUsage, checkQuota, resetMonthlyQuota, checkRateLimit } = require("./services/quota");

function loadDotEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const valueRaw = trimmed.slice(idx + 1).trim();
    const value = valueRaw.replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile();

//★・・・・・・★・・・ PORT ・・・★・・・・・・★
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(attachApiKey);

// Padroniza erros da API para JSON estruturado e evita texto puro em falhas.
app.use("/api", (req, res, next) => {
  const originalSend = res.send.bind(res);
  res.send = function patchedSend(body) {
    if (res.statusCode >= 400 && typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && "success" in parsed && "message" in parsed) {
          return originalSend(body);
        }
      } catch {
        // Se não for JSON válido, padroniza abaixo.
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return originalSend(JSON.stringify({
        success: false,
        message: body,
        data: {}
      }));
    }
    return originalSend(body);
  };
  next();
});

const safeDecodeURIComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const parseCompactPathPairs = (segment) => {
  if (!segment || !segment.includes("=")) return null;
  const parsed = {};
  for (const token of segment.split("&")) {
    const index = token.indexOf("=");
    if (index <= 0) continue;
    const key = safeDecodeURIComponent(token.slice(0, index)).trim();
    const value = safeDecodeURIComponent(token.slice(index + 1));
    if (!key) continue;
    parsed[key] = value;
  }
  return Object.keys(parsed).length ? parsed : null;
};

// Atalho no domínio raiz para consultas PUXADAS:
// /cpf=11396397736&apikey=MINHA_CHAVE -> /api/puxadas/consulta/cpf=11396397736&apikey=MINHA_CHAVE
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const rawUrl = String(req.url || "");
  const [pathPart, searchPart = ""] = rawUrl.split("?");
  if (!pathPart || pathPart === "/") return next();
  if (pathPart.startsWith("/api/")) return next();

  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length !== 1) return next();

  const compactSegment = segments[0];
  if (!compactSegment.includes("&apikey=") || !compactSegment.includes("=")) return next();

  req.url = `/api/puxadas/consulta/${compactSegment}${searchPart ? `?${searchPart}` : ""}`;
  next();
});

// Permite padrão compacto no path para rotas /api:
// /api/modulo/rota/chave=valor&apikey=MINHA_CHAVE
app.use("/api", (req, res, next) => {
  const rawUrl = String(req.url || "");
  const [pathPart, searchPart = ""] = rawUrl.split("?");
  if (!pathPart || pathPart === "/") return next();

  // Rotas de puxadas possuem tratamento específico mais abaixo.
  if (pathPart.startsWith("/puxadas/")) return next();

  const segments = pathPart.split("/").filter(Boolean);
  if (!segments.length) return next();

  const compactSegment = segments[segments.length - 1];
  if (!compactSegment.includes("&apikey=") || !compactSegment.includes("=")) return next();

  const compactPairs = parseCompactPathPairs(compactSegment);
  if (!compactPairs) return next();

  req.query = req.query || {};
  for (const [key, value] of Object.entries(compactPairs)) {
    if (req.query[key] == null || req.query[key] === "") {
      req.query[key] = value;
    }
  }

  const rewrittenPath = "/" + segments.slice(0, -1).join("/");
  req.url = (rewrittenPath || "/") + (searchPart ? `?${searchPart}` : "");
  next();
});

const PORT = Number(process.env.PORT || 2031);
const HOST = process.env.HOST || "0.0.0.0";
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === "true";
const SSL_DOMAIN = process.env.SSL_DOMAIN || "api.dfstech.sbs";
const DEFAULT_CERT_DIR = path.join("/etc/letsencrypt/live", SSL_DOMAIN);
const SSL_CERT_DIR = process.env.SSL_CERT_DIR || DEFAULT_CERT_DIR;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(SSL_CERT_DIR, "privkey.pem");
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(SSL_CERT_DIR, "fullchain.pem");
const SSL_CA_PATH = process.env.SSL_CA_PATH || path.join(SSL_CERT_DIR, "chain.pem");
const PUXADAS_BASE_URL = process.env.PUXADAS_BASE_URL || "";
const PUXADAS_TOKEN = process.env.PUXADAS_TOKEN || "";
const PUXADAS_TOKEN_HEADER = process.env.PUXADAS_TOKEN_HEADER || "Authorization";
const PUXADAS_TIMEOUT_MS = Number(process.env.PUXADAS_TIMEOUT_MS || 15000);
const PUXADAS_RATE_LIMIT = Number(process.env.PUXADAS_RATE_LIMIT || 30);

const puxadasClient = createPuxadasClient({
  baseURL: PUXADAS_BASE_URL,
  token: PUXADAS_TOKEN,
  tokenHeader: PUXADAS_TOKEN_HEADER,
  timeoutMs: PUXADAS_TIMEOUT_MS
});


//★・・・・・・★・・・ DBS ・・・★・・・・・・★
const USERS_FILE = "./dono/users.json";

//★・・・・・・★・・・ APIKEYS ・・・★・・・・・・★
const SECRET_KEY = process.env.RECAPTCHA_SITE_KEY || "";
const DEEPAI_API_KEY = process.env.DEEPAI_API_KEY || "";
const API_KEY_BRONXYS = process.env.BRONXYS_API_KEY || "";
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || "";
const GEMINI_API_URL = process.env.GEMINI_API_URL || "";
//★・・・・・★・・・ CHAMAR GEMINI ・・・★・・・・・・★
async function chamarGemini(texto) {
try {
const response = await axios.post(
GEMINI_API_URL,{
contents: [{parts: [{ text: texto }]}]},
{ headers: { "Content-Type": "application/json" } });
const resultado = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
return resultado;
} catch (e) {
return { status: false, erro: e.response?.data || e.message };
}
}

//★・・・・・・★・・・ CONSOLE ・・・★・・・・・・★
//VERDE->
const consoleVerde = (texto) => {console.log(chalk.green(texto))}
const consoleVerde2 = (texto, texto2) => {console.log(chalk.black(chalk.bgGreen(texto)), chalk.black(chalk.white(texto2)))}
//VERMELHO->
const consoleVermelho = (texto) => {console.log(chalk.red(texto))}
const consoleVermelho2 = (texto, texto2) => {console.log(chalk.black(chalk.bgRed(texto)), chalk.black(chalk.white(texto2)))}
//AMARELO->
const consoleAmarelo = (texto) => {console.log(chalk.yellow(texto))}
const consoleAmarelo2 = (texto, texto2) => {console.log(chalk.black(chalk.bgYellow(texto)), chalk.black(chalk.white(texto2)))}
//AZUL->
const consoleAzul = (texto) => {console.log(chalk.blue(texto))}
const consoleAzul2 = (texto, texto2) => {console.log(chalk.black(chalk.bgBlue(texto)), chalk.black(chalk.white(texto2)))}
//CONSOLE DE ERRO->
const consoleErro = (texto) => {console.log(chalk.black(chalk.bgRed(`[ ERRO ]`)), chalk.black(chalk.white(`Erro: ${texto}`)))}
//CONSOLE DE AVISO
const consoleAviso = (texto) => {console.log(chalk.black(chalk.bgYellow(`[ AVISO ]`)), chalk.black(chalk.white(texto)))}
//CONSOLE DE SUCESSO->
const consoleSucesso = (texto) => {console.log(chalk.black(chalk.bgGreen(`[ SUCESSO ]`)), chalk.black(chalk.white(texto)))}
//CONSOLE DE ONLINE->
const consoleOnline = (texto) => {console.log(chalk.black(chalk.bgGreen(`[ ONLINE ]`)), chalk.black(chalk.white(texto)))}

//CONFIGS DE ADM->
const { nomeApi, criador, userAdm, userAdm2, userAdm3, userAdm4, wallpaperApi, musicaApi, fotoApi } = require('./dono/config.json')
const adms = [userAdm, userAdm2, userAdm3, userAdm4];

//★・・・・・・★・・・ SCRAPERS ・・・★・・・・・・★
const { ytDonlodMp3, ytDonlodMp4, ytPlayMp3, ytPlayMp4, ytSearch } = require("./BANCO DE DADOS/youtube.js");

const {ytMp3, ytMp4} = require("./BANCO DE DADOS/youtubePh.js");

const isHttpUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value);

const ytdlHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:116.0) Gecko/20100101 Firefox/116.0',
  'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.6,en;q=0.4',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const ytdlOptions = {
  requestOptions: { headers: ytdlHeaders },
  highWaterMark: 1 << 25
};

const PUBLIC_YOUTUBE_MAX_SECONDS = Number(process.env.PUBLIC_YOUTUBE_MAX_SECONDS || 7200);

const sanitizeFileName = (name) =>
String(name || "video")
  .replace(/[\\/:*?"<>|]+/g, "_")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 120) || "video";

const resolveYoutubeVideoResult = async (query) => {
const input = String(query || "").trim();
if (!input) return null;

if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(input)) {
return { url: input, title: "youtube_video", seconds: null };
}

const list = await ytSearch(input);
if (!Array.isArray(list) || !list.length) return null;
const video = list.find((item) => item?.url && /(youtube\.com|youtu\.be)/i.test(item.url)) || list.find((item) => item?.url);
if (!video?.url) return null;
return { url: video.url, title: video.title || input, seconds: Number(video.seconds || 0) || 0 };
};

const streamRemoteAudio = async (remoteUrl, res) => {
const response = await axios({
method: 'get',
url: remoteUrl,
responseType: 'stream',
timeout: 30_000
});
res.setHeader('Content-Type', 'audio/mpeg');
res.setHeader('Content-Disposition', 'inline');
response.data.on('error', (err) => {
consoleErro('Erro no streaming remoto:', err?.message || err);
if (!res.headersSent) {
res.status(500).send('Erro ao transmitir o áudio.');
} else {
res.end();
}
});
response.data.pipe(res);
};

const getRemoteAudioLink = async (videoUrl) => {
const providers = [ytMp3, ytPlayMp3];
for (const provider of providers) {
try {
const result = await provider(videoUrl);
if (!result) continue;
const link = typeof result === 'string' ? result : (result.link || result.url || result.download?.url || result.download?.link);
if (isHttpUrl(link)) return link;
} catch (err) {
consoleErro('Erro ao buscar link remoto:', err?.message || err);
}
}
return null;
};

const attemptYtdlStream = async (videoUrl, res, context) => {
try {
await ytdl.getInfo(videoUrl, ytdlOptions);
} catch (err) {
consoleErro(`ytdl getInfo falhou (${context}):`, err?.statusCode ?? err?.message ?? err);
return false;
}
const audioStream = ytdl(videoUrl, ytdlOptions);
res.setHeader('Content-Type', 'audio/mpeg');
audioStream.on('error', (err) => {
consoleErro(`Erro no streaming do ytdl (${context}):`, err?.statusCode ?? err?.message ?? err);
if (!res.headersSent) {
res.status(500).send('Erro ao transmitir o áudio.');
} else {
res.end();
}
});
audioStream.pipe(res);
return true;
};

const { ytsearch, ytMp3Query, ytMp4Query, instagramDl, tiktokDl, xvideosDl, apkpureDl, wikipedia, amazon, tiktokQuery, apkpureQuery, xvideosQuery, aptoide, Pinterest, PinterestMultiMidia, canvaMontagem, travaZapImg, travaZapImg2,metadinha2, logo, gemini, imagemAi, stickAi } = require("./BANCO DE DADOS/scraperPh.js");

const { audiomeme, Hentaizinho, Hentaizinho2 } = require("./BANCO DE DADOS/pedrozz.js");

const { youtubeadl2, youtubeVideoDl, youtubeSearch, youtubeYtdlv2, youtubeChannel, youtubeTranscript } = require('./BANCO DE DADOS/play.js');

const { sambaPornoSearch, playStoreSearch,memesDroid,amazonSearch,mercadoLivreSearch2,gruposZap,lulaFlix,pinterestVideoV2,pinterestVideo,animeFireDownload,animesFireSearch,animesFireEps,hentaihome,hentaitube,lojadomecanico,ultimasNoticias,randomGrupos,topFlix,uptodownsrc,uptodowndl,xvideosDownloader,xvideosSearch,fraseAmor,iFunny,frasesPensador,pensadorSearch,wallpaper,porno,hentai,styletext,twitter} = require ("./BANCO DE DADOS/scraper.js");

const { animememe } = require ("./BANCO DE DADOS/animememe.json");

const { wallpaper2 } = require ("./BANCO DE DADOS/wallpapers4k.json");

const { edts } = require ("./BANCO DE DADOS/edits.json");

const { editsjujutsu } = require ("./BANCO DE DADOS/editsjujutsu.json");

const { editsnaruto } = require ("./BANCO DE DADOS/editsnaruto.json");

const { freefire } = require ("./BANCO DE DADOS/freefire.json");

const { Tiktok } = require ("./BANCO DE DADOS/tijtok.js");

const { PinterestVideo } = require ("./BANCO DE DADOS/pinterest.js"); 

const { YTNomeSearch } = require ("./BANCO DE DADOS/ytsearch.js"); 

const { ytsearch2 } = require("./BANCO DE DADOS/youtube2.js");

const { FreeFireLikesBooster } = require("./BANCO DE DADOS/scraperfreefire.js");

const { gis } = require("./BANCO DE DADOS/gimage.js");

const { fbDownloader } = require("./BANCO DE DADOS/facebook.js");

const { mediafireDl } = require("./BANCO DE DADOS/mediafire.js");

const { tahta } = require("./BANCO DE DADOS/tatha.js")

const getYtdlStream = (videoUrl) => ytdl(videoUrl, {  filter: 'audioonly',  highWaterMark: 1 << 25,  requestOptions: { headers: ytdlHeaders }
});

//★・・・・・★・ IMAGEM TEMPORARIA・・・★・・・・・・★
async function loadImageFromUrl(url) {
const response = await axios.get(url, { responseType: "arraybuffer" });
const buffer = Buffer.from(response.data, "binary");
return await PImage.decodePNGFromStream(require("stream").Readable.from(buffer));
}

//★・・・・・★・ CARD MUSICA・・・★・・・・・・★
async function canvaMusicCard(avatarUrl, artistName, time, songName, progress = 0.5, currentTime = "00:39") {
const fundo = await loadImage("https://files.catbox.moe/yeitfq.jpg");
const canvas = createCanvas(fundo.width, fundo.height);
const ctx = canvas.getContext("2d");
const borderRadius = 30;
ctx.beginPath();
ctx.moveTo(borderRadius, 0);
ctx.lineTo(canvas.width - borderRadius, 0);
ctx.quadraticCurveTo(canvas.width, 0, canvas.width, borderRadius);
ctx.lineTo(canvas.width, canvas.height - borderRadius);
ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - borderRadius, canvas.height);
ctx.lineTo(borderRadius, canvas.height);
ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - borderRadius);
ctx.lineTo(0, borderRadius);
ctx.quadraticCurveTo(0, 0, borderRadius, 0);
ctx.closePath();
ctx.clip(); // aplica a máscara
ctx.drawImage(fundo, 0, 0, fundo.width, fundo.height);
ctx.fillStyle = 'rgba(0,0,0,0.2)';
ctx.shadowColor = 'rgba(0,0,0,0.4)';
ctx.shadowBlur = 20;
ctx.fillRect(0, 0, canvas.width, canvas.height);
const avatar = await loadImage(avatarUrl);
const avatarSize = 150;
const avatarX = (canvas.width / 2) - (avatarSize / 2);
const avatarY = 50;
ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
const avatarColor = await getAverageColor(avatarUrl);
ctx.strokeStyle = avatarColor;
ctx.lineWidth = 6;
ctx.strokeRect(avatarX, avatarY, avatarSize, avatarSize);
ctx.fillStyle = "#FFFFFF";
ctx.font = "bold 28px Arial";
ctx.textAlign = "center";
ctx.fillText(songName, canvas.width / 2, avatarY + avatarSize + 40);
ctx.font = "24px Arial";
ctx.fillText(artistName, canvas.width / 2, avatarY + avatarSize + 80);
const barWidth = canvas.width - 120; 
const barHeight = 14;
const barX = 60;
const barY = avatarY + avatarSize + 160;
ctx.shadowBlur = 0;
ctx.fillStyle = 'rgba(255,255,255,0.2)';
ctx.fillRect(barX, barY, barWidth, barHeight);
ctx.fillStyle = avatarColor;
ctx.fillRect(barX, barY, barWidth * progress, barHeight);
ctx.beginPath();
ctx.arc(barX + barWidth * progress, barY + barHeight / 2, 8, 0, Math.PI * 2);
ctx.fillStyle = avatarColor;
ctx.fill();
ctx.font = "20px Arial";
ctx.fillStyle = "#FFFFFF";
ctx.textAlign = "left";
ctx.fillText(currentTime, barX, barY + barHeight + 20);
ctx.textAlign = "right";
ctx.fillText(time, barX + barWidth, barY + barHeight + 20);
const iconY = barY - 50;
const iconSize = 20;
const spacing = 70;
const centerX = canvas.width / 2;
ctx.fillStyle = "#FFFFFF";
ctx.beginPath();
ctx.moveTo(centerX - spacing*2, iconY);
ctx.lineTo(centerX - spacing*2, iconY + iconSize);
ctx.lineTo(centerX - spacing*2 + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
ctx.beginPath();
ctx.moveTo(centerX - spacing*2 + 10, iconY);
ctx.lineTo(centerX - spacing*2 + 10, iconY + iconSize);
ctx.lineTo(centerX - spacing*2 + 10 + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
const pauseWidth = 6;
const pauseHeight = iconSize;
ctx.fillRect(centerX - spacing/2, iconY, pauseWidth, pauseHeight);
ctx.fillRect(centerX - spacing/2 + 12, iconY, pauseWidth, pauseHeight);
ctx.beginPath();
ctx.moveTo(centerX + spacing, iconY);
ctx.lineTo(centerX + spacing, iconY + iconSize);
ctx.lineTo(centerX + spacing + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
ctx.beginPath();
ctx.moveTo(centerX + spacing + 10, iconY);
ctx.lineTo(centerX + spacing + 10, iconY + iconSize);
ctx.lineTo(centerX + spacing + 10 + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
return canvas.toBuffer("image/png");
}

//★・・・・・★・ CARD MUSICA2・・・★・・・・・・★
async function canvaMusicCard2( avatarUrl, artistName, time, songName,
progress = 0.5, currentTime = "02:54" ) {
progress = Math.max(0, Math.min(1, Number(progress) || 0));
const canvas = createCanvas(900, 500);
const ctx = canvas.getContext("2d");
const avatar = await loadImage(avatarUrl);
let mainColor = "#7b00ff";
let darkColor = "#120018";
try {
const palette = await Vibrant.from(avatarUrl).getPalette();
mainColor = palette.Vibrant?.hex || mainColor;
darkColor = palette.DarkMuted?.hex || darkColor;
} catch {}
const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
bg.addColorStop(0, mainColor);
bg.addColorStop(1, darkColor);
ctx.fillStyle = bg;
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "rgba(0,0,0,0.45)";
ctx.fillRect(0, 0, canvas.width, canvas.height);
for (let i = 0; i < 2000; i++) {
ctx.fillStyle = "rgba(255,255,255,0.02)";
ctx.fillRect(
Math.random() * canvas.width,
Math.random() * canvas.height,
1, 1 );
}
ctx.fillStyle = "rgba(0,0,0,0.6)";
ctx.fillRect(0, 0, canvas.width, 45);
ctx.strokeStyle = "rgba(255,255,255,0.1)";
ctx.strokeRect(0, 0, canvas.width, 45);
ctx.font = "16px Arial";
ctx.fillStyle = "#fff";
ctx.fillText("All Songs   Artists   Playlist   Albums   Genres   Rating   Search", 20, 28);
const panelX = canvas.width - 260;
ctx.fillStyle = "rgba(0,0,0,0.4)";
ctx.fillRect(panelX, 45, 260, canvas.height - 120);
ctx.fillStyle = "rgba(255,255,255,0.1)";
ctx.fillRect(panelX, 45, 260, 35);
ctx.fillStyle = "#fff";
ctx.font = "bold 16px Arial";
ctx.fillText("Now Playing List", panelX + 15, 68);
const tracks = [
"Matue morte autotune",
"Another Day In Paradise",
songName,
"Projota moleque de vila ",
"Ed rock foda se"
];
tracks.forEach((t, i) => {
const y = 110 + i * 40;
if (t === songName) {
ctx.fillStyle = "rgba(0,150,255,0.3)";
ctx.fillRect(panelX, y - 20, 260, 32);
ctx.fillStyle = "#00ccff";
} else {
ctx.fillStyle = "#fff";
}
ctx.font = "16px Arial";
ctx.fillText(t, panelX + 15, y);
});
const size = 220;
const x = 40;
const y = 80;
ctx.shadowColor = mainColor;
ctx.shadowBlur = 25;
ctx.drawImage(avatar, x, y, size, size);
ctx.shadowBlur = 0;
ctx.fillStyle = "#fff";
ctx.font = "bold 34px Arial";
ctx.fillText(artistName, x + size + 40, y + 40);
ctx.font = "22px Arial";
ctx.fillStyle = "rgba(255,255,255,0.6)";
ctx.fillText("Unknown Album", x + size + 40, y + 80);
ctx.font = "bold 28px Arial";
ctx.fillStyle = "#fff";
ctx.fillText(songName, x, y + size + 55);
const barWidth = 600;
const barHeight = 10;
const barX = x;
const barY = y + size + 85;
ctx.fillStyle = "rgba(255,255,255,0.15)";
ctx.fillRect(barX, barY, barWidth, barHeight);
const gradBar = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
gradBar.addColorStop(0, mainColor);
gradBar.addColorStop(1, "#ffffff");
ctx.fillStyle = gradBar;
ctx.fillRect(barX, barY, barWidth * progress, barHeight);
const cx = barX + barWidth * progress;
const cy = barY + barHeight / 2;
ctx.shadowColor = mainColor;
ctx.shadowBlur = 15;
ctx.beginPath();
ctx.arc(cx, cy, 7, 0, Math.PI * 2);
ctx.fillStyle = "#fff";
ctx.fill();
ctx.shadowBlur = 0;
ctx.font = "16px Arial";
ctx.fillStyle = "#fff";
ctx.textAlign = "left";
ctx.fillText(currentTime, barX, barY + 30);
ctx.textAlign = "right";
ctx.fillText(time, barX + barWidth, barY + 30);
const bottomY = canvas.height - 75;
ctx.fillStyle = "rgba(0,0,0,0.6)";
ctx.fillRect(0, bottomY, canvas.width, 75);
const btnY = bottomY + 38;
const centerX = canvas.width / 2;
ctx.fillStyle = "#fff";
ctx.beginPath();
ctx.moveTo(centerX - 10, btnY - 12);
ctx.lineTo(centerX - 10, btnY + 12);
ctx.lineTo(centerX + 12, btnY);
ctx.fill();
ctx.fillRect(centerX - 60, btnY - 10, 6, 20);
ctx.beginPath();
ctx.moveTo(centerX - 40, btnY - 12);
ctx.lineTo(centerX - 40, btnY + 12);
ctx.lineTo(centerX - 58, btnY);
ctx.fill();
ctx.fillRect(centerX + 45, btnY - 10, 6, 20);
ctx.beginPath();
ctx.moveTo(centerX + 45, btnY - 12);
ctx.lineTo(centerX + 45, btnY + 12);
ctx.lineTo(centerX + 63, btnY);
ctx.fill();
return canvas.toBuffer("image/png");
}

//★・・・・・★・ FONTES TEXTO・・・★・・・・・・★
/*registerFont(__dirname + '/fonts/NotoColorEmoji.ttf', { family: 'NotoColorEmoji' });

const canvas = createCanvas(512, 512);
const ctx = canvas.getContext('2d');
ctx.font = '80px "NotoColorEmoji"';
ctx.fillText('😄😎', 256, 256);


const fontes = [
  "Roboto.ttf",
  "Roboto-BlackItalic.ttf",
  "Roboto-Bold.ttf",
  "Roboto-BoldItalic.ttf",
  "Roboto-ExtraBold.ttf",
  "Roboto-ExtraBoldItalic.ttf",
  "Roboto-ExtraLight.ttf",
  "Roboto-ExtraLightItalic.ttf",
  "Roboto-Italic.ttf",
  "Roboto_SemiCondensed-ThinItalic.ttf",
  "Roboto_Condensed-Thin.ttf",
  "Roboto_Condensed-SemiBoldItalic.ttf",
  "Roboto_Condensed-LightItalic.ttf",
  "Roboto_Condensed-ExtraBold.ttf",
  "Roboto-ThinItalic.ttf",
  "Roboto-SemiBold.ttf",
  "Roboto-LightItalic.ttf",
  "Roboto_SemiCondensed-Thin.ttf"
];

const FONTS_DIR = path.join(__dirname, "public", "static", "fonts")
fontes.forEach(f => {
const filePath = path.join(FONTS_DIR, f)
if (fs.existsSync(filePath)) {
registerFont(filePath, {
family: f.replace(".ttf", "")
})
} else {
console.log("Fonte não encontrada:", filePath)
}
})

function corAleatoria() {
return `rgb(${Math.random()*255|0},${Math.random()*255|0},${Math.random()*255|0})`;
}

//★・・・・・★・ CANVAS BEM VINDO・・・★・・・・・・★
async function CanvabemVindo(titulo, avatarUrl, fundo, desc, nome) {
try {
const width = 1280
const height = 720
const canvas = createCanvas(width, height)
const ctx = canvas.getContext('2d')
if (fundo.startsWith('#')) {
ctx.fillStyle = fundo
ctx.fillRect(0, 0, width, height)
} else {
try {
const bg = await loadImage(fundo)
ctx.drawImage(bg, 0, 0, width, height)
} catch {
ctx.fillStyle = '#1f1f1f'
ctx.fillRect(0, 0, width, height)
}}
const shadowX = 120
const shadowY = 220
const shadowWidth = 1040
const shadowHeight = 260
const shadowRadius = 30
ctx.fillStyle = 'rgba(0,0,0,0.15)' // sombra mais transparente
roundRect(ctx, shadowX, shadowY, shadowWidth, shadowHeight, shadowRadius, true, false)
const cardX = 100
const cardY = 200
const cardWidth = 1080
const cardHeight = 300
const cardRadius = 30
ctx.fillStyle = 'rgba(0,0,0,0.6)' // preto semi-transparente
roundRect(ctx, cardX, cardY, cardWidth, cardHeight, cardRadius, true, false)
if (avatarUrl) {
try {
const avatar = await loadImage(avatarUrl)
const avatarSize = 180
const avatarX = cardX + 40
const avatarY = cardY + (cardHeight / 2) - (avatarSize / 2)
ctx.save()
ctx.beginPath()
ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true)
ctx.closePath()
ctx.clip()
ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize)
ctx.restore()
ctx.strokeStyle = '#00ffff'
ctx.lineWidth = 6
ctx.beginPath()
ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2)
ctx.stroke()
} catch {
console.log("Avatar inválido, ignorado")
}}
const textX = cardX + 260
let textY = cardY + 80
ctx.fillStyle = '#00ffff'
ctx.font = 'bold 60px Sans'
ctx.fillText(titulo, textX, textY)
ctx.fillStyle = '#ffffff'
ctx.font = '50px Sans'
textY += 70
ctx.fillText(nome, textX, textY)
ctx.fillStyle = '#d1d5db'
ctx.font = '35px Sans'
textY += 60
const lines = splitText(ctx, desc, cardWidth - 300)
lines.forEach(line => {
ctx.fillText(line, textX, textY)
textY += 45
})
return canvas.toBuffer('image/png')
} catch (err) {
console.error("Erro CanvabemVindo:", err)
throw err
}}
function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
if (typeof radius === 'number') {
radius = { tl: radius, tr: radius, br: radius, bl: radius }
} else {
const defaultRadius = { tl: 0, tr: 0, br: 0, bl: 0 }
for (let side in defaultRadius) radius[side] = radius[side] || 0
}
ctx.beginPath()
ctx.moveTo(x + radius.tl, y)
ctx.lineTo(x + width - radius.tr, y)
ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr)
ctx.lineTo(x + width, y + height - radius.br)
ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height)
ctx.lineTo(x + radius.bl, y + height)
ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl)
ctx.lineTo(x, y + radius.tl)
ctx.quadraticCurveTo(x, y, x + radius.tl, y)
ctx.closePath()
if (fill) ctx.fill()
if (stroke) ctx.stroke()
}
function splitText(ctx, text, maxWidth) {
const words = text.split(' ')
const lines = []
let line = ''
for (let n = 0; n < words.length; n++) {
const testLine = line + words[n] + ' '
const metrics = ctx.measureText(testLine)
if (metrics.width > maxWidth && n > 0) {
lines.push(line.trim())
line = words[n] + ' '
} else {
line = testLine
}
}
lines.push(line.trim())
return lines
}

//★・・・・・★・ CANVAS BEM VINDO2・・・★・・・・・・★
async function CanvabemVindo2(titulo, avatarUrl, fundo, desc, nome) {
try {
const width = 1280
const height = 720
const canvas = createCanvas(width, height)
const ctx = canvas.getContext('2d')
const borderRadius = 40
ctx.save()
roundRect(ctx, 0, 0, width, height, borderRadius, true, false)
ctx.clip()
if (fundo.startsWith('#')) {
ctx.fillStyle = fundo
ctx.fillRect(0, 0, width, height)
} else {
try {
const bg = await loadImage(fundo)
ctx.drawImage(bg, 0, 0, width, height)
} catch {
ctx.fillStyle = '#1f1f1f'
ctx.fillRect(0, 0, width, height)
}}
ctx.restore()
ctx.strokeStyle = '#a1a1a1'
ctx.lineWidth = 8
roundRect(ctx, 0, 0, width, height, borderRadius, false, true)
if (avatarUrl) {
try {
const avatar = await loadImage(avatarUrl)
const avatarSize = 320
const avatarX = width / 2 - avatarSize / 2
const avatarY = 80
ctx.save()
ctx.beginPath()
ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true)
ctx.closePath()
ctx.clip()
ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize)
ctx.restore()
ctx.strokeStyle = '#ffffff'
ctx.lineWidth = 8
ctx.beginPath()
ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2)
ctx.stroke()
} catch {
console.log("Avatar inválido, ignorado")
}}
const centerX = width / 2
let textY = 460 // pouco abaixo do avatar
ctx.fillStyle = '#d1d5db'
ctx.font = 'bold 70px Sans'
let tituloWidth = ctx.measureText(titulo).width
ctx.fillText(titulo, centerX - tituloWidth / 2, textY)
ctx.font = '55px Sans'
textY += 70
const nomeX = centerX - ctx.measureText(nome).width / 2
const nomeY = textY
ctx.lineWidth = 6
ctx.strokeStyle = '#000000'
ctx.strokeText(nome, nomeX, nomeY)
ctx.fillStyle = '#d1d5db'
ctx.fillText(nome, nomeX, nomeY)
ctx.fillStyle = '#d1d5db'
ctx.font = '40px Sans'
textY += 60
const lines = splitText(ctx, desc, width - 200)
lines.forEach(line => {
let lineWidth = ctx.measureText(line).width
ctx.fillText(line, centerX - lineWidth / 2, textY)
textY += 45
})
return canvas.toBuffer('image/png')
} catch (err) {
console.error("Erro CanvabemVindo:", err)
throw err
}}
function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
if (typeof radius === 'number') {
radius = { tl: radius, tr: radius, br: radius, bl: radius }
} else {
const defaultRadius = { tl: 0, tr: 0, br: 0, bl: 0 }
for (let side in defaultRadius) radius[side] = radius[side] || 0
}
ctx.beginPath()
ctx.moveTo(x + radius.tl, y)
ctx.lineTo(x + width - radius.tr, y)
ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr)
ctx.lineTo(x + width, y + height - radius.br)
ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height)
ctx.lineTo(x + radius.bl, y + height)
ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl)
ctx.lineTo(x, y + radius.tl)
ctx.quadraticCurveTo(x, y, x + radius.tl, y)
ctx.closePath()
if (fill) ctx.fill()
if (stroke) ctx.stroke()
}
function splitText(ctx, text, maxWidth) {
const words = text.split(' ')
const lines = []
let line = ''
for (let n = 0; n < words.length; n++) {
const testLine = line + words[n] + ' '
const metrics = ctx.measureText(testLine)
if (metrics.width > maxWidth && n > 0) {
lines.push(line.trim())
line = words[n] + ' '
} else {
line = testLine
}}
lines.push(line.trim())
return lines
}

//★・・・・・★・ CANVAS LEVEL・・・★・・・・・・★
async function canvaLevel(avatar, fundo, nome, level1, level2) {
level1 = Number(level1)
level2 = Number(level2 || 100)
const width = 1280
const height = 720
const canvas = createCanvas(width, height)
const ctx = canvas.getContext("2d")
const bg = await loadImage(fundo)
ctx.drawImage(bg, 0, 0, width, height)
ctx.fillStyle = "rgba(0,0,0,0.55)"
ctx.fillRect(0, 0, width, height)
ctx.fillStyle = "rgba(20,20,20,0.85)"
ctx.fillRect(80, 180, 1120, 360)
ctx.strokeStyle = "#ff0000"
ctx.lineWidth = 4
ctx.strokeRect(80, 180, 1120, 360)
const imgAvatar = await loadImage(avatar)
const avatarSize = 200
const ax = 130
const ay = 260
ctx.save()
ctx.beginPath()
ctx.arc(ax + avatarSize/2, ay + avatarSize/2, avatarSize/2, 0, Math.PI * 2)
ctx.clip()
ctx.drawImage(imgAvatar, ax, ay, avatarSize, avatarSize)
ctx.restore()
ctx.strokeStyle = "#ff0000"
ctx.lineWidth = 6
ctx.beginPath()
ctx.arc(ax + avatarSize/2, ay + avatarSize/2, avatarSize/2, 0, Math.PI * 2)
ctx.stroke()
ctx.font = "bold 46px Arial"
ctx.fillStyle = "#ffffff"
ctx.fillText(nome, 380, 280)
const levelBubbleX = 420
const nextBubbleX = 540
const bubbleY = 350
const bubbleRadius = 45
ctx.textAlign = "center"
ctx.textBaseline = "middle"
ctx.fillStyle = "#000000"
ctx.strokeStyle = "#ff0000"
ctx.lineWidth = 4
ctx.beginPath()
ctx.arc(levelBubbleX, bubbleY, bubbleRadius, 0, Math.PI * 2)
ctx.fill()
ctx.stroke()
ctx.font = "bold 28px Arial"
ctx.fillStyle = "#ff4444"
ctx.fillText(level1.toString(), levelBubbleX, bubbleY)
ctx.beginPath()
ctx.arc(nextBubbleX, bubbleY, bubbleRadius, 0, Math.PI * 2)
ctx.fill()
ctx.stroke()
ctx.fillStyle = "#ffffff"
ctx.fillText(level2.toString(), nextBubbleX, bubbleY)
ctx.font = "bold 22px Arial"
ctx.fillStyle = "#cccccc"
ctx.fillText("LEVEL", levelBubbleX, bubbleY + bubbleRadius + 25)
ctx.fillText("NEXT", nextBubbleX, bubbleY + bubbleRadius + 25)
const barX = 380
const barY = 450
const barWidth = 700
const barHeight = 28
ctx.fillStyle = "#111"
ctx.fillRect(barX, barY, barWidth, barHeight)
ctx.strokeStyle = "#ff0000"
ctx.lineWidth = 3
ctx.strokeRect(barX, barY, barWidth, barHeight)
const progress = Math.min(level1 / level2, 1)
const grad = ctx.createLinearGradient(barX, barY, barX + barWidth, barY)
grad.addColorStop(0, "#ff0000")
grad.addColorStop(1, "#990000")
ctx.fillStyle = grad
ctx.fillRect(barX, barY, barWidth * progress, barHeight)
ctx.strokeStyle = "rgba(255,255,255,0.15)"
for (let i = 0; i < barWidth; i += 40) {
ctx.beginPath()
ctx.moveTo(barX + i, barY)
ctx.lineTo(barX + i, barY + barHeight)
ctx.stroke()
}
const percent = Math.floor(progress * 100)
ctx.font = "bold 22px Arial"
ctx.fillStyle = "#ffffff"
ctx.fillText(`${percent}%`, barX + barWidth + 40, barY + barHeight / 2)
return canvas.toBuffer("image/png")
}


//★・・・・・★・ CANVAS MUSICA・・・★・・・・・・★
async function getAverageColor(url) {
const img = await loadImage(url);
const canvas = createCanvas(img.width, img.height);
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0, img.width, img.height);
const data = ctx.getImageData(0, 0, img.width, img.height).data;
let r = 0, g = 0, b = 0, count = 0;
for (let i = 0; i < data.length; i += 4) {
r += data[i];
g += data[i+1];
b += data[i+2];
count++;
}
r = Math.round(r / count);
g = Math.round(g / count);
b = Math.round(b / count);
return `rgb(${r},${g},${b})`;
}

async function canvaMusicCard(avatarUrl, artistName, time, songName, progress = 0.5, currentTime = "00:39") {
const fundo = await loadImage("https://files.catbox.moe/yeitfq.jpg");
const canvas = createCanvas(fundo.width, fundo.height);
const ctx = canvas.getContext("2d");
const borderRadius = 30;
ctx.beginPath();
ctx.moveTo(borderRadius, 0);
ctx.lineTo(canvas.width - borderRadius, 0);
ctx.quadraticCurveTo(canvas.width, 0, canvas.width, borderRadius);
ctx.lineTo(canvas.width, canvas.height - borderRadius);
ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - borderRadius, canvas.height);
ctx.lineTo(borderRadius, canvas.height);
ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - borderRadius);
ctx.lineTo(0, borderRadius);
ctx.quadraticCurveTo(0, 0, borderRadius, 0);
ctx.closePath();
ctx.clip(); // aplica a máscara
ctx.drawImage(fundo, 0, 0, fundo.width, fundo.height);
ctx.fillStyle = 'rgba(0,0,0,0.2)';
ctx.shadowColor = 'rgba(0,0,0,0.4)';
ctx.shadowBlur = 20;
ctx.fillRect(0, 0, canvas.width, canvas.height);
const avatar = await loadImage(avatarUrl);
const avatarSize = 150;
const avatarX = (canvas.width / 2) - (avatarSize / 2);
const avatarY = 50;
ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
const avatarColor = await getAverageColor(avatarUrl);
ctx.strokeStyle = avatarColor;
ctx.lineWidth = 6;
ctx.strokeRect(avatarX, avatarY, avatarSize, avatarSize);
ctx.fillStyle = "#FFFFFF";
ctx.font = "bold 28px Arial";
ctx.textAlign = "center";
ctx.fillText(songName, canvas.width / 2, avatarY + avatarSize + 40);
ctx.font = "24px Arial";
ctx.fillText(artistName, canvas.width / 2, avatarY + avatarSize + 80);
const barWidth = canvas.width - 120; 
const barHeight = 14;
const barX = 60;
const barY = avatarY + avatarSize + 160;
ctx.shadowBlur = 0;
ctx.fillStyle = 'rgba(255,255,255,0.2)';
ctx.fillRect(barX, barY, barWidth, barHeight);
ctx.fillStyle = avatarColor;
ctx.fillRect(barX, barY, barWidth * progress, barHeight);
ctx.beginPath();
ctx.arc(barX + barWidth * progress, barY + barHeight / 2, 8, 0, Math.PI * 2);
ctx.fillStyle = avatarColor;
ctx.fill();
ctx.font = "20px Arial";
ctx.fillStyle = "#FFFFFF";
ctx.textAlign = "left";
ctx.fillText(currentTime, barX, barY + barHeight + 20);
ctx.textAlign = "right";
ctx.fillText(time, barX + barWidth, barY + barHeight + 20);
const iconY = barY - 50;
const iconSize = 20;
const spacing = 70;
const centerX = canvas.width / 2;
ctx.fillStyle = "#FFFFFF";
ctx.beginPath();
ctx.moveTo(centerX - spacing*2, iconY);
ctx.lineTo(centerX - spacing*2, iconY + iconSize);
ctx.lineTo(centerX - spacing*2 + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
ctx.beginPath();
ctx.moveTo(centerX - spacing*2 + 10, iconY);
ctx.lineTo(centerX - spacing*2 + 10, iconY + iconSize);
ctx.lineTo(centerX - spacing*2 + 10 + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
const pauseWidth = 6;
const pauseHeight = iconSize;
ctx.fillRect(centerX - spacing/2, iconY, pauseWidth, pauseHeight);
ctx.fillRect(centerX - spacing/2 + 12, iconY, pauseWidth, pauseHeight);
ctx.beginPath();
ctx.moveTo(centerX + spacing, iconY);
ctx.lineTo(centerX + spacing, iconY + iconSize);
ctx.lineTo(centerX + spacing + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
ctx.beginPath();
ctx.moveTo(centerX + spacing + 10, iconY);
ctx.lineTo(centerX + spacing + 10, iconY + iconSize);
ctx.lineTo(centerX + spacing + 10 + iconSize, iconY + iconSize/2);
ctx.closePath();
ctx.fill();
return canvas.toBuffer("image/png");
}

//★・・・・・★・ CANVAS ATP FIGU TEXTO・・・★・・・・・・★
async function gerarStickerFonte(texto, fonteFamily) {
const canvas = createCanvas(512, 512)
const ctx = canvas.getContext("2d")
ctx.clearRect(0, 0, 512, 512)
ctx.textAlign = "center"
ctx.textBaseline = "middle"
ctx.font = `bold 80px "${fonteFamily}"`
ctx.fillStyle = corAleatoria()
ctx.fillText(texto, 256, 256, 480)
const buffer = canvas.toBuffer("image/png")
const webp = await sharp(buffer)
.webp({ quality: 90 })
.toBuffer()
return webp
}

//★・・★・ CANVAS ATTP FIGU TEXTO GIF・・・★・・・・・・★
async function gerarGifAnimadoFonte(texto, family = "Arial") {
const encoder = new GIFEncoder(512, 512)
const canvas = createCanvas(512, 512)
const ctx = canvas.getContext("2d")
encoder.start()
encoder.setRepeat(0)   // 0 = loop infinito
encoder.setDelay(200)  // 200ms entre frames
encoder.setQuality(10) // 1-30, menor = melhor
for (let i = 0; i < 8; i++) {
ctx.clearRect(0, 0, 512, 512)
ctx.textAlign = "center"
ctx.textBaseline = "middle"
ctx.font = `bold 80px "${family}"`
if (i % 2 === 0) {
ctx.fillStyle = corAleatoria()
ctx.fillText(texto, 256, 256, 480)
}
encoder.addFrame(ctx)
}
encoder.finish()
const buffer = encoder.out.getData()
return buffer
}

//★・・★・ CANVAS BRAIT TEXTO・・・★・・・・・・★
async function gerarStickerBraitComEmoji(texto, family = "Arial") {
try {
const canvas = createCanvas(512, 512);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#FFFFFF";
ctx.fillRect(0, 0, 512, 512);
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.font = `bold 80px "${family}"`;
ctx.fillStyle = "#000000"; // Letras pretas
const regex = emojiRegex();
const emojis = [...texto.matchAll(regex)];
const textoSemEmoji = texto.replace(regex, '');
ctx.fillText(textoSemEmoji, 256, 256, 480);
if (emojis.length > 0) {
ctx.font = `80px "${family}"`; 
for (let j = 0; j < emojis.length; j++) {
const emoji = emojis[j][0];
const x = 256 + (j * 60) - (emojis.length * 30);
const y = 350;
ctx.fillText(emoji, x, y);
}}
const buffer = canvas.toBuffer("image/png");
const webp = await sharp(buffer).webp({ quality: 90 }).toBuffer();
return webp;
} catch (err) {
console.error("Erro na função gerarStickerBraitComEmoji:", err);
throw new Error("Erro ao gerar sticker Brait");
}
}

//★・・・・・・★・・・ GERAR CPF ・・・★・・・・・・★
function gerarCPF() {
let n = '';
for (let i = 0; i < 9; i++) {
n += Math.floor(Math.random() * 10);
}
const cpf = n.split('');
let v1 = 0;
let v2 = 0;
for (let i = 0; i < 9; i++) {
v1 += cpf[i] * (10 - i);
v2 += cpf[i] * (11 - i);
}
v1 = (v1 % 11) < 2 ? 0 : 11 - (v1 % 11);
cpf.push(v1);
v2 += v1 * 2;
v2 = (v2 % 11) < 2 ? 0 : 11 - (v2 % 11);
cpf.push(v2);
return cpf.join('');
}
*/
//★・・・・LISTA DE PLAQUINHAS ・・・★・・・・・・★
const plaquinhas = [
  {
    id: 1,
    url: 'https://raptibef.sirv.com/images%20(3).jpeg?text.0.text={text}&text.0.position.gravity=center&text.0.position.x=19%25&text.0.size=45&text.0.color=000000&text.0.opacity=55&text.0.font.family=Crimson%20Text&text.0.font.weight=300&text.0.font.style=italic&text.0.outline.opacity=21'
  },
  {
    id: 2,
    url: 'https://umethroo.sirv.com/BUNDA1.jpg?text.0.text={text}&text.0.position.x=-20%25&text.0.position.y=-20%25&text.0.size=18&text.0.color=000000&text.0.font.family=Architects%20Daughter&text.0.font.weight=700&text.0.background.opacity=65'
  },
  {
    id: 3,
    url: 'https://umethroo.sirv.com/bunda3.jpg?text.0.text={text}&text.0.position.gravity=center&text.0.position.x=-25%25&text.0.position.y=-17%25&text.0.size=17&text.0.color=000000&text.0.font.family=Architects%20Daughter&text.0.font.weight=700&text.0.font.style=italic'
  },
  {
    id: 4,
    url: 'https://umethroo.sirv.com/peito1.jpg?text.0.text={text}&text.0.position.x=-48%25&text.0.position.y=-68%25&text.0.size=14&text.0.color=000000&text.0.font.family=Shadows%20Into%20Light&text.0.font.weight=700'
  },
  {
    id: 5,
    url: 'https://umethroo.sirv.com/9152e7a9-7d49-48ef-b8ac-2e6149fda0b2.jpg?text.0.text={text}&text.0.position.x=-70%25&text.0.position.y=-23%25&text.0.size=17&text.0.color=000000&text.0.font.family=Architects%20Daughter&text.0.font.weight=300'
  },
  {
    id: 6,
    url: 'https://clutamac.sirv.com/1011b781-bab1-49e3-89db-ee2c064868fa%20(1).jpg?text.0.text={text}&text.0.position.gravity=northwest&text.0.position.x=22%25&text.0.position.y=60%25&text.0.size=12&text.0.color=000000&text.0.opacity=47&text.0.font.family=Roboto%20Mono&text.0.font.style=italic'
  },
  {
    id: 7,
    url: 'https://umethroo.sirv.com/Torcedora-da-sele%C3%A7%C3%A3o-brasileira-nua-mostrando-a-bunda-236x300.jpg?text.0.text={text}&text.0.position.x=-64%25&text.0.position.y=-39%25&text.0.size=25&text.0.color=1b1a1a&text.0.font.family=Architects%20Daughter'
  }];
  
//★・・・・GETBUFFER PARA IMG ・・・★・・・・・・★
const getBuffer = (url, options) => new Promise(async (resolve, reject) => { 
options ? options : {}
await axios({method: "get", url, headers: {"DNT": 1, "Upgrade-Insecure-Request": 1}, ...options, responseType: "arraybuffer"}).then((res) => {
resolve(res.data)
}).catch(reject)
})

//★・PARA PUXAR O JSON DE UM SITE ・・・★・・・・・・
async function fetchJson (url, options) {
try {
options ? options : {}
const res = await axios({
method: 'GET',
url: url,
headers: {
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36' },
...options })
return res.data
} catch (err) {
return err
}
}

//★・・・・・・★・・・ MIDDLEWARES ・・・★・・・・・・★
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
//
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'change_me_cookie_secret'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Funções de persistência centralizadas no serviço de usuários.
const loadUsers = () => ensureAllUsersSaaS(loadUsersFromStore());
const saveUsers = (users) => saveUsersToStore(users);

function gerarRandomKey() {
return randomApiKey();
}

const REQUESTS_PER_CYCLE = 10;
const REQUEST_RESET_MS = 24 * 60 * 60 * 1000;

function toBoolean(value) {
if (typeof value === "boolean") return value;
if (typeof value === "number") return value === 1;
if (typeof value === "string") {
const v = value.trim().toLowerCase();
return v === "true" || v === "1" || v === "sim" || v === "yes";
}
return false;
}

function renewRequestsIfNeeded(user) {
const now = Date.now();
const lastResetRaw = user.lastRequestResetAt ? new Date(user.lastRequestResetAt).getTime() : NaN;
const isVip = toBoolean(user.vip);
const isUnlimited = toBoolean(user.ilimitado);

// VIP e Ilimitado não entram no ciclo de reset de requests.
if (isVip || isUnlimited) {
if (!Number.isFinite(lastResetRaw)) {
user.lastRequestResetAt = new Date(now).toISOString();
return true;
}
return false;
}

// Migração para usuários antigos: inicia o ciclo atual com 10 requests.
if (!Number.isFinite(lastResetRaw)) {
user.request = REQUESTS_PER_CYCLE;
user.lastRequestResetAt = new Date(now).toISOString();
return true;
}

if (now - lastResetRaw >= REQUEST_RESET_MS) {
// Sem acumular: sempre volta exatamente para 10.
user.request = REQUESTS_PER_CYCLE;
user.lastRequestResetAt = new Date(now).toISOString();
return true;
}
return false;
}

const usarApiKey = (apikey, jujus) => {
let users = loadUsers();
const found = findUserByApiKey(users, apikey);
if (!found) return "API Key inválida";

const { user, apiKeyRecord } = found;
if (apiKeyRecord && apiKeyRecord.status !== "active") {
return "API Key bloqueada";
}

const rateCheck = checkRateLimit(apikey, apiKeyRecord?.rate_limit || 60);
if (!rateCheck.ok) return rateCheck.message;

resetMonthlyQuota(user);
const quotaCheck = checkQuota(user, apiKeyRecord);
if (!quotaCheck.ok) return quotaCheck.message;

const renewed = renewRequestsIfNeeded(user);
const isUnlimited = toBoolean(user.ilimitado);

if (isUnlimited) {
incrementUsage(user);
user.level = (parseFloat(user.level || 0) + 0.1).toFixed(1);
saveUsers(users);
return null;
}

if (Number(user.request || 0) <= 0) return "Sem requests disponíveis";
user.request -= 1;
incrementUsage(user);
user.level = (parseFloat(user.level || 0) + 0.1).toFixed(1);
if (renewed) {
consoleAviso(`Requests renovados para ${user.username}: ${REQUESTS_PER_CYCLE}`);
}
saveUsers(users);
return null;
};
//★・・・・・・★・ PARA O UPLOAD  ・・・★・・・・・・★
//Configuração de armazenamento do multer->
const storage = multer.diskStorage({
destination: (req, file, cb) => {
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
fs.mkdirSync(uploadDir);
}
cb(null, uploadDir);
},
filename: (req, file, cb) => {
cb(null, Date.now() + path.extname(file.originalname));
}
});

const upload = multer({ storage });
//Servir a página HTML->
app.get('/upload', (req, res) => res.sendFile(path.join(__dirname, './public/assets/upload.html')));

function getPublicBaseUrl(req) {
const fixedBase = String(process.env.APP_PUBLIC_URL || "").trim();
if (fixedBase) return fixedBase.replace(/\/+$/, "");
const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
const host = req.headers["x-forwarded-host"] || req.get("host");
return `${proto}://${host}`;
}

//Rota de upload único->
app.post('/upload/single', upload.single('file'), (req, res) => {
if (!req.file) {
return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
}
const fileUrl = `${getPublicBaseUrl(req)}/uploads/${req.file.filename}`;
res.json({ fileUrl });
});

//Rota de upload múltiplo->
app.post('/upload/multi', upload.array('files', 10), (req, res) => {
if (!req.files || req.files.length === 0) {
return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
}
const fileUrls = req.files.map(file => `${getPublicBaseUrl(req)}/uploads/${file.filename}`);
res.json({ fileUrls });
});

//Servir arquivos estáticos da pasta uploads->
app.use(express.static(path.join('./public', '/')));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/deletimg', async (req, res, next) => {
const { idImg, apikey } = req.query;
if (!idImg) {
return res.json({ resposta: "Faltou o parâmetro 'idImg' na query" });
}
if (!apikey) {
return res.json({ resposta: "Faltou o parâmetro 'apikey' na query" });
}
const apikeyAdm = String(process.env.ADMIN_DELETE_API_KEYS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!apikeyAdm.includes(apikey)) {return res.json({ resposta: "API key inválida ou não autorizada." });}

const itemPath = `./uploads/${idImg}`
DLT_FL(itemPath);
        
return res.json({ resposta: "Esse arquivo/pasta já foi apagado do servidor" });

});
//★・・・・・・★・・・ ROTAS ・・・★・・・・・・★
function getClientIP(req) {
return req.headers['x-forwarded-for']?.split(',').shift() || req.socket.remoteAddress;
}

// Rotas modulares (nova arquitetura SaaS) mantidas com compatibilidade legada.
app.use(authRoutes);
app.use(adminRoutes);
app.use(puxadasRoutes);

app.get('/', (req, res) => {
  res.render('login');
});
app.get('/login', (req, res) => {
  res.render('login');
});
app.get('/registro', (req, res) => {
  res.render('regis');
});

function isProduction(req) {
return req.hostname === "api.dfstech.sbs";
}

//docs->
app.get("/docs", (req, res) => {
const { username } = req.signedCookies; 
const users = loadUsers();
const user = users[username];
if (user) {
const { senha, adm, apikey, request, level, foto, nick, ilimitado } = user;
const topUsers = Object.entries(users)
.map(([username, data]) => ({
username,
nick: data.nick || data.username, // fallback se não existir
level: data.level || 0,
foto: data.foto }))
.sort((a, b) => b.level - a.level)
.slice(0, 5);
res.render("docs", {
  username,      // login
  nick,          // nome público
  senha,
  apikey,
  request,
  ilimitado,
  foto: fotoApi, // sanitize se for input do usuário
  level,
  topUsers,
  adm, 
  nomeApi,
  criador, 
  wallpaper: wallpaperApi,
  musica: musicaApi,
  fotoApi });
} else {
res.redirect("/login");
}
});

//adm->
app.get("/adm", async (req, res) => {
try {
const { username } = req.signedCookies;
if (!username) return res.redirect("/login");
const users = loadUsers();
const user = users[username];
if (!user) return res.redirect("/login");
if (!user.adm) return res.status(401).sendFile(path.join(__dirname, 'public', 'assets', 'aviso.html'));
const { adm, request, level, foto, apikey } = user;
let fotoSegura = fotoApi;
if (typeof foto === "string" && /^https?:\/\//.test(foto)) {
fotoSegura = foto;
}
res.render("adm", {
      username,
      apikey,
      request,
      adm,
      foto: fotoSegura,
      level,
      nomeApi,
      criador,
      wallpaper: wallpaperApi,
      musica: musicaApi,
      fotoApi
    });
} catch (e) {
console.log(e);
res.redirect("/login");
}
});


//PERFIL->
app.get("/perfil", async (req, res) => {
try {
const { username } = req.signedCookies;
const users = loadUsers();
const user = users[username];
if (user) {
const { senha, apikey, request, level, foto } = user;
res.render("perfil", {
      username,
      senha,
      apikey,
      request,
      foto,
      nomeApi,
      criador, 
      wallpaper: wallpaperApi,
      musica: musicaApi,
      fotoApi
        });
} else {
res.redirect("/login");
}
} catch (e) {
console.log(e)
}
})

//★・・・・・★・・・ ROTAS DE ERRO・・・★・・・・・・★
app.use((req, res, next) => {
const originalJson = res.json;
res.json = function (data) {
if (data && data.status === false) {
const htmlPath = path.join(__dirname, "public", "assets", "erros.html");
return fs.readFile(htmlPath, "utf8", (err, html) => {
if (err) return res.status(500).send("Erro ao carregar HTML");
const errorDetails = {
mensagem: data.mensagem || data.error || data.msg || "Opa! Tosh na área! em manutenção",
detalhes: data.detalhes || data.detail || "Screep em desenvolvimento",
stack: data.stack || "",
resultado: data || {},
rota: req.path || "",       // <-- apenas o caminho da rota
metodo: req.method || "",
timestamp: new Date().toISOString()
                };
const injected = html.replace(
'<script id="inject-error"></script>',
`<script id="inject-error">window.__ERROR__ = ${JSON.stringify(errorDetails, null, 2)};</script>`
                );
return res.status(400).send(injected);
            });
        }
return originalJson.call(this, data);
    };

    next();
});

app.use((err, req, res, next) => {
console.error("Erro detectado:", err.message);
const htmlPath = path.join(__dirname, "public", "assets", "erros.html");
fs.readFile(htmlPath, "utf8", (erro, html) => {
if (erro) return res.status(500).send("Erro ao carregar HTML");
const errorDetails = {
mensagem: err.message || "Em Manutenção",
detalhes: err.detalhes || "",
stack: err.stack || "",
resultado: err.resultado || {},
rota: req.path || "",       // <-- apenas o caminho da rota
metodo: req.method || "",
timestamp: new Date().toISOString()
        };
const injected = html.replace(
'<script id="inject-error"></script>',
`<script id="inject-error">window.__ERROR__ = ${JSON.stringify(errorDetails, null, 2)};</script>`
        );
res.status(500).send(injected);
    });
});

//★・・・・・★・・・ ROTAS DE HTML・・・★・・・・・・★

app.get('/bots', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'bots.html'));
});

app.get('/dfs-tech-lab', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'dfs-tech-lab.html'));
});

app.get('/direito', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'direito.html'));
});

app.get('/toshiruzsite', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'botsJho.html'));
});

app.get('/jogos', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'jogos.html'));
});

app.get('/planos', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'planos.html'));
});

app.get('/painel', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'painel.html'));
});

app.get('/login.html', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'login.html'));
});

app.get('/dfs-tech-hosting', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'fast.html'));
});

// Compatibilidade com link antigo.
app.get('/fasthost', (req, res) => {
res.redirect('/dfs-tech-hosting');
});

app.get('/pix', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'pix.html'));
});

app.get('/dfs-tech-tube', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'tubex.html'));
});

app.get('/credito', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'creditos.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assets', 'chat.html'));
});

app.get('/logistica', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'logistica.html'));
});

app.get('/api/users', (req, res) => {
res.sendFile(path.join(__dirname, 'dono', 'users.json'));
});

app.get('/testando', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'assets', 'teste.html'), err => {
if (err) {
console.error(err);
res.status(500).send('Erro ao enviar o arquivo');
    }
  });
});

//★・・・・・・★・・・ ROTAS DE APIS・・・★・・・・・・★
const puxadasLimiter = rateLimit({
windowMs: 60 * 1000,
max: PUXADAS_RATE_LIMIT,
standardHeaders: true,
legacyHeaders: false,
message: { status: false, erro: "Muitas requisições em /api/puxadas. Aguarde 1 minuto." }
});


const PUXADAS_TYPES = [
"cpf","cpf2","cpf3","cpf4","cpf5","srs","score","score2","nacional","cnh","fotorj","rg","rg2",
"telefone","telefone2","telefone3","tel","tel2","phone","phone2","placa","placa2","placa3","placa4",
"cnpj","cnpj2","nome","nome2","email","email2","pixconsulta","wifi","cep2","bin","bin2","parentes",
"chassi","chassi1","renavam","obito","socios","vacinas","pai","cns","abreviado","cpfnacional"
];

const encodePathValuePreserveSlash = (value) =>
String(value)
.split("/")
.map((part) => encodeURIComponent(part))
.join("/");

function resolvePuxadasValue(tipo, query) {
switch (tipo) {
case "cpf":
case "cpf2":
case "cpf3":
case "cpf4":
case "cpf5":
case "srs":
case "score":
case "score2":
case "cnh":
case "fotorj":
case "cpfnacional":
return query.cpf ? String(query.cpf) : "";
case "nacional":
if (query.estado && query.cpf) return `${query.estado}_${query.cpf}`;
return "";
case "rg":
case "rg2":
return query.rg ? String(query.rg) : "";
case "telefone":
case "telefone2":
case "telefone3":
case "tel":
case "tel2":
case "phone":
case "phone2":
return String(query.telefone || query.tel || query.phone || "");
case "placa":
case "placa2":
case "placa3":
case "placa4":
return query.placa ? String(query.placa) : "";
case "cnpj":
case "cnpj2":
return query.cnpj ? String(query.cnpj) : "";
case "nome":
case "nome2":
return query.nome ? String(query.nome) : "";
case "email":
case "email2":
return query.email ? String(query.email) : "";
case "pixconsulta":
if (query.short_cpf) return `${query.short_cpf}/${query.partial_name || ""}`;
return "";
case "wifi":
if (query.lat && query.long) return `${query.lat}/${query.long}/${query.radius || 500}`;
return "";
case "cep2":
return query.cep ? String(query.cep) : "";
case "bin":
case "bin2":
return query.bin ? String(query.bin) : "";
case "parentes":
return query.parentes ? String(query.parentes) : "";
case "chassi":
case "chassi1":
return query.chassi ? String(query.chassi) : "";
case "renavam":
return query.renavam ? String(query.renavam) : "";
case "obito":
return query.obito ? String(query.obito) : "";
case "socios":
return query.socios ? String(query.socios) : "";
case "vacinas":
return query.vacinas ? String(query.vacinas) : "";
case "pai":
return query.pai ? String(query.pai) : "";
case "cns":
return query.cns ? String(query.cns) : "";
case "abreviado":
return query.abreviado ? String(query.abreviado) : "";
default:
return "";
}
}

const LEGACY_DADOS_PESSOAIS_TYPES = {
cpf: "cpf",
cnh: "cnh",
score: "score",
abreviado: "abreviado",
nome: "nome",
telefone: "telefone",
placa: "placa",
srs: "srs",
fotorj: "fotorj",
chassi1: "chassi1",
email: "email",
rg: "rg",
cep: "cep2",
cnpj: "cnpj",
obito: "obito",
bin2: "bin2",
parentes: "parentes"
};

const LEGACY_DADOS_PESSOAIS_QUERY_KEYS = {
cpf: "cpf",
cnh: "cnh",
score: "score",
abreviado: "abreviado",
nome: "nome",
telefone: "telefone",
placa: "placa",
srs: "srs",
fotorj: "fotorj",
chassi1: "chassi",
email: "email",
rg: "rg",
cep: "cep",
cnpj: "cnpj",
obito: "obito",
bin2: "bin2",
parentes: "parentes"
};

function createPuxadasHandledError(status, data) {
return { isHandled: true, status, data };
}

function valueByPath(obj, path) {
if (!obj || typeof obj !== "object") return undefined;
const parts = String(path).split(".");
let current = obj;
for (const p of parts) {
if (current == null) return undefined;
current = current[p];
}
return current;
}

function pickFirstValue(obj, paths) {
for (const p of paths) {
const v = valueByPath(obj, p);
if (v !== undefined && v !== null && String(v).trim() !== "") return v;
}
return undefined;
}

function asArray(value) {
if (!value) return [];
if (Array.isArray(value)) return value;
return [value];
}

function normalizeGender(value) {
const v = String(value || "").trim().toUpperCase();
if (v === "F" || v.includes("FEM")) return "FEMININO";
if (v === "M" || v.includes("MASC")) return "MASCULINO";
return v || "---";
}

function calcAgeFromDate(dateStr) {
const raw = String(dateStr || "").trim();
if (!raw) return "";
let d, m, y;
const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
if (br) {
d = Number(br[1]); m = Number(br[2]); y = Number(br[3]);
} else {
const dt = new Date(raw);
if (Number.isNaN(dt.getTime())) return "";
d = dt.getDate(); m = dt.getMonth() + 1; y = dt.getFullYear();
}
const now = new Date();
let age = now.getFullYear() - y;
const beforeBirthday = (now.getMonth() + 1 < m) || ((now.getMonth() + 1 === m) && now.getDate() < d);
if (beforeBirthday) age -= 1;
return Number.isFinite(age) && age >= 0 ? String(age) : "";
}

function getSigno(dateStr) {
const raw = String(dateStr || "").trim();
if (!raw) return "---";
let d, m;
const br = raw.match(/^(\d{2})\/(\d{2})\/\d{4}$/);
if (br) {
d = Number(br[1]); m = Number(br[2]);
} else {
const dt = new Date(raw);
if (Number.isNaN(dt.getTime())) return "---";
d = dt.getDate(); m = dt.getMonth() + 1;
}
if ((m === 1 && d >= 20) || (m === 2 && d <= 18)) return "AQUARIO";
if ((m === 2 && d >= 19) || (m === 3 && d <= 20)) return "PEIXES";
if ((m === 3 && d >= 21) || (m === 4 && d <= 19)) return "ARIES";
if ((m === 4 && d >= 20) || (m === 5 && d <= 20)) return "TOURO";
if ((m === 5 && d >= 21) || (m === 6 && d <= 20)) return "GEMEOS";
if ((m === 6 && d >= 21) || (m === 7 && d <= 22)) return "CANCER";
if ((m === 7 && d >= 23) || (m === 8 && d <= 22)) return "LEAO";
if ((m === 8 && d >= 23) || (m === 9 && d <= 22)) return "VIRGEM";
if ((m === 9 && d >= 23) || (m === 10 && d <= 22)) return "LIBRA";
if ((m === 10 && d >= 23) || (m === 11 && d <= 21)) return "ESCORPIAO";
if ((m === 11 && d >= 22) || (m === 12 && d <= 21)) return "SAGITARIO";
return "CAPRICORNIO";
}

function resolvePayloadRoot(data) {
if (!data || typeof data !== "object") return data;
const body = data.body && typeof data.body === "object" ? data.body : null;
if (body) return body;
const resultado = data.resultado && typeof data.resultado === "object" ? data.resultado : null;
if (resultado) return resultado;
const result = data.result && typeof data.result === "object" ? data.result : null;
if (result) return result;
return data;
}

function toPrettyLine(label, value) {
const v = (value === undefined || value === null || String(value).trim() === "") ? "---" : String(value);
return `${label}: ${v}`;
}

function formatCpfDfsTechTextResponse(data, targetCpf) {
const root = resolvePayloadRoot(data);

const nome = pickFirstValue(root, ["nome", "nome_completo", "name", "pessoa.nome"]);
const nascimento = pickFirstValue(root, ["data_nascimento", "nascimento", "nasc", "dt_nascimento", "birth", "pessoa.nascimento"]);
const idadeRaw = pickFirstValue(root, ["idade", "pessoa.idade"]);
const idade = idadeRaw || calcAgeFromDate(nascimento);
const sexo = normalizeGender(pickFirstValue(root, ["sexo", "genero", "gender", "pessoa.sexo"]));
const rg = pickFirstValue(root, ["rg", "documentos.rg", "pessoa.rg"]);
const mae = pickFirstValue(root, ["mae", "nome_mae", "mother_name", "filiacao.mae", "pessoa.mae"]);
const pai = pickFirstValue(root, ["pai", "nome_pai", "father_name", "filiacao.pai", "pessoa.pai"]);
const renda = pickFirstValue(root, ["purchasing_power.purchasing_power", "renda", "faixa_renda", "financeiro.renda", "economico.renda", "income"]);
const score = pickFirstValue(root, ["score", "financeiro.score", "credito.score"]);
const scoreFaixa = pickFirstValue(root, ["score_faixa", "score_nivel", "financeiro.score_nivel", "credito.classificacao"]);
const signoData = pickFirstValue(root, ["sign", "signo"]);

const enderecos = asArray(
pickFirstValue(root, ["enderecos", "addresses", "endereco", "address", "localizacoes", "ultimos_enderecos", "paradeiros"])
).slice(0, 3);

const parentes = asArray(
pickFirstValue(root, ["filhos", "relatives", "parentes", "vinculos", "vinculos_sanguineos"])
).slice(0, 10);

const telefones = asArray(
pickFirstValue(root, ["telefones", "telephones", "contatos", "phones", "celulares"])
).slice(0, 10);

const linhas = [];
linhas.push("───🚀 REVELACAO DFS TECH | CPF 🚀");
linhas.push(`│ 🆔 ALVO: ${targetCpf || pickFirstValue(root, ["cpf", "documento", "pessoa.cpf"]) || "---"}`);
linhas.push("│");
linhas.push("│ 🏎️ DADOS DA ALMA DFS TECH");
linhas.push(`│ 👤 NOME: ${String(nome || "---").toUpperCase()}`);
const nascLine = nascimento ? `${nascimento}${idade ? ` (${idade} ANOS)` : ""}` : "---";
linhas.push(`│ 🎂 NASC: ${nascLine}`);
linhas.push(`│ ♊ SIGNO: ${String(signoData || getSigno(nascimento) || "---").toUpperCase()}`);
linhas.push(`│ 🚻 SEXO: ${sexo}`);
linhas.push(`│ 🪪 RG: ${rg || "---"}`);
linhas.push(`│ 🤱 MAE: ${String(mae || "---").toUpperCase()}`);
linhas.push(`│ 👨‍🍼 PAI: ${String(pai || "---").toUpperCase()}`);
linhas.push("│");
linhas.push("│ 💰 FINANCEIRO & CREDITO");
linhas.push(`│ 💎 RENDA: ${String(renda || "---").toUpperCase()}`);
const scoreValor = (score && typeof score === "object")
? (pickFirstValue(score, ["csb8", "score", "valor", "csba"]) || "---")
: (score || "---");
const scoreFaixaResolved = scoreFaixa || (score && typeof score === "object" ? (pickFirstValue(score, ["csb8_range", "range", "faixa", "csba_range"]) || "") : "");
linhas.push(`│ 📊 SCORE: ${scoreValor}${scoreFaixaResolved ? ` (${String(scoreFaixaResolved).toUpperCase()})` : ""}`);
linhas.push("│");
linhas.push("│ 🗺️ ULTIMOS PARADEIROS");

if (!enderecos.length) {
linhas.push("│ 📍 LOCAL 1: ---");
} else {
enderecos.forEach((e, i) => {
const item = (e && typeof e === "object") ? e : { endereco: e };
const rua = pickFirstValue(item, ["logradouro", "rua", "endereco", "address", "street", "logr_name"]);
const tipoRua = pickFirstValue(item, ["logr_type", "tipo_logradouro"]);
const numero = pickFirstValue(item, ["numero", "num", "number", "logr_number"]);
const bairro = pickFirstValue(item, ["bairro", "district", "neighborhood"]);
const cidade = pickFirstValue(item, ["cidade", "city"]);
const estado = pickFirstValue(item, ["estado", "uf", "state"]);
const cep = pickFirstValue(item, ["cep", "zipcode", "postal_code", "zip_code"]);
const ruaCompleta = rua ? `${tipoRua ? `${tipoRua} ` : ""}${rua}${numero ? `, ${numero}` : ""}` : "---";
linhas.push(`│ 📍 LOCAL ${i + 1}: ${ruaCompleta}`);
linhas.push(`│ 🏘️ BAIRRO: ${String(bairro || "---").toUpperCase()}`);
linhas.push(`│ 🏙️ CIDADE: ${String(cidade ? `${cidade}${estado ? `/${estado}` : ""}` : "---").toUpperCase()}`);
linhas.push(`│ 📮 CEP: ${cep || "---"}`);
if (i < enderecos.length - 1) linhas.push("│");
});
}

linhas.push("│");
linhas.push("│ 👥 VINCULOS DE SANGUE");
if (!parentes.length) {
linhas.push("│ 👤 FILHA(O): ---");
} else {
parentes.forEach((p) => {
const nomeParente = typeof p === "object" ? (pickFirstValue(p, ["nome", "name", "parente", "descricao"]) || JSON.stringify(p)) : p;
const rel = typeof p === "object" ? (pickFirstValue(p, ["relationship", "parentesco"]) || "FILHA(O)") : "FILHA(O)";
linhas.push(`│ 👤 ${String(rel).toUpperCase()}: ${String(nomeParente).toUpperCase()}`);
});
}

linhas.push("│");
linhas.push("│ 📡 CANAIS DE CONTATO");
if (!telefones.length) {
linhas.push("│ 📱 ---");
} else {
telefones.forEach((t) => {
const tel = typeof t === "object"
? (pickFirstValue(t, ["numero", "telefone", "phone", "valor"]) || (() => {
const ddd = pickFirstValue(t, ["ddd"]);
const phone = pickFirstValue(t, ["phone_number"]);
if (ddd && phone) return `(${ddd}) ${phone}`;
return JSON.stringify(t);
})())
: t;
linhas.push(`│ 📱 ${tel}`);
});
}

linhas.push("│");
linhas.push("╰───⚡ BY API DFS TECH DA ULTRA VELOCIDADE E EFICIENCIA ⚡");
return linhas.join("\n");
}

function formatGenericTextResponse(data) {
const root = resolvePayloadRoot(data);
if (!root || typeof root !== "object") return String(root ?? "");
const lines = [];
for (const [k, v] of Object.entries(root)) {
if (v === null || v === undefined) continue;
if (typeof v === "object") {
lines.push(toPrettyLine(k.toUpperCase(), JSON.stringify(v)));
} else {
lines.push(toPrettyLine(k.toUpperCase(), v));
}
}
return lines.join("\n");
}

function normalizeLegacyDadosPessoaisQuery(consulta, query) {
const paramName = LEGACY_DADOS_PESSOAIS_QUERY_KEYS[consulta];
const rawValue = paramName ? query[paramName] : "";
if (!rawValue) return {};

switch (consulta) {
case "cnh":
case "score":
case "srs":
case "fotorj":
return { cpf: String(rawValue) };
case "bin2":
return { bin: String(rawValue) };
default:
return { [paramName]: String(rawValue) };
}
}

async function executePuxadasConsulta({ tipo, apikey, query, compactValue = "" }) {
if (!PUXADAS_BASE_URL || !PUXADAS_TOKEN) {
throw createPuxadasHandledError(500, {
status: false,
erro: "Integração PUXADAS não configurada.",
detalhes: "Defina PUXADAS_BASE_URL e PUXADAS_TOKEN no ambiente."
});
}
if (!PUXADAS_TYPES.includes(tipo)) {
throw createPuxadasHandledError(400, { status: false, erro: "Tipo de consulta inválido.", tipos_disponiveis: PUXADAS_TYPES });
}
if (!apikey) {
throw createPuxadasHandledError(401, { status: false, erro: "APIKEY obrigatória." });
}

const value = compactValue || resolvePuxadasValue(tipo, query || {});
if (!value) {
throw createPuxadasHandledError(400, {
status: false,
erro: "Parâmetros insuficientes para este tipo.",
detalhes: "Use /api/puxadas/consulta/tipo=valor&apikey=... ou o parâmetro específico do tipo (cpf, cnpj, rg, telefone, etc)."
});
}

const erro = usarApiKey(apikey, `puxadas:${tipo}`);
if (erro) {
throw createPuxadasHandledError(403, { status: false, erro });
}

const upstreamPath = `puxadas/${tipo}=${encodePathValuePreserveSlash(value)}/${encodeURIComponent(PUXADAS_TOKEN)}`;
return forwardPuxadasRequest(puxadasClient, {
method: "GET",
path: upstreamPath,
query: {},
body: null
});
}

function sendPuxadasResponse(req, res, proxied, meta = {}) {
const wantText = String(req.query?.formato || "").toLowerCase() === "texto";
if (wantText) {
const tipo = String(meta.tipo || "");
const cpfLike = ["cpf", "cpf2", "cpf3", "cpf4", "cpf5", "cpfnacional", "score", "score2", "cnh", "srs", "fotorj"];
const payload = proxied.data;
const textOutput = cpfLike.includes(tipo)
? formatCpfDfsTechTextResponse(payload, req.query?.cpf || req.query?.score || req.query?.cnh || req.query?.srs || req.query?.fotorj)
: formatGenericTextResponse(payload);
return res.status(proxied.status).type("text/plain; charset=utf-8").send(textOutput);
}
if (typeof proxied.data === "object") {
return res.status(proxied.status).json(proxied.data);
}
return res.status(proxied.status).send(proxied.data);
}

function sendHandledError(req, res, status, data) {
const wantText = String(req.query?.formato || "").toLowerCase() === "texto";
if (wantText) {
return res.status(status).type("text/plain; charset=utf-8").send(formatGenericTextResponse(data));
}
return res.status(status).json(data);
}

for (const tipo of PUXADAS_TYPES) {
app.get(`/api/puxadas/consulta/${tipo}`, puxadasLimiter, async (req, res) => {
const apikey = getApiKey(req);
try {
const proxied = await executePuxadasConsulta({
tipo,
apikey,
query: req.query
});
return sendPuxadasResponse(req, res, proxied, { tipo });
} catch (error) {
if (error?.isHandled) {
return sendHandledError(req, res, error.status, error.data);
}
consoleErro(`Erro em /api/puxadas/consulta/${tipo}`, error);
return res.status(500).json({ status: false, erro: "Erro interno ao consultar PUXADAS." });
}
});
}

// Compatibilidade com formato compacto:
// /api/puxadas/consulta/cpf=11396397736&apikey=MINHA_CHAVE
app.get('/api/puxadas/consulta/:compact', puxadasLimiter, async (req, res) => {
const rawTipo = String(req.params.compact || "");
if (!rawTipo.includes("=")) {
return res.status(404).json({ status: false, erro: "Tipo de consulta inválido.", tipos_disponiveis: PUXADAS_TYPES });
}

let tipo = rawTipo;
let apikey = getApiKey(req);
let compactValue = "";
const eqIndex = rawTipo.indexOf("=");
tipo = rawTipo.slice(0, eqIndex);
const rest = rawTipo.slice(eqIndex + 1);
const apiKeyToken = "&apikey=";
const apiKeyIndex = rest.lastIndexOf(apiKeyToken);
if (apiKeyIndex >= 0) {
compactValue = rest.slice(0, apiKeyIndex);
if (!apikey) apikey = rest.slice(apiKeyIndex + apiKeyToken.length);
} else {
compactValue = rest;
}

try {
const proxied = await executePuxadasConsulta({
tipo,
apikey,
query: req.query,
compactValue
});
return sendPuxadasResponse(req, res, proxied, { tipo });
} catch (error) {
if (error?.isHandled) {
return sendHandledError(req, res, error.status, error.data);
}
consoleErro("Erro em /api/puxadas/consulta/:compact", error);
return res.status(500).json({ status: false, erro: "Erro interno ao consultar PUXADAS." });
}
});

for (const [consulta, tipo] of Object.entries(LEGACY_DADOS_PESSOAIS_TYPES)) {
app.get(`/api/dados-pessoais/${consulta}`, puxadasLimiter, async (req, res) => {
const { apikey } = req.query;
if (!apikey) {
return res.status(401).json({ success: false, message: "API key obrigatoria.", data: {} });
}

const normalizedQuery = normalizeLegacyDadosPessoaisQuery(consulta, req.query);
if (!Object.keys(normalizedQuery).length) {
const requiredKey = LEGACY_DADOS_PESSOAIS_QUERY_KEYS[consulta];
return res.status(400).json({ status: false, erro: `Parâmetro ${requiredKey} é obrigatório` });
}

try {
const proxied = await executePuxadasConsulta({
tipo,
apikey: String(apikey),
query: normalizedQuery
});
return sendPuxadasResponse(req, res, proxied, { tipo });
} catch (error) {
if (error?.isHandled) {
return sendHandledError(req, res, error.status, error.data);
}
consoleErro(`Erro em /api/dados-pessoais/${consulta}`, error);
return res.status(500).json({ status: false, erro: "Erro interno ao consultar dados pessoais." });
}
});
}

app.all('/api/puxadas/*', puxadasLimiter, async (req, res) => {
let targetPath = req.params[0];
if (!targetPath) {
return res.status(400).json({ status: false, erro: "Endpoint PUXADAS inválido." });
}

let apikeyFromPath = "";
const compactApiKeyToken = "&apikey=";
const compactApiKeyIndex = targetPath.lastIndexOf(compactApiKeyToken);
if (compactApiKeyIndex >= 0) {
apikeyFromPath = safeDecodeURIComponent(targetPath.slice(compactApiKeyIndex + compactApiKeyToken.length));
targetPath = targetPath.slice(0, compactApiKeyIndex);
}

const apikey = getApiKey(req) || req.body?.apikey || apikeyFromPath;
if (!apikey) {
return res.status(401).json({ status: false, erro: "APIKEY obrigatória." });
}

const erro = usarApiKey(apikey, `puxadas:${targetPath}`);
if (erro) {
return res.status(403).json({ status: false, erro });
}

const query = { ...req.query };
delete query.apikey;

let body = req.body;
if (body && typeof body === "object" && !Array.isArray(body)) {
body = { ...body };
delete body.apikey;
}

const proxied = await forwardPuxadasRequest(puxadasClient, {
method: req.method,
path: targetPath,
query,
body
});

if (typeof proxied.data === "object") {
return sendPuxadasResponse(req, res, proxied, { tipo: targetPath.split("=")[0] || targetPath });
}
return res.status(proxied.status).send(proxied.data);
});

//★・・・・・・★・・・ PUXADAS・・・★・・・・・・★
app.get('/api/consulta/cep/:cep', async (req, res) => {
const { apikey } = req.query;
const { cep } = req.params;
const wantText = String(req.query.formato || "").toLowerCase() === "texto";
if (!apikey) {
return res.status(401).json({ success: false, message: "API key obrigatoria.", data: {} });
}
const erro = await usarApiKey(apikey, cep);
if (erro) {
return res.status(500).json({ status: false, erro });
}
try {
const response = await axios.get(`https://brasilapi.com.br/api/cep/v1/${cep}`);
const { state, city, neighborhood, street } = response.data;
const payload = {
status: true,
criador: 'Tosh DFS TECH',
cep: cep,
estado: state,
cidade: city,
vizinhança: neighborhood,
rua: street,
serviço: 'open-cep'
};
if (wantText) {
return res.type("text/plain; charset=utf-8").send(formatGenericTextResponse(payload));
}
res.json(payload);
} catch (error) {
console.error('Erro ao consultar API de CEP:', error.message);
const errPayload = {
status: false,
error: 'Erro ao consultar API de CEP'
};
if (wantText) {
return res.status(error.response?.status || 500).type("text/plain; charset=utf-8").send(formatGenericTextResponse(errPayload));
}
res.status(error.response?.status || 500).json(errPayload);
}
});

app.get('/api/consulta/ddd/:ddd', async (req, res) => {
const { apikey } = req.query;
const { ddd } = req.params;
const wantText = String(req.query.formato || "").toLowerCase() === "texto";
if (!apikey) {
return res.status(401).json({ success: false, message: "API key obrigatoria.", data: {} });
}
const erro = await usarApiKey(apikey, ddd);
if (erro) {
return res.status(500).json({ status: false, erro });
}
try {
const response = await axios.get(`https://brasilapi.com.br/api/ddd/v1/${ddd}`);
const { state, cities } = response.data;
const payload = {
status: true,
criador: 'Tosh DFS TECH',
ddd: ddd,
estado: state,
cidades: cities,
serviço: 'open-ddd'
};
if (wantText) {
return res.type("text/plain; charset=utf-8").send(formatGenericTextResponse(payload));
}
res.json(payload);
} catch (error) {
console.error('Erro ao consultar API de DDD:', error.message);
const errPayload = {
status: false,
error: 'Erro ao consultar API de DDD'
};
if (wantText) {
return res.status(error.response?.status || 500).type("text/plain; charset=utf-8").send(formatGenericTextResponse(errPayload));
}
res.status(error.response?.status || 500).json(errPayload);
}
});

app.get('/api/consulta/clima/aeroporto/:codigoICAO', async (req, res) => {
const { apikey } = req.query;
const { codigoICAO } = req.params;
const wantText = String(req.query.formato || "").toLowerCase() === "texto";
if (!apikey) {
return res.status(401).json({ success: false, message: "API key obrigatoria.", data: {} });
}
const erro = await usarApiKey(apikey, codigoICAO);
if (erro) {
return res.status(500).json({ status: false, erro });
}
try {
const response = await axios.get(`https://brasilapi.com.br/api/cptec/v1/clima/aeroporto/${codigoICAO}`);
const {
umidade,
visibilidade,
codigo_icao,
pressao_atmosferica,
vento,
direcao_vento,
condicao,
condicao_desc,
temp,
atualizado_em
} = response.data;
const payload = {
status: true,
criador: 'Tosh DFS TECH',
codigo_icao,
umidade,
visibilidade,
pressao_atmosferica,
vento,
direcao_vento,
condicao,
condicao_desc,
temp,
atualizado_em,
serviço: 'open-clima-aeroporto'
};
if (wantText) {
return res.type("text/plain; charset=utf-8").send(formatGenericTextResponse(payload));
}
res.json(payload);
} catch (error) {
console.error('Erro ao consultar API de dados climáticos:', error.message);
const errPayload = {
status: false,
error: 'Erro ao consultar API de dados climáticos'
};
if (wantText) {
return res.status(error.response?.status || 500).type("text/plain; charset=utf-8").send(formatGenericTextResponse(errPayload));
}
res.status(error.response?.status || 500).json(errPayload);
}
});

app.get('/api/dados-pessoais', async (req, res) => {
const { apikey } = req.query;
if (!apikey) {
return res.status(401).json({ success: false, message: "API key obrigatoria.", data: {} });
}
const erro = await usarApiKey(apikey, 'dados-pessoais');
if (erro) {
return res.status(500).json({ status: false, erro });
}
try {
const response = await axios.get('https://randomuser.me/api/');
const userData = response.data.results[0];
const personalData = {
nomeCompleto: `${userData.name.first} ${userData.name.last}`,
idade: userData.dob.age,
cpf: userData.login.uuid.substring(0, 14),
email: userData.email,
telefone: userData.phone,
cidade: userData.location.city,
estado: userData.location.state,
cep: userData.location.postcode,
endereco: `${userData.location.street.name}, ${userData.location.street.number}`,
foto: userData.picture.large
};
res.json({
status: true,
criador: 'Tosh DFS TECH',
resultado: personalData,
serviço: 'randomuser.me'
});
} catch (error) {
console.error('Erro ao obter dados do usuário:', error);
res.status(500).json({
status: false,
error: 'Erro ao obter dados do usuário'
});
}
});

app.get('/api/gerar-cpf', async (req, res) => {
const { apikey } = req.query;
const wantText = String(req.query.formato || "").toLowerCase() === "texto";
if (!apikey) {
return res.status(401).json({ success: false, message: "API key obrigatoria.", data: {} });
}
const erro = await usarApiKey(apikey, 'gerar-cpf');
if (erro) {
return res.status(500).json({ status: false, erro });
}
const cpf = gerarCPF();
const payload = {
status: true,
criador: 'Tosh DFS TECH',
cpf: cpf,
serviço: 'gerador-cpf'
};
if (wantText) {
return res.type("text/plain; charset=utf-8").send(formatGenericTextResponse(payload));
}
res.json(payload);
});

//★・・・・・・★・・・ EDTS ・・・★・・・・・・★
app.get('/api/video/edts', async (req, res) => {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'edts');
if (erro) return res.status(403).json({ erro });
try {
const link = edts[Math.floor(Math.random() * edts.length)];
const response = await axios.get(link, {
responseType: 'stream',
headers: { 'User-Agent': 'Mozilla/5.0' } 
});
res.setHeader('Content-Type', 'video/mp4');
response.data.pipe(res);
} catch (e) { consoleErro(e);
res.status(500).json({ status: false, resultado: "ocorreu um erro ao buscar vídeo editado." });
}
});

app.get('/api/video/editsjujutsu', async (req, res) => {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'editsjujutsu');
if (erro) return res.status(403).json({ erro });
try {
const link = editsjujutsu[Math.floor(Math.random() * editsjujutsu.length)];
const response = await axios.get(link, {
responseType: 'stream',
headers: { 'User-Agent': 'Mozilla/5.0' }
});
res.setHeader('Content-Type', 'video/mp4');
response.data.pipe(res);
} catch (e) {
consoleErro(e);
res.status(500).json({ status: false, resultado: "ocorreu um erro ao buscar edits de Jujutsu." });
}
});

app.get('/api/video/editsnaruto', async (req, res) => {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'editsnaruto');
if (erro) return res.status(403).json({ erro });
try {
const link = editsnaruto[Math.floor(Math.random() * editsnaruto.length)];
const response = await axios.get(link, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type']);
response.data.pipe(res);
} catch (e) { consoleErro(e);
res.status(500).json({ status: false, resultado: "ocorreu um erro ao buscar editsnaruto." });
}
});

app.get('/api/video/freefire', async (req, res) => {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'freefire');
if (erro) return res.status(403).json({ erro });
try {
const link = freefire[Math.floor(Math.random() * freefire.length)];
const response = await axios.get(link, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type']);
response.data.pipe(res);
} catch (e) { consoleErro(e);
res.status(500).json({ status: false, resultado: "ocorreu um erro ao buscar freefire." });
}
});

//★・・・・・・★・・・ DOWNLOAD ・・・★・・・・・・★
app.get('/api/download/mix', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'playMix');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.json({ status: false, resultado: 'Cadê o parâmetro nome??' });
try {
const serpApiKey = SERPAPI_KEY;
const url = `https://serpapi.com/search.json?engine=youtube&search_query=${encodeURIComponent(nome)}&api_key=${serpApiKey}&type=video`;
const response = await axios.get(url);
const videos = response.data.video_results || [];
if (!videos.length)
return res.json({ status: false, mensagem: "Nenhum vídeo encontrado", resultado: [] });
const resultado = videos.map(video => ({
titulo: video.title,
url: video.link,
canal: video.channel?.name || "Desconhecido",
canal_url: video.channel?.link || "",
visualizacoes: video.views || "N/A",
publicado: video.published_date || "N/A",
duracao: video.length || "N/A",
thumbnail: video.thumbnail?.[0]?.url || ""
        }));
return res.json({ status: true, mix: nome, quantidade: resultado.length, resultado });
} catch (error) {
console.error("Erro na API SerpApi:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null,
stack: error.stack || ""
        });
    }
});

app.get('/api/download/play', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'play2');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.status(400).json({ status: false, resultado: 'Cade o parametro nome??' });
try {
const api = await ytSearch(nome);
const video = api?.[0];
if (!video?.url) {
  return res.status(404).json({ status: false, resultado: 'Vídeo não encontrado.' });
}
const streamed = await attemptYtdlStream(video.url, res, 'play');
if (streamed) return;
const fallbackUrl = await getRemoteAudioLink(video.url);
if (!fallbackUrl) {
  return res.status(500).send('Erro ao processar o áudio.');
}
await streamRemoteAudio(fallbackUrl, res);
} catch (e) {
console.error('Erro geral:', e);
return res.status(500).send('Erro ao processar o áudio.');
}
});

app.get('/api/download/playv2', async (req, res) => {
const { apikey, url } = req.query;
if (!apikey) {
return res.status(400).json({ erro: 'API Key é necessária' });
}
const erro = await usarApiKey(apikey, 'play4');
if (erro) {
return res.status(403).json({ erro });
}
if (!url) {
return res.json({ status: false, resultado: 'cadê o parâmetro url??' });
}
try {
const api = await ytSearch(url);
const videoUrl = api?.[0]?.url || url;
if (!videoUrl) {
  return res.json({ status: false, resultado: 'Vídeo não encontrado.' });
}
const audioStream = getYtdlStream(videoUrl);
res.setHeader('Content-Type', 'audio/mpeg');
res.setHeader('Content-Disposition', 'inline');
audioStream.on('error', (err) => {
  console.error('Erro no streaming do ytdl (playv2):', err?.statusCode ?? err?.message ?? err);
  if (!res.headersSent) {
    res.status(500).send('Erro ao transmitir o áudio.');
  } else {
    res.end();
  }
});
audioStream.pipe(res);
} catch (e) {
console.error(e);
res.status(500).send('Erro ao processar o áudio.');
}
});

app.get('/api/download/playv3', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'play2');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.status(400).json({ status: false, resultado: 'Cade o parametro nome??' });
try {
const api = await ytSearch(nome);
const video = api?.[0];
if (!video?.url) {
  return res.status(404).json({ status: false, resultado: 'Vídeo não encontrado.' });
}
const audioStream = getYtdlStream(video.url);
res.setHeader('Content-Type', 'audio/mpeg');
audioStream.on('error', (err) => {
  console.error('Erro no streaming do ytdl (playv3):', err?.statusCode ?? err?.message ?? err);
  if (!res.headersSent) {
    res.status(500).send('Erro ao transmitir o áudio.');
  } else {
    res.end();
  }
});
audioStream.pipe(res);
} catch (e) {
console.error('Erro geral:', e);
return res.status(500).send('Erro ao processar o áudio.');
}});

app.get('/api/download/playvd', async(req, res, next) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'playvd');
if (erro) { return res.status(403).json({ erro }); }
nome = req.query.nome
if(!nome)return res.json({status:false, resultado:'Cade o parametro nome??'  }) 
api = await ytSearch(nome)
ytMp4(api[0].url).then((akk) => {
res.setHeader('Content-Type', 'video/mp4');
request.get(akk).pipe(res);
}).catch(e => {
res.json({
status: false,
codigo: 400,
criador: criador,
resultado: "Deu erro ao solicitar seu audio...."
})
console.log(e)
})})

app.get('/api/download/playvdv2', async(req, res, next) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'playvd2');
if (erro) { return res.status(403).json({ erro }); }
 nome = req.query.nome
if(!nome)return res.json({status:false, resultado:'Cade o parametro nome??'  }) 
api = await ytSearch(nome)
ytMp4(api[0].url).then((akk) => {
res.setHeader('Content-Type', 'video/mp4');
request.get(akk).pipe(res);
}).catch(e => {
res.json({
status: false,
codigo: 400,
criador: criador,
resultado: "Deu erro ao solicitar seu audio...."
})
console.log(e)
})})

// Stream público de vídeo para DFS TECH TUBE (sem API key).
app.get('/api/public/youtube/video', async (req, res) => {
const nome = String(req.query?.nome || "").trim();
if (!nome) return res.status(400).json({ status: false, resultado: "Parâmetro nome é obrigatório" });
try {
const resolved = await resolveYoutubeVideoResult(nome);
if (!resolved?.url) {
return res.status(404).json({ status: false, resultado: "Vídeo não encontrado" });
}

ytMp4(resolved.url).then((videoUrl) => {
res.setHeader('Content-Type', 'video/mp4');
request.get(videoUrl).on('error', (err) => {
console.log(err);
if (!res.headersSent) return res.status(500).json({ status: false, resultado: "Erro no streaming do vídeo" });
res.end();
}).pipe(res);
}).catch((err) => {
console.log(err);
return res.status(500).json({ status: false, resultado: "Erro ao processar vídeo do YouTube" });
});
} catch (e) {
console.log(e);
return res.status(500).json({ status: false, resultado: "Erro interno ao baixar vídeo" });
}
});

// Download público de vídeo para DFS TECH TUBE (até 2 horas).
app.get('/api/public/youtube/download', async (req, res) => {
const nome = String(req.query?.nome || "").trim();
if (!nome) return res.status(400).json({ status: false, resultado: "Parâmetro nome é obrigatório" });

try {
const resolved = await resolveYoutubeVideoResult(nome);
if (!resolved?.url) {
return res.status(404).json({ status: false, resultado: "Vídeo não encontrado" });
}

let info = null;
try {
info = await ytdl.getInfo(resolved.url, ytdlOptions);
} catch (err) {
console.log("ytdl getInfo falhou no download público, tentando fallback ytMp4:", err?.message || err);
}

const duration = Number(info?.videoDetails?.lengthSeconds || resolved.seconds || 0);
if (duration > PUBLIC_YOUTUBE_MAX_SECONDS) {
return res.status(413).json({
status: false,
resultado: `Vídeo muito longo. Limite atual: ${Math.floor(PUBLIC_YOUTUBE_MAX_SECONDS / 3600)} horas.`
});
}

const title = sanitizeFileName((info?.videoDetails?.title || resolved.title || "video") + ".mp4");
res.setHeader("Content-Type", "video/mp4");
res.setHeader("Content-Disposition", `attachment; filename=\"${title}\"`);
res.setHeader("Accept-Ranges", "bytes");

if (!info) {
try {
const directUrl = await ytMp4(resolved.url);
if (!directUrl) {
return res.status(500).json({ status: false, resultado: "Link de download indisponível no momento" });
}

return request.get(directUrl).on("error", (err) => {
console.log(err);
if (!res.headersSent) {
res.status(500).json({ status: false, resultado: "Erro no download do vídeo" });
} else {
res.end();
}
}).pipe(res);
} catch (err) {
console.log(err);
return res.status(500).json({ status: false, resultado: "Não foi possível preparar download do vídeo" });
}
}

const progressiveMp4 = (info.formats || [])
  .filter((f) => f && f.hasVideo && f.hasAudio && f.container === "mp4")
  .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

const fallbackFormat = (info.formats || [])
  .filter((f) => f && f.hasVideo && f.hasAudio)
  .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

const format = progressiveMp4 || fallbackFormat;
if (!format) {
return res.status(500).json({ status: false, resultado: "Formato de vídeo indisponível para download" });
}

const stream = ytdl.downloadFromInfo(info, {
...ytdlOptions,
format,
highWaterMark: 1 << 27
});

stream.on("error", (err) => {
console.log(err);
if (!res.headersSent) {
res.status(500).json({ status: false, resultado: "Erro no download do vídeo" });
} else {
res.end();
}
});

stream.pipe(res);
} catch (e) {
console.log(e);
return res.status(500).json({ status: false, resultado: "Erro interno no download do vídeo" });
}
});

// Download público de áudio MP3 para DFS TECH TUBE (até 2 horas).
app.get('/api/public/youtube/download-mp3', async (req, res) => {
const nome = String(req.query?.nome || "").trim();
if (!nome) return res.status(400).json({ status: false, resultado: "Parâmetro nome é obrigatório" });

try {
const resolved = await resolveYoutubeVideoResult(nome);
if (!resolved?.url) {
return res.status(404).json({ status: false, resultado: "Vídeo não encontrado" });
}

let info = null;
try {
info = await ytdl.getInfo(resolved.url, ytdlOptions);
} catch (err) {
console.log("ytdl getInfo falhou no download público de mp3, tentando fallback remoto:", err?.message || err);
}

const duration = Number(info?.videoDetails?.lengthSeconds || resolved.seconds || 0);
if (duration > PUBLIC_YOUTUBE_MAX_SECONDS) {
return res.status(413).json({
status: false,
resultado: `Vídeo muito longo. Limite atual: ${Math.floor(PUBLIC_YOUTUBE_MAX_SECONDS / 3600)} horas.`
});
}

const title = sanitizeFileName((info?.videoDetails?.title || resolved.title || "audio") + ".mp3");
res.setHeader("Content-Type", "audio/mpeg");
res.setHeader("Content-Disposition", `attachment; filename=\"${title}\"`);
res.setHeader("Accept-Ranges", "bytes");

if (!info) {
const remoteAudio = await getRemoteAudioLink(resolved.url);
if (!remoteAudio) {
return res.status(500).json({ status: false, resultado: "Não foi possível preparar download do áudio" });
}
return streamRemoteAudio(remoteAudio, res);
}

const audioFormat = (info.formats || [])
  .filter((f) => f && f.hasAudio && !f.hasVideo)
  .sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0))[0]
  || (info.formats || [])
  .filter((f) => f && f.hasAudio)
  .sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0))[0];

if (!audioFormat) {
const remoteAudio = await getRemoteAudioLink(resolved.url);
if (!remoteAudio) {
return res.status(500).json({ status: false, resultado: "Formato de áudio indisponível para download" });
}
return streamRemoteAudio(remoteAudio, res);
}

const stream = ytdl.downloadFromInfo(info, {
...ytdlOptions,
format: audioFormat,
highWaterMark: 1 << 27
});

stream.on("error", async (err) => {
console.log(err);
if (res.headersSent) return res.end();
try {
const remoteAudio = await getRemoteAudioLink(resolved.url);
if (!remoteAudio) {
return res.status(500).json({ status: false, resultado: "Erro no download do áudio" });
}
return streamRemoteAudio(remoteAudio, res);
} catch (fallbackErr) {
console.log(fallbackErr);
return res.status(500).json({ status: false, resultado: "Erro no download do áudio" });
}
});

stream.pipe(res);
} catch (e) {
console.log(e);
return res.status(500).json({ status: false, resultado: "Erro interno no download do áudio" });
}
});

app.get('/api/download/audiomeme', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'audiomeme');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.json({ status: false, resultado: 'Cadê o parâmetro nome??' });
const serpApiKey = SERPAPI_KEY;
if (!serpApiKey) return res.status(500).json({ status: false, mensagem: "SERPAPI_KEY não configurada no ambiente." });
try {
const query = `${nome} meme sound site:myinstants.com OR site:voicy.network OR site:youtube.com`;
const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&api_key=${serpApiKey}`;
const response = await axios.get(url);
const results = response.data.organic_results || [];
if (!results.length) {
return res.json({ status: false, mensagem: "Nenhum áudio encontrado", resultado: [] });
    }
const audios = results.slice(0, 20).map((r, i) => ({
titulo: r.title || `${nome} #${i + 1}`,
link: r.link,
descricao: r.snippet || "Sem descrição"
    }));
return res.json({
status: true,
resultado: audios
    });
} catch (error) {
console.error("Erro na API SerpAPI:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null
    });
  }
});

app.get("/api/download/tiktok", async (req, res) => {
const url = req.query.url
if (!url) return res.status(500).json({ success: false, message: "Parâmetro url obrigatório", data: {} })
const apikey = req.query.apikey;
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, 'NOME');
if (erro) { return res.status(403).json({ erro }); }
try {
tiktokDl(url).then((data) => {
res.json({
data
})
})
} catch (e) {
res.json({
status: "offline",
criadora,
erro: "Deu erro na sua solicitação"
})
}
})

app.get("/api/download/tiktok/video", async (req, res) => {
const url = req.query.url;
const apikey = req.query.apikey;
if (!url || !apikey)
return res.status(400).json({ erro: "Parâmetro url/apikey obrigatório" });
const erro = await usarApiKey(apikey, 'tiktok_video');
if (erro) return res.status(403).json({ erro });
try {
const data = await Tiktok(url);
const videoUrl = data.nowm || data.video || data.play;
if (!videoUrl)
return res.status(404).json({ erro: "Vídeo não encontrado" });
const stream = await axios.get(videoUrl, { responseType: 'stream' });
res.setHeader('Content-Type', 'video/mp4');
stream.data.pipe(res);
} catch (e) {
res.status(500).json({ erro: "Erro ao carregar vídeo", detalhes: e.message });
}
});

app.get("/api/download/mediafire", async (req, res) => {
const { url, apikey } = req.query;
if (!url) {
return res.status(400).json({
status: false,
criador: "Tosh DFS TECH",
erro: "Parâmetro 'url' obrigatório"
    });
  }
if (!apikey) {
return res.status(400).json({
status: false,
criador: "Tosh DFS TECH",
erro: "Parâmetro 'apikey' obrigatório"
    });
  }
try {
const resultado = await mediafireDl(url);
if (!resultado.status) {
return res.status(400).json({
status: false,
criador: "Tosh DFS TECH",
erro: resultado.erro,
detalhes: resultado.detalhes
      });
    }
res.json({
status: true,
criador: "Tosh DFS TECH",
resultado
    });
} catch (err) {
console.error("Erro na rota /api/download/mediafire:", err.message);
res.status(500).json({
status: false,
criador: "Tosh DFS TECH",
erro: "Erro interno no servidor",
detalhes: err.message
    });
  }
});

////★・・・・・・★・・・ PESQUISAS ・・★・・・・・・★
app.get('/api/pesquisa/youtubeCanal', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'youtubeCanal');
if (erro) { return res.status(403).json({ erro }); }
const nome = req.query.nome;
if (!nome) return res.json({ status: false, resultado: 'cadê o parâmetro nome??' });
try {
const serpApiKey = SERPAPI_KEY;
const url = `https://serpapi.com/search.json?engine=youtube&search_query=${encodeURIComponent(nome)}&api_key=${serpApiKey}&type=channel`;
const response = await axios.get(url);
const canais = response.data.channel_results || [];
if (!canais.length) 
return res.json({ status: false, mensagem: "Nenhum canal encontrado", resultado: [] });
const resultado = canais.map(canal => ({
nome: canal.title,
url: canal.link,
descricao: canal.description || "Sem descrição",
inscritos: canal.subscribers || "N/A",
videos: canal.videos || "N/A",
thumbnail: canal.thumbnail || "" }));
return res.json({ status: true, resultado });
} catch (error) {
console.error("Erro na API SerpApi:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null,
stack: error.stack || ""
        });
    }
});

app.get('/api/pesquisa/youtube', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'youtube2');
if (erro) { return res.status(403).json({ erro }); }
const nome = req.query.nome;
if (!nome) return res.json({ status: false, resultado: 'cadê o parâmetro nome??' });
try {
const result = await youtubeSearch(nome);
res.json({ status: true, resultado: result.results });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

// Endpoint público para DFS TECH TUBE (sem API key).
app.get('/api/public/youtube/search', async (req, res) => {
const nome = String(req.query?.nome || "").trim();
if (!nome) return res.status(400).json({ status: false, resultado: "Parâmetro nome é obrigatório" });
try {
const result = await youtubeSearch(nome);
const items = Array.isArray(result?.results) ? result.results : [];
return res.json({ status: true, resultado: items });
} catch (e) {
consoleErro(e);
return res.status(500).json({ status: false, resultado: "Erro ao buscar informações do vídeo." });
}
});

// ===================== LEGADO BOT (api-bronxys) =====================
const pickFirstHttpUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstHttpUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const found = pickFirstHttpUrl(value[key]);
      if (found) return found;
    }
  }
  return null;
};

const legacyRedirect = (res, pathName, params = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return res.redirect(302, suffix ? `${pathName}?${suffix}` : pathName);
};

app.get('/api-bronxys/consultacep', async (req, res) => {
  const { cep, apikey } = req.query;
  if (!cep) return res.status(400).json({ success: false, message: "Parâmetro cep obrigatório", data: {} });
  return legacyRedirect(res, `/api/consulta/cep/${encodeURIComponent(String(cep))}`, { apikey });
});

app.get('/api-bronxys/pesquisa_ytb', async (req, res) => {
  const { nome, apikey } = req.query;
  if (!nome) return res.status(400).json({ success: false, message: "Parâmetro nome obrigatório", data: {} });
  return legacyRedirect(res, '/api/pesquisa/youtube2', { nome, apikey });
});

app.get('/api-bronxys/Amazon_Pesquisa', async (req, res) => {
  const { pesquisa, apikey } = req.query;
  if (!pesquisa) return res.status(400).json({ success: false, message: "Parâmetro pesquisa obrigatório", data: {} });
  return legacyRedirect(res, '/api/pesquisa/amazon', { nome: pesquisa, apikey });
});

app.get('/api-bronxys/playstore', async (req, res) => {
  const { nome, apikey } = req.query;
  if (!nome) return res.status(400).json({ success: false, message: "Parâmetro nome obrigatório", data: {} });
  return legacyRedirect(res, '/api/pesquisa/playstore', { nome, apikey });
});

app.get('/api-bronxys/mediafire', async (req, res) => {
  const { url, apikey } = req.query;
  if (!url) return res.status(400).json({ success: false, message: "Parâmetro url obrigatório", data: {} });
  return legacyRedirect(res, '/api/download/mediafire', { url, apikey });
});

app.get('/api-bronxys/print_de_site', async (req, res) => {
  const siteUrl = String(req.query.url || "").trim();
  if (!siteUrl) return res.status(400).json({ success: false, message: "Parâmetro url obrigatório", data: {} });
  if (!/^https?:\/\//i.test(siteUrl)) {
    return res.status(400).json({ success: false, message: "URL inválida. Use http/https", data: {} });
  }
  return res.redirect(302, `https://image.thum.io/get/width/1280/noanimate/${encodeURIComponent(siteUrl)}`);
});

app.get('/api-bronxys/gerar_nick', async (req, res) => {
  const raw = String(req.query.nick || "dfs").trim();
  const base = raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 14) || "dfs";
  const suffix = Math.floor(1000 + Math.random() * 90000);
  return res.json({ success: true, message: "Nick gerado", data: { nick: `${base}_${suffix}` } });
});

app.get('/api-bronxys/PERGUNTE_E_EU_RESPONDO', async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ success: false, message: "Parâmetro q obrigatório", data: {} });
  const respostas = [
    "Sim.",
    "Não.",
    "Talvez.",
    "Sem dúvida.",
    "Melhor aguardar um pouco.",
    "Sinais indicam que sim."
  ];
  const answer = respostas[Math.floor(Math.random() * respostas.length)];
  return res.json({ success: true, message: "Resposta gerada", data: { pergunta: q, resposta: answer } });
});

app.get('/api-bronxys/Moedas_Agora', async (_req, res) => {
  try {
    const response = await axios.get("https://api.frankfurter.app/latest?from=BRL&to=USD,EUR,ARS,GBP", { timeout: 12000 });
    return res.json({ success: true, message: "Cotações carregadas", data: response.data });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Erro ao buscar cotações", data: { error: err.message } });
  }
});

app.get('/api-bronxys/letra_musica', async (req, res) => {
  const letra = String(req.query.letra || "").trim();
  if (!letra) return res.status(400).json({ success: false, message: "Parâmetro letra obrigatório", data: {} });
  const [artistRaw, songRaw] = letra.split("-").map((v) => String(v || "").trim());
  if (!artistRaw || !songRaw) {
    return res.status(400).json({
      success: false,
      message: "Use o formato: artista - música",
      data: {}
    });
  }
  try {
    const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artistRaw)}/${encodeURIComponent(songRaw)}`, { timeout: 12000 });
    return res.json({
      success: true,
      message: "Letra encontrada",
      data: { artista: artistRaw, musica: songRaw, letra: response.data?.lyrics || "" }
    });
  } catch (err) {
    return res.status(404).json({ success: false, message: "Letra não encontrada", data: { error: err.message } });
  }
});

app.get('/api-bronxys/info_celular', async (req, res) => {
  const celular = String(req.query.celular || "").replace(/\D/g, "");
  if (!celular) return res.status(400).json({ success: false, message: "Parâmetro celular obrigatório", data: {} });
  const ddd = celular.length >= 10 ? celular.slice(0, 2) : "";
  let dddInfo = null;
  if (ddd) {
    try {
      const response = await axios.get(`https://brasilapi.com.br/api/ddd/v1/${ddd}`, { timeout: 12000 });
      dddInfo = response.data;
    } catch {
      dddInfo = null;
    }
  }
  return res.json({
    success: true,
    message: "Informações do celular",
    data: {
      celular,
      ddd,
      estado: dddInfo?.state || null,
      cidades: dddInfo?.cities || []
    }
  });
});

app.get('/api-bronxys/horoscopo', async (req, res) => {
  const signo = String(req.query.signo || "").trim().toLowerCase();
  if (!signo) return res.status(400).json({ success: false, message: "Parâmetro signo obrigatório", data: {} });
  const frases = [
    "Hoje é um bom dia para focar no que depende de você.",
    "Evite decisões impulsivas e priorize clareza.",
    "Boas oportunidades podem surgir em contatos próximos.",
    "Mantenha disciplina e você terá progresso consistente."
  ];
  return res.json({
    success: true,
    message: "Horóscopo diário",
    data: { signo, previsao: frases[Math.floor(Math.random() * frases.length)] }
  });
});

app.get('/api-bronxys/grupos', async (req, res) => {
  const q = String(req.query.q || "").trim();
  return res.json({
    success: true,
    message: "Busca de grupos (modo compatibilidade)",
    data: { query: q, resultado: [] }
  });
});

app.get('/api-bronxys/esporte_noticias', async (_req, res) => {
  return res.json({
    success: true,
    message: "Feed esportivo (modo compatibilidade)",
    data: { noticias: [] }
  });
});

app.get('/api-bronxys/attp_edit', async (req, res) => {
  const { texto, fonte, apikey } = req.query;
  const id = Number(fonte || 1);
  if (!texto) return res.status(400).json({ success: false, message: "Parâmetro texto obrigatório", data: {} });
  return legacyRedirect(res, `/sticker/attp/${Number.isFinite(id) && id > 0 ? id : 1}/animado`, { texto, apikey });
});

app.get('/api-bronxys/logos_EPH', async (req, res) => {
  const { texto, category, apikey } = req.query;
  if (!texto) return res.status(400).json({ success: false, message: "Parâmetro texto obrigatório", data: {} });
  if (!category) return res.status(400).json({ success: false, message: "Parâmetro category obrigatório", data: {} });
  return legacyRedirect(res, `/api/imagem/logo/${encodeURIComponent(String(category))}`, { query: texto, apikey });
});

app.get('/api-bronxys/logos_PHT', async (req, res) => {
  const { texto, category, apikey } = req.query;
  if (!texto) return res.status(400).json({ success: false, message: "Parâmetro texto obrigatório", data: {} });
  if (!category) return res.status(400).json({ success: false, message: "Parâmetro category obrigatório", data: {} });
  return legacyRedirect(res, `/api/imagem/logo/${encodeURIComponent(String(category))}`, { query: texto, apikey });
});

app.get('/api-bronxys/montagem', async (req, res) => {
  const { url, category, apikey } = req.query;
  if (!url) return res.status(400).json({ success: false, message: "Parâmetro url obrigatório", data: {} });
  if (!category) return res.status(400).json({ success: false, message: "Parâmetro category obrigatório", data: {} });
  return legacyRedirect(res, `/api/canva/montagem/${encodeURIComponent(String(category))}`, { url, apikey });
});

app.get('/api-bronxys/instagram', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: "Parâmetro url obrigatório", data: {} });
  try {
    const data = await instagramDl(String(url));
    const mediaUrl = pickFirstHttpUrl(data);
    if (!mediaUrl) {
      return res.status(404).json({ success: false, message: "Mídia do Instagram não encontrada", data: {} });
    }
    return res.json({ success: true, message: "Download pronto", data: [{ url: mediaUrl }] });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Erro ao processar Instagram", data: { error: err.message } });
  }
});

app.get('/api-bronxys/tiktok', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: "Parâmetro url obrigatório", data: {} });
  try {
    const data = await Tiktok(String(url));
    const videoUrl = data?.nowm || data?.video || data?.play || pickFirstHttpUrl(data);
    if (!videoUrl) return res.status(404).json({ success: false, message: "Vídeo não encontrado", data: {} });
    const stream = await axios.get(videoUrl, { responseType: "stream" });
    res.setHeader("Content-Type", "video/mp4");
    return stream.data.pipe(res);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Erro ao processar TikTok", data: { error: err.message } });
  }
});

app.get('/api-bronxys/:provider(facebook|face_video|face_audio|twitter_video|twitter_audio)', async (req, res) => {
  return res.status(501).json({
    success: false,
    message: "Endpoint legado cadastrado, mas provedor ainda não implementado nesta API",
    data: { provider: req.params.provider }
  });
});
// ===================== FIM LEGADO BOT =====================

app.get('/api/pesquisa/youtube2', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'youtube');
if (erro) return res.status(403).json({ erro });
if (!nome) {
return res.json({ status: false, resultado: 'cadê o parâmetro nome??' });
  }
try {
const serpApiKey = SERPAPI_KEY;
const url = `https://serpapi.com/search.json?engine=youtube&search_query=${encodeURIComponent(nome)}&api_key=${serpApiKey}&type=video`;
const response = await axios.get(url);
const videos = response.data.video_results || [];
if (!videos.length) 
return res.json({ status: false, mensagem: "Nenhum vídeo/música encontrado", resultado: [] });
const resultado = videos.map(video => ({
titulo: video.title,
url: video.link,
canal: video.channel || "Desconhecido",
visualizacoes: video.views || "N/A",
duracao: video.duration || "N/A",
thumbnail: video.thumbnail || ""
 }));
return res.json({ status: true, resultado });
} catch (error) {
console.error("Erro na API SerpApi:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null,
stack: error.stack || ""
        });
    }
});

app.get('/api/pesquisa/transcricao', async (req, res) => {
const { apikey, url } = req.query;
if (!apikey) {
return res.status(400).json({
rota: "/api/pesquisa/transcricao",
mensagem: "API Key é necessária",
status: false,
resultado: []
    });
  }
const erro = await usarApiKey(apikey, 'youtubeTranscricao');
if (erro) {
return res.status(403).json({
rota: "/api/pesquisa/transcricao",
mensagem: erro,
status: false,
resultado: []
    });
  }
if (!url) {
return res.json({
rota: "/api/pesquisa/transcricao",
mensagem: "Cadê o parâmetro url??",
status: false,
resultado: []
    });
  }
try {
const transcricao = await YoutubeTranscript.fetchTranscript(url);
if (transcricao && transcricao.length) {
const resultado = transcricao.map(item => ({
texto: item.text,
inicio: item.offset,
duracao: item.duration
      }));
return res.json({
rota: "/api/pesquisa/transcricao",
mensagem: "Transcrição oficial encontrada",
status: true,
resultado
      });
    }
const tempFile = path.join(__dirname, 'temp_audio.mp3');
await new Promise((resolve, reject) => {
const stream = ytdl(url, { filter: 'audioonly' })
.pipe(fs.createWriteStream(tempFile));
stream.on('finish', resolve);
stream.on('error', reject);
    });
const whisperCmd = `./main -m ./models/ggml-base.en.bin -f ${tempFile} -otxt`;
exec(whisperCmd, (err, stdout, stderr) => {
fs.unlinkSync(tempFile); // apagar o áudio temporário
if (err) {
console.error("Erro no Whisper:", err);
return res.json({
rota: "/api/pesquisa/transcricao",
mensagem: "Erro ao rodar Whisper",
status: false,
detalhes: stderr
        });
      }
return res.json({
rota: "/api/pesquisa/transcricao",
mensagem: "Transcrição gerada pelo Whisper",
status: true,
resultado: stdout.trim()
      });
    });
} catch (error) {
console.error("Erro na transcrição:", error.message);
return res.json({
rota: "/api/pesquisa/transcricao",
mensagem: error.message || "Erro desconhecido",
status: false,
detalhes: error.response?.data || null,
stack: error.stack || ""
    });
  }
});

app.get('/api/pesquisa/pensadorPesquisa', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'pensadorPesquisa');
if (erro) { return res.status(403).json({ erro }); }
const query = req.query;
if (!query) return res.json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const result = await pensadorSearch(query);
res.json({ 
status: true, 
criador: criador,
resultado: result });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

app.get('/api/pesquisa/pensadorFrases', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'pensadorFrase');
if (erro) { return res.status(403).json({ erro }); }
const query = req.query;
if (!query) return res.json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const result = await frasesPensador(query);
res.json({ 
status: true, 
criador: criador,
resultado: result });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

app.get('/api/pesquisa/frasesDeAmor', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'frasesDeAmor');
if (erro) { return res.status(403).json({ erro }); }
const query = req.query;
if (!query) return res.json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const result = await fraseAmor(query);
res.json({ 
status: true, 
criador: criador,
resultado: result });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

app.get("/api/pesquisa/pinterest", async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey)
return res.status(400).json({ status: false, erro: "API Key é necessária" });
const erro = await usarApiKey(apikey, "FreeFireLikesBooster");
if (erro)
return res.status(403).json({ status: false, erro });
if (!nome)
return res.status(400).json({ status: false, resultado: "Parâmetro nome é obrigatório" });
try {
const images = await gis(nome);
if (!images || images.length === 0)
return res.status(404).json({ status: false, mensagem: "Nenhuma imagem encontrada" });
const randomImage = images[Math.floor(Math.random() * images.length)];
const imageUrl = randomImage.url;
const response = await fetch(imageUrl);
const buffer = await response.arrayBuffer();
const contentType = response.headers.get("content-type") || "image/jpeg";
res.set("Content-Type", contentType);
res.send(Buffer.from(buffer));
} catch (err) {
console.error("Erro na rota /api/pesquisa/gimage:", err.message);
res.status(500).json({ status: false, erro: "Erro interno", detalhes: err.message, });
}
});

app.get('/api/pesquisa/pinterest2', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'youtube');
if (erro) return res.status(403).json({ erro });
if (!nome) {
return res.json({ status: false, resultado: 'cadê o parâmetro nome??' });
  }
try {
const giphyKey = GIPHY_API_KEY;
const url = `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(nome)}&limit=10&rating=g`;
const response = await axios.get(url);
const gifs = response.data.data.map(gif => ({
titulo: gif.title || "Sem título",
url: gif.images.original.url,
preview: gif.images.fixed_height_small.url
    }));
if (!gifs.length) {
return res.json({ status: false, mensagem: "Nenhum GIF encontrado", resultado: [] });
        }
return res.json({ status: true, resultado: gifs });
} catch (error) {
console.error("Erro na API Giphy:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null
        });
    }
});

app.get('/api/pesquisa/anime', async (req, res) => {
const nome = req.query.nome;
if (!nome) return res.json({ status: false, mensagem: "Parâmetro 'nome' é obrigatório" });
try {
const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(nome)}&limit=5`;
const response = await axios.get(url);
const animes = response.data.data || [];
if (!animes.length) 
return res.json({ status: false, mensagem: "Nenhum anime encontrado", resultado: [] });
const resultado = animes.map(anime => ({
nome: anime.title,
sinopse: anime.synopsis || "Sem sinopse",
imagem: anime.images?.jpg?.image_url || "",
genero: anime.genres?.map(g => g.name).join(", ") || "N/A",
episodios: anime.episodes || "N/A",
lancamento: anime.aired?.from?.split("T")[0] || "N/A",
score: anime.score || "N/A",
url: anime.url
        }));
return res.json({ status: true, resultado });
} catch (error) {
console.error("Erro na API Jikan:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null,
stack: error.stack || ""
        });
    }
});

app.get("/api/pesquisa/pinterestgif", async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey)
return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'youtube');
if (erro)
return res.status(403).json({ erro });
if (!nome)
 return res.json({ status: false, resultado: 'cadê o parâmetro nome??' });
try {
 const giphyKey = GIPHY_API_KEY;
 const url = `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(nome)}&limit=5&rating=g`;
 const response = await axios.get(url);
 const gifs = response.data.data;
if (!gifs.length) {
return res.json({ status: false, mensagem: "Nenhum GIF encontrado", resultado: [] });
}

const resultado = gifs.map(gif => ({ titulo: gif.title || "Sem título",
url_gif: gif.images.original.url, url_mp4: gif.images.original.mp4,
preview: gif.images.fixed_height_small.url  }));
return res.json({ status: true, resultado });
} catch (error) {
console.error("Erro na API Giphy:", error.message);
return res.json({ status: false, mensagem: error.message || "Erro desconhecido", detalhes: error.response?.data || null   });
}
});

app.get("/api/pesquisa/PinterestMultiMidia", async (req, res) => {
const url = req.query.url;
const apikey = req.query.apikey;
if (!url) return res.status(400).json({ erro: "Parâmetro 'url' obrigatório." });
if (!apikey) return res.status(400).json({ erro: "Parâmetro 'apikey' obrigatório." });
const erro = await usarApiKey(apikey, 'PinterestMultiMidia');
if (erro) return res.status(403).json({ erro });
try {
const resultado = await PinterestMultiMidia(url);
if (!resultado || !resultado.f_url) {
return res.status(404).json({
status: "falha",
mensagem: "Mídia não encontrada ou não é suportada.",
resultado
});
}
res.json({
status: "online",
resultado
});
} catch (e) {
res.status(500).json({
status: "offline",
erro: "Erro interno ao processar a solicitação.",
detalhes: e.message
});
}
});

app.get('/api/pesquisa/wallpaper', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'wallpaper');
if (erro) { return res.status(403).json({ erro }); }
const query = req.query;
if (!query) return res.json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const result = await wallpaper(query);
res.json({ 
status: true, 
criador: criador,
resultado: result });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

app.get('/api/pesquisa/wallpaper2', async (req, res) => {
 const { apikey } = req.query;
 if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'wallpaper2');
if (erro) return res.status(403).json({ erro });
try {
const link = wallpaper2[Math.floor(Math.random() * wallpaper2.length)];
const response = await axios.get(link, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type']);
response.data.pipe(res);
} catch (e) {
consoleErro(e);
res.status(500).json({ status: false, resultado: "ocorreu um erro ao buscar wallpaper." });
}
});

app.get('/api/pesquisa/hentai', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'hentai');
if (erro) { return res.status(403).json({ erro }); }
const query = req.query;
if (!query) return res.json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const result = await hentai(query);
res.json({ 
status: true, 
criador: criador,
resultado: result });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

app.get('/api/pesquisa/amazon', async (req, res) => {
const { apikey, nome } = req.query; // captura 'nome'
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'amazon');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.json({ status: false, resultado: 'cadê o parâmetro nome??' });
try {
const serpApiKey = SERPAPI_KEY;
const url = `https://serpapi.com/search.json?engine=amazon&k=${encodeURIComponent(nome)}&api_key=${serpApiKey}`;
const response = await axios.get(url);
const produtos = response.data.organic_results || [];
if (!produtos.length) return res.json({ status: false, mensagem: "Nenhum produto encontrado", resultado: [] });
const resultado = produtos.map(produto => ({
titulo: produto.title || "Desconhecido",
url: produto.link || "",
preco: produto.price ? produto.price.value + " " + produto.price.currency : "N/A",
avaliacao: produto.rating || "N/A",
reviews: produto.reviews || "N/A",
imagem: produto.thumbnail || ""
    }));
return res.json({ status: true, resultado });
} catch (error) {
console.error("Erro na API SerpApi (Amazon):", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null,
stack: error.stack || ""
    });
  }
});

app.get('/api/pesquisa/playstore', async (req, res) => {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'playstore');
if (erro) { return res.status(403).json({ erro }); }
const query = req.query;
if (!query) return res.json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const result = await playStoreSearch(query);
res.json({ 
status: true, 
criador: criador,
resultado: result });
} catch (e) {
consoleErro(e);
res.json({ status: false, resultado: "ocorreu um erro ao buscar informações do vídeo." });
}
});

app.get('/api/pesquisa/freefirelike', async (req, res) => {
const { apikey, query, req: reqCount, delay } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'FreeFireLikesBooster');
if (erro) return res.status(403).json({ erro });
if (!query) return res.status(400).json({ status: false, resultado: 'cadê o parâmetro query??' });
try {
const booster = new FreeFireLikesBooster(
query,//ID do jogador->
0,// região (0 = Brasil)->
parseInt(reqCount) || 1, //número de requisições->
parseInt(delay) || 1000//delay entre requisições->
);
await booster.start();
res.json({
status: true,
criador: 'Tosh DFS TECH', //defina como desejar->
resultado: {
id: query,
likesEnviados: booster.successCount * 100,
erros: booster.errorCount
}
});
} catch (e) {
consoleErro(e); //certifique-se de que essa função existe->
res.status(500).json({ status: false, resultado: "ocorreu um erro ao enviar likes." });
}
});

app.get('/api/pesquisa/gimage', async (req, res) => {
const { apikey, query, req: reqCount, delay, q } = req.query;
if (!apikey) return res.status(400).json({ status: false, erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'FreeFireLikesBooster');
if (erro) return res.status(403).json({ status: false, erro });
if (!query && !q) {
return res.status(400).json({ status: false, resultado: 'Cadê o parâmetro query??' });
}
try {
const termoBusca = query || q;
const images = await gis(termoBusca);
res.json({
status: true,
criador: 'Tosh DFS TECH ',
query: termoBusca,
count: images.length,
results: images
});
} catch (err) {
console.error('Erro na rota /api/pesquisa/gimage:', err.message);
res.status(500).json({
status: false,
erro: 'Erro interno',
detalhes: err.message
    });
  }
});

app.get('/api/pesquisa/pokemon', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'pokemon');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.json({ status: false, resultado: 'Cadê o parâmetro nome??' });
try {
const url = `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(nome.toLowerCase())}`;
const response = await axios.get(url);
const data = response.data;
const resultado = { nome: data.name, id: data.id, altura: data.height, peso: data.weight, tipos: data.types.map(t => t.type.name), habilidades: data.abilities.map(a => a.ability.name), sprites: data.sprites.front_default };
return res.json({ rota: "/api/pokemon", status: true, resultado });
} catch (error) {
console.error("Erro na PokeAPI:", error.message);
return res.json({ rota: "/api/pokemon", status: false,  mensagem: "Pokémon não encontrado ou erro na API", detalhes: error.response?.data || null, stack: error.stack || "" });
}
});

app.get('/api/pesquisa/pokemon2', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'pokemonFull');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.json({ status: false, resultado: 'Cadê o parâmetro nome??' });
try {
const pokeUrl = `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(nome.toLowerCase())}`;
const response = await axios.get(pokeUrl);
const data = response.data;
let evolutions = [];
try {
const speciesRes = await axios.get(data.species.url);
const evolutionChainRes = await axios.get(speciesRes.data.evolution_chain.url);
const traverseChain = (chain) => {  evolutions.push(chain.species.name);
if (chain.evolves_to.length) traverseChain(chain.evolves_to[0]);
};
traverseChain(evolutionChainRes.data.chain);
} catch (err) {
evolutions = [];
}
const resultado = { nome: data.name, id: data.id,altura: data.height, peso: data.weight, tipos: data.types.map(t => t.type.name), habilidades: data.abilities.map(a => a.ability.name),
stats: data.stats.map(s => ({ nome: s.stat.name, valor: s.base_stat })),
sprites: { front_default: data.sprites.front_default, back_default: data.sprites.back_default, front_shiny: data.sprites.front_shiny,back_shiny: data.sprites.back_shiny, other: data.sprites.other},
evolucoes: evolutions };
return res.json({  rota: "/api/pokemon/full", status: true, resultado
});
} catch (error) {
console.error("Erro na PokeAPI:", error.message);
return res.json({ rota: "/api/pokemon/full", status: false,
mensagem: "Pokémon não encontrado ou erro na API",
detalhes: error.response?.data || null, stack: error.stack || "" });
}
});

////★・・・・・・★・・・ INTELIGÊNCIAS ・・・★・・・・・・
app.get("/api/ai/texto/chatgpt", async (req, res) => {
  const { query } = req.query;
  if (!query)
    return res.status(400).json({ status: false, erro: "Parâmetro 'query' é obrigatório." });

  try {
  const HUGGINGFACE_TOKEN =  "DFS TECH";
  const MODEL = "gpt2"; // GPT-2 leve, público e gratuito
    const response = await axios.post(
      `https://api-inference.huggingface.co/models/${MODEL}`,
      { inputs: query },
      {
        headers: { Authorization: `Bearer ${HUGGINGFACE_TOKEN}` },
        timeout: 10000
      }
    );

    const data = response.data;
    // Retorno do GPT-2: generated_text
    const resposta = data?.[0]?.generated_text || data?.generated_text || "Sem resposta";

    res.json({
      status: true,
      criador: "Tosh DFS TECH",
      resposta
    });
  } catch (err) {
    console.error("Erro na rota /api/ai/texto/chatgpt:", err.message);
    res.status(500).json({
      status: false,
      erro: "Erro ao chamar Hugging Face API",
      detalhes: err.message,
      fallback: "Opa! Tosh na área! em manutenção, tente novamente mais tarde."
    });
  }
});

app.get("/api/ai/texto/gemini", async (req, res) => {
const { query } = req.query;
if (!query)
return res.status(400).json({ status: false, erro: "Parâmetro 'query' é obrigatório." });
try {
const resposta = await chamarGemini(query);
res.json({ status: true, criador: "Tosh DFS TECH", resposta });
} catch (err) {
console.error('Erro na rota /api/ai/texto/gemini:', err.message);
res.status(500).json({
status: false,
erro: 'Erro interno',
detalhes: err.message  });
   }
});

app.get("/api/ai/sticker/stickAi", async (req, res) => {
const { apikey, query } = req.query;
if (!query) return res.status(400).json({ erro: "Parâmetro 'query' é obrigatório" });
if (!apikey) return res.status(400).json({ erro: "Parâmetro 'apikey' é obrigatório" });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
try {
const data = await stickAi(query);
const imgUrl = data?.imagem?.[0];
if (!imgUrl) return res.status(404).json({ erro: "Nenhuma imagem retornada" });
const fetch = (await import('node-fetch')).default;
const response = await fetch(imgUrl);
const buffer = await response.buffer();
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);
} catch (e) {
console.error(e);
res.status(500).json({ status: "offline", criadora: "DFS TECH API",
erro: "Erro ao gerar a figurinha" });
}
});

app.get("/api/ai/imagem/imagemAi", async (req, res) => {
const {apikey, query} = req.query;
if (!query) return res.status(500).json({ success: false, message: "Parâmetro query é obrigatório", data: {} })
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, 'NOME');
if (erro) { return res.status(403).json({ erro }); }
try {
result = await imagemAi(query)
console.log(result)
const response = await axios.get(result.resultado.imagem, { responseType: "arraybuffer" });
res.setHeader("Content-Type", response.headers["content-type"]);
res.send(response.data);
} catch (e) {
res.json({
status: "offline",
criadora,
erro: "Deu erro na sua solicitação"
})
console.log(e)
}
})

app.get("/api/ai/hd/imagem", async (req, res) => {
try {
if (!sharp) {
return res.status(500).json({ erro: "Dependência sharp não instalada no servidor" });
}
const { url } = req.query;
if (!url) {
return res.status(400).json({ erro: "Parâmetro 'url' é obrigatório" });
}
const response = await axios.get(url, {
responseType: "arraybuffer",
headers: { "User-Agent": "Mozilla/5.0" }
});
const inputBuffer = Buffer.from(response.data);
const outputBuffer = await sharp(inputBuffer)
.resize({
width: 2048,
kernel: sharp.kernel.lanczos3,
fit: "inside",
withoutEnlargement: false
})
.modulate({
brightness: 1.05,
saturation: 1.15
})
.sharpen({
sigma: 1.2,
m1: 1,
m2: 2
})
.jpeg({
quality: 98,
chromaSubsampling: "4:4:4"
})
.toBuffer();
res.set("Content-Type", "image/jpeg");
res.set("Cache-Control", "no-store");
res.send(outputBuffer);
} catch (err) {
console.error("Erro ao processar imagem:", err.message);
res.status(500).json({
rota: "/api/ai/hd/imagem",
mensagem: "Erro interno ao converter imagem",
detalhes: err.message
});
}
});

//★・・・・・・★・・・ IMAGEM ・・★・・・・・・★
app.get('/api/imagem/animememe', async (req, res) => {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'animememe');
if (erro) return res.status(403).json({ erro });
try {
const link = animememe[Math.floor(Math.random() * animememe.length)];
const response = await axios.get(link, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type']);
response.data.pipe(res);
} catch (e) { consoleErro(e);
res.status(500).json({ status: false, resultado: "ocorreu um erro ao buscar animememe." });
}
});

app.get("/api/imagem/metadinha", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'metadinha');
if (erro) return res.status(403).json({ erro });
try {
const bla = process.cwd();
const json = JSON.parse(fs.readFileSync(`${bla}/BANCO DE DADOS/metadinha.json`, 'utf8'));
const random = json[Math.floor(Math.random() * json.length)];
res.json(random);
} catch (e) {
res.status(500).json({ erro: 'Erro ao ler o arquivo JSON' });
}
});

app.get("/api/imagem/metadinha2", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, 'NOME');
if (erro) { return res.status(403).json({ erro }); }
try {
metadinha2().then((data) => {
res.json({
data
})
})
} catch (e) {
res.json({
status: "offline",
criadora,
erro: "Deu erro na sua solicitação"
})
}
})

app.get("/api/imagem/travaZapImg", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, 'NOME');
if (erro) { return res.status(403).json({ erro }); }
try {
travaZapImg().then((data) => {
res.json({
data
})
})
} catch (e) {
res.json({
status: "offline",
criadora,
erro: "Deu erro na sua solicitação"
})
}
})

app.get("/api/imagem/travaZapImg2", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, 'NOME');
if (erro) { return res.status(403).json({ erro }); }
try {
travaZapImg2().then((data) => {
res.json({
data
})
})
} catch (e) {
res.json({
status: "offline",
criadora,
erro: "Deu erro na sua solicitação"
})
}
})

//★・・・・・・★・・・ CANVAS ・・・★・・・・・・★
app.get("/api/canva/bemVindo", async (req, res) => {
const { titulo, avatar, fundo, desc, nome, apikey } = req.query
if (!titulo || !avatar || !fundo || !desc || !nome) 
return res.status(500).json({ success: false, message: "Parâmetro titulo, avatar, fundo, desc, nome são obrigatórios", data: {} })
if (!apikey) 
return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
try {
const erro = await usarApiKey(apikey, "uso");
if (erro) return res.status(403).json({ erro });
const buffer = await CanvabemVindo(titulo, avatar, fundo, desc, nome)
res.setHeader("Content-Type", "image/png")
res.send(buffer)
} catch (e) {
console.error("Erro rota bemVindo:", e)
res.json({
status: "offline",
criador: "Tosh DFS TECH",
erro: "Deu erro na sua solicitação"
})
}
})

app.get("/api/canva/bemVindo2", async (req, res) => {
const { titulo, avatar, fundo, desc, nome, apikey } = req.query
if (!titulo || !avatar || !fundo || !desc || !nome) 
return res.status(500).json({ success: false, message: "Parâmetro titulo, avatar, fundo, desc, nome são obrigatórios", data: {} })
if (!apikey) 
return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
try {
const erro = await usarApiKey(apikey, "uso");
if (erro) return res.status(403).json({ erro });
const buffer = await CanvabemVindo2(titulo, avatar, fundo, desc, nome)
res.setHeader("Content-Type", "image/png")
res.send(buffer)
} catch (e) {
console.error("Erro rota bemVindo:", e)
res.json({
status: "offline",
criador: "Tosh DFS TECH",
erro: "Deu erro na sua solicitação"
})
}
})


app.get("/api/canva/level", async (req, res) => {
const { avatar, fundo, nome, level1, level2 } = req.query
if (!nome || !avatar || !fundo || !level1)
return res.status(500).json({ success: false, message: "Parâmetro nome, avatar, fundo, level1, level2 são obrigatórios", data: {} })
const apikey = req.query.apikey
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, "uso")
if (erro) return res.status(403).json({ erro })
try {
const buffer = await canvaLevel(avatar, fundo, nome, level1, level2)
res.setHeader("Content-Type", "image/png")
res.send(buffer)
} catch (e) {
console.log(e) // 👈 ME MANDA ESSE ERRO SE DER DE NOVO
res.json({
status: "offline",
criador,
erro: "Deu erro na sua solicitação"
})
}
})

app.get("/api/canva/musicCard", async (req, res) => {
const { avatar, artistName, time, name, apikey } = req.query;
if (!avatar || !artistName || !time || !name)
return res.status(400).json({ success: false, message: "Parâmetro avatar, artistName, time, name são obrigatórios", data: {} });
if (!apikey) return res.status(400).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} });
const erro = await usarApiKey(apikey, "uso");
if (erro) return res.status(403).json({ erro });
try {
const buffer = await canvaMusicCard(avatar, artistName, time, name);
res.setHeader("Content-Type", "image/png");
res.send(buffer);
} catch (e) {
console.log(e);
res.json({
status: "offline",
criador: "Tosh DFS TECH",
erro: "Deu erro na sua solicitação"
});
}
});

app.get("/api/canva/musicCard2", async (req, res) => {
const { avatar, name, artistName, time, progress } = req.query;
if (!avatar || !name || !artistName) {
return res.status(400).json({ success: false, message: "Parâmetros avatar, name e artistName são obrigatórios", data: {} });
}
const apikey = req.query.apikey;
if (!apikey) return res.status(401).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} });
const erro = await usarApiKey(apikey, "uso");
if (erro) return res.status(403).json({ erro });
try {
const imageBuffer = await canvaMusicCard2(
avatar, 
artistName, 
time || "04:23", // Tempo total padrão caso não enviado
name, 
parseFloat(progress) || 0.5 // Progresso padrão 50%
);
res.setHeader("Content-Type", "image/png");
res.send(imageBuffer);
} catch (e) {
console.error("Erro ao gerar card:", e);
res.status(500).json({
status: "error",
criador: "SeuNome", // Ajuste para sua variável global de criador
erro: "Erro interno ao processar a imagem." });
}
});

app.get("/api/canva/montagem/:nome", async (req, res) => {
const nome = req.params.nome
const link = req.query.url
if (!link) return res.status(500).json({ success: false, message: "Parâmetro url e obrigatório", data: {} })
const apikey = req.query.apikey;
if (!apikey) return res.status(500).json({ success: false, message: "Parâmetro apikey é obrigatório", data: {} })
const erro = await usarApiKey(apikey, "uso");
if (erro) { return res.status(403).json({ erro }); }
try {
data = await canvaMontagem(nome, link)
const response = await axios.get(data, { responseType: "arraybuffer" });
res.setHeader("Content-Type", response.headers["content-type"]);
res.send(response.data);
} catch (e) {
res.json({
status: "offline",
criador,
erro: "Deu erro na sua solicitação"
})
console.log(e)
}
})

//★・・・・・・★・・・ +18 ・・・★・・・・・・★
app.get("/api/18/ass", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'ass');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/ass.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/azurlane", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'azurlane');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/azurlane.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/bdsm", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'bdsm');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/bdsm.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/blackclover", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'blackclover');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/blackclover.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/bleach", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'bleach');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/bleach.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/cosplay", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'cosplay');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/cosplay.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/dbz", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'dbz');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/dbz.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/dragonmaid", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'dragonmaid');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/dragonmaid.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/futanari", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'futanari');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/futanari.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/gordinha", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'gordinha');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/gordinha.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/hentai", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'hentai');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/hentai.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/jujutsukaisen", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'jujutsukaisen');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/jujutsukaisen.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/konosuba", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'konosuba');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/konosuba.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/lesbian", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'lesbian');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/lesbian.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/milf", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'milf');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/milf.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/monstergirls", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'monstergirls');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/monstergirls.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/myheroacademy", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'myheroacademy');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/myheroacademy.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/naruto", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'naruto');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/naruto.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/oniepiece", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'oniepiece');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/oniepiece.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/overlord", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'overlord');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/overlord.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/pokemon", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'pokemon');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/pokemon.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/rezero", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'rezero');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/rezero.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/tentaculos", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'tentaculos');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/tentaculos.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/wall", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'wall');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/wall.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'image/png');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/video/sex", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'sex');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/sex.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/video/sexv", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'sexv');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/sex.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

app.get("/api/18/video/amador", async (req, res) => {
const apikey = req.query.apikey;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'sexv');
if (erro) return res.status(403).json({ erro });
try {
const caminho = `${process.cwd()}/BANCO DE DADOS/Mais18/amador.json`;
const json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
const urlImagem = json[Math.floor(Math.random() * json.length)];
const response = await axios.get(urlImagem, { responseType: 'stream' });
res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
response.data.pipe(res);
} catch (e) { console.error(e);
return res.status(500).json({ erro: 'Erro ao carregar a imagem' });
}
});

plaquinhas.forEach(plaq => {
app.get(`/api/18/plaquinha${plaq.id}`, async (req, res) => {
const { apikey, text } = req.query;
if (!apikey) return res.status(400).json({ status: false, erro: 'APIKEY obrigatória.' });
const erro = await usarApiKey(apikey, `plaquinha${plaq.id}`);
if (erro) return res.status(403).json({ status: false, erro });
if (!text) return res.status(400).json({ status: false, erro: 'Parâmetro "text" obrigatório' });
if (text.length > 15) return res.status(400).json({ status: false, erro: 'Texto muito longo, máximo 15 caracteres.' });
const imageUrl = plaq.url.replace('{text}', encodeURIComponent(text));
try {
const response = await fetch(imageUrl);
const contentType = response.headers.get('content-type');
const buffer = await response.buffer();
res.set('Content-Type', contentType);
res.send(buffer);
} catch (err) {
res.status(500).json({ status: false, erro: 'Erro ao buscar imagem.' });
}
});
});


app.get('/api/18/xvideos', async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'xvideos');
if (erro) return res.status(403).json({ erro });
if (!nome) return res.json({ status: false, resultado: 'Cade o parametro nome??' });
xvideos(nome).then((vídeo) => {
res.json({
status: true,
código: 200,
criador: `${criador}`,
resultado: vídeo 
});
}).catch(e => {
res.json({
status: false,
codigo: 400,
criador,
resultado: "Deu erro ao solicitar seu meme...."
});
console.log(e);
});
});

////★・・・・・・★・・・ FIGURINHAS ・・★・・・・・・★
app.get("/sticker/tema", async (req, res) => {
const { apikey, nome } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'sticker');
if (erro) return res.status(403).json({ erro });
if (!nome) {
return res.json({ status: false, mensagem: 'Parâmetro "nome" é obrigatório' });
    }
try {
const giphyKey = GIPHY_API_KEY; // sua chave Giphy
const url = `https://api.giphy.com/v1/stickers/search?api_key=${giphyKey}&q=${encodeURIComponent(nome)}&limit=20&rating=g`;
const response = await axios.get(url);
const stickers = response.data.data;
if (!stickers.length) {
return res.json({ status: false, mensagem: "Nenhuma figurinha encontrada", resultado: [] });
        }
const resultado = stickers.map(sticker => ({
titulo: sticker.title || "Sem título",
url: sticker.images.original.url,    // GIF da figurinha
mp4: sticker.images.original.mp4,    // versão vídeo (mais leve)
preview: sticker.images.fixed_height_small.url // preview menor
        }));
return res.json({ status: true, resultado });
} catch (error) {
console.error("Erro na API Giphy:", error.message);
return res.json({
status: false,
mensagem: error.message || "Erro desconhecido",
detalhes: error.response?.data || null,
stack: error.stack || ""  });
}
});

app.all('/sticker/figu_emoji', async (req, res) => {
try {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
const { figurinhas } = require('./BANCO DE DADOS/Figurinhas/pack_emoji.json');
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível no pack_emoji.json' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);
} catch (error) {
consoleErro('Erro no endpoint /sticker/figu_emoji:', error);
res.status(500).json({ status: false,
mensagem: 'Erro interno ao processar a solicitação.' });
}
});
   
app.all('/sticker/figu_random', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
const packs = [
require('./BANCO DE DADOS/Figurinhas/pack_anime.json'),
require('./BANCO DE DADOS/Figurinhas/pack_emoji.json'),
require('./BANCO DE DADOS/Figurinhas/pack_coreanas.json'),
require('./BANCO DE DADOS/Figurinhas/pack_desenho.json'),
require('./BANCO DE DADOS/Figurinhas/pack_bebe.json'),
require('./BANCO DE DADOS/Figurinhas/pack_aleatorio.json')
];
const packEscolhido = packs[Math.floor(Math.random() * packs.length)];
if (!Array.isArray(packEscolhido.figurinhas) || packEscolhido.figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível nos packs locais' });
}
const randomIndex = Math.floor(Math.random() * packEscolhido.figurinhas.length);
const figurinha = packEscolhido.figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);
} catch (error) {
consoleErro('Erro no endpoint /sticker/figu_random:', error);
res.status(500).json({  status: false,
mensagem: 'Erro interno ao processar a solicitação.'});
}
});

app.all('/sticker/figu_desenho2', async (req, res) => {
try {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'AP    I Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) { return res.status(403).json({ erro }); }
try {
res.type('png')
var rnd = Math.floor(Math.random() * 102)
res.send(await getBuffer(`https://raw.githubusercontent.com/Scheyot2/anya-bot/master/Figurinhas/figu_flork/${rnd}.webp`))
} catch (e) {
res.send(msgApi.error)
}
} catch (error) {
consoleErro('Erro no endpoint:', error);
res.status(500).json({ status: false, mensagem: "Erro interno ao processar a solicitação." });
}
})

app.all('/sticker/figu_aleatori', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
const { figurinhas } = require('./BANCO DE DADOS/Figurinhas/pack_aleatorio.json');
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível no pack_aleatorio.json' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);

} catch (error) {
consoleErro('Erro no endpoint /sticker/figu_aleatori:', error);
res.status(500).json({
status: false,
mensagem: 'Erro interno ao processar a solicitação.' });
}
});

app.all('/sticker/figu_memes', async (req, res) => {
try {
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) { return res.status(403).json({ erro }); }
try {
res.type('png')
var rnd = Math.floor(Math.random() * 109)
res.send(await getBuffer(`https://raw.githubusercontent.com/Scheyot2/sakura-botv6/master/FIGURINHAS/Figurinha-memes/${rnd}.webp`))
} catch (e) {
res.send(msgApi.error)
}
} catch (error) {
consoleErro('Erro no endpoint:', error);
res.status(500).json({ status: false, mensagem: "Erro interno ao processar a solicitação." });
}
})
   
app.all('/sticker/figu_anime', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
const { figurinhas } = require('./BANCO DE DADOS/Figurinhas/pack_anime.json');
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível no pack_anime.json' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);
} catch (error) {
consoleErro('Erro no endpoint /sticker/figu_anime:', error);
res.status(500).json({ status: false,
mensagem: 'Erro interno ao processar a solicitação.' });
}
});

app.all('/sticker/figu_coreana', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
const { figurinhas } = require('./BANCO DE DADOS/Figurinhas/pack_coreanas.json');
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível no sticker/figu_coreana' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);
} catch (error) {
consoleErro('Erro no endpoint /sticker/figu_coreana:', error);
res.status(500).json({ status: false,
mensagem: 'Erro interno ao processar a solicitação.' });
}
});

app.all('/sticker/figu_bebe', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurinhas');
if (erro) return res.status(403).json({ erro });
const filePath = path.join(__dirname, './BANCO DE DADOS/Figurinhas/pack_bebe.json');
if (!fs.existsSync(filePath)) {
return res.status(404).json({ erro: 'Arquivo pack_bebe.json não encontrado' });
}
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const figurinhas = data.figurinhas;
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.end(buffer);
} catch (error) {
console.error('ERRO REAL:', error);
res.status(500).json({
rota: "/sticker/figu_bebe",
mensagem: "Erro interno ao processar a solicitação.",
detalhes: error.message
});
}
});

app.all('/sticker/figu_desenho', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) return res.status(403).json({ erro });
const { figurinhas } = require('./BANCO DE DADOS/Figurinhas/pack_desenho.json');
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível no pack_desenho.json' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.send(buffer);
} catch (error) {
consoleErro('Erro no endpoint /sticker/figu_coreana:', error);
res.status(500).json({ status: false,
mensagem: 'Erro interno ao processar a solicitação.' });
}
});

app.all('/sticker/figu_animais', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurinhas');
if (erro) return res.status(403).json({ erro });
const filePath = path.join(__dirname, './BANCO DE DADOS/Figurinhas/figu_animais');
if (!fs.existsSync(filePath)) {
return res.status(404).json({ erro: 'Arquivo figu_animais não encontrado' });
}
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const figurinhas = data.figurinhas;
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.end(buffer);
} catch (error) {
console.error('ERRO REAL:', error);
res.status(500).json({
rota: "/sticker/figu_animais",
mensagem: "Erro interno ao processar a solicitação.",
detalhes: error.message
});
}
});

app.all('/sticker/figu_raiva', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurinhas');
if (erro) return res.status(403).json({ erro });
const filePath = path.join(__dirname, './BANCO DE DADOS', 'Figurinhas', 'pack_figu_raiva.json');
if (!fs.existsSync(filePath)) {
return res.status(404).json({ erro: 'Arquivo pack_figu_raiva.json não encontrado' });
}
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const figurinhas = data.figurinhas;
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.end(buffer);
} catch (error) {
console.error('Erro no endpoint /sticker/figu_raiva:', error);
res.status(500).json({
rota: "/sticker/figu_raiva",
mensagem: "Erro interno ao processar a solicitação.",
detalhes: error.message
});
}
});

app.all('/sticker/figu_roblox', async (req, res) => {
try {
const { apikey } = req.query;
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurinhas');
if (erro) return res.status(403).json({ erro });
const filePath = path.join(__dirname, './BANCO DE DADOS', 'Figurinhas', 'pack_figu_roblox.json');
if (!fs.existsSync(filePath)) {
return res.status(404).json({ erro: 'Arquivo pack_figu_roblox.json não encontrado' });
}
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const figurinhas = data.figurinhas;
if (!Array.isArray(figurinhas) || figurinhas.length === 0) {
return res.status(404).json({ erro: 'Nenhuma figurinha disponível' });
}
const randomIndex = Math.floor(Math.random() * figurinhas.length);
const figurinha = figurinhas[randomIndex];
const buffer = await getBuffer(figurinha);
res.setHeader('Content-Type', 'image/webp');
res.end(buffer);
} catch (error) {
console.error('Erro no endpoint /sticker/figu_roblox:', error);
res.status(500).json({
rota: "/sticker/figu_roblox",
mensagem: "Erro interno ao processar a solicitação.",
detalhes: error.message
});
}
});
   
//FEITAS POR PEDROZZ MODS

app.all('/sticker/:nomesFigu', async (req, res) => {
try {
const { nomesFigu } = req.params;
const { apikey } = req.query;  
if (!apikey) return res.status(400).json({ erro: 'API Key é necessária' });
const erro = await usarApiKey(apikey, 'figurunhas');
if (erro) { return res.status(403).json({ erro }); }
   try {
const config = {
//=figu_random: { pastaName: 'random', NomeFig: 'ramdon', max: 585 },
'figu+18': { pastaName: '+18', NomeFig: 'figurinhas', max: 89 },
figu_memes2: { pastaName: 'memes', NomeFig: 'figurinhas', max: 49 },
figu_anime2: { pastaName: 'animes', NomeFig: 'figurinhas', max: 220 },
figu_coreanas2: { pastaName: 'coreanas', NomeFig: 'figurinhas', max: 73 },
figu_gatos: { pastaName: 'gatos', NomeFig: 'figurinhas', max: 108 },
figu_bts: { pastaName: 'bts', NomeFig: 'figurinhas', max: 30 },
};
const { pastaName, NomeFig, max } = config[nomesFigu];
res.type('png')
var numero = Math.floor(Math.random() * max)
res.send(await getBuffer(`https://pedrozz13755.github.io/Arquivos_web/figurinhas/${pastaName}/${NomeFig}${numero}.webp`))
} catch (e) {
res.send(msgApi.error)
}
} catch (error) {
consoleErro('Erro no endpoint:', error);
res.status(500).json({ status: false, mensagem: "Erro interno ao processar a solicitação." });
}
})   

app.get("/sticker/atp/:id", async (req, res) => {
try {
const { apikey, texto } = req.query;
const id = parseInt(req.params.id) - 1;
if (!apikey) return res.status(400).json({ erro: "API Key é necessária" });
const erro = await usarApiKey(apikey, "figurinhas");
if (erro) return res.status(403).json({ erro });
if (!texto) return res.status(400).json({ erro: "Informe o texto" });
if (!fontes[id]) return res.status(400).json({ erro: "Fonte inválida" });
const family = fontes[id].replace(".ttf", "");
const buffer = await gerarStickerFonte(texto, family);
res.setHeader("Content-Type", "image/webp");
res.send(buffer);
} catch (err) {
console.error("ERRO ATP:", err);
res.status(500).json({
rota: "/sticker/atp/:id",
mensagem: "Erro ao gerar figurinha",
detalhes: err.message });
}
});

app.get("/sticker/attp/:id/animado", async (req, res) => {
try {
const { apikey, texto } = req.query;
const id = parseInt(req.params.id) - 1;
if (!apikey) return res.status(400).json({ erro: "API Key é necessária" });
const erro = await usarApiKey(apikey, "figurinhas");
if (erro) return res.status(403).json({ erro });
const txt = texto || "Texto";
if (!fontes[id]) {
return res.status(404).json({ erro: "Fonte não existe" });
}
const family = fontes[id].replace(".ttf", "");
const buffer = await gerarGifAnimadoFonte(txt, family);
res.setHeader("Content-Type", "image/gif");
res.send(buffer);
} catch (e) {
console.error("ERRO ATTP:", e);
res.status(500).json({
rota: "/sticker/attp/:id/animado",
mensagem: "Erro ao gerar GIF animado",
detalhes: e.message });
}
});

app.get("/sticker/brait/:id/animado", async (req, res) => {
try {
const { apikey, texto } = req.query;
const id = parseInt(req.params.id);
if (!apikey) return res.status(400).json({ erro: "API Key é necessária" });
const erro = await usarApiKey(apikey, "figurinhas");
if (erro) return res.status(403).json({ erro });
if (isNaN(id) || id < 1 || id > 17) {
return res.status(400).json({ erro: "ID inválido. Use de 1 a 17" });
}
const txt = texto || `Brait${id}`;
const familyIndex = (id - 1) % fontes.length;
const family = fontes[familyIndex].replace(".ttf", "");
const buffer = await gerarStickerBraitComEmoji(txt, family);
res.setHeader("Content-Type", "image/png");
res.send(buffer);
} catch (e) {
console.error("ERRO BRAIT:", e);
res.status(500).json({
rota: "/sticker/brait/:id/animado",
mensagem: "Erro ao gerar sticker Brait",
detalhes: e.message });
}
});

////★・・・・・・★・・・ LOGOS ・・★・・・・・・★
app.get("/api/imagem/logo/:logoName", async (req, res) => {
const { apikey, query } = req.query;
const logoName = req.params.logoName;
if (!apikey) return res.status(400).json({ erro: "Parâmetro 'apikey' é obrigatório" });
if (!query) return res.status(400).json({ erro: "Parâmetro 'query' é obrigatório" });
const erro = await usarApiKey(apikey, "uso");
if (erro) { return res.status(403).json({ erro }); }
try {
const dd = await logo(logoName, query)
const response = await axios.get(dd, { responseType: "arraybuffer" });
res.setHeader("Content-Type", response.headers["content-type"]);
res.send(response.data);
} catch (e) {
res.status(500).json({
status: "offline",
erro: "Erro ao buscar a imagem"
});
}
});

app.get("/api/imagem/logo6/text", async (req, res) => {
const { texto = "Olá!", largura, altura } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "IMG-20250916-WA0254.png");
const fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 6);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = (fundo.width - textWidth) / 2;
const y = fundo.height - fontSize / 2;
const offset = 4;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx * dx + dy * dy <= offset * offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
const prataGradient = ["#a0a0a0", "#c0c0c0", "#e0e0e0", "#ffffff"];
for (let i = 0; i < prataGradient.length; i++) {
ctx.fillStyle = prataGradient[i];
ctx.fillText(texto, x, y - i * 2);
        }
ctx.fillStyle = "#ffffff";
ctx.fillText(texto, x, y - prataGradient.length * 2);
res.setHeader("Content-Type", "image/png");
await PImage.encodePNGToStream(img, res);
} catch (err) {
console.error(err);
res.status(500).json({
status: false,
erro: "Erro ao gerar imagem",
detalhes: err.message
        });
    }
});

app.get("/api/imagem/logo7/text", async (req, res) => {
const { texto = "Olá!" } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "167569c21a651dc87f757c12e67261dc_edited_1758147862710.png");
let fundo;
try {
fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
} catch (e) {
console.log("Falha ao ler PNG, tentando JPEG...");
fundo = await PImage.decodeJPEGFromStream(fs.createReadStream(fundoPath));
        }
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto-BlackItalic.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 6);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = (fundo.width - textWidth) / 2;
const y = fundo.height - fontSize / 2;
const offset = 4;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx*dx + dy*dy <= offset*offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
const prataGradient = ["#a0a0a0","#b0b0b0","#c0c0c0","#d0d0d0","#e0e0e0","#f0f0f0","#ffffff"];
for (let i = 0; i < prataGradient.length; i++) {
ctx.fillStyle = prataGradient[i];
ctx.fillText(texto, x, y - i * 2);
        }
ctx.fillStyle = "#ffffff";
ctx.fillText(texto, x, y - prataGradient.length * 2);
res.setHeader("Content-Type", "image/jpeg");
await PImage.encodeJPEGToStream(img, res, 100);
} catch (err) {
console.error(err);
res.status(500).json({
status: false,
erro: "Erro ao gerar imagem",
detalhes: err.message
        });
    }
});

app.get("/api/imagem/logo8/text", async (req, res) => {
const { texto = "Olá!" } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "7527038c1abe86ce6555aeff3d07b4d0_edited_1758147862689.png");
let fundo;
try {
fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
} catch (e) {
console.log("Falha ao ler PNG, tentando JPEG...");
fundo = await PImage.decodeJPEGFromStream(fs.createReadStream(fundoPath));
        }
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto-ThinItalic.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 8);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = fundo.width - textWidth - 50;
const y = fundo.height - fontSize / 2; 
const offset = 3;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx*dx + dy*dy <= offset*offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
const gradiente = ["#ffffff", "#d0d0d0", "#a0a0a0"];
for (let i = 0; i < gradiente.length; i++) {
ctx.fillStyle = gradiente[i];
ctx.fillText(texto, x, y - i * 2);
        }
ctx.strokeStyle = "#ffffff";
ctx.lineWidth = 2;
ctx.beginPath();
for (let i = 0; i < texto.length; i++) {
const charX = x + ctx.measureText(texto.slice(0, i)).width;
const charY = y - Math.random() * 10;
ctx.moveTo(charX, charY);
ctx.lineTo(charX + 5, charY - 15);
        }
ctx.stroke();
res.setHeader("Content-Type", "image/jpeg");
await PImage.encodeJPEGToStream(img, res, 100);
} catch (err) {
console.error(err);
res.status(500).json({ status: false, erro: "Erro ao gerar imagem", detalhes: err.message });
    }
});

app.get("/api/imagem/logo9/text", async (req, res) => {
const { texto = "Olá!" } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "fe30143db87f8238e0fb67ae3eda5d5e_edited_1758147862701.png");
let fundo;
try {
fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
} catch (e) {
console.log("Falha ao ler PNG, tentando JPEG...");
fundo = await PImage.decodeJPEGFromStream(fs.createReadStream(fundoPath));
        }
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto-ExtraBoldItalic.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 8);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = fundo.width - textWidth - 50;
const y = fundo.height - fontSize / 2; 
const offset = 3;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx*dx + dy*dy <= offset*offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
const gradiente = ["#ffffff", "#d0d0d0", "#a0a0a0"];
for (let i = 0; i < gradiente.length; i++) {
ctx.fillStyle = gradiente[i];
ctx.fillText(texto, x, y - i * 2);
        }
ctx.strokeStyle = "#ffffff";
ctx.lineWidth = 2;
ctx.beginPath();
for (let i = 0; i < texto.length; i++) {
const charX = x + ctx.measureText(texto.slice(0, i)).width;
const charY = y - Math.random() * 10;
ctx.moveTo(charX, charY);
ctx.lineTo(charX + 5, charY - 15);
        }
ctx.stroke();
res.setHeader("Content-Type", "image/jpeg");
await PImage.encodeJPEGToStream(img, res, 100);
} catch (err) {
console.error(err);
res.status(500).json({ status: false, erro: "Erro ao gerar imagem", detalhes: err.message });
    }
});

app.get("/api/imagem/logo10/text", async (req, res) => {
const { texto = "Olá!" } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "e30c345399ee015f7a7aa4a87e9340ef_edited_1758147862663.png");
let fundo;
try {
fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
} catch (e) {
console.log("Falha ao ler PNG, tentando JPEG...");
fundo = await PImage.decodeJPEGFromStream(fs.createReadStream(fundoPath));
        }
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto-ExtraBoldItalic.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 8);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = fundo.width - textWidth - 50;
const y = fundo.height - fontSize / 2; // mais para baixo
const offset = 3;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx*dx + dy*dy <= offset*offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
ctx.fillStyle = "rgba(255,255,255,0.4)";
for (let dx = -2; dx <= 2; dx++) {
for (let dy = -2; dy <= 2; dy++) {
if (dx !== 0 || dy !== 0) ctx.fillText(texto, x + dx, y + dy);
            }
        }
ctx.fillStyle = "#FF1493"; // rosa pink
ctx.fillText(texto, x, y);
ctx.strokeStyle = "#FF69B4"; // pink mais claro
ctx.lineWidth = 2;
ctx.beginPath();
for (let i = 0; i < texto.length; i++) {
const charX = x + ctx.measureText(texto.slice(0, i)).width;
const charY = y - Math.random() * 15; 
ctx.moveTo(charX, charY);
ctx.lineTo(charX + Math.random() * 10, charY - Math.random() * 20); // raios variáveis
        }
ctx.stroke();
res.setHeader("Content-Type", "image/jpeg");
await PImage.encodeJPEGToStream(img, res, 100);
} catch (err) {
console.error(err);
res.status(500).json({ 
status: false, 
erro: "Erro ao gerar imagem", 
detalhes: err.message 
        });
    }
});

app.get("/api/imagem/logo10/text", async (req, res) => {
const { texto = "Olá!" } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "e30c345399ee015f7a7aa4a87e9340ef_edited_1758147862663.png");
let fundo;
try {
fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
} catch (e) {
console.log("Falha ao ler PNG, tentando JPEG...");
fundo = await PImage.decodeJPEGFromStream(fs.createReadStream(fundoPath));
        }
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto-ExtraBoldItalic.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 8);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = fundo.width - textWidth - 50;
const y = fundo.height - fontSize / 2; // mais para baixo
const offset = 3;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx*dx + dy*dy <= offset*offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
ctx.fillStyle = "rgba(255,255,255,0.4)";
for (let dx = -2; dx <= 2; dx++) {
for (let dy = -2; dy <= 2; dy++) {
if (dx !== 0 || dy !== 0) ctx.fillText(texto, x + dx, y + dy);
            }
        }
ctx.fillStyle = "#FF1493"; // rosa pink
ctx.fillText(texto, x, y);
ctx.strokeStyle = "#FF69B4"; // pink mais claro
ctx.lineWidth = 2;
ctx.beginPath();
for (let i = 0; i < texto.length; i++) {
const charX = x + ctx.measureText(texto.slice(0, i)).width;
const charY = y - Math.random() * 15; // deslocamento vertical aleatório
ctx.moveTo(charX, charY);
ctx.lineTo(charX + Math.random() * 10, charY - Math.random() * 20); // raios variáveis
        }
ctx.stroke();
res.setHeader("Content-Type", "image/jpeg");
await PImage.encodeJPEGToStream(img, res, 100);
} catch (err) {
console.error(err);
res.status(500).json({ 
status: false, 
erro: "Erro ao gerar imagem", 
detalhes: err.message 
        });
    }
});


app.get("/api/imagem/logo11/text", async (req, res) => {
const { texto = "Olá!" } = req.query;
try {
const fundoPath = path.join(__dirname, "public", "logos", "f3113013b9bb5f423b0eef009bd807d0_edited_1758147862593.png");
let fundo;
try {
fundo = await PImage.decodePNGFromStream(fs.createReadStream(fundoPath));
} catch (e) {
console.log("Falha ao ler PNG, tentando JPEG...");
fundo = await PImage.decodeJPEGFromStream(fs.createReadStream(fundoPath));
        }
const img = PImage.make(fundo.width, fundo.height);
const ctx = img.getContext("2d");
ctx.drawImage(fundo, 0, 0);
const fontPath = path.join(__dirname, "public", "static", "Roboto-ExtraBoldItalic.ttf");
const font = PImage.registerFont(fontPath, "Roboto");
font.loadSync();
const fontSize = Math.floor(fundo.width / 8);
ctx.font = `${fontSize}pt Roboto`;
const textWidth = ctx.measureText(texto).width;
const x = (fundo.width - textWidth) / 2 - 30; 
const y = fundo.height / 2 + fontSize / 3; // centralizado verticalmente, um pouco para baixo
const offset = 4;
ctx.fillStyle = "#000000";
for (let dx = -offset; dx <= offset; dx++) {
for (let dy = -offset; dy <= offset; dy++) {
if (dx*dx + dy*dy <= offset*offset && (dx !== 0 || dy !== 0)) {
ctx.fillText(texto, x + dx, y + dy);
                }
            }
        }
ctx.fillStyle = "rgba(0,0,0,0.7)";
for (let dx = -2; dx <= 2; dx++) {
for (let dy = -2; dy <= 2; dy++) {
if (dx !== 0 || dy !== 0) ctx.fillText(texto, x + dx, y + dy);
            }
        }
ctx.fillStyle = "#9400D3"; // roxo vibrante
ctx.fillText(texto, x, y);
ctx.strokeStyle = "#FFFFFF"; // branco para brilho
ctx.lineWidth = 2;
ctx.beginPath();
for (let i = 0; i < texto.length; i++) {
const charX = x + ctx.measureText(texto.slice(0, i)).width;
const charY = y - Math.random() * 12; // leve variação vertical
ctx.moveTo(charX, charY);
ctx.lineTo(charX + Math.random() * 6, charY - Math.random() * 15);
        }
ctx.stroke();
res.setHeader("Content-Type", "image/jpeg");
await PImage.encodeJPEGToStream(img, res, 100);
} catch (err) {
console.error(err);
res.status(500).json({ 
status: false, 
erro: "Erro ao gerar imagem", 
detalhes: err.message 
        });
    }
});

const httpServer = http.createServer(app);

//★・・・・・・★・・・ PORT LISTEN・・・★・・・・・・★
const startServers = () => {
  httpServer.listen(PORT, HOST, () => {
    const hostDisplay = HOST === "0.0.0.0" ? "localhost" : HOST;
    consoleSucesso(`${nomeApi} rodando em http://${hostDisplay}:${PORT}`);
  });

  if (ENABLE_HTTPS) {
    const sslMissing = !fs.existsSync(SSL_KEY_PATH) || !fs.existsSync(SSL_CERT_PATH);
    if (sslMissing) {
      consoleErro(`HTTPS ativado, mas os certificados em ${SSL_CERT_DIR} não foram encontrados.`);
      return;
    }
    const sslOptions = {
      key: fs.readFileSync(SSL_KEY_PATH),
      cert: fs.readFileSync(SSL_CERT_PATH)
    };
    if (fs.existsSync(SSL_CA_PATH)) {
      sslOptions.ca = fs.readFileSync(SSL_CA_PATH);
    }
    https.createServer(sslOptions, app).listen(HTTPS_PORT, HOST, () => {
      const hostDisplay = HOST === "0.0.0.0" ? "localhost" : HOST;
      consoleSucesso(`${nomeApi} rodando em https://${hostDisplay}:${HTTPS_PORT}`);
    });
  } else {
    consoleAviso("HTTPS está desativado. Defina ENABLE_HTTPS=true e forneça certificados válidos para ativar.");
  }
};

startServers();


fs.watchFile('./index.js', (curr, prev) => {
if (curr.mtime.getTime() !== prev.mtime.getTime()) {
consoleAviso('Código editado, reiniciando...');
process.exit();
}
});
