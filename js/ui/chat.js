import * as api from '../api.js';
import {
  clearNativeNotification,
  getBubbleChatId,
  isBubbleWindow,
  isNativeAndroid,
  nativeCopyText,
  nativeShareText,
  openNativeChatBubble,
} from '../native.js?v=30';
import {
  formatAudioClock,
  isAudioFile,
  isHeicFile,
  isImageFile,
  isVideoFile,
  resolveHeicPreviewUrl,
} from '../media.js?v=30';
import {
  DEFAULT_DOUBLE_TAP_EMOJI,
  DEFAULT_REACTION_PALETTE,
  getActiveChat,
  getChat,
  getChatDraft,
  getDisplayName,
  setChatDraft,
  state,
} from '../state.js';
import {
  $,
  avatarMarkup,
  dayKey,
  esc,
  formatDayLabel,
  formatFileSize,
  formatLastSeen,
  formatTime,
  haptic,
  linkifyEscapedText,
  openModal,
  popUiLayer,
  pushUiLayer,
  showToast,
} from '../utils.js';
import { openViewOnceMedia } from '../viewOnce.js';

const MUTE_SVG = '<svg class="mute-svg-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Muted" title="Muted"><path d="M8.56 2.9A7 7 0 0 1 19 9v4m-2 4H2a3 3 0 0 0 2-2.8V9a7 7 0 0 1 .78-3.22"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

export function isMessagesNearBottom(box = $('#messages'), threshold = 110) {
  if (!box) return true;
  return (box.scrollHeight - box.scrollTop - box.clientHeight) < threshold;
}

export function updateScrollBottomBtn() {
  const btn = $('#scroll-bottom-btn');
  const badge = $('#scroll-bottom-badge');
  const box = $('#messages');
  const c = getActiveChat();
  if (!btn || !box || !c) {
    btn?.classList.add('hidden');
    return;
  }
  const distFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  const unread = Number(c.scrolledUnread || 0);
  const show = distFromBottom > 150 || unread > 0;
  btn.classList.toggle('hidden', !show);
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.toggle('hidden', unread <= 0);
  }
}

let callbacks = {
  onChatSelected: null,
  onRefreshInbox: null,
};

let lastBubbleTap = { id: '', time: 0 };

export function initChatUI(handlers) {
  callbacks = { ...callbacks, ...handlers };
}

function highlightMatch(text, term) {
  if (!term) return linkifyEscapedText(text);
  const safe = esc(text);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="search-hit">$1</mark>');
}

