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
const activeOutcomesPanel = document.getElementById('active-outcomes');
const activeOutcomeList = document.getElementById('active-outcome-list');
const activeOutcomesTitle = document.getElementById('active-outcomes-title');
const confettiLayer = document.getElementById('confetti-layer');

const votePanel = document.getElementById('vote-panel');
const voteList = document.getElementById('vote-list');
const voteClock = document.getElementById('vote-clock');
const voteSeconds = document.getElementById('vote-seconds');
const voteTimerFill = document.getElementById('vote-timer-fill');
const voteTitleText = document.getElementById('vote-title-text');
const voteHint = document.getElementById('vote-hint');
const voteResultKicker = document.getElementById('vote-result-kicker');
const voteResultLabel = document.getElementById('vote-result-label');
const VOTE_RESULT_HOLD_MS = 8000; // Kazanan ekranda bu kadar kalır
const VOTE_URGENT_SECONDS = 5;

let animationQueue = Promise.resolve();
let lastState = null;
let potionToastTimer = null;
let voteActive = false;
let voteTick = null;
let voteHideTimer = null;
let configGoldenMultiplier = 3;
let lastAnimatedPotionNumber = 0;

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

function renderActiveOutcomes(items = []) {
  if (!activeOutcomesPanel || !activeOutcomeList) return;
  activeOutcomeList.replaceChildren();
  const sorted = Array.isArray(items) ? items : [];
  if (!sorted.length) {
    activeOutcomesPanel.classList.remove('visible');
    activeOutcomesPanel.setAttribute('aria-hidden', 'true');
    return;
  }

  if (activeOutcomesTitle) activeOutcomesTitle.textContent = sorted.length > 1 ? 'ACTIVE QUESTS' : 'ACTIVE ' + (sorted[0].type === 'reward' ? 'REWARD' : 'PUNISHMENT');
  for (const outcome of sorted) {
    const card = document.createElement('article');
    card.className = 'active-outcome-card ' + (outcome.type === 'reward' ? 'reward' : 'punishment');
    card.dataset.id = String(outcome.id);

    const icon = document.createElement('span');
    icon.className = 'active-outcome-icon';
    icon.textContent = outcome.type === 'reward' ? '🎁' : '💀';

    const body = document.createElement('div');
    body.className = 'active-outcome-body';
    const label = document.createElement('div');
    label.className = 'active-outcome-label';
    label.textContent = outcome.label || (outcome.type === 'reward' ? 'Active reward' : 'Active punishment');

    const count = Math.max(1, Number(outcome.remaining) || 1);
    const unit = outcome.unit === 'game' ? (count === 1 ? 'game' : 'games')
      : outcome.unit === 'round' ? (count === 1 ? 'round' : 'rounds')
      : (count === 1 ? 'task' : 'tasks');
    const remaining = document.createElement('div');
    remaining.className = 'active-outcome-remaining';
    remaining.textContent = count + ' ' + unit + ' remaining';

    body.append(label, remaining);
    card.append(icon, body);
    activeOutcomeList.appendChild(card);
  }
  activeOutcomesPanel.classList.add('visible');
  activeOutcomesPanel.setAttribute('aria-hidden', 'false');
}

function renderState(data = {}) {
  lastState = data;
  const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (progressLabel) progressLabel.textContent = `${Math.round(progress)}%`;
  if (Array.isArray(data.activeOutcomes)) renderActiveOutcomes(data.activeOutcomes);

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

  // Restore a currently brewing animation if OBS/browser source was refreshed.
  const potionNumber = Number(data.potionNumber) || 0;
  if (data.brewing && data.currentOutcome && potionNumber > 0 && potionNumber !== lastAnimatedPotionNumber) {
    lastAnimatedPotionNumber = potionNumber;
    queueAnimation(() => playPotionComplete({ outcome: data.currentOutcome, potionNumber, resumed: true }), 'Resume Potion Result');
  }

  // OBS kaynağı oylama sırasında yenilenirse paneli kaldığı yerden göster
  if (data.vote?.open && !voteActive) showVote(data.vote);
}

/* --- CEZA OYLAMA PANELİ --- */
function buildVoteRows(options = []) {
  if (!voteList) return;
  voteList.replaceChildren();
  for (const option of options) {
    const row = document.createElement('li');
    row.className = 'vote-row';
    row.dataset.id = String(option.id);

    const bar = document.createElement('span');
    bar.className = 'vote-bar';
    const num = document.createElement('span');
    num.className = 'vote-num';
    num.textContent = String(option.id);
    const label = document.createElement('span');
    label.className = 'vote-label';
    label.textContent = option.label;
    const count = document.createElement('span');
    count.className = 'vote-count';
    count.textContent = '0';

    row.append(bar, num, label, count);
    voteList.appendChild(row);
  }
}

