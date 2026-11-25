import { configured } from './config.js';
import * as api from './api.js';
import { joinConversationTyping, sendTypingSignal, startRealtime, stopRealtime } from './realtime.js';
import { getActiveChat, getChat, resetState, state, upsertMessage } from './state.js';
import {
  clearComposeContext,
  closeChatSearch,
  initChatUI,
  openChatSearch,
  renderChats,
  renderMessages,
  renderSharedMedia,
  runChatSearch,
  selectChat,
  stepChatSearch,
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
  formatTime,
  initials,
  playNotificationChime,
  showToast,
} from './utils.js';

let authMode = 'login';
let isRecoveryFlow = window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery');
let activeUserId = null;
let refreshPromise = null;
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
  };
  const descriptions = {
    login: 'Sign in to pick up where your conversations left off.',
    signup: 'A few details, then you can start chatting.',
    reset: 'Enter your account email and we will send a reset link.',
    recovery: 'Choose a new password with at least 8 characters.',
  };
  const submits = {
    login: 'Sign in',
    signup: 'Create account',
    reset: 'Send reset link',
    recovery: 'Update password',
  };

  $('#auth-title').textContent = titles[mode] || titles.login;
  $('#auth-description').textContent = descriptions[mode] || descriptions.login;
  $('#auth-signup-fields').classList.toggle('hidden', mode !== 'signup');
  $('#auth-email-field')?.classList.toggle('hidden', mode === 'recovery');
  $('#auth-password-field')?.classList.toggle('hidden', mode === 'reset');
  $('#auth-confirm-field')?.classList.toggle('hidden', mode !== 'recovery');
  $('#auth-forgot')?.classList.toggle('hidden', mode !== 'login');

  const pwLabel = $('label[for="auth-password"]');
  if (pwLabel) pwLabel.textContent = mode === 'recovery' ? 'New password' : 'Password';
  $('#auth-password').autocomplete = mode === 'signup' || mode === 'recovery' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = submits[mode] || submits.login;
  $('#auth-switch').innerHTML = mode === 'login'
    ? 'New to Whisper? <b>Create an account</b>'
    : mode === 'signup'
      ? 'Already have an account? <b>Sign in</b>'
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
  if ('Notification' in window && Notification.permission === 'granted') {
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
    startRealtime(user.id, {
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
    });
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
  const txt = input?.value.trim() || '';
  if (!c || !txt) return;

  if (state.editingMessage) {
    const targetId = state.editingMessage.id;
    clearComposeContext();
    input.value = '';
    input.style.height = 'auto';
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
  sendTypingSignal(c.id, state.user.id, false);

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

  $('#auth-switch').onclick = () => showAuth(authMode === 'login' ? 'signup' : 'login');
  $('#auth-forgot')?.addEventListener('click', () => showAuth('reset'));

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
      if (authMode === 'reset') {
        if (!email) throw new Error('Enter your email address.');
        const { error } = await api.requestPasswordReset(email);
        if (error) throw error;
        authNotice('Password reset link sent. Check your email inbox (and spam folder).');
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
        else authNotice('Check your email to confirm your account, then return here to sign in.');
      } else {
        const result = await api.signIn(email, password);
        if (result.error) throw result.error;
        await enterCloud(result.data.user);
      }
    } catch (error) {
      authNotice(error.message || 'Sign-in failed. Please try again.', true);
    } finally {
      $('#auth-submit').disabled = false;
    }
  };

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
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(110, e.target.scrollHeight)}px`;
    const c = getActiveChat();
    if (c && e.target.value.trim()) sendTypingSignal(c.id, state.user.id, true);
  });

  $('#view-once-btn')?.addEventListener('click', () => {
    state.viewOnce = !state.viewOnce;
    $('#view-once-btn').classList.toggle('active', state.viewOnce);
    showToast(state.viewOnce ? 'Next attachment will be View Once (1×)' : 'Normal persistent attachments enabled');
  });

  $('#attach-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (event) => {
    const file = event.target.files[0];
    const c = getActiveChat();
    if (!file || !c) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('Attachments must be 10 MB or smaller');
      event.target.value = '';
      return;
    }
    const isViewOnce = state.viewOnce;
    const replyTo = state.replyingTo;
    state.viewOnce = false;
    $('#view-once-btn')?.classList.remove('active');
    clearComposeContext();

    showToast(isViewOnce ? 'Uploading view-once media…' : 'Uploading attachment…');
    try {
      await api.sendAttachment({
        conversationId: c.id,
        file,
        caption: $('#message-input').value.trim(),
        replyToId: replyTo?.id || null,
        viewOnce: isViewOnce,
      });
      $('#message-input').value = '';
      $('#message-input').style.height = 'auto';
    } catch (error) {
      showToast(error.message || 'Could not upload attachment');
    } finally {
      event.target.value = '';
    }
  };

  $('#emoji-btn').onclick = () => $('#emoji-pop').classList.toggle('hidden');
  $('#emoji-pop').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      const input = $('#message-input');
      input.value += [...btn.textContent][0];
      $('#emoji-pop').classList.add('hidden');
      input.focus();
    };
  });

  $('#new-chat').onclick = $('#empty-add').onclick = $('#contacts-tab').onclick = () =>
    openFindPeopleModal(() => refreshInbox());
  $('#requests-tab').onclick = () => renderRequestsModal('incoming', () => refreshInbox());
  $('#profile-open').onclick = () => openProfileModal(updateUserBadge);
  $('#settings-open').onclick = () =>
    openSettingsModal({ onThemeChange: setTheme, onSignOut: handleSignOut });
  $('#theme-toggle').onclick = () => setTheme(state.user.theme === 'dark' ? 'aero' : 'dark');

  $('#back-btn').onclick = () => $('#conversation').classList.remove('mobile-open');
  $('#details-close').onclick = () => $('#details').classList.add('hidden');
  $('#more-btn').onclick = () => $('#details').classList.toggle('hidden');

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
      showToast(`Call notification sent to ${c.name}`);
    } catch (error) {
      showToast(error.message || 'Call notification could not be sent');
    }
  };

  $('#chat-search-btn').onclick = () => {
    if (state.chatSearch.open) closeChatSearch();
    else openChatSearch();
  };
  $('#chat-search-input')?.addEventListener('input', (e) => runChatSearch(e.target.value));
  $('#chat-search-prev')?.addEventListener('click', () => stepChatSearch(-1));
  $('#chat-search-next')?.addEventListener('click', () => stepChatSearch(1));
  $('#chat-search-close')?.addEventListener('click', closeChatSearch);

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

  document.addEventListener('visibilitychange', () => {
    const c = getActiveChat();
    if (document.visibilityState === 'visible' && c && c.unread > 0) {
      c.unread = 0;
      api.markConversationRead(c.id, state.user.id).then((ts) => {
        if (ts) c.lastReadAt = ts;
      });
      renderChats();
    }
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
