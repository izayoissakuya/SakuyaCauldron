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
const COMMUNITY_PATH = path.join(ROOT, 'community-data.json');

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
  // Aynı kişinin iki !throw arası bekleme süresi (eskiden koda gömülü 120 sn idi)
  userCooldownMs: clampInt(process.env.THROW_COOLDOWN_SECONDS, 180, 0, 3600) * 1000,
  // Herhangi iki !throw arası ortak bekleme (eskiden koda gömülü 5 sn idi)
  globalCooldownMs: clampInt(process.env.GLOBAL_COOLDOWN_SECONDS, 5, 0, 600) * 1000,
  goldenChance: clampInt(process.env.GOLDEN_THROW_CHANCE, 5, 0, 100),
  goldenMultiplier: clampInt(process.env.GOLDEN_THROW_MULTIPLIER, 3, 2, 10),
  rewardChance: clampInt(process.env.REWARD_CHANCE, 50, 0, 100),
  coolingPerMinute: clampInt(process.env.CAULDRON_COOLING_PER_MINUTE, 1, 0, 100),
  // Bot "şu kadar bekle" uyarısını chat'e yazsın mı
  cooldownNotices: !/^(0|false|off|no)$/i.test((process.env.COOLDOWN_NOTICES || '').trim()),
  brewResetMs: clampInt(process.env.BREW_RESET_MS, 4500, 1000, 60000),
  voteMs: clampInt(process.env.VOTE_SECONDS, 30, 5, 300) * 1000,
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

// ---------------------------------------------------------------------------
// Emoji filtresi
// ---------------------------------------------------------------------------
const DEFAULT_THROW_EMOJI = '🎁';
// Yayında göstermek istemediğin emojiler. Kendi eklemelerini .env içindeki
// BLOCKED_EMOJIS satırına yan yana yazabilirsin (örn. BLOCKED_EMOJIS=🔫🍺).
const DEFAULT_BLOCKED_EMOJIS = '🍆🍑💦🖕🔞👅💉💊🚬';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

// Görünüm seçicisi (FE0F) ve ten rengi farklarını yok sayarak karşılaştır
function emojiKey(value) {
  return String(value || '').replace(/[︎️\u{1F3FB}-\u{1F3FF}]/gu, '');
}

function listEmojis(text) {
  const found = [];
  for (const { segment } of graphemes.segment(String(text || ''))) {
    if (PICTOGRAPHIC.test(segment)) found.push(segment);
  }
  return found;
}

const blockedEmojis = new Set(
  listEmojis(DEFAULT_BLOCKED_EMOJIS + (process.env.BLOCKED_EMOJIS || '')).map(emojiKey)
);

function isEmojiBlocked(emoji) {
  return blockedEmojis.has(emojiKey(emoji));
}