function updateVoteCounts(votes = {}, total = 0) {
  if (!voteList) return;
  const counts = [...voteList.children].map(row => Number(votes[row.dataset.id]) || 0);
  const max = Math.max(0, ...counts);
  [...voteList.children].forEach((row, index) => {
    const count = counts[index];
    row.style.setProperty('--share', `${total > 0 ? (count / total) * 100 : 0}%`);
    row.querySelector('.vote-count').textContent = String(count);
    row.classList.toggle('leading', max > 0 && count === max);
  });
}

function stopVoteTick() {
  if (voteTick) window.clearInterval(voteTick);
  voteTick = null;
}

function startVoteCountdown(remainingMs, durationMs) {
  stopVoteTick();
  const deadline = Date.now() + Math.max(0, remainingMs);
  const duration = Math.max(1000, durationMs || remainingMs || 30000);

  // Çubuğu kalan orandan başlatıp kalan süre boyunca sıfıra doğru kaydır
  if (voteTimerFill) {
    voteTimerFill.style.transition = 'none';
    voteTimerFill.style.width = `${Math.min(100, (remainingMs / duration) * 100)}%`;
    void voteTimerFill.offsetWidth; // yeniden akış: geçişin sıfırdan başlaması için
    voteTimerFill.style.transition = `width ${Math.max(0, remainingMs)}ms linear`;
    voteTimerFill.style.width = '0%';
  }

  const render = () => {
    const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (voteSeconds) voteSeconds.textContent = String(secondsLeft);
    if (voteClock) voteClock.classList.toggle('urgent', secondsLeft > 0 && secondsLeft <= VOTE_URGENT_SECONDS);
    if (secondsLeft <= 0) stopVoteTick();
  };
  render();
  voteTick = window.setInterval(render, 250);
}

function showVote(snapshot = {}) {
  if (!votePanel) return;
  if (voteHideTimer) window.clearTimeout(voteHideTimer);
  voteHideTimer = null;
  voteActive = true;

  votePanel.classList.remove('finished');
  const voteType = snapshot.type === 'reward' ? 'REWARD' : 'PUNISHMENT';
  if (voteTitleText) voteTitleText.textContent = voteType + ' VOTE';
  if (voteHint) voteHint.innerHTML = 'Type <b>1</b> – <b>' + (snapshot.options?.length || 5) + '</b> in chat to vote';
  buildVoteRows(snapshot.options);
  updateVoteCounts(snapshot.votes, snapshot.total);
  startVoteCountdown(snapshot.remainingMs ?? snapshot.durationMs, snapshot.durationMs);

  votePanel.classList.add('visible');
  votePanel.setAttribute('aria-hidden', 'false');
}

function hideVote() {
  voteActive = false;
  stopVoteTick();
  if (voteHideTimer) window.clearTimeout(voteHideTimer);
  voteHideTimer = null;
  if (voteClock) voteClock.classList.remove('urgent');
  if (!votePanel) return;
  votePanel.classList.remove('visible');
  votePanel.setAttribute('aria-hidden', 'true');
}

function finishVote(result = {}) {
  if (!votePanel) return;
  if (!voteList?.children.length) showVote({ options: [], votes: {}, total: 0, remainingMs: 0, durationMs: 1000 });
  voteActive = false;
  stopVoteTick();
  if (voteHideTimer) window.clearTimeout(voteHideTimer);

  updateVoteCounts(result.votes, result.total);
  [...voteList.children].forEach(row => {
    const isWinner = Number(row.dataset.id) === Number(result.winner);
    row.classList.remove('leading');
    row.classList.toggle('winner', isWinner);
    row.classList.toggle('loser', !isWinner);
  });

  if (voteSeconds) voteSeconds.textContent = '0';
  if (voteClock) voteClock.classList.remove('urgent');
  if (voteTitleText) voteTitleText.textContent = (result.type === 'reward' ? 'REWARD' : 'PUNISHMENT') + ' VOTE ENDED';

  const votesText = `${result.maxVotes} ${result.maxVotes === 1 ? 'VOTE' : 'VOTES'}`;
  let kicker = `WINNER · ${votesText}`;
  if (result.mode === 'tie') kicker = `TIE AT ${votesText} · PICKED AT RANDOM`;
  if (result.mode === 'no-votes') kicker = 'NO VOTES · PICKED AT RANDOM';
  if (voteResultKicker) voteResultKicker.textContent = kicker;
  if (voteResultLabel) voteResultLabel.textContent = result.label || '';

  votePanel.classList.add('finished', 'visible');
  votePanel.setAttribute('aria-hidden', 'false');
  voteHideTimer = window.setTimeout(hideVote, VOTE_RESULT_HOLD_MS);
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
    if (eventData.golden) {
      configGoldenMultiplier = Math.max(2, Number(eventData.multiplier) || 3);
      if (stage) stage.classList.add('golden-throw-active');
      showResultToast('golden');
    }
    await delay(Math.max(250, THROW_ANIMATION_MS));
    if (stage) stage.classList.remove('golden-throw-active');
    setArt(IDLE_ASSET, true);
  } else {
    showFlyingItem(emoji);
    await delay(700);
  }
}

