import * as api from '../api.js';
import { getActiveChat, getChat, state } from '../state.js';
import {
  $,
  $$,
  avatarMarkup,
  dayKey,
  esc,
  formatDayLabel,
  formatLastSeen,
  formatTime,
  openModal,
  showToast,
} from '../utils.js';
import { openViewOnceMedia } from '../viewOnce.js';

const REACTION_PALETTE = ['❤️', '😂', '👍', '🔥', '🎉', '🥹', '😮', '🙏'];

let callbacks = {
  onChatSelected: null,
  onRefreshInbox: null,
};

export function initChatUI(handlers) {
  callbacks = { ...callbacks, ...handlers };
}

function highlightMatch(text, term) {
  const safe = esc(text);
  if (!term) return safe;
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
    const matchesQuery =
      !q
      || `${c.name} ${c.username} ${c.latestMessage?.text || ''}`.toLowerCase().includes(q);
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
          const preview = m?.deletedAt
            ? 'Message deleted'
            : m?.file
              ? `${m.file.isViewOnce ? '1× ' : '▣ '}${esc(m.file.name)}`
              : esc(m?.text || 'Start a conversation');
          return `
            <div class="chat-item ${c.id === state.activeChatId ? 'active' : ''}" data-chat="${esc(c.id)}">
              <div class="avatar-wrap">
                ${avatarMarkup(c)}
                ${online ? '<span class="presence-dot" title="Online"></span>' : ''}
              </div>
              <div class="chat-main">
                <div class="chat-row">
                  <span class="chat-name">${esc(c.name)}</span>
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
  const peerAvatar = $('#peer-avatar');
  if (peerAvatar) {
    peerAvatar.textContent = c.avatar ? '' : c.initial;
    peerAvatar.style.backgroundImage = c.avatar ? `url('${c.avatar}')` : '';
    peerAvatar.style.backgroundSize = 'cover';
    peerAvatar.style.backgroundPosition = 'center';
    peerAvatar.style.backgroundColor = c.color;
  }
  const online = state.onlineUsers.has(c.peerId);
  $('#peer-name').textContent = c.name;
  $('#peer-status').innerHTML = `<i style="background:${online ? '#43b581' : '#94a1a5'}"></i> ${esc(formatLastSeen(c.lastSeenAt, online))}`;

  const detAvatar = $('#details-avatar');
  if (detAvatar) {
    detAvatar.textContent = c.avatar ? '' : c.initial;
    detAvatar.style.backgroundImage = c.avatar ? `url('${c.avatar}')` : '';
    detAvatar.style.backgroundSize = 'cover';
    detAvatar.style.backgroundPosition = 'center';
    detAvatar.style.backgroundColor = c.color;
  }
  $('#details-name').textContent = c.name;
  $('#details-handle').textContent = `@${c.username}`;
  $('.about-copy').textContent = c.about || 'Say hello and get to know each other.';
  $('#favorite-btn').innerHTML = c.favorite ? '★ &nbsp; In favorites' : '☆ &nbsp; Add to favorites';
}

export async function selectChat(chatId) {
  const c = getChat(chatId);
  if (!c) return;

  const changed = state.activeChatId !== chatId;
  state.activeChatId = chatId;
  if (changed) {
    clearComposeContext();
    closeChatSearch();
  }

  $('#empty-state').classList.add('hidden');
  $('#thread').classList.remove('hidden');
  $('#conversation').classList.add('mobile-open');

  updatePeerHeader();
  updateTypingBanner();
  renderChats();

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
  }

  if (c.unread > 0) {
    c.unread = 0;
    api.markConversationRead(c.id, state.user.id).then((ts) => {
      if (ts) c.lastReadAt = ts;
    });
    renderChats();
  }

  renderMessages();
  renderSharedMedia();
  callbacks.onChatSelected?.(c.id);
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
    .map((m) => `<button type="button" class="shared-tile" data-shared-id="${esc(m.id)}" data-shared-type="${esc(m.type)}" data-shared-name="${esc(m.name)}" title="${esc(m.name)}">${m.type.startsWith('video/') ? '▶' : '▧'}</button>`)
    .join('')}</div>`;

  box.querySelectorAll('[data-shared-id]').forEach(async (btn) => {
    const id = btn.dataset.sharedId;
    const type = btn.dataset.sharedType;
    const name = btn.dataset.sharedName;
    const url = await api.getAttachmentUrl(id);
    if (!url || !btn.isConnected) return;
    if (type.startsWith('image/')) {
      btn.style.backgroundImage = `url('${url}')`;
      btn.textContent = '';
    }
    btn.onclick = () => openLightbox(url, type, name, id);
  });
}