function findThrowEmoji(input) {
  // Doğrudan emoji yazıldıysa (!throw 🎃) ilkini kullan
  const [direct] = listEmojis(input);
  if (direct) return direct;

  const text = normalizeEmojiText(input);

  // Boş komut: hediye kutusu
  if (!text) return DEFAULT_THROW_EMOJI;

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

// Chat'ten gelen metni ekrana düşecek emojiye çevirir; engelli emoji çıkarsa
// atış yine sayılır ama hediye kutusu düşer.
function resolveThrowEmoji(input) {
  const emoji = findThrowEmoji(input);
  if (isEmojiBlocked(emoji)) {
    console.log(`[FILTER] Engelli emoji hediye kutusuna cevrildi: ${emoji}`);
    return DEFAULT_THROW_EMOJI;
  }
  return emoji;
}

const sseClients = new Set();
const cooldowns = new Map();

const state = {
  progress: 0,
  throwCount: 0,
  brewing: false,
  potionNumber: 0,
  lastThrower: '',
  currentOutcome: null,
  twitchConnected: false,
  twitchLogin: '',
  statusMessage: 'Twitch baglantisi bekleniyor',
};

let savedTokens = readSavedTokens();
let twitchClient = null;
let oauthState = null;
let testThrowNumber = 0;
let testVoterNumber = 0;
let brewResetTimer = null;
let lastGlobalThrow = 0;
// ---------------------------------------------------------------------------
// Reward/punishment votes, persistent active outcomes, and moderated community
// suggestions. The current outcome type is chosen when the cauldron reaches 100%.
// ---------------------------------------------------------------------------
const DEFAULT_PUNISHMENTS = [
  { label: '20 Push-ups', remaining: 1, unit: 'task' },
  { label: 'Eat a Lemon', remaining: 1, unit: 'task' },
  { label: 'Pistol Only for 1 game', remaining: 1, unit: 'game' },
  { label: 'Play without skill 1 game', remaining: 1, unit: 'game' },
  { label: 'VIP a Random Chatter', remaining: 1, unit: 'task' },
];
const DEFAULT_REWARDS = [
  { label: 'Skip the next punishment', remaining: 1, unit: 'task' },
  { label: 'Choose the next game mode', remaining: 1, unit: 'task' },
  { label: 'Shout-out a chatter', remaining: 1, unit: 'task' },
  { label: 'Choose the next cauldron emoji', remaining: 1, unit: 'task' },
  { label: 'One bonus round with no punishment', remaining: 1, unit: 'round' },
];
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const VOTE_OPTION_COUNT = 5;

function makeCommunityDefaults() {
  return {
    nextSuggestionId: 1,
    nextOutcomeId: 1,
    pendingSuggestions: [],
    approved: { punishment: [], reward: [] },
    activeOutcomes: [],
  };
}

function loadCommunityData() {
  const defaults = makeCommunityDefaults();
  try {
    if (!fs.existsSync(COMMUNITY_PATH)) return defaults;
    const parsed = JSON.parse(fs.readFileSync(COMMUNITY_PATH, 'utf8'));
    return {
      ...defaults,
      ...parsed,
      pendingSuggestions: Array.isArray(parsed.pendingSuggestions) ? parsed.pendingSuggestions : [],
      approved: {
        punishment: Array.isArray(parsed.approved && parsed.approved.punishment) ? parsed.approved.punishment : [],
        reward: Array.isArray(parsed.approved && parsed.approved.reward) ? parsed.approved.reward : [],
      },
      activeOutcomes: Array.isArray(parsed.activeOutcomes) ? parsed.activeOutcomes : [],
    };
  } catch (error) {
    console.warn('[COMMUNITY] community-data.json could not be read; defaults loaded:', error.message);
    return defaults;
  }
}

let communityData = loadCommunityData();

function persistCommunityData() {
  try {
    const tempPath = COMMUNITY_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(communityData, null, 2), 'utf8');
    fs.renameSync(tempPath, COMMUNITY_PATH);
  } catch (error) {
    console.error('[COMMUNITY] Could not save data:', error.message);
  }
}

let isVotingOpen = false;
let currentVoteType = 'punishment';
let currentVoteOptions = [];
let votes = {};
let votedUsers = new Set();
let voteEndsAt = 0;
let voteTimer = null;
let voteBroadcastTimer = null;
let animationComplete = false;
let voteComplete = false;
let animationFailsafeTimer = null;

