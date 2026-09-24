// PINNED ON PURPOSE, and served from our own origin. This used to import the
// unversioned esm.sh URL, which meant every homeowner silently got whatever
// the newest release was: 2.6.2 shipped on 2026-08-14 and calls stopped
// connecting that same evening. It is now the esm.sh es2020 bundle of 2.6.1,
// vendored into /public/vendor so a third-party CDN outage can't take calls
// down either. Do not swap the version without testing a real call on a phone.
import Vapi from '/vendor/vapi-web-2.6.1.mjs';

const consentCheck = document.getElementById('consent-check');
const startBtn = document.getElementById('start-btn');
const endBtn = document.getElementById('end-btn');
const preCall = document.getElementById('pre-call');
const inCall = document.getElementById('in-call');
const postCall = document.getElementById('post-call');
const statusText = document.getElementById('status-text');
const volumeFill = document.getElementById('volume-fill');
const errorBox = document.getElementById('call-error');
const consentRow = document.querySelector('.consent');
const countdown = document.getElementById('countdown');
const countdownNum = document.getElementById('countdown-num');

const COUNTDOWN_SECONDS = 5;
const CONNECT_TIMEOUT_MS = 30000;
const ERROR_GRACE_MS = 8000;

const MSG_GENERIC = 'The call hit a technical problem. Please press “Try again” — if it keeps happening, contact our team.';
const MSG_NO_CONNECT = 'The call could not connect. Please check your internet connection and press “Try again”.';
const MSG_ENDED_EARLY = 'The call ended before it could start. Please press “Try again” — if it keeps happening, contact our team.';
const MSG_MIC = 'Your phone blocked the microphone, so the assistant can’t hear you. Please allow microphone access for this page and press “Try again”. '
  + 'On iPhone: tap “aA” in the address bar → Website Settings → Microphone → Allow. '
  + 'On Android: tap the lock icon next to the address → Permissions → Microphone → Allow.';

// Give the homeowner a moment to settle in before the assistant speaks — a
// visible countdown, then we connect (which is when the AI says hello).
function runCountdown(seconds) {
  return new Promise((resolve) => {
    let remaining = seconds;
    countdownNum.textContent = remaining;
    countdownNum.classList.remove('tick');
    void countdownNum.offsetWidth; // restart the tick animation
    countdownNum.classList.add('tick');
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        resolve();
        return;
      }
      countdownNum.textContent = remaining;
      countdownNum.classList.remove('tick');
      void countdownNum.offsetWidth;
      countdownNum.classList.add('tick');
    }, 1000);
  });
}

let vapi = null;
let wakeLock = null;
let attemptInProgress = false;
let callActive = false;
let callEnded = false;
// Set when an error arrives before we're connected. Held rather than shown,
// because the SDK reports non-fatal problems (microphone noise-processing
// failures, for one) on the same channel as real ones, and the call usually
// connects anyway a moment later.
let pendingFailure = null;
// The room can open without the assistant ever joining, which raises no error
// at all and leaves the homeowner watching "Connecting..." indefinitely.
let connectTimeout = null;

function clearTimers() {
  if (pendingFailure) { clearTimeout(pendingFailure); pendingFailure = null; }
  if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
}

// ---------------------------------------------------------------------------
// Audio playback guard.
//
// The SDK plays the assistant through an <audio> element and only tells the
// assistant it may speak ("playable") after audio.play() resolves. Phones -
// iPhones especially - reject play() when it isn't close enough to a tap, and
// by then we're a countdown plus a connection away from the Start tap. When
// that rejection happened the SDK swallowed it, never sent "playable", and the
// assistant stayed silent for the whole call: "the AI is not picking up".
//
// Instead, a blocked play() now waits for one tap on a "Tap to hear" button
// and plays from inside that tap. Because the SDK is still awaiting play(),
// the assistant holds its greeting until the homeowner can actually hear it.
// ---------------------------------------------------------------------------
const nativePlay = HTMLMediaElement.prototype.play;
const blockedPlayers = [];
let tapPrompt = null;