export function renderChats() {
  const list = $('#chat-list');
  if (!list) return;

  const sorted = [...state.chats].sort((a, b) => {
    const tA = new Date(a.latestMessage?.createdAt || 0).getTime();
    const tB = new Date(b.latestMessage?.createdAt || 0).getTime();
    return tB - tA;
  });

  const q = state.query.trim().toLowerCase();
  const items = sorted.filter((c) => {
    const displayName = getDisplayName(c);
    const matchesQuery =
      !q
      || `${displayName} ${c.name} ${c.username} ${c.latestMessage?.text || ''}`.toLowerCase().includes(q);
    const matchesFilter =
      (state.filter === 'all')
      || (state.filter === 'unread' && c.unread > 0)
      || (state.filter === 'favorites' && c.favorite);
    return matchesQuery && matchesFilter;
  });

  list.innerHTML = items.length
    ? items
        .map((c) => {
          const m = c.latestMessage;
          const online = state.onlineUsers.has(c.peerId);
          const displayName = getDisplayName(c);
          const draft = c.id !== state.activeChatId ? getChatDraft(c.id).trim() : '';
          const preview = draft
            ? `<span class="chat-draft-tag">Draft:</span> ${esc(draft)}`
            : m?.deletedAt
              ? 'Message deleted'
              : m?.file
                ? `${m.file.isViewOnce ? '1× ' : '▣ '}${esc(m.file.name)}`
                : esc(m?.text || 'Start a conversation');
          return `
            <div class="chat-item ${c.id === state.activeChatId ? 'active' : ''}" data-chat="${esc(c.id)}">
              <div class="avatar-wrap">
                ${avatarMarkup({ ...c, name: displayName })}
                ${online ? '<span class="presence-dot" title="Online"></span>' : ''}
              </div>
              <div class="chat-main">
                <div class="chat-row">
                  <span class="chat-name"><span class="chat-name-text">${esc(displayName)}</span>${c.muted ? MUTE_SVG : ''}</span>
                  <span class="chat-time">${esc(m?.time || '')}</span>
                </div>
                <div class="chat-row">
                  <span class="chat-preview">${c.favorite ? '★ ' : ''}${preview}</span>
                  ${c.unread > 0 ? `<span class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
                </div>
              </div>
            </div>
          `;
        })
        .join('')
    : '<div class="empty-list">No conversations match this view.</div>';

  list.querySelectorAll('[data-chat]').forEach((el) => {
    el.onclick = () => selectChat(el.dataset.chat);
  });

  const badge = $('#request-count');
  if (badge) {
    badge.textContent = state.incomingRequests.length ? String(state.incomingRequests.length) : '';
    badge.classList.toggle('has-count', state.incomingRequests.length > 0);
  }
}

export function updatePeerHeader() {
  const c = getActiveChat();
  if (!c) return;
  const displayName = getDisplayName(c);
  const peerAvatar = $('#peer-avatar');
  if (peerAvatar) {
    peerAvatar.textContent = c.avatar ? '' : c.initial;
    peerAvatar.style.backgroundImage = c.avatar ? `url('${c.avatar}')` : '';
    peerAvatar.style.backgroundSize = 'cover';
    peerAvatar.style.backgroundPosition = 'center';
    peerAvatar.style.backgroundColor = c.color;
  }
  const online = state.onlineUsers.has(c.peerId);
  $('#peer-name').innerHTML = `<span class="peer-name-text">${esc(displayName)}</span>${c.muted ? MUTE_SVG : ''}`;
  $('#peer-status').innerHTML = `<i style="background:${online ? '#43b581' : '#94a1a5'}"></i> ${esc(formatLastSeen(c.lastSeenAt, online))}`;

  const detAvatar = $('#details-avatar');
  if (detAvatar) {
    detAvatar.textContent = c.avatar ? '' : c.initial;
    detAvatar.style.backgroundImage = c.avatar ? `url('${c.avatar}')` : '';
    detAvatar.style.backgroundSize = 'cover';
    detAvatar.style.backgroundPosition = 'center';
    detAvatar.style.backgroundColor = c.color;
  }
  $('#details-name').textContent = displayName;
  const nick = String(state.nicknames?.[c.peerId] || '').trim();
  const realNameEl = $('#details-real-name');
  if (realNameEl) {
    realNameEl.textContent = nick ? `Name: ${c.name}` : '';
    realNameEl.classList.toggle('hidden', !nick);
  }
  const nickValEl = $('#details-nickname-value');
  if (nickValEl) {
    nickValEl.textContent = nick || 'Not set';
  }
  $('#details-handle').textContent = `@${c.username}`;
  $('.about-copy').textContent = c.about || 'Say hello and get to know each other.';
  $('#favorite-btn').innerHTML = c.favorite ? '★ &nbsp; In favorites' : '☆ &nbsp; Add to favorites';
}

export async function syncChatMessages(chatId, { reloadSharedMedia = false } = {}) {
  const c = getChat(chatId);
  if (!c || !state.user) return false;
  try {
    const { messages, hasMore } = await api.loadMessages(c.id, state.user.id, { limit: 50 });
    if (!c.loaded) {
      c.messages = messages;
      c.hasMore = hasMore;
      c.loaded = true;
    } else {
      const merged = new Map();
      for (const m of c.messages) {
        if (m && m.id) merged.set(m.id, m);
      }
      for (const m of messages) {
        merged.set(m.id, m);
      }
      c.messages = [...merged.values()].sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );
      if (!c.hasMore) c.hasMore = hasMore;
    }
    c.latestMessage = c.messages.at(-1) || c.latestMessage;
    if (reloadSharedMedia) {
      c.sharedMedia = await api.loadSharedMedia(c.id).catch(() => c.sharedMedia || []);
    }
    if (state.activeChatId === c.id) {
      const box = $('#messages');
      const nearBottom = isMessagesNearBottom(box);
      const latestAt = c.messages.at(-1)?.createdAt || '';
      const hasUnreadLatest = Boolean(latestAt && (!c.lastReadAt || latestAt > c.lastReadAt));
      if (document.visibilityState === 'visible' && nearBottom && (c.unread > 0 || hasUnreadLatest)) {
        c.unread = 0;
        api.markConversationRead(c.id, state.user.id).then((ts) => {
          if (ts) c.lastReadAt = ts;
        });
      }
      renderMessages({ preserveScroll: !nearBottom });
      renderChats();
      if (reloadSharedMedia) renderSharedMedia();
    }
    return true;
  } catch {
    return false;
  }
}

export async function selectChat(chatId, { forceSync = false, allowInBubble = false } = {}) {
  const c = getChat(chatId);
  if (!c) return;

  if (!allowInBubble && isBubbleWindow() && isNativeAndroid()) {
    const currentBubbleId = getBubbleChatId();
    if (currentBubbleId && chatId !== currentBubbleId) {
      const ok = openNativeChatBubble({ ...c, name: getDisplayName(c) });
      showToast(ok ? `Opened ${getDisplayName(c)} in a new bubble` : 'Enable Bubbles for Whisper in Android settings');
      return;
    }
  }

  const prevChatId = state.activeChatId;
  const changed = prevChatId !== chatId;
  if (changed && prevChatId) {
    setChatDraft(prevChatId, $('#message-input')?.value || '');
  }
  state.activeChatId = chatId;
  c.scrolledUnread = 0;
  if (changed) {
    clearComposeContext();
    clearPendingAttachment();
    closeChatSearch();
    const input = $('#message-input');
    if (input) {
      input.value = getChatDraft(chatId);
      input.style.height = 'auto';
      input.style.height = `${Math.min(110, input.scrollHeight)}px`;
    }
  }

  callbacks.onChatSelected?.(c.id);

  const wasMobileOpen = $('#conversation').classList.contains('mobile-open');
  $('#empty-state').classList.add('hidden');
  $('#thread').classList.remove('hidden');
  $('#conversation').classList.add('mobile-open');
  if (window.innerWidth <= 700 && !wasMobileOpen) {
    pushUiLayer('chat');
  }

  // Clear OS & native notifications for this chat when opened (skip inside floating bubble windows)
  if (!isBubbleWindow()) {
    clearNativeNotification(chatId);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.getNotifications({ tag: `whisper-msg-${chatId}` }))
      .then((list) => list.forEach((n) => n.close()))
      .catch(() => {});
  }

  updatePeerHeader();
  updateTypingBanner();
  renderChats();

  const needsSync =
    c.loaded &&
    (forceSync ||
      c.unread > 0 ||
      (c.latestMessage && c.latestMessage.id !== c.messages.at(-1)?.id));

  if (!c.loaded) {
    $('#messages').innerHTML = '<div class="people-empty">Loading conversation…</div>';
    try {
      const [{ messages, hasMore }, sharedMedia] = await Promise.all([
        api.loadMessages(c.id, state.user.id, { limit: 50 }),
        api.loadSharedMedia(c.id),
      ]);
      c.messages = messages;
      c.hasMore = hasMore;
      c.loaded = true;
      c.sharedMedia = sharedMedia;
      c.latestMessage = messages.at(-1) || c.latestMessage;
    } catch (error) {
      showToast(error.message || 'Could not load messages');
    }
  } else if (needsSync) {
    await syncChatMessages(c.id, { reloadSharedMedia: true });
  }

  const wasUnread = c.unread > 0;
  const lastReadAtBefore = c.lastReadAt || '';
  if (c.unread > 0) {
    c.unread = 0;
    api.markConversationRead(c.id, state.user.id).then((ts) => {
      if (ts) c.lastReadAt = ts;
    });
    renderChats();
  }
  c.firstUnreadMsgId = '';
  if (wasUnread && c.messages?.length) {
    const firstUnread = c.messages.find(
      (m) => m.from === 'them' && !m.deletedAt && (!lastReadAtBefore || m.createdAt > lastReadAtBefore),
    );
    if (firstUnread) c.firstUnreadMsgId = firstUnread.id;
  }

  renderMessages({ forceBottom: true });
  renderSharedMedia();
}

export function renderSharedMedia() {
  const box = $('#shared-media');
  const c = getActiveChat();
  if (!box || !c) return;
  const media = c.sharedMedia || [];
  if (!media.length) {
    box.innerHTML = '<p class="muted">Photos and videos will appear here</p>';
    return;
  }
  box.innerHTML = `<div class="shared-grid">${media
    .slice(0, 12)
    .map((m) => `<button type="button" class="shared-tile" data-shared-id="${esc(m.id)}" data-shared-type="${esc(m.type)}" data-shared-name="${esc(m.name)}" title="${esc(m.name)}">${isVideoFile(m) ? '▶' : '▧'}</button>`)
    .join('')}</div>`;

  box.querySelectorAll('[data-shared-id]').forEach(async (btn) => {
    const id = btn.dataset.sharedId;
    const type = btn.dataset.sharedType;
    const name = btn.dataset.sharedName;
    const signedUrl = await api.getAttachmentUrl(id);
    if (!signedUrl || !btn.isConnected) return;
    let url = signedUrl;
    if (isHeicFile({ type, name })) {
      const converted = await resolveHeicPreviewUrl(id, signedUrl);
      if (!btn.isConnected) return;
      if (converted) url = converted;
    }
    if (isImageFile({ type, name }) && !isVideoFile({ type, name })) {
      const thumb = document.createElement('img');
      thumb.className = 'shared-thumb';
      thumb.src = url;
      thumb.alt = name;
      thumb.loading = 'lazy';
      thumb.onerror = () => {
        btn.textContent = '▤';
      };
      btn.replaceChildren(thumb);
    }
    btn.onclick = () => openLightbox(url, type, name, id);
  });
}

export function openLightbox(url, mimeType, fileName, attachmentId) {
  const isVideo = isVideoFile({ type: mimeType, name: fileName });
  openModal(`
    <div class="lightbox-wrap">
      ${isVideo
        ? `<video class="lightbox-media" src="${esc(url)}" controls autoplay playsinline></video>`
        : `<img class="lightbox-media" src="${esc(url)}" alt="${esc(fileName || 'Photo')}">`}
      <div class="lightbox-foot">
        <span>${esc(fileName || 'Attachment')}</span>
        ${attachmentId ? `<button class="secondary-btn" type="button" id="lightbox-download">Download</button>` : ''}
      </div>
    </div>
  `);
  const dlBtn = $('#lightbox-download');
  if (dlBtn) {
    dlBtn.onclick = async () => {
      try {
        await api.downloadAttachment(attachmentId, fileName);
      } catch (e) {
        showToast(e.message || 'Download failed');
      }
    };
  }
}

async function toggleMessageReaction(msg, emoji) {
  if (!msg || msg.deletedAt || msg.pending) return;
  const reactions = msg.reactions ? msg.reactions.map((r) => ({ ...r })) : [];
  const idx = reactions.findIndex((r) => r.emoji === emoji);
  const mine = idx >= 0 && Boolean(reactions[idx].mine);

  // Optimistic update
  const snapshot = msg.reactions;
  if (mine) {
    if (reactions[idx].count <= 1) reactions.splice(idx, 1);
    else reactions[idx] = { ...reactions[idx], count: reactions[idx].count - 1, mine: false };
  } else if (idx >= 0) {
    reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, mine: true };
  } else {
    reactions.push({ emoji, count: 1, mine: true });
  }
  msg.reactions = reactions;
  renderMessages({ preserveScroll: true });

  try {
    await api.toggleReaction(msg.id, emoji, mine);
  } catch (error) {
    msg.reactions = snapshot;
    renderMessages({ preserveScroll: true });
    showToast(error.message || 'Could not save reaction');
  }
}

function startReplyTo(msg, chat) {
  if (!msg || msg.deletedAt) return;
  state.editingMessage = null;
  state.replyingTo = {
    id: msg.id,
    senderName: msg.from === 'me' ? 'You' : getDisplayName(chat),
    text: msg.text || msg.file?.name || 'Attachment',
  };
  renderComposeContext();
  $('#message-input')?.focus({ preventScroll: true });
}

export function closeMessageMenu(fromPop = false) {
  const existing = document.querySelector('.msg-context-backdrop');
  if (!existing) return;
  existing.remove();
  if (!fromPop) popUiLayer();
}

function openMessageMenu(msg, chat, anchorRect) {
  if (!msg || msg.deletedAt) return;
  closeMessageMenu();
  pushUiLayer('menu');

  const wasInputFocused = document.activeElement === $('#message-input');
  const restoreKeyboardIfNeeded = () => {
    if (wasInputFocused && document.activeElement !== $('#message-input')) {
      $('#message-input')?.focus({ preventScroll: true });
    }
  };

  const palette = state.reactionPalette?.length ? state.reactionPalette : DEFAULT_REACTION_PALETTE;
  const mine = msg.from === 'me';
  const backdrop = document.createElement('div');
  backdrop.className = 'msg-context-backdrop';
  backdrop.addEventListener('contextmenu', (e) => e.preventDefault());
  backdrop.addEventListener('pointerdown', (e) => e.preventDefault());
  backdrop.addEventListener('mousedown', (e) => e.preventDefault());

  // Keep the top chat header unblurred above the backdrop
  const headerRect = $('.chat-header')?.getBoundingClientRect();
  const minTop = headerRect ? Math.max(8, Math.round(headerRect.bottom)) : 8;
  backdrop.style.top = `${minTop}px`;

  const previewText = msg.file
    ? `${msg.file.isViewOnce ? '1× View once · ' : ''}${msg.file.name}${msg.text ? ` — ${msg.text}` : ''}`
    : (msg.text || '');

  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';
  menu.addEventListener('pointerdown', (e) => e.preventDefault());
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.innerHTML = `
    <div class="msg-react-bar" role="group" aria-label="Add reaction">
      ${palette.map((emoji) => {
        const active = msg.reactions?.some((r) => r.emoji === emoji && r.mine);
        return `<button type="button" class="${active ? 'active' : ''}" data-menu-react="${esc(emoji)}">${emoji}</button>`;
      }).join('')}
    </div>
    <div class="msg-spotlight-bubble ${mine ? 'mine' : 'theirs'}">${esc(previewText)}</div>
    <div class="msg-action-bar" role="menu">
      <button type="button" data-menu-action="reply">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        <span>Reply</span>
      </button>
      <button type="button" data-menu-action="copy">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        <span>Copy</span>
      </button>
      ${isNativeAndroid() && previewText ? `
        <button type="button" data-menu-action="share">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
          <span>Share</span>
        </button>
      ` : ''}
      ${mine && !msg.file ? `
        <button type="button" data-menu-action="edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          <span>Edit</span>
        </button>
      ` : ''}
      ${mine ? `
        <button type="button" class="danger" data-menu-action="delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          <span>Delete</span>
        </button>
      ` : ''}
    </div>
  `;

  backdrop.append(menu);
  document.body.append(backdrop);

  // Measure and clamp strictly within visual viewport below the header (above open keyboard)
  const rect = menu.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const pad = 10;
  const topBound = minTop + 8;
  const centerX = anchorRect.left + anchorRect.width / 2;
  const left = Math.max(pad, Math.min(window.innerWidth - rect.width - pad, centerX - rect.width / 2));
  let top = anchorRect.top - 52;
  if (top + rect.height > viewBottom - pad) {
    top = viewBottom - rect.height - pad;
  }
  top = Math.max(topBound, top);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeMessageMenu();
      document.removeEventListener('keydown', onKey);
      restoreKeyboardIfNeeded();
    }
  };
  document.addEventListener('keydown', onKey);

  let dismissed = false;
  const dismissMenu = (e) => {
    if (e.target !== backdrop || dismissed) return;
    dismissed = true;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    closeMessageMenu();
    document.removeEventListener('keydown', onKey);
    restoreKeyboardIfNeeded();
  };
  backdrop.addEventListener('touchend', dismissMenu, { passive: false });
  backdrop.addEventListener('click', dismissMenu);

  menu.querySelectorAll('[data-menu-react]').forEach((btn) => {
    let reacted = false;
    const handleReact = (e) => {
      if (reacted) return;
      reacted = true;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      haptic(10);
      closeMessageMenu();
      document.removeEventListener('keydown', onKey);
      toggleMessageReaction(msg, btn.dataset.menuReact);
      restoreKeyboardIfNeeded();
    };
    btn.addEventListener('touchend', handleReact, { passive: false });
    btn.addEventListener('click', handleReact);
  });

  menu.querySelectorAll('[data-menu-action]').forEach((btn) => {
    btn.onclick = async () => {
      const action = btn.dataset.menuAction;
      haptic(10);
      closeMessageMenu();
      document.removeEventListener('keydown', onKey);
      if (action === 'reply') {
        startReplyTo(msg, chat);
      } else if (action === 'copy') {
        const textToCopy = msg.text || msg.file?.name || '';
        if (nativeCopyText(textToCopy)) {
          showToast('Copied to clipboard');
        } else {
          try {
            await navigator.clipboard.writeText(textToCopy);
            showToast('Copied to clipboard');
          } catch {
            showToast('Copy is unavailable here');
          }
        }
        restoreKeyboardIfNeeded();
      } else if (action === 'share') {
        nativeShareText(chat?.name || 'Whisper', msg.text || msg.file?.name || '');
        restoreKeyboardIfNeeded();
      } else if (action === 'edit') {
        state.replyingTo = null;
        state.editingMessage = { id: msg.id, conversationId: chat.id, text: msg.text };
        renderComposeContext();
        const input = $('#message-input');
        if (input) {
          input.value = msg.text;
          input.focus({ preventScroll: true });
        }
      } else if (action === 'delete') {
        try {
          await api.deleteMessage(msg.id);
        } catch (error) {
          showToast(error.message || 'Could not delete message');
        }
        restoreKeyboardIfNeeded();
      }
    };
  });
}

function buildDownloadCard(id, name, size = '') {
  const card = document.createElement('div');
  card.className = 'attachment-card';
  card.innerHTML = `
    <span class="file-symbol" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg></span>
    <span class="file-info">
      <span class="file-name">${esc(name)}</span><br>
      <span class="file-size">${esc(size || 'Tap Download to open')}</span>
    </span>
    <button class="download-btn" type="button" data-download="${esc(id)}" data-filename="${esc(name)}">Download</button>
  `;
  const btn = card.querySelector('[data-download]');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.downloadAttachment(id, name);
      } catch (error) {
        showToast(error.message || 'Download failed');
      } finally {
        btn.disabled = false;
      }
    };
  }
  return card;
}

let activeChatAudio = null;

function isSameCluster(a, b) {
  if (!a || !b || a.deletedAt || b.deletedAt) return false;
  if (a.from !== b.from) return false;
  if (dayKey(a.createdAt) !== dayKey(b.createdAt)) return false;
  const diff = Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return diff <= 3 * 60 * 1000;
}

export function renderMessages({ preserveScroll = false, forceBottom = false } = {}) {
  const c = getActiveChat();
  const box = $('#messages');
  if (!c || !box) return;

  const wasNearBottom = isMessagesNearBottom(box);
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  const searchTerm = state.chatSearch.open ? state.chatSearch.term.trim() : '';

  let lastDay = '';
  const chunks = [];

  if (c.hasMore && c.messages.length >= 50) {
    chunks.push(`<div class="load-more-wrap"><button type="button" class="secondary-btn load-more-btn" id="load-older-btn">${c.loadingMore ? 'Loading…' : 'Load older messages'}</button></div>`);
  }

  if (!c.messages.length) {
    chunks.push('<div class="people-empty">No messages yet. Say hello!</div>');
  }

  const peerDisplayName = getDisplayName(c);
  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (c.firstUnreadMsgId && m.id === c.firstUnreadMsgId) {
      chunks.push('<div class="unread-divider" id="unread-divider"><span>Unread messages</span></div>');
    }
    const dk = dayKey(m.createdAt);
    if (dk && dk !== lastDay) {
      lastDay = dk;
      chunks.push(`<div class="day-label">${esc(formatDayLabel(m.createdAt))}</div>`);
    }

    const mine = m.from === 'me';
    const clusterPrev = isSameCluster(c.messages[i - 1], m);
    const clusterNext = isSameCluster(m, c.messages[i + 1]);
    const isMatch = searchTerm && !m.deletedAt && m.text?.toLowerCase().includes(searchTerm.toLowerCase());
    const activeMatchId = state.chatSearch.matchIds[state.chatSearch.activeIndex];
    const isActiveMatch = activeMatchId === m.id;

    let bodyHtml = '';
    if (m.deletedAt) {
      bodyHtml = '<div class="message-bubble deleted-bubble">This message was deleted</div>';
    } else {
      const replyHtml = m.replyPreview
        ? `<button type="button" class="reply-quote" data-jump-msg="${esc(m.replyPreview.id)}"><strong>${esc(m.replyPreview.senderId === state.user.id ? 'You' : peerDisplayName)}</strong><span>${esc(m.replyPreview.text)}</span></button>`
        : '';

      let mediaHtml = '';
      if (m.file) {
        if (m.file.isViewOnce) {
          if (mine) {
            mediaHtml = `<div class="view-once-card sent"><span>1×</span><div><strong>View-once ${isVideoFile(m.file) ? 'video' : isImageFile(m.file) ? 'photo' : isAudioFile(m.file) ? 'voice note' : 'file'}</strong><small>${m.file.downloaded ? 'Opened by recipient' : 'Sent · waiting to open'}</small></div></div>`;
          } else if (m.file.downloaded) {
            mediaHtml = `<div class="view-once-card opened"><span>1×</span><div><strong>Opened</strong><small>View-once media removed</small></div></div>`;
          } else {
            mediaHtml = `<button type="button" class="view-once-card incoming" data-open-vo="${esc(m.id)}"><span>1×</span><div><strong>Tap to view once</strong><small>${esc(m.file.name)} · ${esc(m.file.size)}</small></div></button>`;
          }
        } else if (isAudioFile(m.file)) {
          mediaHtml = `
            <div class="audio-msg-card" data-audio-id="${esc(m.file.id)}" data-audio-name="${esc(m.file.name)}" data-audio-size="${esc(m.file.size)}">
              <button type="button" class="audio-play-btn" aria-label="Play voice message" disabled>
                <svg class="ico-play" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                <svg class="ico-pause hidden" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              </button>
              <div class="audio-wave-col">
                <input type="range" class="audio-seek" min="0" max="100" value="0" aria-label="Seek voice message" disabled>
                <div class="audio-meta-row">
                  <span class="audio-clock">0:00</span>
                  <span class="audio-size">${esc(m.file.size)}</span>
                </div>
              </div>
              <button class="audio-dl-btn" type="button" data-download="${esc(m.file.id)}" data-filename="${esc(m.file.name)}" title="Download audio" aria-label="Download audio">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
              </button>
              <audio preload="metadata"></audio>
            </div>
          `;
        } else if (isImageFile(m.file) || isVideoFile(m.file)) {
          const isVid = isVideoFile(m.file);
          const isHeic = isHeicFile(m.file);
          const cached = state.mediaUrlCache.get(m.file.id);
          const url = cached && cached.expiresAt > Date.now() ? cached.url : '';
          if (url && !isHeic) {
            mediaHtml = isVid
              ? `<video class="attachment-video" src="${esc(url)}" controls preload="metadata" playsinline data-media-fallback-id="${esc(m.file.id)}" data-media-fallback-name="${esc(m.file.name)}" data-media-fallback-size="${esc(m.file.size)}"></video>`
              : `<img class="attachment-image clickable-media" src="${esc(url)}" alt="${esc(m.file.name)}" data-lightbox-id="${esc(m.file.id)}" data-lightbox-type="${esc(m.file.type)}" data-lightbox-name="${esc(m.file.name)}" data-media-fallback-id="${esc(m.file.id)}" data-media-fallback-name="${esc(m.file.name)}" data-media-fallback-size="${esc(m.file.size)}">`;
          } else {
            mediaHtml = `<div class="media-slot" data-media-id="${esc(m.file.id)}" data-media-type="${esc(m.file.type)}" data-media-name="${esc(m.file.name)}" data-media-size="${esc(m.file.size)}">${isHeic ? 'Converting HEIC photo…' : `Loading ${isVid ? 'video' : 'photo'}…`}</div>`;
          }
        } else {
          mediaHtml = `
            <div class="attachment-card">
              <span class="file-symbol" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg></span>
              <span class="file-info">
                <span class="file-name">${esc(m.file.name)}</span><br>
                <span class="file-size">${esc(m.file.size)}</span>
              </span>
              <button class="download-btn" type="button" data-download="${esc(m.file.id)}" data-filename="${esc(m.file.name)}">Download</button>
            </div>
          `;
        }
      }

      const textHtml = m.text ? `<div class="message-text">${highlightMatch(m.text, searchTerm)}</div>` : '';
      bodyHtml = `<div class="message-bubble ${isActiveMatch ? 'search-active-bubble' : ''}">${replyHtml}${mediaHtml}${textHtml}</div>`;
    }

    const reactionsHtml = (m.reactions || [])
      .map((r) => `<button class="reaction-chip ${r.mine ? 'mine-reaction' : ''}" type="button" data-emoji="${esc(r.emoji)}" data-reaction-message="${esc(m.id)}">${esc(r.emoji)}${r.count > 1 ? ` ${r.count}` : ''}</button>`)
      .join('');

    const isSeen = mine && c.peerLastReadAt && m.createdAt && new Date(c.peerLastReadAt) >= new Date(m.createdAt);
    const ticks = mine ? (m.pending ? '⏳' : isSeen ? '✓✓' : '✓') : '';
    const showMeta = !clusterNext || Boolean(m.editedAt) || Boolean(m.pending);
    const avatarHtml = mine ? '' : (clusterPrev ? '<span class="mini-avatar-spacer" aria-hidden="true"></span>' : avatarMarkup(c, 'mini-avatar'));

    chunks.push(`
      <div class="message-row ${mine ? 'mine' : 'theirs'} ${clusterPrev ? 'cluster-prev' : ''} ${clusterNext ? 'cluster-next' : ''} ${isMatch ? 'search-row-match' : ''}" data-msg-id="${esc(m.id)}">
        <span class="swipe-reply-hint" aria-hidden="true">↩</span>
        ${avatarHtml}
        <div class="message-wrap">
          ${bodyHtml}
          ${reactionsHtml ? `<div class="message-reactions">${reactionsHtml}</div>` : ''}
          ${showMeta ? `<div class="message-meta">${esc(m.time || formatTime(m.createdAt))}${m.editedAt ? ' · edited' : ''} ${ticks}</div>` : ''}
        </div>
      </div>
    `);
  }

  box.innerHTML = chunks.join('');

  box.querySelectorAll('[data-media-fallback-id]').forEach((el) => {
    el.onerror = () => {
      if (!el.isConnected) return;
      el.replaceWith(
        buildDownloadCard(
          el.dataset.mediaFallbackId,
          el.dataset.mediaFallbackName || 'Attachment',
          el.dataset.mediaFallbackSize || '',
        ),
      );
    };
  });

  box.querySelectorAll('[data-media-id]').forEach(async (slot) => {
    const id = slot.dataset.mediaId;
    const type = slot.dataset.mediaType;
    const name = slot.dataset.mediaName;
    const size = slot.dataset.mediaSize || '';
    const signedUrl = await api.getAttachmentUrl(id);
    if (!slot.isConnected) return;
    if (!signedUrl) {
      slot.replaceWith(buildDownloadCard(id, name, size));
      return;
    }
    if (isVideoFile({ type, name })) {
      const video = document.createElement('video');
      video.className = 'attachment-video';
      video.src = signedUrl;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.onerror = () => {
        if (video.isConnected) video.replaceWith(buildDownloadCard(id, name, size));
      };
      slot.replaceWith(video);
      return;
    }
    let displayUrl = signedUrl;
    if (isHeicFile({ type, name })) {
      const converted = await resolveHeicPreviewUrl(id, signedUrl);
      if (!slot.isConnected) return;
      if (converted) {
        displayUrl = converted;
      } else {
        slot.replaceWith(buildDownloadCard(id, name, size));
        return;
      }
    }
    const img = document.createElement('img');
    img.className = 'attachment-image clickable-media';
    img.src = displayUrl;
    img.alt = name;
    img.onerror = () => {
      if (img.isConnected) img.replaceWith(buildDownloadCard(id, name, size));
    };
    img.onclick = () => openLightbox(displayUrl, type, name, id);
    slot.replaceWith(img);
  });

  box.querySelectorAll('[data-audio-id]').forEach(async (card) => {
    const id = card.dataset.audioId;
    const playBtn = card.querySelector('.audio-play-btn');
    const seek = card.querySelector('.audio-seek');
    const clock = card.querySelector('.audio-clock');
    const audio = card.querySelector('audio');
    if (!id || !playBtn || !seek || !clock || !audio) return;

    const url = await api.getAttachmentUrl(id);
    if (!card.isConnected) return;
    if (!url) {
      clock.textContent = 'Unavailable';
      return;
    }
    audio.src = url;
    playBtn.disabled = false;
    seek.disabled = false;

    const syncIcons = (playing) => {
      playBtn.querySelector('.ico-play')?.classList.toggle('hidden', playing);
      playBtn.querySelector('.ico-pause')?.classList.toggle('hidden', !playing);
    };

    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        clock.textContent = formatAudioClock(audio.duration);
      }
    });
    audio.addEventListener('timeupdate', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        seek.value = String(Math.round((audio.currentTime / audio.duration) * 100));
        clock.textContent = `${formatAudioClock(audio.currentTime)} / ${formatAudioClock(audio.duration)}`;
      } else {
        clock.textContent = formatAudioClock(audio.currentTime);
      }
    });
    audio.addEventListener('pause', () => syncIcons(false));
    audio.addEventListener('play', () => {
      if (activeChatAudio && activeChatAudio !== audio) {
        activeChatAudio.pause();
      }
      activeChatAudio = audio;
      syncIcons(true);
    });
    audio.addEventListener('ended', () => {
      syncIcons(false);
      seek.value = '0';
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        clock.textContent = formatAudioClock(audio.duration);
      }
    });

    playBtn.onclick = () => {
      haptic(8);
      if (audio.paused) {
        audio.play().catch(() => showToast('Could not play voice message'));
      } else {
        audio.pause();
      }
    };
    seek.oninput = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = (Number(seek.value) / 100) * audio.duration;
      }
    };
  });

  box.querySelectorAll('[data-lightbox-id]').forEach((img) => {
    img.onclick = () => openLightbox(img.src, img.dataset.lightboxType, img.dataset.lightboxName, img.dataset.lightboxId);
  });

  box.querySelectorAll('[data-open-vo]').forEach((btn) => {
    btn.onclick = () => {
      const msg = c.messages.find((x) => x.id === btn.dataset.openVo);
      if (!msg?.file) return;
      openViewOnceMedia(msg.file, () => {
        msg.file.downloaded = true;
        renderMessages({ preserveScroll: true });
      });
    };
  });

  box.querySelectorAll('[data-download]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.downloadAttachment(btn.dataset.download, btn.dataset.filename);
      } catch (error) {
        showToast(error.message || 'Download failed');
      } finally {
        btn.disabled = false;
      }
    };
  });

  box.querySelectorAll('[data-reaction-message]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.onclick = () => {
      const msg = c.messages.find((x) => x.id === btn.dataset.reactionMessage);
      if (!msg) return;
      haptic(10);
      toggleMessageReaction(msg, btn.dataset.emoji);
    };
  });

  box.querySelectorAll('[data-jump-msg]').forEach((btn) => {
    btn.onclick = () => {
      const target = box.querySelector(`[data-msg-id="${CSS.escape(btn.dataset.jumpMsg)}"]`);
      if (!target) {
        showToast('Original message is further up — load older messages to jump');
        return;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('msg-jump-highlight');
      void target.offsetWidth;
      target.classList.add('msg-jump-highlight');
      setTimeout(() => target.classList.remove('msg-jump-highlight'), 1600);
    };
  });

  // Prevent native browser long-press context menu inside message stream
  box.oncontextmenu = (e) => {
    if (e.target.closest('.message-row') || window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
    }
  };

  let lastTouchHeartAt = 0;
  const BUBBLE_INTERACTIVE = 'button, a, video, input, img.clickable-media, [data-lightbox-id]';

  // Wire right-click, long-press, double-tap/double-click, and swipe-right-to-reply
  box.querySelectorAll('.message-row').forEach((row) => {
    const msg = c.messages.find((x) => x.id === row.dataset.msgId);
    const wrap = row.querySelector('.message-wrap');
    const bubble = row.querySelector('.message-bubble');
    const hint = row.querySelector('.swipe-reply-hint');
    if (!msg || msg.deletedAt || !wrap || !bubble) return;

    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      haptic(12);
      openMessageMenu(msg, c, bubble.getBoundingClientRect());
    });

    bubble.addEventListener('mousedown', (e) => {
      if (!e.target.closest(BUBBLE_INTERACTIVE)) {
        e.preventDefault();
      }
    });

    bubble.addEventListener('dblclick', (e) => {
      if (e.target.closest(BUBBLE_INTERACTIVE)) return;
      if (Date.now() - lastTouchHeartAt < 600) return;
      haptic(12);
      toggleMessageReaction(msg, state.doubleTapEmoji || DEFAULT_DOUBLE_TAP_EMOJI);
    });

    let pressTimer = 0;
    let startX = 0;
    let startY = 0;
    let swiping = false;
    let swipeFired = false;
    let longPressFired = false;
    let moved = false;
    let wasInputFocused = false;

    row.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      swiping = false;
      swipeFired = false;
      longPressFired = false;
      moved = false;
      wasInputFocused = document.activeElement === $('#message-input');
      wrap.style.transition = 'none';

      if (e.target.closest('.message-bubble')) {
        pressTimer = setTimeout(() => {
          if (moved || swiping) return;
          longPressFired = true;
          haptic(20);
          openMessageMenu(msg, c, bubble.getBoundingClientRect());
        }, 400);
      }
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (Math.abs(dx) > 15 || Math.abs(dy) > 15) {
        moved = true;
        clearTimeout(pressTimer);
      }

      if (!swiping && dx > 14 && dx > Math.abs(dy) * 1.35) {
        swiping = true;
      }

      if (swiping) {
        const pull = Math.max(0, Math.min(64, dx));
        wrap.style.transform = `translateX(${pull}px)`;
        if (hint) {
          hint.style.opacity = String(Math.min(1, pull / 48));
          hint.style.transform = `scale(${0.7 + Math.min(0.4, (pull / 48) * 0.4)})`;
        }
        if (pull >= 48 && !swipeFired) {
          swipeFired = true;
          haptic(15);
        }
      }
    }, { passive: true });

    const finishTouch = (e) => {
      clearTimeout(pressTimer);
      wrap.style.transition = 'transform 0.18s ease-out';
      wrap.style.transform = '';
      if (hint) {
        hint.style.opacity = '0';
        hint.style.transform = '';
      }

      if (longPressFired) {
        if (e.cancelable) e.preventDefault();
        return;
      }

      if (swiping && swipeFired) {
        startReplyTo(msg, c);
        return;
      }

      if (!moved && e.target.closest('.message-bubble') && !e.target.closest(BUBBLE_INTERACTIVE)) {
        if (e.cancelable) e.preventDefault();
        const now = Date.now();
        if (lastBubbleTap.id === msg.id && (now - lastBubbleTap.time) < 350) {
          lastBubbleTap = { id: '', time: 0 };
          lastTouchHeartAt = now;
          haptic(12);
          toggleMessageReaction(msg, state.doubleTapEmoji || DEFAULT_DOUBLE_TAP_EMOJI);
        } else {
          lastBubbleTap = { id: msg.id, time: now };
        }
        if (wasInputFocused && document.activeElement !== $('#message-input')) {
          $('#message-input')?.focus({ preventScroll: true });
        }
      }
    };

    row.addEventListener('touchend', finishTouch, { passive: false });
    row.addEventListener('touchcancel', () => {
      clearTimeout(pressTimer);
      wrap.style.transition = 'transform 0.18s ease-out';
      wrap.style.transform = '';
      if (hint) hint.style.opacity = '0';
    }, { passive: true });
  });

  const olderBtn = $('#load-older-btn', box);
  if (olderBtn) {
    olderBtn.onclick = async () => {
      if (c.loadingMore || !c.hasMore || !c.messages.length) return;
      c.loadingMore = true;
      olderBtn.textContent = 'Loading…';
      try {
        const { messages, hasMore } = await api.loadMessages(c.id, state.user.id, {
          before: c.messages[0].createdAt,
          limit: 50,
        });
        c.messages = [...messages, ...c.messages];
        c.hasMore = hasMore;
      } catch (error) {
        showToast(error.message || 'Could not load older messages');
      } finally {
        c.loadingMore = false;
        renderMessages({ preserveScroll: true });
      }
    };
  }

  if (forceBottom) {
    box.scrollTop = box.scrollHeight;
    c.scrolledUnread = 0;
  } else if (preserveScroll || !wasNearBottom) {
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  } else {
    box.scrollTop = box.scrollHeight;
    c.scrolledUnread = 0;
  }
  updateScrollBottomBtn();
}

export function renderComposeContext() {
  const bar = $('#compose-context');
  if (!bar) return;
  const keepKeyboard = (btn) => {
    btn?.addEventListener('pointerdown', (e) => e.preventDefault());
    btn?.addEventListener('mousedown', (e) => e.preventDefault());
  };
  if (state.editingMessage) {
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <div class="compose-ctx-text"><strong>Editing message</strong><span>${esc(state.editingMessage.text)}</span></div>
      <button type="button" class="compose-ctx-close" id="compose-ctx-cancel" aria-label="Cancel">×</button>
    `;
    const cancelBtn = $('#compose-ctx-cancel', bar);
    keepKeyboard(cancelBtn);
    cancelBtn.onclick = () => {
      clearComposeContext();
      const input = $('#message-input');
      if (input) {
        input.value = '';
        input.focus({ preventScroll: true });
      }
    };
  } else if (state.replyingTo) {
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <div class="compose-ctx-text"><strong>Replying to ${esc(state.replyingTo.senderName)}</strong><span>${esc(state.replyingTo.text)}</span></div>
      <button type="button" class="compose-ctx-close" id="compose-ctx-cancel" aria-label="Cancel">×</button>
    `;
    const cancelBtn = $('#compose-ctx-cancel', bar);
    keepKeyboard(cancelBtn);
    cancelBtn.onclick = () => {
      const wasFocused = document.activeElement === $('#message-input');
      clearComposeContext();
      if (wasFocused) $('#message-input')?.focus({ preventScroll: true });
    };
  } else {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}

export function clearComposeContext() {
  state.replyingTo = null;
  state.editingMessage = null;
  renderComposeContext();
}

export function renderAttachmentPreview() {
  const bar = $('#attachment-preview');
  if (!bar) return;
  const list = state.pendingAttachments || [];
  if (!list.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  bar.innerHTML = `
    <div class="att-strip" role="list">
      ${list.map((att) => {
        const { id, file, previewUrl, isViewOnce } = att;
        const isImg = Boolean(isImageFile(file) && previewUrl);
        const isVid = Boolean(isVideoFile(file) && previewUrl);
        const isVisual = isImg || isVid;
        const mediaHtml = isImg
          ? `<img class="att-card-media" src="${esc(previewUrl)}" alt="${esc(file.name)}">`
          : isVid
            ? `<video class="att-card-media" src="${esc(previewUrl)}" muted playsinline></video>`
            : `<div class="att-card-file"><span class="att-card-file-ico" aria-hidden="true">▤</span><strong>${esc(file.name)}</strong><small>${esc(formatFileSize(file.size))}</small></div>`;
        return `
          <div class="att-card ${isVisual ? 'is-visual' : 'is-file'}" role="listitem" data-att-id="${esc(id)}">
            ${mediaHtml}
            <button type="button" class="att-card-remove" data-att-rm="${esc(id)}" aria-label="Remove ${esc(file.name)}">×</button>
            ${isVisual ? `<button type="button" class="att-card-vo ${isViewOnce ? 'active' : ''}" data-att-vo="${esc(id)}" title="Toggle View Once (1×)" aria-pressed="${isViewOnce ? 'true' : 'false'}">1×</button>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  bar.querySelectorAll('[data-att-rm], [data-att-vo]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.preventDefault());
  });

  bar.querySelectorAll('[data-att-vo]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const target = (state.pendingAttachments || []).find((x) => x.id === btn.dataset.attVo);
      if (!target) return;
      haptic(10);
      target.isViewOnce = !target.isViewOnce;
      renderAttachmentPreview();
      showToast(target.isViewOnce ? 'View-once enabled for this item' : 'View-once turned off');
    };
  });

  bar.querySelectorAll('[data-att-rm]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      clearPendingAttachment(btn.dataset.attRm);
    };
  });
}

