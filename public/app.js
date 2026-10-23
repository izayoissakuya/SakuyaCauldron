'use strict';

/*
 * Sakuya's Haunted Cauldron overlay animation controller.
 */
const IDLE_ASSET = '/assets/cauldron-idle.gif';
const THROW_ASSET = '/assets/cauldron-add.gif';
const REWARD_ASSET = '/assets/reward.gif';
const PUNISHMENT_ASSET = '/assets/punishment.gif';
const THROW_ANIMATION_MS = 4000;
const COMPLETE_ANIMATION_MS = 8000; // 8 saniyelik animasyon süresi

// HTML ID'leri güncellendi
const art = document.getElementById('cauldronArt');
const stage = document.getElementById('cauldron-widget');
const flyLayer = document.getElementById('flyLayer');
const progressFill = document.getElementById('progress-fill');
const progressTrack = document.querySelector('.progress-track');
const progressLabel = document.getElementById('progress-value');
const connectionStatus = document.getElementById('status-chip');
const completeToast = document.getElementById('potion-result');
const potionMessage = document.getElementById('potion-message');

let animationQueue = Promise.resolve();
let lastState = null;
let potionToastTimer = null;

function delay(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function setConnection(label, status = 'pending') {
  if (!connectionStatus) return;
  connectionStatus.classList.remove('connected', 'error');
  if (status === 'connected') connectionStatus.classList.add('connected');
  if (status === 'error') connectionStatus.classList.add('error');
  connectionStatus.textContent = label;
}

function cacheBusted(path) {
  if (!path) return '';
  return `${path}${path.includes('?') ? '&' : '?'}play=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setArt(path, restart = false) {
  if (!art || !path) return;
  art.src = restart ? cacheBusted(path) : path;
}

function renderState(data = {}) {
  lastState = data;
  const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (progressLabel) progressLabel.textContent = `${Math.round(progress)}%`;

  // Sunucudan gelen Türkçe mesajları İngilizceye çevirerek ekrana basıyoruz
  if (data.twitchConnected) {
    setConnection(`Twitch Connected · #${data.channel || ''}`, 'connected');
  } else {
    let msg = data.statusMessage || 'Waiting for Twitch connection';
    if (msg.includes('baglaniyor')) msg = 'Connecting to Twitch...';
    else if (msg.includes('bekleniyor')) msg = 'Waiting for Twitch...';
    else if (msg.includes('kesildi')) msg = 'Twitch disconnected';
    else if (msg.includes('hatasi')) msg = 'Twitch connection error';
    setConnection(msg, 'pending');
  }
  
  if (stage) stage.classList.toggle('brewing', Boolean(data.brewing));
}

function showFlyingItem(emoji) {
  if (!flyLayer) return;
  const item = document.createElement('span');
  item.className = 'flying-item';
  item.textContent = emoji || '🎁';
  flyLayer.appendChild(item);
  item.addEventListener('animationend', () => item.remove(), { once: true });
  window.setTimeout(() => item.remove(), 1600);
}

function queueAnimation(task, label) {
  animationQueue = animationQueue
    .then(task)
    .catch(error => {
      console.error(`[Overlay] ${label || 'Animation'} failed:`, error);
      setArt(IDLE_ASSET, true);
    });
  return animationQueue;
}

async function playThrow(eventData = {}) {
  const emoji = eventData.emoji || '🎁';

  if (THROW_ASSET) {
    setArt(THROW_ASSET, true);
    showFlyingItem(emoji); // Eşya atma animasyonu
    await delay(Math.max(250, THROW_ANIMATION_MS));
    setArt(IDLE_ASSET, true);
  } else {
    showFlyingItem(emoji);
    await delay(700);
  }
}

function showResultToast(outcome) {
  if (!completeToast || !potionMessage) return;
  
  // Ödül/Ceza İngilizce metinleri
  potionMessage.textContent = outcome === 'reward' ? '🎉 REWARD UNLOCKED!' : '💀 PUNISHMENT ACTIVE!';
  
  completeToast.classList.add('visible');
  if (potionToastTimer) window.clearTimeout(potionToastTimer);
  
  // Bildirimi 3 saniye ekranda tut, sonra CSS ile yavaşça silinmesi için sınıfı kaldır
  potionToastTimer = window.setTimeout(() => {
    completeToast.classList.remove('visible');
  }, 3000); 
}

