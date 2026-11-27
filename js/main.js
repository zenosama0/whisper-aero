import { config, configured, supabase } from './config.js';
import * as api from './api.js';
import { replaceEmojiShortcodes, searchEmojis } from './emoji.js?v=29';
import {
  isHeicFile,
  isImageFile,
  isVideoFile,
  normalizeUploadFile,
} from './media.js?v=29';
import {
  clearNativeSession,
  getNativeStoredSession,
  isBubbleWindow,
  isNativeAndroid,
  isNativeApp,
  openNativeChatBubble,
  pushNativeChatShortcuts,
  sendNativeNotification,
  startNativeGoogleSignIn,
  syncNativeSession,
  syncNativeTheme,
  triggerNativeCallAlarm,
} from './native.js?v=29';
import { joinConversationTyping, sendTypingSignal, startRealtime, stopRealtime } from './realtime.js';
import {
  getActiveChat,
  getChat,
  getDisplayName,
  getEffectiveChatTheme,
  resetState,
  setChatDraft,
  state,
  upsertMessage,
} from './state.js';
import {
  clearComposeContext,
  clearPendingAttachment,
  closeChatSearch,
  closeMessageMenu,
  initChatUI,
  isMessagesNearBottom,
  openChatSearch,
  renderAttachmentPreview,
  renderChats,
  renderMessages,
  renderSharedMedia,
  runChatSearch,
  selectChat,
  stepChatSearch,
  syncChatMessages,
  updatePeerHeader,
  updateScrollBottomBtn,
  updateTypingBanner,
} from './ui/chat.js';
import {
  closeAvatarLightbox,
  closeWorkspacePanel,
  getActiveWorkspacePanel,
  openAvatarLightbox,
  openChatThemeModal,
  openNicknameModal,
  openPeoplePage,
  openProfileModal,
  openRequestsPage,
  openSettingsPage,
  refreshRequestsPageIfOpen,
} from './ui/modals.js';
import {
  $,
  $$,
  closeModal,
  consumePopLayer,
  esc,
  formatTime,
  haptic,
  initials,
  playNotificationChime,
  popUiLayer,
  pushUiLayer,
  showToast,
  startCallRingtone,
  stopCallRingtone,
} from './utils.js';

let authMode = 'login';
let resetTab = 'code';
let mfaUseBackup = false;
let pendingMfaFactorId = null;
let pendingChatId = new URLSearchParams(window.location.search).get('chat') || '';
let closingModalFromPop = false;
let isRecoveryFlow = window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery');
let activeUserId = null;
let enteringUserId = null;
let refreshPromise = null;
let resumePromise = null;
let lastResumeSyncAt = 0;
let pendingSharedText = '';
const typingTimers = new Map();

const bootSplash = $('#boot-splash');
const authGate = $('#auth-gate');
const appShell = $('.app-shell');
const authMessage = $('#auth-message');

function hideBootSplash() {
  bootSplash?.classList.add('hidden');
}

const MOON_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>';
const SUN_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

function applyChatTheme(theme = getEffectiveChatTheme(state.activeChatId)) {
  const rootStyle = document.documentElement.style;
  const t = theme || {};
  rootStyle.setProperty('--custom-mine-bg', t.mineBg || '');
  rootStyle.setProperty('--custom-mine-text', t.mineText || '');
  rootStyle.setProperty('--custom-theirs-bg', t.theirsBg || '');
  rootStyle.setProperty('--custom-theirs-text', t.theirsText || '');
  rootStyle.setProperty('--custom-chat-bg', t.bgImage ? `url("${t.bgImage}")` : 'none');
  const dim = t.bgImage ? Math.max(0, Math.min(0.75, Number(t.bgDim) || 0)) : 0;
  rootStyle.setProperty('--custom-chat-dim-rgba', `rgba(14, 20, 19, ${dim})`);
  document.body.classList.toggle('has-custom-chat-bg', Boolean(t.bgImage));
  document.body.classList.toggle('has-custom-mine-bubble', Boolean(t.mineBg));
  document.body.classList.toggle('has-custom-theirs-bubble', Boolean(t.theirsBg));
}

function closeChatMoreMenu(fromPop = false) {
  const existing = document.querySelector('.chat-more-backdrop');
  if (!existing) return;
  existing.remove();
  if (!fromPop) popUiLayer();
}

function openChatMoreMenu(anchorEl) {
  const c = getActiveChat();
  if (!c) return;
  if (document.querySelector('.chat-more-backdrop')) {
    closeChatMoreMenu();
    return;
  }

  const wasInputFocused = document.activeElement === $('#message-input');
  const restoreKeyboardIfNeeded = () => {
    if (wasInputFocused && document.activeElement !== $('#message-input')) {
      $('#message-input')?.focus({ preventScroll: true });
    }
  };

  pushUiLayer('chat-menu');
  const backdrop = document.createElement('div');
  backdrop.className = 'chat-more-backdrop';
  backdrop.addEventListener('pointerdown', (e) => e.preventDefault());
  backdrop.addEventListener('mousedown', (e) => e.preventDefault());

  const showBubbleBtn = isNativeAndroid() && !isBubbleWindow();
  const menu = document.createElement('div');
  menu.className = 'chat-more-menu';
  menu.setAttribute('role', 'menu');
  menu.addEventListener('pointerdown', (e) => e.preventDefault());
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.innerHTML = `
    ${showBubbleBtn ? `
      <button type="button" data-chat-more="bubble" role="menuitem">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="17" cy="7" r="3" fill="currentColor"/></svg>
        <span>Pop out bubble</span>
      </button>
    ` : ''}
    <button type="button" data-chat-more="mute" role="menuitem">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${c.muted ? '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>' : '<path d="M8.56 2.9A7 7 0 0 1 19 9v4m-2 4H2a3 3 0 0 0 2-2.8V9a7 7 0 0 1 .78-3.22"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="2" x2="22" y1="2" y2="22"/>'}</svg>
      <span>${c.muted ? 'Unmute notifications' : 'Mute notifications'}</span>
    </button>
    <button type="button" data-chat-more="favorite" role="menuitem">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="${c.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      <span>${c.favorite ? 'Remove favorite' : 'Add to favorites'}</span>
    </button>
    <button type="button" data-chat-more="search" role="menuitem">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <span>Search in chat</span>
    </button>
    <button type="button" data-chat-more="theme" role="menuitem">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
      <span>Chat theme</span>
    </button>
    <button type="button" data-chat-more="nickname" role="menuitem">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      <span>Set nickname</span>
    </button>
    <button type="button" data-chat-more="profile" role="menuitem">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      <span>View profile</span>
    </button>
  `;

  backdrop.append(menu);
  document.body.append(backdrop);

  const anchor = anchorEl?.getBoundingClientRect?.() || { right: window.innerWidth - 12, bottom: 56 };
  const rect = menu.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const top = Math.min(viewBottom - rect.height - 10, Math.max(8, Math.round(anchor.bottom + 6)));
  const left = Math.max(10, Math.min(window.innerWidth - rect.width - 10, Math.round(anchor.right - rect.width)));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeChatMoreMenu();
      document.removeEventListener('keydown', onKey);
      restoreKeyboardIfNeeded();
    }
  };
  document.addEventListener('keydown', onKey);

  let dismissed = false;
  const dismiss = (e) => {
    if (e.target !== backdrop || dismissed) return;
    dismissed = true;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    closeChatMoreMenu();
    document.removeEventListener('keydown', onKey);
    restoreKeyboardIfNeeded();
  };
  backdrop.addEventListener('touchend', dismiss, { passive: false });
  backdrop.addEventListener('click', dismiss);

  menu.querySelectorAll('[data-chat-more]').forEach((btn) => {
    let ran = false;
    const handleAction = async (e) => {
      if (ran) return;
      ran = true;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const action = btn.dataset.chatMore;
      haptic(10);
      closeChatMoreMenu();
      document.removeEventListener('keydown', onKey);

      if (action === 'bubble') {
        const ok = openNativeChatBubble(c);
        showToast(ok ? 'Opening floating chat bubble…' : 'Enable Bubbles for Whisper in Android settings');
        restoreKeyboardIfNeeded();
      } else if (action === 'mute') {
        const nextMuted = !c.muted;
        c.muted = nextMuted;
        updatePeerHeader();
        renderChats();
        pushNativeSession();
        showToast(nextMuted ? `Muted ${getDisplayName(c)}` : `Unmuted ${getDisplayName(c)}`);
        restoreKeyboardIfNeeded();
        try {
          await api.setConversationMuted(c.id, state.user.id, nextMuted);
        } catch (error) {
          c.muted = !nextMuted;
          updatePeerHeader();
          renderChats();
          pushNativeSession();
          showToast(error.message || 'Could not update mute setting');
        }
      } else if (action === 'favorite') {
        const nextFav = !c.favorite;
        c.favorite = nextFav;
        updatePeerHeader();
        renderChats();
        showToast(nextFav ? `Added ${getDisplayName(c)} to favorites` : `Removed ${getDisplayName(c)} from favorites`);
        restoreKeyboardIfNeeded();
        try {
          await api.setConversationFavorite(c.id, state.user.id, nextFav);
        } catch (error) {
          c.favorite = !nextFav;
          updatePeerHeader();
          renderChats();
          showToast(error.message || 'Could not update favorite');
        }
      } else if (action === 'search') {
        openChatSearch();
        $('#chat-search-btn')?.classList.add('is-active');
        if (window.innerWidth <= 700) pushUiLayer('search');
      } else if (action === 'theme') {
        openChatThemeModal(c, () => applyChatTheme());
      } else if (action === 'nickname') {
        openNicknameModal(c, () => {
          updatePeerHeader();
          renderChats();
          renderMessages({ preserveScroll: true });
          pushNativeSession();
        });
      } else if (action === 'profile') {
        openDetailsPanel();
      }
    };
    btn.addEventListener('touchend', handleAction, { passive: false });
    btn.addEventListener('click', handleAction);
  });
}