function showResultToast(outcome) {
  if (!completeToast || !potionMessage) return;

  completeToast.classList.remove('toast-golden', 'toast-reward', 'toast-punishment');
  if (outcome === 'golden') {
    potionMessage.textContent = '✨ GOLDEN THROW x' + (configGoldenMultiplier || 3) + '!';
    completeToast.classList.add('toast-golden');
  } else if (outcome === 'reward') {
    potionMessage.textContent = '🎉 REWARD UNLOCKED!';
    completeToast.classList.add('toast-reward');
  } else {
    potionMessage.textContent = '💀 PUNISHMENT ACTIVE!';
    completeToast.classList.add('toast-punishment');
  }

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

function spawnConfetti() {
  if (!confettiLayer) return;
  const colors = ['#ffd76a', '#d7a7ff', '#8df2bd', '#ff91cb', '#ffffff'];
  const total = 72;
  for (let i = 0; i < total; i += 1) {
    const bit = document.createElement('span');
    bit.className = 'confetti-bit';
    bit.style.left = (Math.random() * 100) + 'vw';
    bit.style.backgroundColor = colors[i % colors.length];
    bit.style.animationDelay = (Math.random() * 450) + 'ms';
    bit.style.setProperty('--confetti-drift', ((Math.random() * 240) - 120) + 'px');
    bit.style.setProperty('--confetti-rotation', ((Math.random() * 1080) - 540) + 'deg');
    confettiLayer.appendChild(bit);
    bit.addEventListener('animationend', () => bit.remove(), { once: true });
    window.setTimeout(() => bit.remove(), 4500);
  }
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
    try {
      const data = JSON.parse(event.data);
      const potionNumber = Number(data.potionNumber) || 0;
      if (potionNumber && potionNumber === lastAnimatedPotionNumber) return;
      if (potionNumber) lastAnimatedPotionNumber = potionNumber;
      queueAnimation(() => playPotionComplete(data), 'Potion Result');
    } catch (error) { console.warn('[Overlay] potionComplete failed:', error); }
  });
  events.addEventListener('brewReset', () => {
    queueAnimation(async () => resetBrew(), 'Reset Cauldron');
  });
  // Oylama paneli kazan animasyon sırasından bağımsız, anında çalışır
  events.addEventListener('voteStart', event => {
    try { showVote(JSON.parse(event.data)); }
    catch (error) { console.warn('[Overlay] voteStart failed:', error); }
  });
  events.addEventListener('voteUpdate', event => {
    try {
      const data = JSON.parse(event.data);
      if (!voteActive) showVote(data);
      else updateVoteCounts(data.votes, data.total);
    } catch (error) { console.warn('[Overlay] voteUpdate failed:', error); }
  });
  events.addEventListener('voteEnd', event => {
    try { finishVote(JSON.parse(event.data)); }
    catch (error) { console.warn('[Overlay] voteEnd failed:', error); }
  });
  events.addEventListener('voteCancel', hideVote);
  events.addEventListener('activeOutcomes', event => {
    try { renderActiveOutcomes(JSON.parse(event.data)); } catch (error) { console.warn('[Overlay] activeOutcomes failed:', error); }
  });
  events.addEventListener('outcomeDone', event => {
    try {
      const data = JSON.parse(event.data);
      spawnConfetti();
    } catch (error) { console.warn('[Overlay] outcomeDone failed:', error); }
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
  document.getElementById('test-start-vote')?.addEventListener('click', () => runTestAction('/api/test/start-vote'));
  document.getElementById('test-vote')?.addEventListener('click', () => runTestAction('/api/test/vote'));
  document.getElementById('test-reset')?.addEventListener('click', () => runTestAction('/api/test/reset'));
}

if (art) {
  art.addEventListener('error', () => {
    setConnection('Cauldron asset not found in public/assets', 'error');
  });
}

connectEvents();