export function openLightbox(url, mimeType, fileName, attachmentId) {
  const isVideo = mimeType?.startsWith('video/');
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

export function renderMessages({ preserveScroll = false } = {}) {
  const c = getActiveChat();
  const box = $('#messages');
  if (!c || !box) return;

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

  for (const m of c.messages) {
    const dk = dayKey(m.createdAt);
    if (dk && dk !== lastDay) {
      lastDay = dk;
      chunks.push(`<div class="day-label">${esc(formatDayLabel(m.createdAt))}</div>`);
    }

    const mine = m.from === 'me';
    const isMatch = searchTerm && !m.deletedAt && m.text?.toLowerCase().includes(searchTerm.toLowerCase());
    const activeMatchId = state.chatSearch.matchIds[state.chatSearch.activeIndex];
    const isActiveMatch = activeMatchId === m.id;

    let bodyHtml = '';
    if (m.deletedAt) {
      bodyHtml = '<div class="message-bubble deleted-bubble">This message was deleted</div>';
    } else {
      const replyHtml = m.replyPreview
        ? `<button type="button" class="reply-quote" data-jump-msg="${esc(m.replyPreview.id)}"><strong>${esc(m.replyPreview.senderId === state.user.id ? 'You' : c.name)}</strong><span>${esc(m.replyPreview.text)}</span></button>`
        : '';

      let mediaHtml = '';
      if (m.file) {
        if (m.file.isViewOnce) {
          if (mine) {
            mediaHtml = `<div class="view-once-card sent"><span>1×</span><div><strong>View-once ${m.file.type?.startsWith('video/') ? 'video' : m.file.type?.startsWith('image/') ? 'photo' : 'file'}</strong><small>${m.file.downloaded ? 'Opened by recipient' : 'Sent · waiting to open'}</small></div></div>`;
          } else if (m.file.downloaded) {
            mediaHtml = `<div class="view-once-card opened"><span>1×</span><div><strong>Opened</strong><small>View-once media removed</small></div></div>`;
          } else {
            mediaHtml = `<button type="button" class="view-once-card incoming" data-open-vo="${esc(m.id)}"><span>1×</span><div><strong>Tap to view once</strong><small>${esc(m.file.name)} · ${esc(m.file.size)}</small></div></button>`;
          }
        } else if (m.file.type?.startsWith('image/') || m.file.type?.startsWith('video/')) {
          const cached = state.mediaUrlCache.get(m.file.id);
          const url = cached && cached.expiresAt > Date.now() ? cached.url : '';
          if (url) {
            mediaHtml = m.file.type.startsWith('video/')
              ? `<video class="attachment-video" src="${esc(url)}" controls preload="metadata" playsinline></video>`
              : `<img class="attachment-image clickable-media" src="${esc(url)}" alt="${esc(m.file.name)}" data-lightbox-id="${esc(m.file.id)}" data-lightbox-type="${esc(m.file.type)}" data-lightbox-name="${esc(m.file.name)}">`;
          } else {
            mediaHtml = `<div class="media-slot" data-media-id="${esc(m.file.id)}" data-media-type="${esc(m.file.type)}" data-media-name="${esc(m.file.name)}">Loading ${m.file.type.startsWith('video/') ? 'video' : 'photo'}…</div>`;
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
      .map((r) => `<button class="reaction-chip ${r.mine ? 'mine-reaction' : ''}" type="button" data-emoji="${esc(r.emoji)}" data-mine="${r.mine}" data-reaction-message="${esc(m.id)}">${esc(r.emoji)} ${r.count}</button>`)
      .join('');

    const isSeen = mine && c.peerLastReadAt && m.createdAt && new Date(c.peerLastReadAt) >= new Date(m.createdAt);
    const ticks = mine ? (m.pending ? '⏳' : isSeen ? '✓✓' : '✓') : '';

    const toolsHtml = m.deletedAt
      ? ''
      : `
        <div class="message-tools">
          <button type="button" data-react-open="${esc(m.id)}" title="React" aria-label="React"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg></button>
          <button type="button" data-reply="${esc(m.id)}" title="Reply" aria-label="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>
          <button type="button" data-copy="${esc(m.id)}" title="Copy" aria-label="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          ${mine && !m.file ? `<button type="button" data-edit="${esc(m.id)}" title="Edit" aria-label="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>` : ''}
          ${mine ? `<button type="button" data-delete="${esc(m.id)}" title="Delete" aria-label="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>` : ''}
        </div>
      `;

    chunks.push(`
      <div class="message-row ${mine ? 'mine' : 'theirs'} ${isMatch ? 'search-row-match' : ''}" data-msg-id="${esc(m.id)}">
        ${mine ? '' : avatarMarkup(c, 'mini-avatar')}
        <div class="message-wrap">
          ${toolsHtml}
          ${bodyHtml}
          ${reactionsHtml ? `<div class="message-reactions">${reactionsHtml}</div>` : ''}
          <div class="message-meta">${esc(m.time || formatTime(m.createdAt))}${m.editedAt ? ' · edited' : ''} ${ticks}</div>
        </div>
      </div>
    `);
  }

  box.innerHTML = chunks.join('');

  // Load uncached persistent images/videos asynchronously
  box.querySelectorAll('[data-media-id]').forEach(async (slot) => {
    const id = slot.dataset.mediaId;
    const type = slot.dataset.mediaType;
    const name = slot.dataset.mediaName;
    const url = await api.getAttachmentUrl(id);
    if (!slot.isConnected) return;
    if (!url) {
      slot.textContent = `${name} (unavailable)`;
      return;
    }
    if (type.startsWith('video/')) {
      slot.outerHTML = `<video class="attachment-video" src="${esc(url)}" controls preload="metadata" playsinline></video>`;
    } else {
      const img = document.createElement('img');
      img.className = 'attachment-image clickable-media';
      img.src = url;
      img.alt = name;
      img.onclick = () => openLightbox(url, type, name, id);
      slot.replaceWith(img);
    }
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

  box.querySelectorAll('[data-react-open]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openInlineReactionPicker(btn, btn.dataset.reactOpen);
    };
  });

  box.querySelectorAll('[data-reaction-message]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.toggleReaction(btn.dataset.reactionMessage, btn.dataset.emoji, btn.dataset.mine === 'true');
      } catch (error) {
        showToast(error.message || 'Reaction failed');
      }
    };
  });

  box.querySelectorAll('[data-reply]').forEach((btn) => {
    btn.onclick = () => {
      const msg = c.messages.find((x) => x.id === btn.dataset.reply);
      if (!msg) return;
      state.editingMessage = null;
      state.replyingTo = {
        id: msg.id,
        senderName: msg.from === 'me' ? 'You' : c.name,
        text: msg.text || msg.file?.name || 'Attachment',
      };
      renderComposeContext();
      $('#message-input')?.focus();
    };
  });

  box.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const msg = c.messages.find((x) => x.id === btn.dataset.edit);
      if (!msg || msg.deletedAt || msg.file) return;
      state.replyingTo = null;
      state.editingMessage = { id: msg.id, conversationId: c.id, text: msg.text };
      renderComposeContext();
      const input = $('#message-input');
      if (input) {
        input.value = msg.text;
        input.focus();
      }
    };
  });

  box.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.deleteMessage(btn.dataset.delete);
      } catch (error) {
        showToast(error.message || 'Could not delete message');
      }
    };
  });

  box.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const msg = c.messages.find((x) => x.id === btn.dataset.copy);
      try {
        await navigator.clipboard.writeText(msg?.text || msg?.file?.name || '');
        showToast('Copied to clipboard');
      } catch {
        showToast('Copy is unavailable here');
      }
    };
  });

  box.querySelectorAll('[data-jump-msg]').forEach((btn) => {
    btn.onclick = () => {
      const target = box.querySelector(`[data-msg-id="${CSS.escape(btn.dataset.jumpMsg)}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
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

  if (preserveScroll) {
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  } else {
    box.scrollTop = box.scrollHeight;
  }
}

function openInlineReactionPicker(anchorBtn, messageId) {
  $$('.reaction-picker-pop').forEach((el) => el.remove());
  const picker = document.createElement('div');
  picker.className = 'reaction-picker-pop';
  picker.innerHTML = REACTION_PALETTE.map((emoji) => `<button type="button">${emoji}</button>`).join('');
  anchorBtn.closest('.message-wrap')?.append(picker);

  const c = getActiveChat();
  const msg = c?.messages.find((m) => m.id === messageId);

  picker.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const emoji = btn.textContent;
      const existing = msg?.reactions?.find((r) => r.emoji === emoji);
      picker.remove();
      try {
        await api.toggleReaction(messageId, emoji, Boolean(existing?.mine));
      } catch (err) {
        showToast(err.message || 'Could not save reaction');
      }
    };
  });

  const dismiss = () => {
    picker.remove();
    document.removeEventListener('click', dismiss);
  };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

export function renderComposeContext() {
  const bar = $('#compose-context');
  if (!bar) return;
  if (state.editingMessage) {
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <div class="compose-ctx-text"><strong>Editing message</strong><span>${esc(state.editingMessage.text)}</span></div>
      <button type="button" class="compose-ctx-close" id="compose-ctx-cancel" aria-label="Cancel">×</button>
    `;
    $('#compose-ctx-cancel', bar).onclick = () => {
      clearComposeContext();
      const input = $('#message-input');
      if (input) input.value = '';
    };
  } else if (state.replyingTo) {
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <div class="compose-ctx-text"><strong>Replying to ${esc(state.replyingTo.senderName)}</strong><span>${esc(state.replyingTo.text)}</span></div>
      <button type="button" class="compose-ctx-close" id="compose-ctx-cancel" aria-label="Cancel">×</button>
    `;
    $('#compose-ctx-cancel', bar).onclick = clearComposeContext;
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
  const input = $('#chat-search-input');
  input?.focus();
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