function openDetailsPanel() {
  const details = $('#details');
  if (!details || !details.classList.contains('hidden')) return;
  details.style.transform = '';
  details.style.transition = '';
  details.classList.remove('hidden');
  if (window.innerWidth <= 1050) {
    $('#details-backdrop')?.classList.remove('hidden');
    details.classList.add('sheet-enter');
    setTimeout(() => details.classList.remove('sheet-enter'), 240);
    pushUiLayer('details');
  }
}

function closeDetailsPanel(fromPop = false) {
  const details = $('#details');
  if (!details || details.classList.contains('hidden')) return;
  details.classList.add('hidden');
  details.classList.remove('sheet-enter');
  details.style.transform = '';
  details.style.transition = '';
  const bd = $('#details-backdrop');
  if (bd) {
    bd.classList.add('hidden');
    bd.style.opacity = '';
  }
  if (!fromPop && window.innerWidth <= 1050) popUiLayer();
}

function setTheme(theme) {
  state.user.theme = theme;
  localStorage.setItem('whisper-theme', theme);
  document.body.classList.toggle('dark', theme === 'dark');
  document.body.classList.toggle('minimal', theme === 'minimal');
  const toggle = $('#theme-toggle');
  if (toggle) toggle.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
  applyChatTheme();
  syncNativeTheme(theme);
}

function authNotice(message, isError = false) {
  if (!authMessage) return;
  authMessage.textContent = message;
  authMessage.classList.toggle('hidden', !message);
  authMessage.classList.toggle('error', isError);
}

function showAuth(mode = 'login') {
  hideBootSplash();
  authMode = mode;
  document.body.classList.remove('authenticated');
  appShell.style.display = 'none';
  authGate.classList.remove('hidden');

  const titles = {
    login: 'Welcome back',
    signup: 'Create your account',
    reset: 'Reset your password',
    recovery: 'Set a new password',
    mfa: 'Two-factor check',
  };
  const descriptions = {
    login: 'Sign in to pick up where your conversations left off.',
    signup: 'A few details, then you can start chatting.',
    reset: resetTab === 'code'
      ? 'Reset instantly using one of your single-use backup codes (no email required).'
      : 'Enter your account email to request a reset link.',
    recovery: 'Choose a new password with at least 8 characters.',
    mfa: 'This account has optional 2FA enabled.',
  };
  const submits = {
    login: 'Sign in',
    signup: 'Create account',
    reset: resetTab === 'code' ? 'Reset password' : 'Send reset link',
    recovery: 'Update password',
    mfa: mfaUseBackup ? 'Unlock with backup code' : 'Verify code',
  };

  $('#auth-title').textContent = titles[mode] || titles.login;
  $('#auth-description').textContent = descriptions[mode] || descriptions.login;

  $('#auth-oauth-wrap')?.classList.toggle('hidden', mode !== 'login' && mode !== 'signup');
  $('#auth-reset-tabs')?.classList.toggle('hidden', mode !== 'reset');
  $('#auth-signup-fields').classList.toggle('hidden', mode !== 'signup');
  $('#auth-email-field')?.classList.toggle('hidden', !(mode === 'login' || mode === 'signup' || (mode === 'reset' && resetTab === 'email')));
  $('#auth-password-field')?.classList.toggle('hidden', !(mode === 'login' || mode === 'signup' || mode === 'recovery'));
  $('#auth-confirm-field')?.classList.toggle('hidden', mode !== 'recovery');
  $('#auth-reset-code-fields')?.classList.toggle('hidden', !(mode === 'reset' && resetTab === 'code'));
  $('#auth-mfa-fields')?.classList.toggle('hidden', mode !== 'mfa');
  $('#auth-forgot')?.classList.toggle('hidden', mode !== 'login');

  if (mode === 'reset') {
    $$('#auth-reset-tabs [data-reset-tab]').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.resetTab === resetTab);
    });
  }

  if (mode === 'mfa') {
    $('#auth-mfa-label').textContent = mfaUseBackup ? 'Single-use backup code' : '6-digit authenticator code';
    $('#auth-mfa-backup-toggle').textContent = mfaUseBackup ? 'Use authenticator app' : 'Use backup code';
    $('#auth-mfa-code').placeholder = mfaUseBackup ? 'XXXX-XXXX' : '123456';
    $('#auth-mfa-code').inputMode = mfaUseBackup ? 'text' : 'numeric';
    $('#auth-mfa-help').textContent = mfaUseBackup
      ? 'Using a backup code will sign you in and disable 2FA until you re-enable it in Settings.'
      : 'Open your authenticator app (Google Authenticator, Authy, 1Password) and enter the current code.';
  }

  const pwLabel = $('label[for="auth-password"]');
  if (pwLabel) pwLabel.textContent = mode === 'recovery' ? 'New password' : 'Password';
  $('#auth-password').autocomplete = mode === 'signup' || mode === 'recovery' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = submits[mode] || submits.login;
  $('#auth-switch').innerHTML = mode === 'login'
    ? 'New to Whisper? <b>Create an account</b>'
    : mode === 'signup'
      ? 'Already have an account? <b>Sign in</b>'
      : mode === 'mfa'
        ? 'Wrong account? <b>Sign out</b>'
        : 'Remembered your password? <b>Back to Sign in</b>';
  authNotice('');
}

function updateUserBadge() {
  const button = $('#profile-open');
  if (!button) return;
  button.querySelector('.profile-name').textContent = state.user.name || state.user.username;
  const avatar = button.querySelector('.avatar');
  if (state.user.avatar) {
    avatar.style.backgroundImage = `url('${state.user.avatar}')`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    avatar.textContent = '';
  } else {
    avatar.style.backgroundImage = '';
    avatar.textContent = initials(state.user.name || state.user.username);
  }
}

async function pushNativeSession(providedSession = null) {
  if (!isNativeApp() || !state.user?.id) return;
  try {
    const sess = providedSession || (await supabase?.auth?.getSession?.())?.data?.session;
    if (!sess?.access_token) return;
    syncNativeSession({
      supabaseUrl: config.supabaseUrl,
      anonKey: config.supabaseAnonKey,
      accessToken: sess.access_token,
      refreshToken: sess.refresh_token || '',
      expiresAt: sess.expires_at || 0,
      userId: state.user.id,
      chats: state.chats.map((c) => ({
        id: c.id,
        peerId: c.peerId || '',
        name: getDisplayName(c),
        avatar: c.avatar || '',
        avatarPath: c.avatarPath || '',
        muted: Boolean(c.muted),
      })),
    });
    pushNativeChatShortcuts(state.chats);
  } catch {
    // Ignore session sync failure
  }
}

function getRealtimeHandlers() {
  return {
    onMessageEvent: handleMessageRealtime,
    onReactionEvent: handleReactionRealtime,
    onAttachmentEvent: handleAttachmentRealtime,
    onMemberEvent: handleMemberRealtime,
    onRequestEvent: handleRequestRealtime,
    onCallInvite: handleCallInviteRealtime,
    onPresenceSync: (onlineIds) => {
      state.onlineUsers = onlineIds;
      renderChats();
      updatePeerHeader();
    },
  };
}

async function resumeSync({ forceChatId = '' } = {}) {
  if (!state.user.id) {
    if (forceChatId) pendingChatId = forceChatId;
    return;
  }
  const now = Date.now();
  if (!forceChatId && !resumePromise && now - lastResumeSyncAt < 1500) return;
  if (resumePromise) {
    await resumePromise;
    if (forceChatId) {
      if (getChat(forceChatId)) await selectChat(forceChatId, { forceSync: true, allowInBubble: true });
      else pendingChatId = forceChatId;
    }
    return;
  }
  lastResumeSyncAt = now;
  resumePromise = (async () => {
    try {
      startRealtime(state.user.id, getRealtimeHandlers());
      if (state.activeChatId) {
        joinConversationTyping(state.activeChatId, state.user.id, handleRemoteTyping);
      }
      await refreshInbox({ preserveActive: true });
      if (forceChatId) {
        closeWorkspacePanel(true);
        closeDetailsPanel(true);
        if (getChat(forceChatId)) await selectChat(forceChatId, { forceSync: true, allowInBubble: true });
        else pendingChatId = forceChatId;
      } else if (state.activeChatId) {
        await syncChatMessages(state.activeChatId);
      }
    } finally {
      resumePromise = null;
    }
  })();
  return resumePromise;
}

