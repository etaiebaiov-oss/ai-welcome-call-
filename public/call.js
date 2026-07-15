import Vapi from 'https://esm.sh/@vapi-ai/web';

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

let vapi = null;
let wakeLock = null;
let callActive = false;
let callEnded = false;

// Phones lock their screens mid-call, which suspends the browser tab and
// kills the WebRTC connection ("customer disconnected"). Keep the screen
// awake for the duration of the call, and re-acquire if the user briefly
// switches away and comes back.
async function keepScreenAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) { /* not supported or denied - harmless */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && callActive) keepScreenAwake();
});

consentCheck.addEventListener('change', () => {
  startBtn.disabled = !consentCheck.checked;
});

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
  preCall.classList.remove('hidden');
  inCall.classList.add('hidden');
  startBtn.disabled = !consentCheck.checked;
  startBtn.textContent = '🎙️ Try again';
}

startBtn.addEventListener('click', async () => {
  errorBox.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.textContent = 'Connecting…';

  let config;
  try {
    const res = await fetch(`/api/call-config/${window.CALL_TOKEN}`);
    config = await res.json();
    if (!res.ok) throw new Error(config.error || 'Could not start the call.');
  } catch (err) {
    return showError(err.message || 'Could not reach the call service. Please check your connection and try again.');
  }

  try {
    vapi = new Vapi(config.publicKey);

    vapi.on('call-start', () => {
      statusText.textContent = 'Connected — say hello!';
      callActive = true;
      keepScreenAwake();
    });

    vapi.on('speech-start', () => { statusText.textContent = 'Assistant is speaking…'; });
    vapi.on('speech-end', () => { statusText.textContent = 'Listening to you…'; });

    vapi.on('volume-level', (level) => {
      volumeFill.style.width = `${Math.min(100, Math.round(level * 100))}%`;
    });

    vapi.on('call-end', () => {
      callActive = false;
      callEnded = true;
      releaseWakeLock();
      inCall.classList.add('hidden');
      postCall.classList.remove('hidden');
      if (consentRow) consentRow.classList.add('hidden');
    });

    vapi.on('error', (err) => {
      console.error('vapi error', err);
      // Disconnect noise fired after the call already ended (e.g. silence
      // timeout ejection) is not a user-facing problem - don't alarm them.
      if (callEnded) return;
      showError('The call hit a technical problem. Please try again — if it keeps happening, contact our team.');
    });

    const call = await vapi.start(config.assistantId, config.overrides);

    preCall.classList.add('hidden');
    inCall.classList.remove('hidden');
    statusText.textContent = 'Connecting…';

    if (call && call.id) {
      fetch('/api/call-linked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: window.CALL_TOKEN, vapiCallId: call.id }),
      }).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    showError('Could not start the call. Please make sure microphone access is allowed, then try again.');
  }
});

endBtn.addEventListener('click', () => {
  if (vapi) vapi.stop();
});
