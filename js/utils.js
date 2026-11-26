export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value) => UUID_RE.test(String(value || ''));

export function initials(name) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .map((part) => part[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';
}

export function avatarMarkup(person, extraClass = '') {
  if (person?.avatar) {
    return `<span class="avatar ${extraClass}" style="background-image:url('${esc(person.avatar)}');background-size:cover;background-position:center" aria-label="${esc(person.name || '')}"></span>`;
  }
  const color = person?.color || '#dce8e2';
  return `<span class="avatar ${extraClass}" style="background:${esc(color)};color:#586d61">${esc(person?.initial || initials(person?.name))}</span>`;
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDayLabel(iso) {
  if (!iso) return 'RECENT';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'RECENT';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const key = dayKey(iso);
  if (key === dayKey(today.toISOString())) return 'Today';
  if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function formatLastSeen(iso, isOnline) {
  if (isOnline) return 'online';
  if (!iso) return 'last seen recently';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'last seen recently';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 90) return 'last seen just now';
  if (diffSec < 3600) return `last seen ${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `last seen today at ${formatTime(iso)}`;
  return `last seen ${formatDayLabel(iso)}`;
}

export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

let toastTimer = 0;
export function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

let uiHistoryDepth = 0;
let suppressPopCount = 0;

export function pushUiLayer(name) {
  try {
    uiHistoryDepth++;
    history.pushState({ whisperLayer: name, depth: uiHistoryDepth }, '');
  } catch {
    // Ignore history push errors in restricted contexts.
  }
}

export function popUiLayer(count = 1) {
  const n = Math.min(count, uiHistoryDepth);
  if (n > 0 && history.state?.whisperLayer) {
    uiHistoryDepth -= n;
    suppressPopCount += n;
    history.go(-n);
  }
}

export function consumePopLayer() {
  if (suppressPopCount > 0) {
    suppressPopCount--;
    return false;
  }
  if (uiHistoryDepth > 0) uiHistoryDepth--;
  return true;
}

export function openModal(html) {
  const modal = $('#modal');
  const body = $('#modal-body');
  if (!modal || !body) return;
  body.innerHTML = html;
  if (!modal.open) {
    pushUiLayer('modal');
    modal.showModal();
  }
}

export function closeModal() {
  const modal = $('#modal');
  if (modal?.open) modal.close();
}

export function playNotificationChime(enabled = true, type = 'message') {
  if (!enabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(type === 'call' ? 660 : 587.33, ctx.currentTime);
    if (type !== 'call') {
      osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.09);
    }
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (type === 'call' ? 0.25 : 0.16));
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close().catch(() => {});
    }, type === 'call' ? 270 : 180);
  } catch {
    // Audio playback may be blocked prior to user interaction.
  }
}

export function haptic(pattern = 15) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration API unavailable or blocked.
  }
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