async function refreshInbox({ preserveActive = true } = {}) {
  if (!state.user.id) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const existingById = new Map(state.chats.map((c) => [c.id, c]));
      const data = await api.loadInboxSummary(state.user.id);
      state.chats = data.chats.map((c) => {
        const prev = existingById.get(c.id);
        return prev?.loaded
          ? {
              ...c,
              messages: prev.messages,
              hasMore: prev.hasMore,
              loaded: true,
              sharedMedia: prev.sharedMedia,
              unread: c.id === state.activeChatId ? 0 : c.unread,
            }
          : c;
      });
      state.incomingRequests = data.incomingRequests;
      state.outgoingRequests = data.outgoingRequests;

      if (!preserveActive || !getChat(state.activeChatId)) {
        state.activeChatId = null;
      }

      renderChats();
      pushNativeSession();
      refreshRequestsPageIfOpen();
      if (state.activeChatId) {
        updatePeerHeader();
      } else {
        $('#thread').classList.add('hidden');
        $('#empty-state').classList.remove('hidden');
      }
    } catch (error) {
      showToast(error.message || 'Could not refresh conversations');
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function handleMessageRealtime(payload) {
  const row = payload.new;
  if (!row?.conversation_id) return;
  const chat = getChat(row.conversation_id);
  if (!chat) {
    await refreshInbox();
    return;
  }

  const hydratedList = await api.hydrateMessages([row], state.user.id);
  const msg = hydratedList[0];
  if (!msg) return;

  if (payload.eventType === 'INSERT') {
    const isDuplicate = chat.messages.some((m) => m.id === msg.id);
    if (!isDuplicate && msg.from === 'me') {
      const tempIdx = chat.messages.findIndex(
        (m) => m.pending && m.text === msg.text,
      );
      if (tempIdx >= 0) chat.messages.splice(tempIdx, 1);
    }

    if (chat.loaded) upsertMessage(chat.id, msg);
    chat.latestMessage = msg;

    if (msg.file && !msg.file.isViewOnce && (msg.file.type?.startsWith('image/') || msg.file.type?.startsWith('video/'))) {
      chat.sharedMedia = [msg.file, ...(chat.sharedMedia || []).filter((x) => x.id !== msg.file.id)];
    }

    if (msg.from === 'them') {
      const box = $('#messages');
      const nearBottom = state.activeChatId === chat.id && isMessagesNearBottom(box);
      if (state.activeChatId === chat.id && document.visibilityState === 'visible' && nearBottom) {
        chat.unread = 0;
        chat.scrolledUnread = 0;
        api.markConversationRead(chat.id, state.user.id).then((ts) => {
          if (ts) chat.lastReadAt = ts;
        });
      } else if (state.activeChatId === chat.id && document.visibilityState === 'visible') {
        chat.scrolledUnread = (chat.scrolledUnread || 0) + 1;
        chat.unread = 0;
        api.markConversationRead(chat.id, state.user.id).then((ts) => {
          if (ts) chat.lastReadAt = ts;
        });
      } else {
        chat.unread = (chat.unread || 0) + 1;
        if (!chat.muted) {
          playNotificationChime(state.soundEnabled, 'message');
          if (document.visibilityState === 'hidden') {
            const preview = msg.file ? `Sent ${msg.file.name}` : msg.text;
            const peerLabel = getDisplayName(chat);
            const handledNative = sendNativeNotification({
              conversationId: chat.id,
              title: peerLabel,
              body: preview,
              icon: chat.avatar || '',
              tag: `whisper-msg-${chat.id}`,
              messageId: msg.id,
            });
            if (!handledNative && 'Notification' in window && Notification.permission === 'granted') {
              new Notification(peerLabel, {
                body: preview,
                icon: chat.avatar || './icon-192.png',
                tag: `whisper-msg-${chat.id}`,
              });
            }
          }
        }
      }
    }

    renderChats();
    if (state.activeChatId === chat.id) {
      const nearBottom = isMessagesNearBottom($('#messages'));
      renderMessages({
        forceBottom: msg.from === 'me',
        preserveScroll: msg.from !== 'me' && !nearBottom,
      });
      renderSharedMedia();
    }
  } else if (payload.eventType === 'UPDATE') {
    if (chat.loaded) upsertMessage(chat.id, msg);
    if (chat.latestMessage?.id === msg.id) {
      chat.latestMessage = {
        ...msg,
        text: msg.deletedAt ? 'Message deleted' : msg.text,
      };
    }
    renderChats();
    if (state.activeChatId === chat.id) renderMessages({ preserveScroll: true });
  }
}

async function handleReactionRealtime(payload) {
  const row = payload.new || payload.old;
  if (!row?.message_id) return;
  const chat = state.chats.find((c) => c.messages.some((m) => m.id === row.message_id));
  if (!chat) return;
  const msg = chat.messages.find((m) => m.id === row.message_id);
  if (!msg) return;

  const { messages } = await api.loadMessages(chat.id, state.user.id, { limit: Math.max(50, chat.messages.length) });
  const updated = messages.find((m) => m.id === row.message_id);
  if (updated) {
    msg.reactions = updated.reactions;
    if (state.activeChatId === chat.id) renderMessages({ preserveScroll: true });
  }
}

function handleAttachmentRealtime(payload) {
  const row = payload.new;
  if (!row?.id) return;
  const chat = getChat(row.conversation_id);
  if (!chat) return;
  const msg = chat.messages.find((m) => m.file?.id === row.id);
  if (msg?.file) {
    msg.file.downloaded = Boolean(row.downloaded_at);
    if (state.activeChatId === chat.id) renderMessages({ preserveScroll: true });
  }
}

function handleMemberRealtime(payload) {
  const row = payload.new;
  if (!row?.conversation_id) return;
  const chat = getChat(row.conversation_id);
  if (!chat) return;
  if (row.user_id === chat.peerId && row.last_read_at) {
    chat.peerLastReadAt = row.last_read_at;
    if (state.activeChatId === chat.id) renderMessages({ preserveScroll: true });
  }
}

async function handleRequestRealtime(payload) {
  const own = state.user.id;
  if (
    payload.eventType === 'INSERT'
    && payload.new?.receiver_id === own
    && payload.new?.status === 'pending'
  ) {
    showToast('You have a new friend request');
    playNotificationChime(state.soundEnabled, 'message');
    if (document.visibilityState === 'hidden') {
      const handledNative = sendNativeNotification({
        title: 'New friend request',
        body: 'Someone would like to connect on Whisper.',
        tag: 'whisper-request',
      });
      if (!handledNative && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('New friend request', {
          body: 'Someone would like to connect on Whisper.',
          icon: './icon-192.png',
          tag: 'whisper-request',
        });
      }
    }
  }
  await refreshInbox();
}

let incomingCallBannerEl = null;
let incomingCallTimer = 0;

function dismissIncomingCallBanner() {
  stopCallRingtone();
  clearTimeout(incomingCallTimer);
  incomingCallTimer = 0;
  incomingCallBannerEl?.remove();
  incomingCallBannerEl = null;
}

function showIncomingCallBanner(chat) {
  dismissIncomingCallBanner();
  const label = chat ? getDisplayName(chat) : 'A contact';
  const banner = document.createElement('div');
  banner.className = 'incoming-call-banner';
  banner.setAttribute('role', 'alertdialog');
  banner.innerHTML = `
    <div class="incoming-call-pulse" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
    </div>
    <div class="incoming-call-copy">
      <strong>${esc(label)} is calling</strong>
      <small>Tap Open Chat or Dismiss</small>
    </div>
    <div class="incoming-call-actions">
      <button type="button" class="secondary-btn incoming-call-dismiss">Dismiss</button>
      ${chat ? '<button type="button" class="primary-btn incoming-call-open">Open</button>' : ''}
    </div>
  `;
  document.body.append(banner);
  incomingCallBannerEl = banner;

  banner.querySelector('.incoming-call-dismiss')?.addEventListener('click', dismissIncomingCallBanner);
  banner.querySelector('.incoming-call-open')?.addEventListener('click', async () => {
    const cid = chat?.id;
    dismissIncomingCallBanner();
    if (cid) await selectChat(cid, { allowInBubble: true });
  });

  startCallRingtone();
  incomingCallTimer = setTimeout(dismissIncomingCallBanner, 40000);
}

function handleCallInviteRealtime(payload) {
  if (payload.new?.caller_id === state.user.id) return;
  const chat = getChat(payload.new?.conversation_id);
  const label = chat ? getDisplayName(chat) : 'A contact';
  if (document.visibilityState === 'hidden') {
    const handledNative = triggerNativeCallAlarm({
      conversationId: chat?.id || '',
      title: label,
      icon: chat?.avatar || '',
    });
    if (!handledNative && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`${label} is calling`, {
        body: 'Incoming Whisper call alert — tap to open chat.',
        icon: chat?.avatar || './icon-192.png',
        tag: 'whisper-call',
        requireInteraction: true,
      });
    }
  }
  showIncomingCallBanner(chat);
}

