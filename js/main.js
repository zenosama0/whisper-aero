import { configured } from './config.js';
import * as api from './api.js';
import { replaceEmojiShortcodes, searchEmojis } from './emoji.js?v=19';
import { joinConversationTyping, sendTypingSignal, startRealtime, stopRealtime } from './realtime.js';
import { getActiveChat, getChat, resetState, state, upsertMessage } from './state.js';
import {
  clearComposeContext,
  clearPendingAttachment,
  closeChatSearch,
  closeMessageMenu,
  initChatUI,
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
  updateTypingBanner,
} from './ui/chat.js';
import {
  openFindPeopleModal,
  openProfileModal,
  openSettingsModal,
  renderRequestsModal,
} from './ui/modals.js';
import {
  $,
  $$,
  closeModal,
  consumePopLayer,
  esc,
  formatTime,
  initials,
  playNotificationChime,
  popUiLayer,
  pushUiLayer,
  showToast,
} from './utils.js';

let authMode = 'login';
let resetTab = 'code';
let mfaUseBackup = false;
let pendingMfaFactorId = null;
let pendingChatId = new URLSearchParams(window.location.search).get('chat') || '';
let closingModalFromPop = false;
let isRecoveryFlow = window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery');
let activeUserId = null;
let refreshPromise = null;
let resumePromise = null;
let lastResumeSyncAt = 0;
const typingTimers = new Map();

const authGate = $('#auth-gate');
const appShell = $('.app-shell');
const authMessage = $('#auth-message');

const MOON_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>';
const SUN_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

function setTheme(theme) {
  state.user.theme = theme;
  localStorage.setItem('whisper-theme', theme);
  document.body.classList.toggle('dark', theme === 'dark');
  document.body.classList.toggle('minimal', theme === 'minimal');
  const toggle = $('#theme-toggle');
  if (toggle) toggle.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
}

function authNotice(message, isError = false) {
  if (!authMessage) return;
  authMessage.textContent = message;
  authMessage.classList.toggle('hidden', !message);
  authMessage.classList.toggle('error', isError);
}

function showAuth(mode = 'login') {
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
      if (getChat(forceChatId)) await selectChat(forceChatId, { forceSync: true });
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
        if (getChat(forceChatId)) await selectChat(forceChatId, { forceSync: true });
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
      if (state.activeChatId === chat.id && document.visibilityState === 'visible') {
        chat.unread = 0;
        api.markConversationRead(chat.id, state.user.id).then((ts) => {
          if (ts) chat.lastReadAt = ts;
        });
      } else {
        chat.unread = (chat.unread || 0) + 1;
        playNotificationChime(state.soundEnabled, 'message');
        if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(chat.name, {
            body: msg.file ? `Sent ${msg.file.name}` : msg.text,
            icon: './icon.svg',
            tag: `whisper-msg-${chat.id}`,
          });
        }
      }
    }

    renderChats();
    if (state.activeChatId === chat.id) {
      renderMessages();
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
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('New friend request', {
        body: 'Someone would like to connect on Whisper.',
        icon: './icon.svg',
        tag: 'whisper-request',
      });
    }
  }
  await refreshInbox();
}

function handleCallInviteRealtime(payload) {
  if (payload.new?.caller_id === state.user.id) return;
  const chat = getChat(payload.new?.conversation_id);
  showToast(`${chat?.name || 'Your contact'} is calling`);
  playNotificationChime(state.soundEnabled, 'call');
  if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Incoming call notification', {
      body: `${chat?.name || 'A contact'} is trying to reach you.`,
      icon: './icon.svg',
      tag: 'whisper-call',
    });
  }
  if (navigator.vibrate) navigator.vibrate([180, 80, 180]);
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
  if (!user?.id || user.id === activeUserId) return;
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
    authGate.classList.add('hidden');
    appShell.style.display = 'flex';
    document.body.classList.add('authenticated');
    setTheme(state.user.theme);

    await refreshInbox({ preserveActive: false });
    if (pendingChatId) {
      const targetId = pendingChatId;
      pendingChatId = '';
      if (getChat(targetId)) {
        await selectChat(targetId);
      }
      history.replaceState(null, '', window.location.pathname);
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      api.registerWebPush().catch(() => {});
    }
    startRealtime(user.id, getRealtimeHandlers());
  } catch (error) {
    activeUserId = null;
    showAuth('login');
    authNotice(error.message || 'Your account profile could not be loaded.', true);
  }
}

