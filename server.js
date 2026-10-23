'use strict';

// Sakuya Cauldron - lightweight Twitch chat + SSE overlay.
// No image/video processing and no AI service runs during the stream.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tmi = require('tmi.js');
const EMOJI_KEYWORDS = require('emojilib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_PATH = path.join(ROOT, '.env');
const TOKEN_PATH = path.join(ROOT, 'tokens.json');

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const config = {
  clientId: (process.env.TWITCH_CLIENT_ID || '').trim(),
  clientSecret: (process.env.TWITCH_CLIENT_SECRET || '').trim(),
  channel: (process.env.TWITCH_CHANNEL || '').trim().replace(/^#/, '').replace(/^@/, '').toLowerCase(),
  host: '127.0.0.1',
  port: clampInt(process.env.PORT, 3131, 1, 65535),
  fillPerThrow: clampInt(process.env.FILL_PER_THROW, 10, 1, 100),
  cooldownMs: clampInt(process.env.USER_COOLDOWN_SECONDS, 3, 0, 3600) * 1000,
  brewResetMs: clampInt(process.env.BREW_RESET_MS, 4500, 1000, 60000),
};

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const ALLOWED_EMOJIS = ['🎃', '👻', '🦇', '🕷️', '🧙', '🖤', '🍬', '🐈‍⬛', '💀', '🧪', '🕯️', '😈'];

const TURKISH_EMOJI_ALIASES = {
  'kedi': '🐈',
  'kediler': '🐈',
  'köpek': '🐕',
  'kopek': '🐕',
  'fare': '🐀',
  'sıçan': '🐀',
  'sican': '🐀',
  'hayalet': '👻',
  'balkabağı': '🎃',
  'balkabagi': '🎃',
  'yarasa': '🦇',
  'örümcek': '🕷️',
  'orumcek': '🕷️',
  'cadı': '🧙',
  'cadi': '🧙',
  'hediye': '🎁',
  'pizza': '🍕',
  'kalp': '❤️',
  'ejderha': '🐉',
  'kurukafa': '💀',
};

function normalizeEmojiText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr')
    .replace(/[_-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findThrowEmoji(input) {
  const text = normalizeEmojiText(input);

  // Boş komut: hediye kutusu
  if (!text) return '🎁';

  // Türkçe özel eşleştirmeler
  if (TURKISH_EMOJI_ALIASES[text]) {
    return TURKISH_EMOJI_ALIASES[text];
  }

  // Emoji kütüphanesinde tam ifade eşleşmesi ara
  for (const [emoji, keywords] of Object.entries(EMOJI_KEYWORDS)) {
    if (keywords.some(keyword =>
      normalizeEmojiText(keyword) === text
    )) {
      return emoji;
    }
  }

  // Birden fazla kelime varsa en anlamlı eşleşmeyi ara.
  // Örneğin "red dragon" ifadesinde "dragon" bulunabilir.
  const words = text.split(' ').filter(word => word.length >= 2);
  let bestEmoji = null;
  let bestScore = 0;

  for (const [emoji, keywords] of Object.entries(EMOJI_KEYWORDS)) {
    for (const keyword of keywords) {
      const normalizedKeyword = normalizeEmojiText(keyword);
      const keywordWords = normalizedKeyword.split(' ');

      for (const word of words) {
        if (keywordWords.includes(word)) {
          const score = word.length;
          if (score > bestScore) {
            bestScore = score;
            bestEmoji = emoji;
          }
        }
      }
    }
  }

  // Hiçbir eşleşme bulunmazsa hediye kutusu
  return bestEmoji || '🎁';
}

const sseClients = new Set();
const cooldowns = new Map();
const userEmojis = new Map();

const state = {
  progress: 0,
  throwCount: 0,
  brewing: false,
  potionNumber: 0,
  lastThrower: '',
  twitchConnected: false,
  twitchLogin: '',
  statusMessage: 'Twitch baglantisi bekleniyor',
};

let savedTokens = readSavedTokens();
let twitchClient = null;
let oauthState = null;
let testThrowNumber = 0;
let brewResetTimer = null;

function readSavedTokens() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch (error) {
    console.warn('[OAuth] tokens.json okunamadi:', error.message);
    return null;
  }
}

function saveTokens(tokens) {
  savedTokens = tokens;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function hasOAuthConfig() {
  return Boolean(config.clientId && config.clientSecret && config.channel);
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

async function exchangeCodeForTokens(code) {
  const body = formBody({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: `http://localhost:${config.port}/auth/callback`,
  });
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(payload.message || payload.error_description || `Twitch token exchange failed (${response.status})`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 14400) * 1000,
    scopes: payload.scope || [],
    login: '',
  };
}

async function refreshTokens() {
  if (!savedTokens?.refreshToken) throw new Error('Refresh token bulunamadi. /setup sayfasindan yeniden Twitch baglantisi kur.');
  const body = formBody({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: savedTokens.refreshToken,
  });
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(payload.message || payload.error_description || `Twitch token refresh failed (${response.status})`);
  }
  saveTokens({
    ...savedTokens,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 14400) * 1000,
    scopes: payload.scope || savedTokens.scopes || [],
  });
  console.log('[OAuth] Twitch erisim tokeni yenilendi.');
}

async function getFreshAccessToken() {
  if (!savedTokens?.accessToken) throw new Error('Twitch hesabi bagli degil. /setup sayfasini ac.');
  if (!savedTokens.expiresAt || savedTokens.expiresAt < Date.now() + 60_000) {
    await refreshTokens();
  }
  return savedTokens.accessToken;
}

async function validateAccessToken(accessToken) {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.login) {
    throw new Error(payload.message || 'Twitch tokeni dogrulanamadi. /setup sayfasindan yeniden baglan.');
  }
  if (Array.isArray(payload.scopes) && !payload.scopes.includes('chat:read')) {
    throw new Error('Bu token chat:read iznine sahip degil. Twitch baglantisini yeniden kur.');
  }
  return payload;
}

function currentPublicState() {
  return {
    progress: state.progress,
    throwCount: state.throwCount,
    brewing: state.brewing,
    potionNumber: state.potionNumber,
    lastThrower: state.lastThrower,
    twitchConnected: state.twitchConnected,
    twitchLogin: state.twitchLogin,
    channel: config.channel,
    fillPerThrow: config.fillPerThrow,
    statusMessage: state.statusMessage,
  };
}

function sendSse(response, eventName, data) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(eventName, data) {
  for (const response of sseClients) {
    try { sendSse(response, eventName, data); } catch { sseClients.delete(response); }
  }
}

function broadcastState() {
  broadcast('state', currentPublicState());
}

function stableEmojiFor(username) {
  if (userEmojis.has(username)) return userEmojis.get(username);
  let hash = 0;
  for (const char of username) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  const emoji = ALLOWED_EMOJIS[hash % ALLOWED_EMOJIS.length];
  userEmojis.set(username, emoji);
  if (userEmojis.size > 500) userEmojis.delete(userEmojis.keys().next().value);
  return emoji;
}

function performThrow(username, requestedEmoji, { bypassCooldown = false, isTest = false } = {}) {
  const cleanUsername = String(username || 'viewer').trim().slice(0, 32);
  const usernameKey = cleanUsername.toLowerCase();
  if (!cleanUsername || state.brewing) return { accepted: false, reason: state.brewing ? 'brewing' : 'invalid-user' };

  const now = Date.now();
  const last = cooldowns.get(usernameKey) || 0;
  if (!bypassCooldown && config.cooldownMs > 0 && now - last < config.cooldownMs) {
    return { accepted: false, reason: 'cooldown' };
  }
  cooldowns.set(usernameKey, now);
  if (cooldowns.size > 2000) {
    const expiry = now - Math.max(config.cooldownMs, 60_000) * 2;
    for (const [key, timestamp] of cooldowns) if (timestamp < expiry) cooldowns.delete(key);
  }

  const emoji = requestedEmoji || '🎁';
  state.progress = Math.min(100, state.progress + config.fillPerThrow);
  state.throwCount += 1;
  state.lastThrower = cleanUsername;

  broadcast('throw', {
    username: cleanUsername,
    emoji,
    progress: state.progress,
    isTest,
    timestamp: now,
  });
  broadcastState();
  console.log(`[${isTest ? 'TEST' : 'CHAT'}] !throw: ${cleanUsername} ${emoji} (${state.progress}%)`);

  if (state.progress >= 100) completePotion();
  return { accepted: true, progress: state.progress };
}

function completePotion() {
  if (state.brewing) return;
  state.progress = 100;
  state.brewing = true;
  state.potionNumber += 1;
  const result = {
    potionNumber: state.potionNumber,
    message: 'POTION BREWED!',
    // Intentionally no reward/punishment selection in this first version.
    timestamp: Date.now(),
  };
  broadcastState();
  broadcast('potionComplete', result);
  console.log(`[CAULDRON] Iksir hazir (#${state.potionNumber}). Odul/ceza sistemi daha eklenmedi.`);

  if (brewResetTimer) clearTimeout(brewResetTimer);
  brewResetTimer = setTimeout(() => {
    state.progress = 0;
    state.throwCount = 0;
    state.brewing = false;
    state.lastThrower = '';
    broadcastState();
    broadcast('brewReset', { potionNumber: state.potionNumber });
    console.log('[CAULDRON] Kazan sifirlandi.');
  }, config.brewResetMs);
  brewResetTimer.unref?.();
}

async function startTwitchClient() {
  if (!hasOAuthConfig()) {
    state.statusMessage = 'Once .env dosyasini doldur ve Twitch baglantisini kur.';
    broadcastState();
    return;
  }
  if (!savedTokens?.accessToken) {
    state.statusMessage = 'Twitch hesabi baglanmamis. /setup sayfasini ac.';
    broadcastState();
    return;
  }

  try {
    const accessToken = await getFreshAccessToken();
    const validated = await validateAccessToken(accessToken);
    if (twitchClient) {
      try { await twitchClient.disconnect(); } catch { /* ignored while replacing client */ }
      twitchClient = null;
    }

    state.twitchLogin = String(validated.login || '').toLowerCase();
    state.statusMessage = `Twitch: ${state.twitchLogin} hesabi baglaniyor...`;
    broadcastState();

    const client = new tmi.Client({
      options: {
        debug: false,
        skipMembership: true,
        skipUpdatingEmotesets: true,
        updateEmotesetsTimer: 0,
      },
      connection: { secure: true, reconnect: true },
      identity: {
        username: state.twitchLogin,
        // tmi.js calls this on connection/reconnection so an expired token can be refreshed.
        password: async () => `oauth:${await getFreshAccessToken()}`,
      },
      channels: [config.channel],
    });

    twitchClient = client;
    client.on('connected', () => {
      state.twitchConnected = true;
      state.statusMessage = `Baglandi: #${config.channel}`;
      broadcastState();
      console.log(`[Twitch] #${config.channel} kanalina baglandi (${state.twitchLogin}).`);
    });
    client.on('disconnected', (reason) => {
      state.twitchConnected = false;
      state.statusMessage = `Twitch baglantisi kesildi: ${String(reason || 'bilinmeyen neden')}`;
      broadcastState();
      console.warn('[Twitch] Baglanti kesildi:', reason || 'bilinmeyen neden');
    });
    client.on('notice', (_channel, message) => {
      console.warn('[Twitch notice]', message);
    });
    client.on('message', (channel, tags, message) => {
      if (!message || !channel) return;
      const match = /^!throw(?:\s+([\s\S]*))?$/i.exec(message.trim());
      if (!match) return;

      const username = tags['display-name'] || tags.username || 'viewer';
      const requestedEmoji = findThrowEmoji(match[1] || '');

      performThrow(username, requestedEmoji, {
        bypassCooldown: false,
        isTest: false
      });
    });

    await client.connect();
  } catch (error) {
    state.twitchConnected = false;
    state.statusMessage = `Twitch baglanti hatasi: ${error.message}`;
    broadcastState();
    console.error('[Twitch] Baglanti baslatilamadi:', error);
    console.error('[Twitch] Hata nedeni:', error.cause || error.stack);
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function setupPage() {
  const configured = hasOAuthConfig();
  const isAuthenticated = Boolean(savedTokens?.accessToken);
  const channel = htmlEscape(config.channel || 'ayarlanmadi');
  const status = state.twitchConnected
    ? `Bagli: ${htmlEscape(state.twitchLogin)} → #${channel}`
    : htmlEscape(state.statusMessage);
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sakuya Cauldron - Kurulum</title><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#100d18;color:#f3edf9;font:16px/1.5 system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}.card{width:min(680px,100%);background:#1b1526;border:1px solid #55456d;border-radius:20px;padding:28px;box-shadow:0 20px 70px #0006}h1{margin:0 0 6px;font-size:28px}p{color:#c8bdd6}.status{padding:12px 14px;border-radius:12px;background:#292137;margin:18px 0;overflow-wrap:anywhere}.button{display:inline-block;background:#8c65c7;color:white;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;margin:4px 6px 4px 0}.button.secondary{background:#372a49}.note{font-size:14px;color:#b9abc9}code{background:#0e0b14;padding:2px 5px;border-radius:4px}</style></head><body><main class="card"><h1>🧙 Sakuya's Haunted Cauldron</h1><p>Yerel kontrol paneli ve Twitch baglantisi.</p><div class="status"><strong>Durum:</strong> ${status}</div>
    ${!configured ? '<p><strong>Once .env dosyasini doldur.</strong> TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET ve TWITCH_CHANNEL degerlerini gir, sonra sunucuyu yeniden baslat.</p>' : ''}
    ${configured && !isAuthenticated ? '<p>Twitch hesabinla guvenli OAuth baglantisi kurmak icin asagidaki dugmeye bas. Uygulama yalnizca <code>chat:read</code> izni ister.</p><a class="button" href="/auth">Twitch hesabini bagla</a>' : ''}
    ${configured && isAuthenticated ? '<p>Yerel tokens.json dosyasi bulundu. Baglanti tekrar kurulabilir.</p><a class="button" href="/auth">Twitch hesabini yeniden bagla</a>' : ''}
    <a class="button secondary" href="/overlay?test=1">Overlay testini ac</a><p class="note">Bu panel yalnizca bu bilgisayarda acilir. .env ve tokens.json dosyalarini kimseyle paylasma.</p></main></body></html>`;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readRequestBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${config.port}`);
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, ...currentPublicState() });
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, currentPublicState());
  }
  if (req.method === 'GET' && pathname === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(setupPage());
  }
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    sendSse(res, 'state', currentPublicState());
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'GET' && pathname === '/auth') {
    if (!hasOAuthConfig()) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>.env ayarlanmamis</h1><p>TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET ve TWITCH_CHANNEL alanlarini doldurup sunucuyu yeniden baslat.</p>');
    }
    oauthState = crypto.randomBytes(24).toString('hex');
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: `http://localhost:${config.port}/auth/callback`,
      response_type: 'code',
      scope: 'chat:read',
      state: oauthState,
    });
    res.writeHead(302, { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` });
    return res.end();
  }
  if (req.method === 'GET' && pathname === '/auth/callback') {
    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');
    const returnedState = requestUrl.searchParams.get('state');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>Twitch baglantisi reddedildi</h1><p>${htmlEscape(requestUrl.searchParams.get('error_description') || error)}</p><p><a href="/setup">Kuruluma don</a></p>`);
    }
    if (!code || !oauthState || returnedState !== oauthState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>OAuth state dogrulanamadi</h1><p>Güvenlik nedeniyle istek kabul edilmedi. /setup sayfasindan tekrar dene.</p>');
    }
    oauthState = null;
    try {
      const tokenData = await exchangeCodeForTokens(code);
      saveTokens(tokenData);
      const validated = await validateAccessToken(tokenData.accessToken);
      savedTokens.login = validated.login;
      saveTokens(savedTokens);
      state.twitchLogin = validated.login;
      state.statusMessage = 'Twitch baglandi; chat baslatiliyor...';
      broadcastState();
      startTwitchClient();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Twitch baglandi</title><style>body{font:16px system-ui;background:#100d18;color:#f3edf9;padding:40px;max-width:680px;margin:auto}a{color:#d4b4ff}</style><h1>✅ Twitch baglantisi kuruldu</h1><p>Hesap: <strong>${htmlEscape(validated.login)}</strong></p><p>Kanal: <strong>#${htmlEscape(config.channel)}</strong></p><p>Bu pencereyi kapatabilir veya <a href="/setup">kontrol paneline</a> donebilirsin.</p></html>`);
    } catch (err) {
      console.error('[OAuth] Baglanti kurulamadı:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>Twitch baglantisi basarisiz</h1><p>${htmlEscape(err.message)}</p><p><a href="/setup">Kuruluma don</a></p>`);
    }
  }
  if (req.method === 'POST' && pathname === '/api/test/throw') {
    testThrowNumber += 1;
    const emoji = ALLOWED_EMOJIS[(testThrowNumber - 1) % ALLOWED_EMOJIS.length];
    const username = `TestViewer${testThrowNumber}`;
    const result = performThrow(username, emoji, { bypassCooldown: true, isTest: true });
    return sendJson(res, result.accepted ? 200 : 409, result);
  }
  if (req.method === 'POST' && pathname === '/api/test/reset') {
    if (brewResetTimer) clearTimeout(brewResetTimer);
    brewResetTimer = null;
    state.progress = 0;
    state.throwCount = 0;
    state.brewing = false;
    state.lastThrower = '';
    cooldowns.clear();
    broadcastState();
    broadcast('brewReset', { potionNumber: state.potionNumber, manual: true });
    return sendJson(res, 200, { accepted: true, ...currentPublicState() });
  }

  const files = {
    '/': 'index.html',
    '/overlay': 'index.html',
    '/index.html': 'index.html',
    '/style.css': 'style.css',
    '/app.js': 'app.js',
  };

  // İstenen yol belirtilen dosyalardan biriyse veya '/assets/' ile başlıyorsa kabul et
  let resolvedFile = files[pathname];
  if (!resolvedFile && pathname.startsWith('/assets/')) {
    resolvedFile = pathname;
  }

  if (req.method === 'GET' && resolvedFile) {
    const filePath = path.join(PUBLIC_DIR, resolvedFile);
    fs.readFile(filePath, (error, contents) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Dosya okunamadi. Proje dosyalarini kontrol et.');
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(contents);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 - Not Found');
});

// A tiny SSE heartbeat keeps the overlay connection alive; it is not a busy loop.
const heartbeat = setInterval(() => {
  for (const response of sseClients) {
    try { response.write(': keepalive\n\n'); } catch { sseClients.delete(response); }
  }
}, 25_000);
heartbeat.unref?.();

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('🧙 Sakuya Cauldron hazir.');
  console.log(`Overlay: http://127.0.0.1:${config.port}/overlay`);
  console.log(`Test:    http://127.0.0.1:${config.port}/overlay?test=1`);
  console.log(`Setup:   http://127.0.0.1:${config.port}/setup`);
  console.log(`Kanal:   ${config.channel || '( .env icinde ayarlanmadi )'}`);
  console.log('');

  if (!fs.existsSync(ENV_PATH)) {
    console.warn('.env dosyasi yok. install.bat dosyasini calistir veya .env.example dosyasini .env olarak kopyala.');
  } else if (!hasOAuthConfig()) {
    console.warn('Twitch OAuth ayarlari eksik. .env dosyasini doldurunca sunucuyu yeniden baslat. Test modu yine de calisir.');
  } else if (savedTokens?.accessToken) {
    startTwitchClient();
  } else {
    state.statusMessage = 'Twitch baglanmamis. /setup sayfasini ac.';
  }
});

function shutdown() {
  clearInterval(heartbeat);
  if (brewResetTimer) clearTimeout(brewResetTimer);
  for (const response of sseClients) {
    try { response.end(); } catch { /* ignored */ }
  }
  if (twitchClient) {
    try { twitchClient.disconnect(); } catch { /* ignored */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