function handleRemoteTyping(conversationId, _peerId, isTyping) {
  clearTimeout(typingTimers.get(conversationId));
  if (isTyping) {
    state.typingChats.add(conversationId);
    typingTimers.set(
      conversationId,
      setTimeout(() => {
        state.typingChats.delete(conversationId);
        if (state.activeChatId === conversationId) updateTypingBanner();
      }, 3200),
    );
  } else {
    state.typingChats.delete(conversationId);
  }
  if (state.activeChatId === conversationId) updateTypingBanner();
}

async function enterCloud(user) {
  if (!user?.id || user.id === activeUserId || user.id === enteringUserId) return;
  enteringUserId = user.id;
  try {
    const mfaStatus = await api.getMfaStatus();
    if (mfaStatus.nextLevel === 'aal2' && mfaStatus.currentLevel !== 'aal2' && mfaStatus.totpFactors.length) {
      pendingMfaFactorId = mfaStatus.totpFactors[0].id;
      mfaUseBackup = false;
      showAuth('mfa');
      return;
    }

    const profileData = await api.getProfile(user.id);
    activeUserId = user.id;
    state.user = {
      id: user.id,
      name: profileData.display_name,
      username: profileData.username,
      about: profileData.about || '',
      theme: state.user.theme || 'aero',
      avatar: profileData.avatar || '',
    };
    updateUserBadge();
    hideBootSplash();
    authGate.classList.add('hidden');
    appShell.style.display = 'flex';
    document.body.classList.add('authenticated');
    setTheme(state.user.theme);

    await refreshInbox({ preserveActive: false });
    if (pendingChatId) {
      const targetId = pendingChatId;
      pendingChatId = '';
      if (getChat(targetId)) {
        await selectChat(targetId, { allowInBubble: true });
      }
      if (!isBubbleWindow()) {
        history.replaceState(null, '', window.location.pathname);
      }
    }
    if (!isNativeApp() && 'Notification' in window && Notification.permission === 'granted') {
      api.registerWebPush().catch(() => {});
    }
    pushNativeSession();
    startRealtime(user.id, getRealtimeHandlers());
  } catch (error) {
    activeUserId = null;
    showAuth('login');
    authNotice(error.message || 'Your account profile could not be loaded.', true);
  } finally {
    if (enteringUserId === user.id) enteringUserId = null;
  }
}

async function handleSignOut() {
  try {
    stopRealtime();
    clearNativeSession();
    await api.signOut();
    activeUserId = null;
    resetState();
    closeModal();
    showAuth('login');
  } catch (error) {
    showToast(error.message || 'Sign-out failed');
  }
}