async function handleSignOut() {
  try {
    stopRealtime();
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
  const pending = state.pendingAttachment;
  if (!c || (!txt && !pending)) return;

  if (state.editingMessage && !pending) {
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
  input.value = '';
  input.style.height = 'auto';
  input.focus({ preventScroll: true });
  sendTypingSignal(c.id, state.user.id, false);

  if (pending?.file) {
    const fileToSend = pending.file;
    const isViewOnce = Boolean(pending.isViewOnce);
    clearPendingAttachment();
    showToast(isViewOnce ? 'Sending view-once media…' : 'Uploading attachment…');
    try {
      await api.sendAttachment({
        conversationId: c.id,
        file: fileToSend,
        caption: txt,
        replyToId: replyTo?.id || null,
        viewOnce: isViewOnce,
      });
      api.triggerPushNotification({
        conversationId: c.id,
        title: state.user.name || state.user.username,
        body: isViewOnce ? 'Sent a view-once attachment' : `Sent ${fileToSend.name}`,
        tag: `whisper-msg-${c.id}`,
      });
    } catch (error) {
      showToast(error.message || 'Could not upload attachment');
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
      joinConversationTyping(convId, state.user.id, handleRemoteTyping);
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
    try {
      const { error } = await api.signInWithGoogle();
      if (error) throw error;
    } catch (error) {
      authNotice(error.message || 'Google sign-in is not configured yet.', true);
    }
  });
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

  function stageAttachmentFile(file) {
    const c = getActiveChat();
    if (!file || !c) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('Attachments must be 10 MB or smaller');
      return;
    }
    if (state.pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(state.pendingAttachment.previewUrl);
    }
    const previewUrl = (file.type?.startsWith('image/') || file.type?.startsWith('video/'))
      ? URL.createObjectURL(file)
      : '';
    state.pendingAttachment = { file, previewUrl, isViewOnce: false };
    renderAttachmentPreview();
    $('#message-input')?.focus({ preventScroll: true });
  }

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
    if (c && el.value.trim()) sendTypingSignal(c.id, state.user.id, true);
  });

  $('#message-input').addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const fileItem = items.find((it) => it.kind === 'file');
    const rawFile = fileItem?.getAsFile() || e.clipboardData?.files?.[0];
    if (!rawFile) return;
    e.preventDefault();
    const ext = (rawFile.type?.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const file = rawFile.name && rawFile.name !== 'image.png'
      ? rawFile
      : new File([rawFile], `pasted-${Date.now()}.${ext}`, { type: rawFile.type || 'image/png' });
    stageAttachmentFile(file);
  });

  $('#attach-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (event) => {
    const file = event.target.files[0];
    if (file) stageAttachmentFile(file);
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
        if (box) box.scrollTop = box.scrollHeight;
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

  $('#new-chat').onclick = $('#empty-add').onclick = $('#contacts-tab').onclick = () =>
    openFindPeopleModal(() => refreshInbox());
  $('#requests-tab').onclick = () => renderRequestsModal('incoming', () => refreshInbox());
  $('#profile-open').onclick = () => openProfileModal(updateUserBadge);
  $('#settings-open').onclick = () =>
    openSettingsModal({ onThemeChange: setTheme, onSignOut: handleSignOut });
  $('#theme-toggle').onclick = () => setTheme(state.user.theme === 'dark' ? 'aero' : 'dark');

  $('#back-btn').onclick = () => {
    let popCount = 0;
    if (isEmojiTrayOpen()) {
      closeEmojiTray(true);
      if (window.innerWidth <= 700) popCount++;
    }
    if (!$('#details').classList.contains('hidden')) {
      $('#details').classList.add('hidden');
      if (window.innerWidth <= 1050) popCount++;
    }
    if (state.chatSearch.open) {
      closeChatSearch();
      if (window.innerWidth <= 700) popCount++;
    }
    if ($('#conversation').classList.contains('mobile-open')) {
      $('#conversation').classList.remove('mobile-open');
      if (window.innerWidth <= 700) popCount++;
    }
    if (popCount > 0) popUiLayer(popCount);
  };
  $('#details-close').onclick = () => {
    if (!$('#details').classList.contains('hidden')) {
      $('#details').classList.add('hidden');
      if (window.innerWidth <= 1050) popUiLayer();
    }
  };
  $('#more-btn').onclick = () => {
    const opening = $('#details').classList.contains('hidden');
    $('#details').classList.toggle('hidden');
    if (window.innerWidth <= 1050) {
      if (opening) pushUiLayer('details');
      else popUiLayer();
    }
  };

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
        title: 'Incoming call',
        body: `${state.user.name || state.user.username} is calling on Whisper`,
        tag: `whisper-call-${c.id}`,
      });
      showToast(`Call notification sent to ${c.name}`);
    } catch (error) {
      showToast(error.message || 'Call notification could not be sent');
    }
  };

  $('#chat-search-btn').onclick = () => {
    if (state.chatSearch.open) {
      closeChatSearch();
      if (window.innerWidth <= 700) popUiLayer();
    } else {
      openChatSearch();
      if (window.innerWidth <= 700) pushUiLayer('search');
    }
  };
  $('#chat-search-input')?.addEventListener('input', (e) => runChatSearch(e.target.value));
  $('#chat-search-prev')?.addEventListener('click', () => stepChatSearch(-1));
  $('#chat-search-next')?.addEventListener('click', () => stepChatSearch(1));
  $('#chat-search-close')?.addEventListener('click', () => {
    if (state.chatSearch.open) {
      closeChatSearch();
      if (window.innerWidth <= 700) popUiLayer();
    }
  });

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
    if (document.querySelector('.msg-context-backdrop')) {
      closeMessageMenu(true);
      return;
    }
    if ($('#modal')?.open) {
      closingModalFromPop = true;
      closeModal();
      return;
    }
    if (!$('#details').classList.contains('hidden') && window.innerWidth <= 1050) {
      $('#details').classList.add('hidden');
      return;
    }
    if (isEmojiTrayOpen()) {
      closeEmojiTray(true);
      return;
    }
    if (state.chatSearch.open) {
      closeChatSearch();
      return;
    }
    if ($('#conversation').classList.contains('mobile-open')) {
      $('#conversation').classList.remove('mobile-open');
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
}

async function bootstrap() {
  setTheme(state.user.theme || 'aero');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  wireEvents();

  if (!configured) {
    authNotice('Supabase configuration is missing in app-config.js.', true);
    showAuth('login');
    return;
  }

  appShell.style.display = 'none';
  showAuth(isRecoveryFlow ? 'recovery' : 'login');

  api.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      isRecoveryFlow = true;
      showAuth('recovery');
    } else if (event === 'SIGNED_OUT') {
      stopRealtime();
      activeUserId = null;
      isRecoveryFlow = false;
      resetState();
      showAuth('login');
    } else if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user) {
      if (isRecoveryFlow) showAuth('recovery');
      else enterCloud(session.user);
    }
  });

  try {
    const { data, error } = await api.getSession();
    if (error) throw error;
    if (isRecoveryFlow) {
      showAuth('recovery');
    } else if (data.session?.user) {
      await enterCloud(data.session.user);
    }
  } catch (error) {
    authNotice(error.message || 'Could not connect to the account service.', true);
  }
}

bootstrap();