HTMLMediaElement.prototype.play = function guardedPlay() {
  const el = this;
  return nativePlay.call(el).catch((err) => {
    if (!err || err.name !== 'NotAllowedError') throw err;
    return new Promise((resolve) => {
      blockedPlayers.push({ el, resolve });
      showTapPrompt();
    });
  });
};

function showTapPrompt() {
  // The homeowner may take a moment to notice the button; don't time the
  // connection out from under them while they do.
  if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
  statusText.textContent = 'Tap the button below to hear the assistant';
  if (tapPrompt) return;
  tapPrompt = document.createElement('button');
  tapPrompt.type = 'button';
  tapPrompt.className = 'btn btn-primary btn-lg';
  tapPrompt.style.cssText = 'display:block;width:100%;margin:4px 0 14px;';
  tapPrompt.textContent = '🔊 Tap to hear the assistant';
  tapPrompt.addEventListener('click', () => {
    const waiting = blockedPlayers.splice(0);
    waiting.forEach(({ el, resolve }) => {
      nativePlay.call(el).then(resolve).catch(() => {
        blockedPlayers.push({ el, resolve });
        if (tapPrompt) tapPrompt.textContent = '🔊 Tap again to hear the assistant';
      });
    });
    setTimeout(() => { if (!blockedPlayers.length) hideTapPrompt(); }, 300);
  });
  endBtn.parentNode.insertBefore(tapPrompt, endBtn);
}

function hideTapPrompt() {
  if (tapPrompt) { tapPrompt.remove(); tapPrompt = null; }
  if (callActive && !callEnded) statusText.textContent = 'Connected — say hello!';
}

// Phones lock their screens mid-call, which suspends the browser tab and
// kills the WebRTC connection ("customer disconnected"). Keep the screen awake
// from the Start tap onward - Safari only grants this from a user gesture -
// and re-acquire if the user briefly switches away and comes back.
async function keepScreenAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* not supported or denied - harmless */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && attemptInProgress && !callEnded) keepScreenAwake();
});

consentCheck.addEventListener('change', () => {
  startBtn.disabled = !consentCheck.checked;
});

function showError(message) {
  clearTimers();
  hideTapPrompt();
  blockedPlayers.splice(0);
  attemptInProgress = false;
  releaseWakeLock();
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
  countdown.classList.add('hidden');
  preCall.classList.remove('hidden');
  if (consentRow) consentRow.classList.remove('hidden');
  inCall.classList.add('hidden');
  startBtn.disabled = !consentCheck.checked;
  startBtn.textContent = '🎙️ Try again';
}

// Give up on this attempt: hang up first, so a call that is half-alive behind
// the error screen can't keep talking to nobody.
function fail(message) {
  callEnded = true;
  const v = vapi;
  vapi = null;
  if (v) { try { v.stop(); } catch (_) { /* already gone */ } }
  showError(message);
}

function isMicPermissionError(err) {
  let text = '';
  try { text = JSON.stringify(err); } catch (_) { text = String(err); }
  return /NotAllowedError|NotFoundError|Permission|not-allowed|microphone|getUserMedia|cam-mic|blocked/i.test(text);
}

// "call-start" alone is not a reliable sign the call is live - in testing it
// went missing on roughly one call in thirteen even though the assistant was
// talking. Treating its absence as "never connected" used to hang up working
// calls at the 30-second mark and show an error at the end of real ones.
// Any evidence of a live call counts.
function markConnected() {
  if (callActive || callEnded || !attemptInProgress) return;
  callActive = true;
  clearTimers();
  keepScreenAwake();
  if (!tapPrompt) statusText.textContent = 'Connected — say hello!';
  const stepConsent = document.getElementById('step-consent');
  const stepCall = document.getElementById('step-call');
  if (stepConsent) { stepConsent.classList.remove('current'); stepConsent.classList.add('done'); }
  if (stepCall) stepCall.classList.add('current');
}