async function handleSendText() {
  const c = getActiveChat();
  const input = $('#message-input');
  const txt = replaceEmojiShortcodes(input?.value.trim() || '');
  const pendingList = [...(state.pendingAttachments || [])];
  if (!c || (!txt && !pendingList.length)) return;

  if (state.editingMessage && !pendingList.length) {
    const targetId = state.editingMessage.id;
    clearComposeContext();
    input.value = '';
    input.style.height = 'auto';
    input.focus({ preventScroll: true });
    try {
      await api.editMessage(targetId, txt);
    } catch (error) {
      showToast(error.message || 'Could not edit message');
    }
    return;
  }

  const replyTo = state.replyingTo;
  clearComposeContext();
  setChatDraft(c.id, '');
  renderChats();
  input.value = '';
  input.style.height = 'auto';
  input.focus({ preventScroll: true });
  sendTypingSignal(c.id, state.user.id, false);

  if (pendingList.length) {
    clearPendingAttachment();
    showToast(
      pendingList.length > 1
        ? `Uploading ${pendingList.length} attachments…`
        : (pendingList[0].isViewOnce ? 'Sending view-once media…' : 'Uploading attachment…'),
    );
    let sentCount = 0;
    let lastBody = '';
    for (let i = 0; i < pendingList.length; i++) {
      const item = pendingList[i];
      const isViewOnce = Boolean(item.isViewOnce);
      try {
        await api.sendAttachment({
          conversationId: c.id,
          file: item.file,
          caption: i === 0 ? txt : '',
          replyToId: i === 0 ? (replyTo?.id || null) : null,
          viewOnce: isViewOnce,
        });
        sentCount++;
        lastBody = isViewOnce ? 'Sent a view-once attachment' : `Sent ${item.file.name}`;
      } catch (error) {
        showToast(error.message || `Could not upload ${item.file.name}`);
      }
    }
    if (sentCount > 0) {
      api.triggerPushNotification({
        conversationId: c.id,
        title: state.user.name || state.user.username,
        body: sentCount > 1 ? `Sent ${sentCount} attachments` : lastBody,
        tag: `whisper-msg-${c.id}`,
      });
    }
    return;
  }

  const tempId = `temp-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const optimistic = {
    id: tempId,
    conversationId: c.id,
    senderId: state.user.id,
    from: 'me',
    text: txt,
    createdAt: nowIso,
    time: formatTime(nowIso),
    replyToId: replyTo?.id || null,
    replyPreview: replyTo ? { id: replyTo.id, senderId: state.user.id, text: replyTo.text } : null,
    reactions: [],
    file: null,
    pending: true,
  };
  upsertMessage(c.id, optimistic);
  renderChats();
  renderMessages();

  try {
    const inserted = await api.sendMessage({
      conversationId: c.id,
      body: txt,
      replyToId: replyTo?.id || null,
    });
    const idx = c.messages.findIndex((m) => m.id === tempId);
    if (idx >= 0) {
      c.messages[idx] = {
        ...c.messages[idx],
        id: inserted.id,
        createdAt: inserted.created_at,
        time: formatTime(inserted.created_at),
        pending: false,
      };
      c.latestMessage = c.messages.at(-1);
      renderChats();
      renderMessages({ preserveScroll: true });
    }
    api.triggerPushNotification({
      conversationId: c.id,
      title: state.user.name || state.user.username,
      body: txt,
      tag: `whisper-msg-${c.id}`,
    });
  } catch (error) {
    c.messages = c.messages.filter((m) => m.id !== tempId);
    renderMessages({ preserveScroll: true });
    showToast(error.message || 'Message could not be sent');
  }
}

function wireEvents() {
  initChatUI({
    onChatSelected: (convId) => {
      applyChatTheme(getEffectiveChatTheme(convId));
      joinConversationTyping(convId, state.user.id, handleRemoteTyping);
      if (pendingSharedText) {
        const input = $('#message-input');
        if (input) {
          input.value = input.value ? `${input.value}\n${pendingSharedText}` : pendingSharedText;
          input.style.height = 'auto';
          input.style.height = `${Math.min(110, input.scrollHeight)}px`;
          setChatDraft(convId, input.value);
        }
        pendingSharedText = '';
      }
    },
    onRefreshInbox: () => refreshInbox(),
  });

  $('#auth-switch').onclick = async () => {
    if (authMode === 'mfa') {
      await api.signOut().catch(() => {});
      pendingMfaFactorId = null;
      mfaUseBackup = false;
      showAuth('login');
      return;
    }
    showAuth(authMode === 'login' ? 'signup' : 'login');
  };
  $('#auth-forgot')?.addEventListener('click', () => {
    resetTab = 'code';
    showAuth('reset');
  });
  $('#auth-google-btn')?.addEventListener('click', async () => {
    authNotice('');
    if (isNativeAndroid() && config.googleWebClientId) {
      if (startNativeGoogleSignIn(config.googleWebClientId)) {
        return;
      }
    }
    try {
      const { error } = await api.signInWithGoogle();
      if (error) throw error;
    } catch (error) {
      authNotice(error.message || 'Google sign-in is not configured yet.', true);
    }
  });

  window.WhisperOnNativeGoogleToken = async (idToken, rawNonce) => {
    try {
      const { error } = await api.signInWithGoogleIdToken(idToken, rawNonce);
      if (error) throw error;
    } catch (error) {
      authNotice(error.message || 'Could not complete Google sign-in.', true);
    }
  };

  window.WhisperOnNativeGoogleError = async (errMsg) => {
    if (errMsg === 'cancelled') return;
    if (errMsg === 'missing_client_id' || /no credentials available/i.test(String(errMsg || ''))) {
      try {
        const { error } = await api.signInWithGoogle();
        if (error) throw error;
      } catch (error) {
        authNotice(error.message || 'Google sign-in failed.', true);
      }
      return;
    }
    authNotice(errMsg || 'Google sign-in failed.', true);
  };
  $$('#auth-reset-tabs [data-reset-tab]').forEach((tab) => {
    tab.onclick = () => {
      resetTab = tab.dataset.resetTab;
      showAuth('reset');
    };
  });
  $('#auth-mfa-backup-toggle')?.addEventListener('click', () => {
    mfaUseBackup = !mfaUseBackup;
    $('#auth-mfa-code').value = '';
    showAuth('mfa');
  });

  let usernameCheckTimer = 0;
  $('#auth-username')?.addEventListener('input', (e) => {
    clearTimeout(usernameCheckTimer);
    const val = e.target.value.trim().replace(/^@/, '').toLowerCase();
    const help = $('#auth-username-help');
    if (!help) return;
    if (!/^[a-z0-9_]{3,24}$/.test(val)) {
      help.textContent = '3–24 letters, numbers, or underscores.';
      help.className = 'field-help';
      return;
    }
    usernameCheckTimer = setTimeout(async () => {
      const ok = await api.checkUsernameAvailable(val);
      help.textContent = ok ? `@${val} is available` : `@${val} is already taken`;
      help.className = `field-help ${ok ? 'help-ok' : 'help-err'}`;
    }, 280);
  });

  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    authNotice('');
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    $('#auth-submit').disabled = true;
    try {
      if (authMode === 'mfa') {
        const code = $('#auth-mfa-code')?.value.trim() || '';
        if (!code) throw new Error('Enter your verification code.');
        if (mfaUseBackup) {
          await api.consume2faBackupCode(code);
          const { data } = await api.refreshSession();
          pendingMfaFactorId = null;
          mfaUseBackup = false;
          $('#auth-mfa-code').value = '';
          showToast('Signed in with backup code. Re-enable 2FA anytime in Settings.');
          await enterCloud(data?.user || (await api.getSession()).data.session?.user);
        } else {
          if (!pendingMfaFactorId) throw new Error('MFA session expired. Sign in again.');
          await api.verifyTotp(pendingMfaFactorId, code);
          const { data } = await api.refreshSession();
          pendingMfaFactorId = null;
          $('#auth-mfa-code').value = '';
          await enterCloud(data?.user || (await api.getSession()).data.session?.user);
        }
      } else if (authMode === 'reset') {
        if (resetTab === 'code') {
          const identifier = $('#auth-reset-identifier')?.value.trim() || '';
          const code = $('#auth-reset-code')?.value.trim() || '';
          const newPassword = $('#auth-reset-new-password')?.value || '';
          if (!identifier) throw new Error('Enter your email address or @username.');
          if (!code) throw new Error('Enter a backup code.');
          if (newPassword.length < 8) throw new Error('Choose a password with at least 8 characters.');
          await api.resetPasswordWithBackupCode({ identifier, code, newPassword });
          $('#auth-reset-code').value = '';
          $('#auth-reset-new-password').value = '';
          showAuth('login');
          authNotice('Password updated! You can sign in with your new password now.');
        } else {
          if (!email) throw new Error('Enter your email address.');
          const { error } = await api.requestPasswordReset(email);
          if (error) throw error;
          authNotice('Password reset link sent. Check your email inbox (and spam folder).');
        }
      } else if (authMode === 'recovery') {
        const confirmPw = $('#auth-password-confirm')?.value || '';
        if (password.length < 8) throw new Error('Choose a password with at least 8 characters.');
        if (password !== confirmPw) throw new Error('Passwords do not match.');
        const { data, error } = await api.updatePassword(password);
        if (error) throw error;
        isRecoveryFlow = false;
        history.replaceState(null, '', window.location.pathname);
        $('#auth-password').value = '';
        if ($('#auth-password-confirm')) $('#auth-password-confirm').value = '';
        showToast('Password updated!');
        if (data?.user) await enterCloud(data.user);
        else showAuth('login');
      } else if (authMode === 'signup') {
        const username = $('#auth-username').value.trim().replace(/^@/, '').toLowerCase();
        const displayName = $('#auth-display-name').value.trim();
        if (!/^[a-z0-9_]{3,24}$/.test(username)) {
          throw new Error('Use 3–24 lowercase letters, numbers, or underscores for your username.');
        }
        if (!displayName) throw new Error('Enter the name you want contacts to see.');
        if (password.length < 8) throw new Error('Choose a password with at least 8 characters.');
        const available = await api.checkUsernameAvailable(username);
        if (!available) throw new Error('That username is already taken.');
        const result = await api.signUp({ email, password, username, displayName });
        if (result.error) throw result.error;
        if (result.data.session) await enterCloud(result.data.user);
        else authNotice('Account created! Check your email to confirm (or disable Confirm Email in Supabase to skip email verification).');
      } else {
        const result = await api.signIn(email, password);
        if (result.error) throw result.error;
        await enterCloud(result.data.user);
      }
    } catch (error) {
      const msg = error.message || 'Sign-in failed. Please try again.';
      const friendly = /rate limit/i.test(msg)
        ? 'Email sending is temporarily rate-limited. Use Google Sign-in, a Backup Code, or turn off "Confirm email" in Supabase Auth settings.'
        : msg;
      authNotice(friendly, true);
    } finally {
      $('#auth-submit').disabled = false;
    }
  };

  async function stageAttachmentFiles(fileList) {
    const c = getActiveChat();
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length || !c) return;
    if (!Array.isArray(state.pendingAttachments)) state.pendingAttachments = [];

    const hasHeic = files.some((f) => isHeicFile(f));
    if (hasHeic) showToast('Converting HEIC photo for preview…');

    let skippedSize = 0;
    let added = 0;
    for (const rawFile of files) {
      if (state.pendingAttachments.length >= 12) {
        showToast('You can queue up to 12 attachments at once');
        break;
      }
      const file = isHeicFile(rawFile) ? await normalizeUploadFile(rawFile) : rawFile;
      if (file.size > 10 * 1024 * 1024) {
        skippedSize++;
        continue;
      }
      const previewUrl = (isImageFile(file) || isVideoFile(file))
        ? URL.createObjectURL(file)
        : '';
      state.pendingAttachments.push({
        id: crypto.randomUUID(),
        file,
        previewUrl,
        isViewOnce: false,
      });
      added++;
    }
    if (skippedSize) {
      showToast(skippedSize === 1 ? 'Skipped a file larger than 10 MB' : `Skipped ${skippedSize} files larger than 10 MB`);
    }
    if (added) {
      renderAttachmentPreview();
      $('#message-input')?.focus({ preventScroll: true });
    }
  }

  function closeAttachMenu(fromPop = false) {
    const existing = document.querySelector('.attach-picker-backdrop');
    if (!existing) return;
    existing.remove();
    if (!fromPop) popUiLayer();
  }

  function openAttachMenu(anchorEl) {
    if (document.querySelector('.attach-picker-backdrop')) {
      closeAttachMenu();
      return;
    }
    if (!getActiveChat()) return;

    const wasFocused = document.activeElement === $('#message-input');
    const restoreFocus = () => {
      if (wasFocused && document.activeElement !== $('#message-input')) {
        $('#message-input')?.focus({ preventScroll: true });
      }
    };

    pushUiLayer('attach');
    const backdrop = document.createElement('div');
    backdrop.className = 'attach-picker-backdrop';
    backdrop.addEventListener('pointerdown', (e) => e.preventDefault());
    backdrop.addEventListener('mousedown', (e) => e.preventDefault());

    const pop = document.createElement('div');
    pop.className = 'attach-picker-pop';
    pop.setAttribute('role', 'menu');
    pop.addEventListener('pointerdown', (e) => e.preventDefault());
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    pop.innerHTML = `
      <button type="button" class="attach-opt-btn" data-attach-kind="camera" role="menuitem">
        <span class="attach-opt-ico camera" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
        </span>
        <span class="attach-opt-label">Camera</span>
      </button>
      <button type="button" class="attach-opt-btn" data-attach-kind="media" role="menuitem">
        <span class="attach-opt-ico media" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
        </span>
        <span class="attach-opt-label">Photos &amp; videos</span>
      </button>
      <button type="button" class="attach-opt-btn" data-attach-kind="files" role="menuitem">
        <span class="attach-opt-ico files" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" x2="16" y1="13" y2="13"/><line x1="8" x2="16" y1="17" y2="17"/></svg>
        </span>
        <span class="attach-opt-label">Files</span>
      </button>
    `;
    backdrop.append(pop);
    document.body.append(backdrop);

    const anchor = anchorEl?.getBoundingClientRect?.() || { left: 16, top: window.innerHeight - 64 };
    const popRect = pop.getBoundingClientRect();
    const top = Math.max(12, Math.round(anchor.top - popRect.height - 10));
    const left = Math.max(10, Math.min(window.innerWidth - popRect.width - 10, Math.round(anchor.left)));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;

    let dismissed = false;
    const dismiss = (e) => {
      if (e.target !== backdrop || dismissed) return;
      dismissed = true;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      closeAttachMenu();
      restoreFocus();
    };
    backdrop.addEventListener('touchend', dismiss, { passive: false });
    backdrop.addEventListener('click', dismiss);

    pop.querySelectorAll('[data-attach-kind]').forEach((btn) => {
      let ran = false;
      const triggerPick = (e) => {
        if (ran) return;
        ran = true;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        const kind = btn.dataset.attachKind;
        haptic(8);
        closeAttachMenu();
        if (kind === 'camera') $('#camera-input')?.click();
        else if (kind === 'media') $('#media-input')?.click();
        else $('#file-input')?.click();
      };
      btn.addEventListener('touchend', triggerPick, { passive: false });
      btn.addEventListener('click', triggerPick);
    });
  }

  let voiceRecorder = null;
  let voiceStream = null;
  let voiceChunks = [];
  let voiceStartAt = 0;
  let voiceTimerId = 0;
  let voiceMime = '';

  function stopVoiceTracks() {
    clearInterval(voiceTimerId);
    voiceTimerId = 0;
    voiceStream?.getTracks?.().forEach((t) => t.stop());
    voiceStream = null;
    $('#voice-recorder')?.classList.add('hidden');
    $('#composer')?.classList.remove('hidden');
  }

  $('#mic-btn')?.addEventListener('pointerdown', (e) => e.preventDefault());
  $('#mic-btn')?.addEventListener('mousedown', (e) => e.preventDefault());
  $('#mic-btn')?.addEventListener('click', async () => {
    const c = getActiveChat();
    if (!c) return;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      showToast('Voice recording is not supported here');
      return;
    }
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showToast('Microphone permission is required for voice messages');
      return;
    }
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    voiceMime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    voiceChunks = [];
    voiceRecorder = voiceMime
      ? new MediaRecorder(voiceStream, { mimeType: voiceMime })
      : new MediaRecorder(voiceStream);
    voiceRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) voiceChunks.push(ev.data);
    };
    voiceStartAt = Date.now();
    $('#voice-timer').textContent = '0:00';
    $('#composer')?.classList.add('hidden');
    $('#voice-recorder')?.classList.remove('hidden');
    haptic(12);
    voiceRecorder.start(250);
    voiceTimerId = setInterval(() => {
      const sec = Math.floor((Date.now() - voiceStartAt) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      $('#voice-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
      if (sec >= 300) $('#voice-send-btn')?.click();
    }, 250);
  });

  $('#voice-cancel-btn')?.addEventListener('click', () => {
    const rec = voiceRecorder;
    voiceRecorder = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => { voiceChunks = []; };
      rec.stop();
    } else {
      voiceChunks = [];
    }
    stopVoiceTracks();
    haptic(8);
  });

  $('#voice-send-btn')?.addEventListener('click', () => {
    const c = getActiveChat();
    const rec = voiceRecorder;
    if (!rec || !c) {
      stopVoiceTracks();
      return;
    }
    voiceRecorder = null;
    const replyTo = state.replyingTo;
    rec.onstop = async () => {
      const chunks = [...voiceChunks];
      voiceChunks = [];
      stopVoiceTracks();
      const rawType = rec.mimeType || voiceMime || 'audio/webm';
      const cleanType = rawType.split(';')[0] || 'audio/webm';
      const blob = new Blob(chunks, { type: cleanType });
      if (blob.size < 1) {
        showToast('Recorded audio was empty');
        return;
      }
      if (blob.size > 10 * 1024 * 1024) {
        showToast('Voice message must be 10 MB or smaller');
        return;
      }
      const ext = cleanType.includes('mp4') ? 'm4a' : cleanType.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([blob], `voice-message-${Date.now()}.${ext}`, { type: cleanType });
      clearComposeContext();
      showToast('Sending voice message…');
      try {
        await api.sendAttachment({
          conversationId: c.id,
          file,
          caption: '',
          replyToId: replyTo?.id || null,
          viewOnce: false,
        });
        api.triggerPushNotification({
          conversationId: c.id,
          title: state.user.name || state.user.username,
          body: 'Sent a voice message',
          tag: `whisper-msg-${c.id}`,
        });
      } catch (error) {
        showToast(error.message || 'Could not send voice message');
      }
    };
    if (rec.state !== 'inactive') {
      rec.stop();
    } else {
      stopVoiceTracks();
    }
  });

  const sendBtn = $('.send-btn');
  sendBtn?.addEventListener('pointerdown', (e) => e.preventDefault());
  sendBtn?.addEventListener('mousedown', (e) => e.preventDefault());

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    handleSendText();
  });

  $('#message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
    } else if (e.key === 'Escape' && (state.replyingTo || state.editingMessage)) {
      clearComposeContext();
    }
  });

  $('#message-input').addEventListener('input', (e) => {
    const el = e.target;
    if (el.value.includes(':')) {
      const caret = el.selectionStart ?? el.value.length;
      const before = el.value.slice(0, caret);
      const after = el.value.slice(caret);
      const replacedBefore = replaceEmojiShortcodes(before);
      if (replacedBefore !== before) {
        el.value = replacedBefore + after;
        el.setSelectionRange(replacedBefore.length, replacedBefore.length);
      }
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(110, el.scrollHeight)}px`;
    const c = getActiveChat();
    if (c) {
      setChatDraft(c.id, el.value);
      if (el.value.trim()) sendTypingSignal(c.id, state.user.id, true);
    }
  });

  $('#message-input').addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    const list = files.length ? files : [...(e.clipboardData?.files || [])];
    if (!list.length) return;
    e.preventDefault();
    const normalized = list.map((rawFile, idx) => {
      const ext = (rawFile.type?.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      return rawFile.name && rawFile.name !== 'image.png'
        ? rawFile
        : new File([rawFile], `pasted-${Date.now()}-${idx}.${ext}`, { type: rawFile.type || 'image/png' });
    });
    stageAttachmentFiles(normalized);
  });

  const attachBtn = $('#attach-btn');
  if (attachBtn) {
    let lastAttachTap = 0;
    const toggleAttach = (e) => {
      const now = Date.now();
      if (e.type === 'touchend') {
        if (e.cancelable) e.preventDefault();
        lastAttachTap = now;
      } else if (now - lastAttachTap < 450) {
        return;
      }
      e.stopPropagation();
      openAttachMenu(attachBtn);
    };
    attachBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    attachBtn.addEventListener('mousedown', (e) => e.preventDefault());
    attachBtn.addEventListener('touchend', toggleAttach, { passive: false });
    attachBtn.addEventListener('click', toggleAttach);
  }

  $('#camera-input')?.addEventListener('change', (event) => {
    if (event.target.files?.length) stageAttachmentFiles(event.target.files);
    event.target.value = '';
  });
  $('#media-input')?.addEventListener('change', (event) => {
    if (event.target.files?.length) stageAttachmentFiles(event.target.files);
    event.target.value = '';
  });
  $('#file-input').onchange = (event) => {
    if (event.target.files?.length) stageAttachmentFiles(event.target.files);
    event.target.value = '';
  };

  const emojiBtn = $('#emoji-btn');
  const emojiTray = $('#emoji-tray');
  const emojiGrid = $('#emoji-grid');
  const emojiSearch = $('#emoji-search-input');
  const EMOJI_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>';
  const KEYBOARD_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h8"/></svg>';

  const insertEmojiAtCursor = (emoji) => {
    const input = $('#message-input');
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    const nextPos = start + emoji.length;
    input.setSelectionRange(nextPos, nextPos);
    input.style.height = 'auto';
    input.style.height = `${Math.min(110, input.scrollHeight)}px`;
    if (window.innerWidth > 700) {
      input.focus({ preventScroll: true });
    }
  };

  const renderEmojiGrid = (term = '') => {
    if (!emojiGrid) return;
    const items = searchEmojis(term);
    emojiGrid.innerHTML = items.length
      ? items
          .map((item) => `<button type="button" class="emoji-cell" title=":${esc(item.name)}:" data-emoji-pick="${esc(item.emoji)}">${item.emoji}</button>`)
          .join('')
      : '<div class="people-empty" style="grid-column:1/-1">No matching emojis</div>';

    emojiGrid.querySelectorAll('[data-emoji-pick]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.preventDefault());
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.onclick = () => insertEmojiAtCursor(btn.dataset.emojiPick);
    });
  };

  const isEmojiTrayOpen = () => Boolean(emojiTray && !emojiTray.classList.contains('hidden'));

  const closeEmojiTray = (fromPop = false) => {
    if (!emojiTray || emojiTray.classList.contains('hidden')) return;
    emojiTray.classList.add('hidden');
    if (emojiBtn) emojiBtn.innerHTML = EMOJI_ICON;
    if (!fromPop && window.innerWidth <= 700) popUiLayer();
  };

  const openEmojiTray = () => {
    if (!emojiTray) return;
    if (window.innerWidth <= 700) {
      $('#message-input')?.blur();
      $('#emoji-search-input')?.blur();
      if (emojiTray.classList.contains('hidden')) pushUiLayer('emoji');
    }
    if (emojiSearch) emojiSearch.value = '';
    renderEmojiGrid('');
    emojiTray.classList.remove('hidden');
    if (emojiBtn && window.innerWidth <= 700) emojiBtn.innerHTML = KEYBOARD_ICON;
    const box = $('#messages');
    if (box) box.scrollTop = box.scrollHeight;
  };

  emojiBtn?.addEventListener('pointerdown', (e) => e.preventDefault());
  emojiBtn?.addEventListener('mousedown', (e) => e.preventDefault());
  emojiBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isEmojiTrayOpen()) {
      closeEmojiTray();
      $('#message-input')?.focus({ preventScroll: true });
    } else {
      openEmojiTray();
    }
  });

  emojiSearch?.addEventListener('input', (e) => renderEmojiGrid(e.target.value));

  // On mobile, close the emoji tray synchronously before the phone keyboard rises
  const dismissTrayOnInputTap = () => {
    if (window.innerWidth <= 700 && isEmojiTrayOpen()) {
      closeEmojiTray();
    }
  };
  $('#message-input')?.addEventListener('pointerdown', dismissTrayOnInputTap);
  $('#message-input')?.addEventListener('touchstart', dismissTrayOnInputTap, { passive: true });
  $('#message-input')?.addEventListener('focus', dismissTrayOnInputTap);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isEmojiTrayOpen()) {
      closeEmojiTray();
      $('#message-input')?.focus({ preventScroll: true });
    }
  });

  document.addEventListener('click', (e) => {
    if (
      window.innerWidth > 700
      && isEmojiTrayOpen()
      && !e.target.closest('#emoji-tray')
      && !e.target.closest('#emoji-btn')
    ) {
      closeEmojiTray();
    }
  });

  // Keep mobile open conversation & chat header pinned inside visualViewport when keyboard opens
  if (window.visualViewport) {
    const syncViewport = () => {
      const conv = $('#conversation');
      if (!conv) return;
      if (window.innerWidth <= 700 && conv.classList.contains('mobile-open')) {
        const vv = window.visualViewport;
        conv.style.height = `${Math.round(vv.height)}px`;
        conv.style.top = `${Math.round(vv.offsetTop)}px`;
        conv.style.bottom = 'auto';
        const box = $('#messages');
        if (box && isMessagesNearBottom(box, 160)) {
          box.scrollTop = box.scrollHeight;
        }
        updateScrollBottomBtn();
      } else {
        conv.style.height = '';
        conv.style.top = '';
        conv.style.bottom = '';
      }
    };
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
  }

  $('#new-chat').onclick = $('#empty-add').onclick = () => openPeoplePage(() => refreshInbox());
  $('#contacts-tab').onclick = () => {
    if (getActiveWorkspacePanel() === 'people') closeWorkspacePanel();
    else openPeoplePage(() => refreshInbox());
  };
  $('#requests-tab').onclick = () => {
    if (getActiveWorkspacePanel() === 'requests') closeWorkspacePanel();
    else openRequestsPage('incoming', () => refreshInbox());
  };
  $('#profile-open').onclick = () => openProfileModal(updateUserBadge);
  $('#chats-tab').onclick = () => closeWorkspacePanel();
  $('#settings-open').onclick = () => {
    if (getActiveWorkspacePanel() === 'settings') {
      closeWorkspacePanel();
    } else {
      openSettingsPage({
        onThemeChange: setTheme,
        onChatThemeChange: () => applyChatTheme(),
        onSignOut: handleSignOut,
      });
    }
  };
  $('#theme-toggle').onclick = () => setTheme(state.user.theme === 'dark' ? 'aero' : 'dark');

  $('#peer-avatar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = getActiveChat();
    if (c) openAvatarLightbox(c);
  });
  const peerMeta = $('.peer-meta');
  if (peerMeta) {
    peerMeta.addEventListener('pointerdown', (e) => e.preventDefault());
    peerMeta.addEventListener('mousedown', (e) => e.preventDefault());
    peerMeta.addEventListener('click', () => {
      if ($('#details').classList.contains('hidden')) openDetailsPanel();
      else closeDetailsPanel();
    });
  }
  $('#details-avatar')?.addEventListener('click', () => {
    const c = getActiveChat();
    if (c) openAvatarLightbox(c);
  });

  const leaveMobileConversation = () => {
    const prevId = state.activeChatId;
    if (prevId) setChatDraft(prevId, $('#message-input')?.value || '');
    pendingChatId = '';
    $('#conversation')?.classList.remove('mobile-open');
    if (window.innerWidth <= 700 || isBubbleWindow()) {
      state.activeChatId = null;
      applyChatTheme();
      renderChats();
    }
  };

  $('#messages')?.addEventListener('scroll', () => {
    const c = getActiveChat();
    const box = $('#messages');
    if (c && box && isMessagesNearBottom(box, 65)) {
      c.scrolledUnread = 0;
    }
    updateScrollBottomBtn();
  }, { passive: true });

  $('#scroll-bottom-btn')?.addEventListener('pointerdown', (e) => e.preventDefault());
  $('#scroll-bottom-btn')?.addEventListener('mousedown', (e) => e.preventDefault());
  $('#scroll-bottom-btn')?.addEventListener('click', () => {
    const box = $('#messages');
    const c = getActiveChat();
    if (c) c.scrolledUnread = 0;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    updateScrollBottomBtn();
  });

  $('#details-nickname-btn')?.addEventListener('click', () => {
    const c = getActiveChat();
    if (!c) return;
    openNicknameModal(c, () => {
      updatePeerHeader();
      renderChats();
      renderMessages({ preserveScroll: true });
      pushNativeSession();
    });
  });

  $('#back-btn').onclick = () => {
    let popCount = 0;
    if (document.querySelector('.chat-more-backdrop')) {
      closeChatMoreMenu(true);
      popCount++;
    }
    if (isEmojiTrayOpen()) {
      closeEmojiTray(true);
      if (window.innerWidth <= 700) popCount++;
    }
    if (!$('#details').classList.contains('hidden')) {
      closeDetailsPanel(true);
      if (window.innerWidth <= 1050) popCount++;
    }
    if (state.chatSearch.open) {
      closeChatSearch();
      $('#chat-search-btn')?.classList.remove('is-active');
      if (window.innerWidth <= 700) popCount++;
    }
    if ($('#conversation').classList.contains('mobile-open')) {
      leaveMobileConversation();
      if (window.innerWidth <= 700) popCount++;
    }
    if (popCount > 0) popUiLayer(popCount);
  };
  $('#details-close').onclick = () => closeDetailsPanel();
  $('#details-backdrop')?.addEventListener('click', () => closeDetailsPanel());

  const moreBtn = $('#more-btn');
  if (moreBtn) {
    let lastMoreAt = 0;
    const toggleMore = (e) => {
      const now = Date.now();
      if (e.type === 'touchend') {
        if (e.cancelable) e.preventDefault();
        lastMoreAt = now;
      } else if (now - lastMoreAt < 450) {
        return;
      }
      e.stopPropagation();
      openChatMoreMenu(moreBtn);
    };
    moreBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    moreBtn.addEventListener('mousedown', (e) => e.preventDefault());
    moreBtn.addEventListener('touchend', toggleMore, { passive: false });
    moreBtn.addEventListener('click', toggleMore);
  }

  // Swipe down to collapse bottom profile sheet smoothly without teleporting
  const detailsDrawer = $('#details');
  if (detailsDrawer) {
    let dStartX = 0;
    let dStartY = 0;
    let dDragOriginY = 0;
    let dDragStartAt = 0;
    let dDragging = false;
    let dDelta = 0;

    detailsDrawer.addEventListener('touchstart', (e) => {
      if (window.innerWidth > 1050 || detailsDrawer.classList.contains('hidden') || e.touches.length !== 1) return;
      dStartX = e.touches[0].clientX;
      dStartY = e.touches[0].clientY;
      dDragOriginY = dStartY;
      dDragStartAt = Date.now();
      dDragging = false;
      dDelta = 0;
      detailsDrawer.classList.remove('sheet-enter');
      detailsDrawer.style.transition = 'none';
    }, { passive: true });

    detailsDrawer.addEventListener('touchmove', (e) => {
      if (window.innerWidth > 1050 || detailsDrawer.classList.contains('hidden') || e.touches.length !== 1) return;
      const curX = e.touches[0].clientX;
      const curY = e.touches[0].clientY;
      const dx = curX - dStartX;
      const dy = curY - dStartY;
      if (!dDragging && detailsDrawer.scrollTop <= 0 && dy > 10 && dy > Math.abs(dx) * 1.25) {
        dDragging = true;
        dDragOriginY = curY;
        dDragStartAt = Date.now();
      }
      if (dDragging) {
        if (e.cancelable) e.preventDefault();
        dDelta = Math.max(0, curY - dDragOriginY);
        detailsDrawer.style.transform = `translateY(${dDelta}px)`;
        const bd = $('#details-backdrop');
        if (bd) {
          const h = Math.max(260, detailsDrawer.offsetHeight || 420);
          bd.style.opacity = String(Math.max(0, 1 - dDelta / h));
        }
      }
    }, { passive: false });

    const endDrawerDrag = () => {
      if (!dDragging) {
        detailsDrawer.style.transition = '';
        return;
      }
      dDragging = false;
      const elapsed = Math.max(16, Date.now() - dDragStartAt);
      const velocity = dDelta / elapsed;
      if (dDelta > 110 || (dDelta > 56 && velocity > 0.65)) {
        detailsDrawer.style.transition = 'transform 0.16s ease-out';
        detailsDrawer.style.transform = 'translateY(100%)';
        setTimeout(() => closeDetailsPanel(), 150);
      } else {
        detailsDrawer.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
        detailsDrawer.style.transform = '';
        const bd = $('#details-backdrop');
        if (bd) bd.style.opacity = '';
      }
    };
    detailsDrawer.addEventListener('touchend', endDrawerDrag, { passive: true });
    detailsDrawer.addEventListener('touchcancel', endDrawerDrag, { passive: true });
  }

  $('#favorite-btn').onclick = async () => {
    const c = getActiveChat();
    if (!c) return;
    const next = !c.favorite;
    c.favorite = next;
    updatePeerHeader();
    renderChats();
    try {
      await api.setConversationFavorite(c.id, state.user.id, next);
    } catch (error) {
      c.favorite = !next;
      updatePeerHeader();
      renderChats();
      showToast(error.message || 'Could not update favorite');
    }
  };

  $('#unfriend-btn')?.addEventListener('click', async () => {
    const c = getActiveChat();
    if (!c) return;
    try {
      await api.removeFriend(c.peerId);
      showToast(`Removed ${c.name} from friends`);
      $('#details').classList.add('hidden');
      await refreshInbox({ preserveActive: false });
    } catch (error) {
      showToast(error.message || 'Could not remove friend');
    }
  });

  $('#block-btn')?.addEventListener('click', async () => {
    const c = getActiveChat();
    if (!c) return;
    try {
      await api.blockUser(c.peerId);
      showToast(`Blocked ${c.name}`);
      $('#details').classList.add('hidden');
      await refreshInbox({ preserveActive: false });
    } catch (error) {
      showToast(error.message || 'Could not block user');
    }
  });

  $('#call-btn').onclick = async () => {
    const c = getActiveChat();
    if (!c) return;
    try {
      await api.createCallInvite(c.id);
      api.triggerPushNotification({
        conversationId: c.id,
        title: state.user.name || state.user.username,
        body: `${state.user.name || state.user.username} is calling on Whisper`,
        tag: `whisper-call-${c.id}`,
        kind: 'call',
      });
      showToast(`Ringing ${getDisplayName(c)}…`);
    } catch (error) {
      showToast(error.message || 'Call notification could not be sent');
    }
  };

  const searchBtn = $('#chat-search-btn');
  if (searchBtn) {
    searchBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    searchBtn.addEventListener('mousedown', (e) => e.preventDefault());
    searchBtn.onclick = () => {
      if (state.chatSearch.open) {
        closeChatSearch();
        searchBtn.classList.remove('is-active');
        if (window.innerWidth <= 700) popUiLayer();
      } else {
        openChatSearch();
        searchBtn.classList.add('is-active');
        if (window.innerWidth <= 700) pushUiLayer('search');
      }
      searchBtn.blur();
    };
  }
  $('#chat-search-input')?.addEventListener('input', (e) => runChatSearch(e.target.value));
  $('#chat-search-prev')?.addEventListener('click', () => stepChatSearch(-1));
  $('#chat-search-next')?.addEventListener('click', () => stepChatSearch(1));
  $('#chat-search-close')?.addEventListener('click', () => {
    if (state.chatSearch.open) {
      closeChatSearch();
      $('#chat-search-btn')?.classList.remove('is-active');
      if (window.innerWidth <= 700) popUiLayer();
    }
  });

  const sidebarSearchToggle = $('#sidebar-search-toggle');
  const sidebarSearchBox = $('#sidebar-searchbox');
  if (sidebarSearchToggle && sidebarSearchBox) {
    sidebarSearchToggle.onclick = () => {
      const opening = sidebarSearchBox.classList.contains('hidden');
      sidebarSearchBox.classList.toggle('hidden', !opening);
      sidebarSearchToggle.classList.toggle('is-active', opening);
      sidebarSearchToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) {
        $('#search')?.focus();
      } else {
        if ($('#search')) $('#search').value = '';
        if (state.query) {
          state.query = '';
          renderChats();
        }
        sidebarSearchToggle.blur();
      }
    };
  }

  $('#search').oninput = (e) => {
    state.query = e.target.value;
    renderChats();
  };

  $$('.filter').forEach((btn) => {
    btn.onclick = () => {
      $$('.filter').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderChats();
    };
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target === $('#modal')) closeModal();
  });

  $('#modal').addEventListener('close', () => {
    if (closingModalFromPop) {
      closingModalFromPop = false;
      return;
    }
    popUiLayer();
  });

  window.addEventListener('popstate', () => {
    if (!consumePopLayer()) return;
    if (document.querySelector('dialog.avatar-lightbox-dialog[open]')) {
      closeAvatarLightbox(true);
      return;
    }
    if (document.querySelector('.attach-picker-backdrop')) {
      document.querySelector('.attach-picker-backdrop')?.remove();
      return;
    }
    if (document.querySelector('.chat-more-backdrop')) {
      closeChatMoreMenu(true);
      return;
    }
    if (document.querySelector('.msg-context-backdrop')) {
      closeMessageMenu(true);
      return;
    }
    if ($('#modal')?.open) {
      closingModalFromPop = true;
      closeModal();
      return;
    }
    if (getActiveWorkspacePanel()) {
      closeWorkspacePanel(true);
      return;
    }
    if (!$('#details').classList.contains('hidden') && window.innerWidth <= 1050) {
      closeDetailsPanel(true);
      return;
    }
    if (isEmojiTrayOpen()) {
      closeEmojiTray(true);
      return;
    }
    if (state.chatSearch.open) {
      closeChatSearch();
      $('#chat-search-btn')?.classList.remove('is-active');
      return;
    }
    if ($('#conversation').classList.contains('mobile-open')) {
      leaveMobileConversation();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const chatId = event.data?.type === 'OPEN_CHAT' ? event.data.conversationId : '';
      if (!chatId) return;
      resumeSync({ forceChatId: chatId });
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeSync();
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted || document.visibilityState === 'visible') {
      resumeSync();
    }
  });

  window.addEventListener('online', () => {
    resumeSync();
  });

  window.WhisperOnNativeResume = () => resumeSync();
  window.WhisperOnNativeState = (nextState) => {
    window.__WHISPER_WINDOWS_STATE__ = nextState || null;
    window.WhisperOnNativeCapsChanged?.();
  };
  window.WhisperOpenChat = (chatId) => {
    if (chatId) resumeSync({ forceChatId: String(chatId) });
  };
  window.WhisperReceiveSharedText = (text) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (getActiveChat()) {
      const input = $('#message-input');
      if (input) {
        input.value = input.value ? `${input.value}\n${clean}` : clean;
        input.style.height = 'auto';
        input.style.height = `${Math.min(110, input.scrollHeight)}px`;
        input.focus({ preventScroll: true });
      }
    } else {
      pendingSharedText = clean;
      showToast('Pick a chat to share text');
    }
  };
  window.WhisperHandleNativeBack = () => {
    if (document.querySelector('dialog.avatar-lightbox-dialog[open]')) {
      closeAvatarLightbox();
      return true;
    }
    if (document.querySelector('.attach-picker-backdrop')) {
      document.querySelector('.attach-picker-backdrop')?.remove();
      popUiLayer();
      return true;
    }
    if (document.querySelector('.chat-more-backdrop')) {
      closeChatMoreMenu();
      return true;
    }
    if (document.querySelector('.msg-context-backdrop')) {
      closeMessageMenu();
      return true;
    }
    if ($('#modal')?.open) {
      closeModal();
      return true;
    }
    if (getActiveWorkspacePanel()) {
      closeWorkspacePanel();
      return true;
    }
    if (!$('#details').classList.contains('hidden') && window.innerWidth <= 1050) {
      closeDetailsPanel();
      return true;
    }
    if (isEmojiTrayOpen()) {
      closeEmojiTray();
      return true;
    }
    if (state.chatSearch.open) {
      closeChatSearch();
      $('#chat-search-btn')?.classList.remove('is-active');
      if (window.innerWidth <= 700) popUiLayer();
      return true;
    }
    if ($('#conversation').classList.contains('mobile-open')) {
      leaveMobileConversation();
      popUiLayer();
      return true;
    }
    return false;
  };
}