function cleanSuggestionLabel(input) {
  return String(input || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function itemDefaults(type) {
  return type === 'reward' ? DEFAULT_REWARDS : DEFAULT_PUNISHMENTS;
}

function availableCatalog(type) {
  const custom = communityData.approved[type] || [];
  const combined = [...itemDefaults(type), ...custom];
  if (combined.length <= VOTE_OPTION_COUNT) return combined;
  const shuffled = [...combined];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, VOTE_OPTION_COUNT);
}

function emptyVotes(options = currentVoteOptions) {
  return Object.fromEntries(options.map((_, index) => [index + 1, 0]));
}

function totalVotes() {
  return Object.values(votes).reduce((sum, count) => sum + count, 0);
}

function voteSnapshot() {
  return {
    open: isVotingOpen,
    type: currentVoteType,
    options: currentVoteOptions.map((item, index) => ({ id: index + 1, label: item.label })),
    votes: { ...votes },
    total: totalVotes(),
    durationMs: config.voteMs,
    remainingMs: isVotingOpen ? Math.max(0, voteEndsAt - Date.now()) : 0,
  };
}

function chatSay(message) {
  if (!twitchClient) return;
  try {
    Promise.resolve(twitchClient.say(config.channel, message)).catch(error => {
      console.warn('[Twitch] Message could not be sent:', error && (error.message || error));
    });
  } catch (error) {
    console.warn('[Twitch] Message could not be sent:', error && (error.message || error));
  }
}

function scheduleVoteBroadcast() {
  if (voteBroadcastTimer) return;
  voteBroadcastTimer = setTimeout(() => {
    voteBroadcastTimer = null;
    if (isVotingOpen) broadcast('voteUpdate', voteSnapshot());
  }, 200);
}

function castVote(userKey, option) {
  const optionId = Number(option);
  if (!isVotingOpen || !Number.isInteger(optionId) || optionId < 1 || optionId > currentVoteOptions.length) return false;
  if (!userKey || votedUsers.has(userKey)) return false;
  votes[optionId] += 1;
  votedUsers.add(userKey);
  scheduleVoteBroadcast();
  return true;
}

function pickVoteWinner() {
  const optionIds = currentVoteOptions.map((_, index) => index + 1);
  const maxVotes = Math.max(...optionIds.map(id => votes[id] || 0));
  const candidates = optionIds.filter(id => (votes[id] || 0) === maxVotes);
  const mode = maxVotes === 0 ? 'no-votes' : candidates.length > 1 ? 'tie' : 'clear';
  const winner = candidates[crypto.randomInt(candidates.length)];
  return { winner, maxVotes, candidates, mode };
}

function clearVoteTimers() {
  if (voteTimer) clearTimeout(voteTimer);
  if (voteBroadcastTimer) clearTimeout(voteBroadcastTimer);
  voteTimer = null;
  voteBroadcastTimer = null;
}

function startOutcomeVote(type) {
  if (isVotingOpen) return;
  currentVoteType = type === 'reward' ? 'reward' : 'punishment';
  currentVoteOptions = availableCatalog(currentVoteType);
  votes = emptyVotes(currentVoteOptions);
  votedUsers.clear();
  isVotingOpen = true;
  voteEndsAt = Date.now() + config.voteMs;

  const seconds = Math.round(config.voteMs / 1000);
  const title = currentVoteType === 'reward' ? '🎁 REWARD TIME!' : '💀 PUNISHMENT TIME!';
  const optionsText = currentVoteOptions.map((item, index) => KEYCAPS[index] + ' ' + item.label).join(' | ');
  chatSay(title + ' You have ' + seconds + ' seconds to vote by typing a number from 1 to ' + currentVoteOptions.length + ' in chat! Options: ' + optionsText);
  broadcast('voteStart', voteSnapshot());
  console.log('[VOTE] ' + currentVoteType + ' vote started (' + seconds + 's).');

  clearVoteTimers();
  voteTimer = setTimeout(endOutcomeVote, config.voteMs);
}

function activeOutcomeSnapshot() {
  return [...communityData.activeOutcomes].sort((a, b) => a.createdAt - b.createdAt);
}

function broadcastActiveOutcomes() {
  broadcast('activeOutcomes', activeOutcomeSnapshot());
  broadcastState();
}

function finishBrewIfReady() {
  if (!state.brewing || !animationComplete || !voteComplete) return;
  if (animationFailsafeTimer) clearTimeout(animationFailsafeTimer);
  animationFailsafeTimer = null;
  state.progress = 0;
  state.throwCount = 0;
  state.brewing = false;
  state.currentOutcome = null;
  state.lastThrower = '';
  broadcastState();
  broadcast('brewReset', { potionNumber: state.potionNumber });
  console.log('[CAULDRON] Animation and vote complete; cauldron reset.');
}

function endOutcomeVote() {
  if (!isVotingOpen) return;
  isVotingOpen = false;
  clearVoteTimers();

  const result = pickVoteWinner();
  const selected = currentVoteOptions[result.winner - 1];
  const type = currentVoteType;
  const outcome = {
    id: communityData.nextOutcomeId++,
    type,
    label: selected.label,
    remaining: Math.max(1, Number(selected.remaining) || 1),
    unit: selected.unit || (/\bgame\b/i.test(selected.label) ? 'game' : 'task'),
    createdAt: Date.now(),
  };
  communityData.activeOutcomes.push(outcome);
  persistCommunityData();
  broadcastActiveOutcomes();

  const kind = type === 'reward' ? 'REWARD' : 'PUNISHMENT';
  if (result.mode === 'clear') {
    chatSay('🔔 ' + kind + ' VOTE ENDED! Winner (' + result.maxVotes + ' votes): ' + selected.label + '. Mods/streamer: type !done when completed.');
  } else if (result.mode === 'tie') {
    const tied = result.candidates.map(id => '#' + id).join(', ');
    chatSay('🔔 ' + kind + ' VOTE TIED between ' + tied + '; picked at random: ' + selected.label + '.');
  } else {
    chatSay('🔔 No votes received; selected at random: ' + selected.label + '.');
  }

  broadcast('voteEnd', {
    type,
    winner: result.winner,
    label: selected.label,
    maxVotes: result.maxVotes,
    candidates: result.candidates,
    mode: result.mode,
    votes: { ...votes },
    total: totalVotes(),
    activeOutcome: outcome,
  });
  console.log('[VOTE] Ended: ' + type + ' #' + result.winner + ' ' + selected.label + ' (' + result.mode + ', ' + result.maxVotes + ' votes).');
  voteComplete = true;
  finishBrewIfReady();
}

function cancelOutcomeVote() {
  if (!isVotingOpen) return;
  isVotingOpen = false;
  clearVoteTimers();
  broadcast('voteCancel', {});
  console.log('[VOTE] Vote cancelled.');
}

function isModOrBroadcaster(tags, username) {
  const login = String((tags && tags.username) || username || '').toLowerCase();
  return Boolean((tags && tags.mod) || (tags && tags.badges && tags.badges.broadcaster) || login === config.channel);
}

function parseSuggestionPayload(payload) {
  const parts = String(payload || '').split('|');
  const label = cleanSuggestionLabel(parts[0]);
  let remaining = 1;
  let unit = /\bgame\b/i.test(label) ? 'game' : 'task';
  for (const option of parts.slice(1)) {
    const match = option.trim().match(/^(games?|tasks?|rounds?)\s*=\s*(\d{1,2})$/i);
    if (!match) continue;
    remaining = Math.min(99, Math.max(1, Number(match[2])));
    const raw = match[1].toLowerCase();
    unit = raw.startsWith('game') ? 'game' : raw.startsWith('round') ? 'round' : 'task';
  }
  return { label, remaining, unit };
}

function submitCommunitySuggestion(type, payload, username) {
  const item = parseSuggestionPayload(payload);
  if (item.label.length < 3) {
    chatSay('@' + username + ', please provide a suggestion of at least 3 characters.');
    return;
  }
  if (communityData.pendingSuggestions.length >= 50) {
    chatSay('@' + username + ', the suggestion queue is full for now.');
    return;
  }
  const normalized = item.label.toLocaleLowerCase('en');
  const allItems = [
    ...communityData.pendingSuggestions,
    ...communityData.approved.punishment,
    ...communityData.approved.reward,
  ];
  const exists = allItems.some(entry => String(entry.label || entry).toLocaleLowerCase('en') === normalized);
  if (exists) {
    chatSay('@' + username + ', that suggestion is already pending or approved.');
    return;
  }
  const suggestion = {
    id: communityData.nextSuggestionId++,
    type,
    label: item.label,
    remaining: item.remaining,
    unit: item.unit,
    submittedBy: String(username || 'viewer').slice(0, 32),
    createdAt: Date.now(),
  };
  communityData.pendingSuggestions.push(suggestion);
  persistCommunityData();
  chatSay('💡 @' + username + ', suggestion #' + suggestion.id + ' submitted for moderator review (' + type + ').');
  broadcast('suggestionsUpdate', { pendingCount: communityData.pendingSuggestions.length });
}

function moderateSuggestion(action, id, username) {
  const index = communityData.pendingSuggestions.findIndex(item => item.id === Number(id));
  if (index < 0) {
    chatSay('@' + username + ', suggestion #' + id + ' was not found.');
    return;
  }
  const suggestion = communityData.pendingSuggestions[index];
  communityData.pendingSuggestions.splice(index, 1);
  if (action === 'approve') {
    communityData.approved[suggestion.type].push({
      label: suggestion.label,
      remaining: suggestion.remaining,
      unit: suggestion.unit,
    });
    chatSay('✅ @' + username + ' approved ' + suggestion.type + ' suggestion #' + suggestion.id + ': ' + suggestion.label);
  } else {
    chatSay('🗑️ @' + username + ' rejected suggestion #' + suggestion.id + '.');
  }
  persistCommunityData();
  broadcast('suggestionsUpdate', { pendingCount: communityData.pendingSuggestions.length });
}

function reportPendingSuggestions(username) {
  if (!communityData.pendingSuggestions.length) {
    chatSay('@' + username + ', there are no pending suggestions.');
    return;
  }
  const lines = communityData.pendingSuggestions.slice(0, 4)
    .map(item => '#' + item.id + ' [' + item.type + '] ' + item.label);
  const more = communityData.pendingSuggestions.length > 4 ? ' (+' + (communityData.pendingSuggestions.length - 4) + ' more)' : '';
  chatSay('Pending suggestions: ' + lines.join(' | ') + more);
}

function completeActiveOutcome(username) {
  const active = activeOutcomeSnapshot()[0];
  if (!active) {
    chatSay('@' + username + ', there is no active reward or punishment to complete.');
    return;
  }
  if (active.remaining > 1) {
    active.remaining -= 1;
    communityData.activeOutcomes = communityData.activeOutcomes.map(item => item.id === active.id ? active : item);
    persistCommunityData();
    broadcastActiveOutcomes();
    const plural = active.unit === 'game' ? 'games' : active.unit === 'round' ? 'rounds' : 'tasks';
    chatSay('✅ ' + active.label + ': 1 completed, ' + active.remaining + ' ' + plural + ' remaining.');
    return;
  }
  communityData.activeOutcomes = communityData.activeOutcomes.filter(item => item.id !== active.id);
  persistCommunityData();
  broadcastActiveOutcomes();
  broadcast('outcomeDone', { id: active.id, type: active.type, label: active.label });
  chatSay('🎉 Completed: ' + active.label + '!');
}

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
  if (Array.isArray(payload.scopes) && !payload.scopes.includes('chat:edit')) {
    console.warn('[OAuth] Token chat:edit iznine sahip degil: bot oylama ve bekleme mesajlarini yazamaz. /setup sayfasindan Twitch baglantisini yeniden kur.');
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
    currentOutcome: state.currentOutcome,
    activeOutcomes: activeOutcomeSnapshot(),
    vote: voteSnapshot(),
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

// ---------------------------------------------------------------------------
// Bekleme uyarıları: chat'i doldurmasın diye sınırlıdır.
//  - Ortak (global) beklemede sessiz kalınır; kalabalıkta herkes bu duvara çarpar.
//  - Kişisel beklemede aynı kişiye en çok 30 sn'de bir, tüm kanala en çok 3 sn'de bir yazılır.
// ---------------------------------------------------------------------------
const NOTICE_PER_USER_MS = 30_000;
const NOTICE_GLOBAL_MS = 3_000;
const noticeTimes = new Map();
let lastNoticeAt = 0;

function formatWait(totalSeconds) {
  const seconds = Math.max(1, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function noticeCooldown(username, result) {
  if (!config.cooldownNotices || result.reason !== 'user-cooldown') return;
  const now = Date.now();
  const key = String(username).toLowerCase();
  if (now - lastNoticeAt < NOTICE_GLOBAL_MS) return;
  if (now - (noticeTimes.get(key) || 0) < NOTICE_PER_USER_MS) return;

  lastNoticeAt = now;
  noticeTimes.set(key, now);
  if (noticeTimes.size > 1000) {
    for (const [name, time] of noticeTimes) if (now - time > NOTICE_PER_USER_MS) noticeTimes.delete(name);
  }
  chatSay(`@${username}, you can throw again in ${formatWait(result.remaining)}.`);
}

function performThrow(username, requestedEmoji, { bypassCooldown = false, isTest = false } = {}) {
  const cleanUsername = String(username || 'viewer').trim().slice(0, 32);
  const usernameKey = cleanUsername.toLowerCase();
  if (!cleanUsername || state.brewing || isVotingOpen) {
    return { accepted: false, reason: state.brewing || isVotingOpen ? 'brewing' : 'invalid-user' };
  }

  const now = Date.now();
  if (!bypassCooldown && now - lastGlobalThrow < config.globalCooldownMs) {
    return { accepted: false, reason: 'global-cooldown' };
  }

  const userCooldownMs = config.userCooldownMs;
  const lastUserThrow = cooldowns.get(usernameKey) || 0;
  if (!bypassCooldown && now - lastUserThrow < userCooldownMs) {
    const remainingSec = Math.ceil((userCooldownMs - (now - lastUserThrow)) / 1000);
    return { accepted: false, reason: 'user-cooldown', remaining: remainingSec };
  }

  if (!bypassCooldown) {
    lastGlobalThrow = now;
    cooldowns.set(usernameKey, now);
  }

  if (cooldowns.size > 2000) {
    const expiry = now - Math.max(userCooldownMs, 60_000) * 2;
    for (const [key, timestamp] of cooldowns) if (timestamp < expiry) cooldowns.delete(key);
  }

  const emoji = requestedEmoji || '🎁';
  const golden = crypto.randomInt(100) < config.goldenChance;
  const multiplier = golden ? config.goldenMultiplier : 1;
  const before = state.progress;
  const requestedGain = config.fillPerThrow * multiplier;
  state.progress = Math.min(100, state.progress + requestedGain);
  const gained = state.progress - before;
  state.throwCount += 1;
  state.lastThrower = cleanUsername;

  broadcast('throw', {
    username: cleanUsername,
    emoji,
    progress: state.progress,
    isTest,
    golden,
    multiplier,
    gained,
    timestamp: now,
  });
  broadcastState();
  if (golden) {
    broadcast('goldenThrow', { username: cleanUsername, emoji, gained, multiplier, progress: state.progress });
  }
  console.log('[CHAT] !throw: ' + cleanUsername + ' ' + emoji + (golden ? ' GOLDEN x' + multiplier : '') + ' (+' + gained + '%, ' + state.progress + '%)');

  if (state.progress >= 100) completePotion();
  return { accepted: true, progress: state.progress, golden, gained };
}

function completePotion() {
  if (state.brewing) return;
  state.progress = 100;
  state.brewing = true;
  state.potionNumber += 1;
  const outcome = crypto.randomInt(100) < config.rewardChance ? 'reward' : 'punishment';
  state.currentOutcome = outcome;
  animationComplete = false;
  voteComplete = false;

  const result = {
    potionNumber: state.potionNumber,
    outcome,
    message: outcome === 'reward' ? 'REWARD BREWED!' : 'PUNISHMENT BREWED!',
    timestamp: Date.now(),
  };
  broadcastState();
  broadcast('potionComplete', result);
  console.log('[CAULDRON] Potion brewed (#' + state.potionNumber + '); outcome type: ' + outcome + '.');
  startOutcomeVote(outcome);

  if (animationFailsafeTimer) clearTimeout(animationFailsafeTimer);
  animationFailsafeTimer = setTimeout(() => {
    animationComplete = true;
    console.warn('[CAULDRON] Overlay animation callback timed out; continuing safely.');
    finishBrewIfReady();
  }, 60_000);
  animationFailsafeTimer.unref?.();
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

    client.on('message', (channel, tags, message, self) => {
      if (self || !message || !channel) return;
      const username = tags['display-name'] || tags.username || 'viewer';
      const login = String(tags.username || username).toLowerCase();
      const clean = message.trim();
      const isMod = isModOrBroadcaster(tags, username);

      if (/^!done$/i.test(clean)) {
        if (isMod) completeActiveOutcome(username);
        return;
      }

      const suggestionMatch = /^!(punish|reward)\s+([\s\S]+)$/i.exec(clean);
      if (suggestionMatch) {
        submitCommunitySuggestion(suggestionMatch[1].toLowerCase() === 'reward' ? 'reward' : 'punishment', suggestionMatch[2], username);
        return;
      }

      const moderationMatch = /^!(approve|reject)\s+(\d+)$/i.exec(clean);
      if (moderationMatch) {
        if (isMod) moderateSuggestion(moderationMatch[1].toLowerCase(), Number(moderationMatch[2]), username);
        return;
      }
      if (/^!suggestions$/i.test(clean)) {
        if (isMod) reportPendingSuggestions(username);
        return;
      }

      if (isVotingOpen) {
        const voteMatch = clean.match(/^[1-5]$/);
        if (voteMatch && castVote(login, Number(voteMatch[0]))) return;
      }

      const match = /^!throw(?:\s+([\s\S]*))?$/i.exec(clean);
      if (!match) return;
      const requestedEmoji = resolveThrowEmoji(match[1] || '');
      const result = performThrow(username, requestedEmoji, { bypassCooldown: false, isTest: false });
      if (!result.accepted) noticeCooldown(username, result);
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
    ${configured && !isAuthenticated ? '<p>Twitch hesabinla guvenli OAuth baglantisi kurmak icin asagidaki dugmeye bas. Uygulama <code>chat:read</code> ve <code>chat:edit</code> izinlerini ister (bot, oylama ve bekleme mesajlarini bagladigin hesapla sohbete yazar).</p><a class="button" href="/auth">Twitch hesabini bagla</a>' : ''}
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
  if (req.method === 'POST' && pathname === '/api/animation/complete') {
    if (!state.brewing) return sendJson(res, 409, { accepted: false, reason: 'not-brewing' });
    animationComplete = true;
    if (animationFailsafeTimer) clearTimeout(animationFailsafeTimer);
    animationFailsafeTimer = null;
    finishBrewIfReady();
    return sendJson(res, 200, { accepted: true, brewing: state.brewing, voteOpen: isVotingOpen });
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
      scope: 'chat:read chat:edit', // Botun mesaj yazabilmesi için chat:edit izni eklendi
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
  if (req.method === 'POST' && pathname === '/api/test/start-vote') {
    // Kazanı doldurmadan oylama panelini denemek için
    if (isVotingOpen) return sendJson(res, 409, { accepted: false, voting: true });
    startOutcomeVote('punishment');
    return sendJson(res, 200, { accepted: true, voting: isVotingOpen });
  }
  if (req.method === 'POST' && pathname === '/api/test/vote') {
    // Test modunda sahte bir izleyici adına oy ver; ?option=1..5 (verilmezse rastgele)
    const requested = Number.parseInt(requestUrl.searchParams.get('option'), 10);
    const option = OPTION_IDS.includes(requested) ? requested : OPTION_IDS[crypto.randomInt(OPTION_IDS.length)];
    testVoterNumber += 1;
    const accepted = castVote(`testvoter${testVoterNumber}`, option);
    return sendJson(res, accepted ? 200 : 409, { accepted, option, voting: isVotingOpen });
  }
  if (req.method === 'POST' && pathname === '/api/test/reset') {
    cancelPunishmentVote();
    if (brewResetTimer) clearTimeout(brewResetTimer);
    brewResetTimer = null;
    state.progress = 0;
    state.throwCount = 0;
    state.brewing = false;
    state.currentOutcome = null;
    state.lastThrower = '';
    animationComplete = false;
    voteComplete = false;
    if (animationFailsafeTimer) clearTimeout(animationFailsafeTimer);
    animationFailsafeTimer = null;
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
const coolingTimer = setInterval(() => {
  if (config.coolingPerMinute <= 0 || state.brewing || isVotingOpen || state.progress <= 0) return;
  const before = state.progress;
  state.progress = Math.max(0, state.progress - config.coolingPerMinute);
  if (state.progress !== before) {
    broadcastState();
    broadcast('cauldronCooling', { progress: state.progress, lost: before - state.progress });
    console.log('[CAULDRON] Cooling: -' + (before - state.progress) + '% (' + state.progress + '%).');
  }
}, 60_000);
coolingTimer.unref?.();

const heartbeat = setInterval(() => {
  for (const response of sseClients) {
    try { response.write(': keepalive\n\n'); } catch { sseClients.delete(response); }
  }
}, 25_000);
heartbeat.unref?.();

server.listen(config.port, config.host, () => {
  if (!fs.existsSync(COMMUNITY_PATH)) persistCommunityData();
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
  clearInterval(coolingTimer);
  if (brewResetTimer) clearTimeout(brewResetTimer);
  if (animationFailsafeTimer) clearTimeout(animationFailsafeTimer);
  clearVoteTimers();
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