startBtn.addEventListener('click', async () => {
  if (attemptInProgress) return;
  attemptInProgress = true;
  callActive = false;
  callEnded = false;
  errorBox.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  keepScreenAwake();

  let config;
  try {
    const res = await fetch(`/api/call-config/${window.CALL_TOKEN}`);
    config = await res.json();
    if (!res.ok) throw new Error(config.error || 'Could not start the call.');
  } catch (err) {
    return showError(err.message || 'Could not reach the call service. Please check your connection and try again.');
  }

  // Visible countdown BEFORE connecting, so the assistant's greeting doesn't
  // start before the homeowner has settled in.
  preCall.classList.add('hidden');
  if (consentRow) consentRow.classList.add('hidden');
  countdown.classList.remove('hidden');
  await runCountdown(COUNTDOWN_SECONDS);
  countdown.classList.add('hidden');
  inCall.classList.remove('hidden');
  statusText.textContent = 'Connecting…';
  connectTimeout = setTimeout(() => {
    connectTimeout = null;
    if (callActive || callEnded || tapPrompt) return;
    fail(MSG_NO_CONNECT);
  }, CONNECT_TIMEOUT_MS);

  const v = new Vapi(config.publicKey);
  vapi = v;
  // Events from an attempt the homeowner has already abandoned are ignored.
  const current = () => vapi === v;

  v.on('call-start', () => { if (current()) markConnected(); });

  v.on('speech-start', () => {
    if (!current()) return;
    markConnected();
    statusText.textContent = 'Assistant is speaking…';
  });
  v.on('speech-end', () => { if (current() && callActive) statusText.textContent = 'Listening to you…'; });

  v.on('message', (m) => {
    if (!current() || !m) return;
    if ((m.type === 'status-update' && m.status === 'in-progress') || m.type === 'transcript') markConnected();
  });

  v.on('volume-level', (level) => {
    if (!current()) return;
    if (level > 0.01) markConnected();
    volumeFill.style.width = `${Math.min(100, Math.round(level * 100))}%`;
  });

  v.on('call-end', () => {
    if (!current()) return;
    const wasActive = callActive;
    callEnded = true;
    attemptInProgress = false;
    clearTimers();
    hideTapPrompt();
    releaseWakeLock();
    vapi = null;
    // A call that ends without ever having connected did not happen. Saying
    // "all done" there tells the homeowner they completed a verification
    // they were never actually asked a single question in.
    if (!wasActive) return showError(MSG_ENDED_EARLY);
    inCall.classList.add('hidden');
    postCall.classList.remove('hidden');
    if (consentRow) consentRow.classList.add('hidden');
    const stepCall = document.getElementById('step-call');
    if (stepCall) { stepCall.classList.remove('current'); stepCall.classList.add('done'); }
  });

  v.on('error', (err) => {
    console.error('vapi error', err);
    if (!current() || callEnded || callActive) return;
    if (isMicPermissionError(err)) return fail(MSG_MIC);
    // Give the connection a few seconds to succeed anyway before giving up on
    // it, so a recoverable hiccup doesn't end the call.
    if (pendingFailure) return;
    pendingFailure = setTimeout(() => {
      pendingFailure = null;
      if (!current() || callActive || callEnded) return;
      fail(MSG_GENERIC);
    }, ERROR_GRACE_MS);
  });

  let call = null;
  try {
    call = await v.start(config.assistantId, config.overrides);
  } catch (err) {
    console.error(err);
    if (current()) fail(isMicPermissionError(err) ? MSG_MIC : MSG_GENERIC);
    return;
  }
  // The SDK reports a failed start by resolving null (after emitting
  // "error"), not by throwing - so there is nothing to wait for.
  if (!call || !call.id) {
    if (current() && !callActive && !callEnded) fail(MSG_GENERIC);
    return;
  }
  fetch('/api/call-linked', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: window.CALL_TOKEN, vapiCallId: call.id }),
  }).catch(() => {});
});

endBtn.addEventListener('click', () => {
  if (vapi) vapi.stop();
});