async function playPotionComplete(data = {}) {
  const outcome = data.outcome === 'punishment' ? 'punishment' : 'reward';
  const outcomeAsset = outcome === 'reward' ? REWARD_ASSET : PUNISHMENT_ASSET;
  
  if (stage) {
    stage.classList.add('brewing');
    stage.classList.toggle('outcome-reward', outcome === 'reward');
    stage.classList.toggle('outcome-punishment', outcome === 'punishment');
  }

  // 1. Önce kazan efektini oynat (8 saniye boyunca)
  if (outcomeAsset) {
    setArt(outcomeAsset, true);
  }

  await delay(Math.max(500, COMPLETE_ANIMATION_MS)); // 8 Saniye Bekle
  
  // 2. Animasyon bittikten sonra kazanı normal haline (idle) döndür
  if (stage) {
    stage.classList.remove('brewing', 'outcome-reward', 'outcome-punishment');
  }
  setArt(IDLE_ASSET, true);

  // 3. ŞİMDİ Toast (Bildirim) mesajını ekrana çıkart
  showResultToast(outcome);

  // 4. Bildirim süresi (3 sn) + CSS Yavaşça Silinme Payı (1.5 sn) kadar bekle ki döngü bozulmasın
  await delay(4500); 

  try {
    const response = await fetch('/api/animation/complete', { method: 'POST', cache: 'no-store' });
    if (!response.ok && response.status !== 409) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('[Overlay] Failed to send reset signal:', error);
  }
}

function resetBrew() {
  if (stage) {
    stage.classList.remove('brewing', 'outcome-reward', 'outcome-punishment');
  }
  if (completeToast) completeToast.classList.remove('visible');
  if (potionToastTimer) window.clearTimeout(potionToastTimer);
  setArt(IDLE_ASSET, true);
}

async function connectEvents() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (response.ok) renderState(await response.json());
  } catch (error) {
    setConnection('Cannot reach local server', 'error');
  }

  const events = new EventSource('/events');
  events.addEventListener('open', () => {
    if (lastState?.twitchConnected) setConnection(`Twitch Connected · #${lastState.channel || ''}`, 'connected');
    else if (lastState?.statusMessage) setConnection('Waiting for Twitch connection', 'pending');
    else setConnection('Overlay connected to server', 'connected');
  });
  events.addEventListener('error', () => setConnection('Reconnecting overlay...', 'error'));
  events.addEventListener('state', event => {
    try { renderState(JSON.parse(event.data)); }
    catch (error) {}
  });
  events.addEventListener('throw', event => {
    try { queueAnimation(() => playThrow(JSON.parse(event.data)), 'Throw'); }
    catch (error) {}
  });
  events.addEventListener('potionComplete', event => {
    try { queueAnimation(() => playPotionComplete(JSON.parse(event.data)), 'Potion Result'); }
    catch (error) {}
  });
  events.addEventListener('brewReset', () => {
    queueAnimation(async () => resetBrew(), 'Reset Cauldron');
  });
}

async function runTestAction(endpoint) {
  const buttons = [...document.querySelectorAll('#test-panel button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    await fetch(endpoint, { method: 'POST', cache: 'no-store' });
  } catch (error) {
    console.warn(error);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

const testPanel = document.getElementById('test-panel');
if (new URLSearchParams(window.location.search).get('test') === '1' && testPanel) {
  document.body.classList.add('test-mode');
  document.getElementById('test-throw')?.addEventListener('click', () => runTestAction('/api/test/throw'));
  document.getElementById('test-reset')?.addEventListener('click', () => runTestAction('/api/test/reset'));
}

if (art) {
  art.addEventListener('error', () => {
    setConnection('Cauldron asset not found in public/assets', 'error');
  });
}

connectEvents();