export function clearPendingAttachment(itemId = null) {
  const list = state.pendingAttachments || [];
  if (itemId) {
    const idx = list.findIndex((x) => x.id === itemId);
    if (idx >= 0) {
      if (list[idx]?.previewUrl) URL.revokeObjectURL(list[idx].previewUrl);
      list.splice(idx, 1);
    }
  } else {
    for (const item of list) {
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    state.pendingAttachments = [];
    const fileInput = $('#file-input');
    if (fileInput) fileInput.value = '';
    const mediaInput = $('#media-input');
    if (mediaInput) mediaInput.value = '';
  }
  renderAttachmentPreview();
}

export function updateTypingBanner() {
  const el = $('#typing');
  const c = getActiveChat();
  if (!el || !c) return;
  const isTyping = state.typingChats.has(c.id);
  el.classList.toggle('hidden', !isTyping);
  if (isTyping) {
    el.innerHTML = `${esc(c.name.split(' ')[0])} is typing<span>•••</span>`;
  }
}

export function openChatSearch() {
  const bar = $('#chat-search-bar');
  if (!bar) return;
  state.chatSearch.open = true;
  bar.classList.remove('hidden');
  $('#chat-search-input')?.focus();
}

export function closeChatSearch() {
  const bar = $('#chat-search-bar');
  if (!bar) return;
  state.chatSearch = { open: false, term: '', matchIds: [], activeIndex: 0 };
  bar.classList.add('hidden');
  const input = $('#chat-search-input');
  if (input) input.value = '';
  $('#chat-search-count').textContent = '';
  renderMessages({ preserveScroll: true });
}

export function runChatSearch(term) {
  const c = getActiveChat();
  state.chatSearch.term = term;
  if (!c || !term.trim()) {
    state.chatSearch.matchIds = [];
    state.chatSearch.activeIndex = 0;
    $('#chat-search-count').textContent = '';
    renderMessages({ preserveScroll: true });
    return;
  }
  const lower = term.trim().toLowerCase();
  state.chatSearch.matchIds = c.messages
    .filter((m) => !m.deletedAt && m.text?.toLowerCase().includes(lower))
    .map((m) => m.id);
  state.chatSearch.activeIndex = state.chatSearch.matchIds.length ? state.chatSearch.matchIds.length - 1 : 0;
  updateChatSearchNav();
}

export function stepChatSearch(delta) {
  const len = state.chatSearch.matchIds.length;
  if (!len) return;
  state.chatSearch.activeIndex = (state.chatSearch.activeIndex + delta + len) % len;
  updateChatSearchNav();
}

function updateChatSearchNav() {
  const len = state.chatSearch.matchIds.length;
  $('#chat-search-count').textContent = len ? `${state.chatSearch.activeIndex + 1}/${len}` : '0/0';
  renderMessages({ preserveScroll: true });
  const id = state.chatSearch.matchIds[state.chatSearch.activeIndex];
  if (id) {
    $(`[data-msg-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