async function bootstrap() {
  if (isNativeAndroid()) {
    document.body.classList.add('native-android');
  }
  if (isBubbleWindow()) {
    document.body.classList.add('bubble-mode');
  }
  setTheme(state.user.theme || 'aero');
  applyChatTheme();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  wireEvents();

  if (!configured) {
    showAuth('login');
    authNotice('Supabase configuration is missing in app-config.js.', true);
    return;
  }

  appShell.style.display = 'none';
  authGate.classList.add('hidden');

  api.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      isRecoveryFlow = true;
      showAuth('recovery');
    } else if (event === 'SIGNED_OUT') {
      stopRealtime();
      clearNativeSession();
      activeUserId = null;
      enteringUserId = null;
      isRecoveryFlow = false;
      resetState();
      showAuth('login');
    } else if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user) {
      if (isRecoveryFlow) {
        showAuth('recovery');
      } else {
        enterCloud(session.user);
        pushNativeSession(session);
      }
    }
  });

  try {
    const { data, error } = await api.getSession();
    if (error) throw error;
    let activeUser = data?.session?.user || null;
    if (!activeUser && isNativeAndroid()) {
      const stored = getNativeStoredSession();
      if (stored?.accessToken && stored?.refreshToken) {
        const restored = await api.setSessionTokens(stored.accessToken, stored.refreshToken).catch(() => null);
        activeUser = restored?.data?.session?.user || restored?.data?.user || null;
      }
    }
    if (isRecoveryFlow) {
      showAuth('recovery');
    } else if (activeUser) {
      await enterCloud(activeUser);
    } else {
      showAuth('login');
    }
  } catch (error) {
    showAuth('login');
    authNotice(error.message || 'Could not connect to the account service.', true);
  }
}

bootstrap();
