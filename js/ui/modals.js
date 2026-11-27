import * as api from '../api.js';
import { searchEmojis } from '../emoji.js?v=28';
import {
  getNativeCapabilities,
  isNativeAndroid,
  isNativeWindows,
  openNativeBubbleSettings,
  openNativeNotificationSettings,
  requestIgnoreBatteryOptimizations,
  requestNativeNotifications,
  sendNativeTestNotification,
  setNativeBackgroundSync,
  setWindowsMinimizeToTray,
  setWindowsStartup,
} from '../native.js?v=28';
import {
  CHAT_THEME_PRESETS,
  DEFAULT_DOUBLE_TAP_EMOJI,
  DEFAULT_REACTION_PALETTE,
  getDisplayName,
  getEffectiveChatTheme,
  resetChatTheme,
  resetPerChatTheme,
  setChatTheme,
  setDoubleTapEmoji,
  setFriendNickname,
  setPerChatTheme,
  setReactionPalette,
  state,
} from '../state.js';
import { $, avatarMarkup, closeModal, esc, openModal, popUiLayer, pushUiLayer, showToast } from '../utils.js';
import { renderChats, selectChat } from './chat.js';

const PANEL_CONFIGS = {
  requests: { pageId: '#requests-page', tabId: '#requests-tab' },
  people: { pageId: '#people-page', tabId: '#contacts-tab' },
  settings: { pageId: '#settings-page', tabId: '#settings-open' },
};

let lastRequestsTab = 'incoming';
let lastRefreshCb = null;

export function getActiveWorkspacePanel() {
  for (const [key, cfg] of Object.entries(PANEL_CONFIGS)) {
    const el = $(cfg.pageId);
    if (el && !el.classList.contains('hidden')) return key;
  }
  return null;
}

function activateWorkspacePanel(key) {
  const hadPanel = Boolean(getActiveWorkspacePanel());
  Object.entries(PANEL_CONFIGS).forEach(([k, cfg]) => {
    const el = $(cfg.pageId);
    const tab = $(cfg.tabId);
    const active = k === key;
    el?.classList.toggle('hidden', !active);
    tab?.classList.toggle('selected', active);
  });
  $('#chats-tab')?.classList.remove('selected');
  $('.workspace')?.classList.add('panel-open');
  $('.workspace')?.classList.toggle('settings-open', key === 'settings');
  if (!hadPanel) pushUiLayer(key);
}

export function closeWorkspacePanel(fromPop = false) {
  if (!getActiveWorkspacePanel()) return;
  Object.values(PANEL_CONFIGS).forEach((cfg) => {
    $(cfg.pageId)?.classList.add('hidden');
    $(cfg.tabId)?.classList.remove('selected');
  });
  $('.workspace')?.classList.remove('panel-open', 'settings-open');
  $('#chats-tab')?.classList.add('selected');
  if (!fromPop) popUiLayer();
}

export function closeAvatarLightbox(fromPop = false) {
  const existing = document.querySelector('dialog.avatar-lightbox-dialog');
  if (!existing) return;
  existing.dataset.closingFromPop = fromPop ? '1' : '';
  if (existing.open) existing.close();
  existing.remove();
  if (!fromPop) popUiLayer();
}

export function openAvatarLightbox(person) {
  if (!person) return;
  closeAvatarLightbox(true);
  pushUiLayer('avatar');

  const dialog = document.createElement('dialog');
  dialog.className = 'avatar-lightbox-dialog';
  dialog.innerHTML = `
    <div class="avatar-lightbox-card">
      <button type="button" class="avatar-lightbox-close" aria-label="Close photo">×</button>
      <div class="avatar-lightbox-media">
        ${person.avatar
          ? `<img src="${esc(person.avatar)}" alt="${esc(person.name || '')}">`
          : `<div class="avatar-lightbox-fallback" style="background:${esc(person.color || '#dce8e2')}">${esc(person.initial || (person.name || '?').slice(0, 2).toUpperCase())}</div>`}
      </div>
      <div class="avatar-lightbox-caption">
        <strong>${esc(person.name || 'Whisper user')}</strong>
        ${person.username ? `<small>@${esc(person.username)}</small>` : ''}
      </div>
    </div>
  `;

  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeAvatarLightbox();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('.avatar-lightbox-close')) {
      closeAvatarLightbox();
    }
  });

  document.body.append(dialog);
  dialog.showModal();
}

function panelBackButtonHtml() {
  return `
    <button type="button" class="settings-back-btn" data-panel-back aria-label="Back to chats">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
    </button>
  `;
}

export function openRequestsPage(activeTab = lastRequestsTab, onRefreshInbox = lastRefreshCb) {
  lastRequestsTab = activeTab === 'outgoing' ? 'outgoing' : 'incoming';
  if (onRefreshInbox) lastRefreshCb = onRefreshInbox;

  const page = $('#requests-page');
  if (!page) return;
  activateWorkspacePanel('requests');

  const incoming = state.incomingRequests || [];
  const outgoing = state.outgoingRequests || [];
  const list = lastRequestsTab === 'incoming' ? incoming : outgoing;

  page.innerHTML = `
    <div class="settings-page-inner">
      <div class="settings-page-head">
        ${panelBackButtonHtml()}
        <div>
          <h2>Friend requests</h2>
          <p>Confirm incoming requests or manage requests you sent.</p>
        </div>
      </div>

      <div class="settings-card panel-card-padded">
        <div class="modal-tabs" style="margin:0 0 12px">
          <button type="button" class="modal-tab ${lastRequestsTab === 'incoming' ? 'active' : ''}" data-req-tab="incoming">Incoming (${incoming.length})</button>
          <button type="button" class="modal-tab ${lastRequestsTab === 'outgoing' ? 'active' : ''}" data-req-tab="outgoing">Sent (${outgoing.length})</button>
        </div>
        <div class="people-results panel-results-list">
          ${list.length
            ? list
                .map((r) => `
                  <div class="request-card">
                    ${avatarMarkup(r)}
                    <div class="request-person">
                      <strong>${esc(r.name)}</strong>
                      <small>@${esc(r.username)} · ${esc(r.text)}</small>
                    </div>
                    ${lastRequestsTab === 'incoming'
                      ? `<button type="button" class="accept" data-accept="${esc(r.id)}">Confirm</button><button type="button" data-decline="${esc(r.id)}" aria-label="Decline">×</button>`
                      : `<button type="button" data-cancel="${esc(r.id)}">Cancel</button>`}
                  </div>
                `)
                .join('')
            : `<p class="people-empty">${lastRequestsTab === 'incoming' ? 'No incoming friend requests.' : 'No pending sent requests.'}</p>`}
        </div>
      </div>
    </div>
  `;

  page.querySelector('[data-panel-back]').onclick = () => closeWorkspacePanel();

  page.querySelectorAll('[data-req-tab]').forEach((btn) => {
    btn.onclick = () => openRequestsPage(btn.dataset.reqTab, onRefreshInbox);
  });

  page.querySelectorAll('[data-accept]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const convId = await api.acceptContactRequest(btn.dataset.accept);
        await onRefreshInbox?.();
        closeWorkspacePanel();
        if (convId) await selectChat(convId);
        showToast('Friend request accepted');
      } catch (error) {
        btn.disabled = false;
        showToast(error.message || 'Request could not be accepted');
      }
    };
  });

  page.querySelectorAll('[data-decline]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.declineContactRequest(btn.dataset.decline);
        await onRefreshInbox?.();
        openRequestsPage('incoming', onRefreshInbox);
        showToast('Request declined');
      } catch (error) {
        btn.disabled = false;
        showToast(error.message || 'Request could not be declined');
      }
    };
  });

  page.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.cancelFriendRequest(btn.dataset.cancel);
        await onRefreshInbox?.();
        openRequestsPage('outgoing', onRefreshInbox);
        showToast('Friend request cancelled');
      } catch (error) {
        btn.disabled = false;
        showToast(error.message || 'Could not cancel request');
      }
    };
  });
}

export function refreshRequestsPageIfOpen() {
  if (getActiveWorkspacePanel() === 'requests') {
    openRequestsPage(lastRequestsTab, lastRefreshCb);
  }
}

export function openPeoplePage(onRefreshInbox = lastRefreshCb) {
  if (onRefreshInbox) lastRefreshCb = onRefreshInbox;
  const page = $('#people-page');
  if (!page) return;
  activateWorkspacePanel('people');

  page.innerHTML = `
    <div class="settings-page-inner">
      <div class="settings-page-head">
        ${panelBackButtonHtml()}
        <div>
          <h2>Find people</h2>
          <p>Search by display name or @username to add friends.</p>
        </div>
      </div>

      <div class="settings-card panel-card-padded">
        <label class="field-label" for="people-search" style="margin-top:4px">Search people</label>
        <input class="field" id="people-search" placeholder="Name or @username" autocomplete="off" maxlength="48">
        <div class="people-results panel-results-list" id="people-results" aria-live="polite" style="margin-top:14px">
          <div class="people-empty">Type at least two characters to search.</div>
        </div>
      </div>
    </div>
  `;

  page.querySelector('[data-panel-back]').onclick = () => closeWorkspacePanel();

  const input = $('#people-search', page);
  const results = $('#people-results', page);
  let searchTimer = 0;
  let searchRun = 0;

  const draw = (people) => {
    results.innerHTML = people.length
      ? people
          .map((person) => {
            let action = '';
            if (person.relationship === 'friend') {
              const convId = person.conversationId || state.chats.find((c) => c.peerId === person.id)?.id;
              action = convId
                ? `<button class="people-action" type="button" data-open-conv="${esc(convId)}">Message</button>`
                : '<span class="people-status">Friends</span>';
            } else if (person.relationship === 'outgoing') {
              action = person.requestId
                ? `<button class="people-action" type="button" data-cancel-person="${esc(person.requestId)}">Cancel sent</button>`
                : '<span class="people-status">Request sent</span>';
            } else if (person.relationship === 'incoming') {
              action = `<button class="people-action accept" type="button" data-accept-person="${esc(person.requestId)}">Confirm</button>`;
            } else {
              action = `<button class="people-action" type="button" data-add-person="${esc(person.id)}">${person.relationship === 'declined' ? 'Send again' : 'Add friend'}</button>`;
            }
            return `
              <div class="people-card">
                ${avatarMarkup(person)}
                <div class="request-person">
                  <strong>${esc(person.name)}</strong>
                  <small>@${esc(person.username)}${person.about ? ` · ${esc(person.about)}` : ''}</small>
                </div>
                ${action}
              </div>
            `;
          })
          .join('')
      : '<div class="people-empty">No people found. Try a name or username.</div>';

    results.querySelectorAll('[data-add-person]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const res = await api.sendFriendRequest(btn.dataset.addPerson);
          await onRefreshInbox?.();
          if (res?.status === 'accepted' || res?.status === 'already_friends') {
            closeWorkspacePanel();
            if (res.conversation_id) await selectChat(res.conversation_id);
            showToast(res.status === 'accepted' ? 'Mutual request accepted — chat opened!' : 'Opened existing chat');
            return;
          }
          showToast('Friend request sent');
          lookup();
        } catch (error) {
          btn.disabled = false;
          showToast(error.message || 'Friend request could not be sent');
        }
      };
    });

    results.querySelectorAll('[data-cancel-person]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api.cancelFriendRequest(btn.dataset.cancelPerson);
          await onRefreshInbox?.();
          showToast('Friend request cancelled');
          lookup();
        } catch (error) {
          btn.disabled = false;
          showToast(error.message || 'Could not cancel request');
        }
      };
    });

    results.querySelectorAll('[data-accept-person]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const convId = await api.acceptContactRequest(btn.dataset.acceptPerson);
          await onRefreshInbox?.();
          closeWorkspacePanel();
          if (convId) await selectChat(convId);
          showToast('Friend request accepted');
        } catch (error) {
          btn.disabled = false;
          showToast(error.message || 'Friend request could not be accepted');
        }
      };
    });

    results.querySelectorAll('[data-open-conv]').forEach((btn) => {
      btn.onclick = async () => {
        const convId = btn.dataset.openConv;
        closeWorkspacePanel();
        await onRefreshInbox?.();
        await selectChat(convId);
      };
    });
  };

  const lookup = async () => {
    const term = input.value.trim();
    const run = ++searchRun;
    if (term.replace(/^@/, '').length < 2) {
      results.innerHTML = '<div class="people-empty">Type at least two characters to search.</div>';
      return;
    }
    results.innerHTML = '<div class="people-empty">Searching…</div>';
    try {
      const people = await api.searchPeople(term);
      if (run === searchRun && input.isConnected) draw(people);
    } catch (error) {
      if (run === searchRun) {
        results.innerHTML = `<div class="people-empty people-error">${esc(error.message || 'People search failed.')}</div>`;
      }
    }
  };

  input.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(lookup, 220);
  };
  if (window.innerWidth > 700) setTimeout(() => input?.focus(), 30);
}

function prepareAvatarUpload(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(file);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(file);
      img.onload = () => {
        const maxEdge = 900;
        const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || 1) * scale));
        const h = Math.max(1, Math.round((img.height || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(file);
              return;
            }
            resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.86,
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function openProfileModal(onProfileUpdated) {
  let stagedFile = null;
  let previewObjectUrl = '';

  openModal(`
    <h2>Your profile</h2>
    <p>This name and photo appear in your conversations.</p>
    <div class="profile-avatar-hero">
      <button type="button" class="avatar-click-btn" id="profile-avatar-preview" aria-label="View your profile photo">
        ${avatarMarkup(state.user, 'avatar-large')}
      </button>
      <small>Tap photo to enlarge</small>
    </div>
    <label class="field-label">Display name</label>
    <input class="field" id="profile-name-input" maxlength="48" value="${esc(state.user.name)}">
    <label class="field-label">Username</label>
    <input class="field" value="@${esc(state.user.username)}" disabled>
    <label class="field-label">About</label>
    <input class="field" id="profile-about" maxlength="160" value="${esc(state.user.about)}">
    <label class="field-label">Profile photo</label>
    <div class="profile-photo-picker">
      <input id="profile-photo" type="file" accept="image/*" hidden>
      <button type="button" class="secondary-btn" id="profile-photo-pick-btn">Choose photo</button>
      <span class="profile-photo-name" id="profile-photo-name">${state.user.avatar ? 'Current photo active' : 'No photo selected'}</span>
    </div>
    <div class="field-help">Large photos are automatically cropped and compressed on upload.</div>
    <div class="modal-actions">
      <button class="secondary-btn" value="cancel">Cancel</button>
      <button class="primary-btn" type="button" id="save-profile">Save changes</button>
    </div>
  `);

  $('#profile-avatar-preview')?.addEventListener('click', () => {
    openAvatarLightbox(previewObjectUrl ? { ...state.user, avatar: previewObjectUrl } : state.user);
  });

  $('#profile-photo-pick-btn')?.addEventListener('click', () => $('#profile-photo')?.click());

  $('#profile-photo')?.addEventListener('change', (e) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    if (picked.size > 12 * 1024 * 1024) {
      showToast('Source photo must be 12 MB or smaller');
      e.target.value = '';
      return;
    }
    stagedFile = picked;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(picked);
    const previewBtn = $('#profile-avatar-preview');
    if (previewBtn) {
      previewBtn.innerHTML = `<span class="avatar avatar-large" style="background-image:url('${esc(previewObjectUrl)}');background-size:cover;background-position:center"></span>`;
    }
    const nameEl = $('#profile-photo-name');
    if (nameEl) nameEl.textContent = picked.name;
  });

  $('#save-profile').onclick = async () => {
    const displayName = $('#profile-name-input').value.trim();
    const about = $('#profile-about').value.trim();
    if (!displayName) {
      showToast('Display name is required');
      return;
    }
    $('#save-profile').disabled = true;
    $('#save-profile').textContent = stagedFile ? 'Optimizing…' : 'Saving…';
    try {
      const uploadFile = stagedFile ? await prepareAvatarUpload(stagedFile) : null;
      const updated = await api.updateProfile({ displayName, about, file: uploadFile });
      state.user.name = updated.display_name;
      state.user.about = updated.about;
      state.user.avatar = updated.avatar;
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      onProfileUpdated?.();
      closeModal();
      showToast('Profile updated');
    } catch (error) {
      $('#save-profile').disabled = false;
      $('#save-profile').textContent = 'Save changes';
      showToast(error.message || 'Profile could not be saved');
    }
  };
}

export function openNicknameModal(chat, onUpdated) {
  if (!chat?.peerId) return;
  const currentNick = String(state.nicknames?.[chat.peerId] || '');
  openModal(`
    <h2>Nickname</h2>
    <p>Only visible to you for <b>${esc(chat.name)}</b> (@${esc(chat.username)}).</p>
    <label class="field-label" for="nickname-modal-input">Custom nickname</label>
    <input class="field" id="nickname-modal-input" maxlength="48" placeholder="${esc(chat.name)}" value="${esc(currentNick)}">
    <div class="modal-actions">
      ${currentNick ? '<button class="secondary-btn" type="button" id="nickname-clear-btn">Clear</button>' : '<button class="secondary-btn" value="cancel">Cancel</button>'}
      <button class="primary-btn" type="button" id="nickname-save-btn">Save nickname</button>
    </div>
  `);

  const input = $('#nickname-modal-input');
  setTimeout(() => {
    input?.focus();
    input?.select();
  }, 40);

  $('#nickname-clear-btn')?.addEventListener('click', () => {
    setFriendNickname(chat.peerId, '');
    onUpdated?.();
    closeModal();
    showToast('Nickname cleared');
  });

  $('#nickname-save-btn').onclick = () => {
    const val = input?.value.trim() || '';
    setFriendNickname(chat.peerId, val);
    onUpdated?.();
    closeModal();
    showToast(val ? `Nickname set to "${val}"` : 'Nickname cleared');
  };
}

export function openChatThemeModal(chat, onThemeChange) {
  if (!chat?.id) return;
  const t = getEffectiveChatTheme(chat.id);
  const label = getDisplayName(chat);
  openModal(`
    <h2>Chat theme · ${esc(label)}</h2>
    <p>Customize bubble colors and wallpaper just for this conversation.</p>
    <div class="chat-theme-preview" id="m-ctp-preview">
      <div class="chat-theme-preview-dim" id="m-ctp-dim"></div>
      <div class="ctp-bubble theirs" id="m-ctp-theirs">Hey, loving this vibe!</div>
      <div class="ctp-bubble mine" id="m-ctp-mine">Just for our chat ✨</div>
    </div>
    <div class="theme-presets" id="m-ctp-presets">
      ${CHAT_THEME_PRESETS.map((p) => `<button type="button" class="theme-preset-pill" data-m-preset="${esc(p.id)}">${esc(p.label)}</button>`).join('')}
    </div>
    <div class="settings-row">
      <span>Your bubble<small>Outgoing tint</small></span>
      <input type="color" class="color-swatch-input" id="m-mine-color" value="${esc(t.mineBg || '#70a993')}">
    </div>
    <div class="settings-row">
      <span>Their bubble<small>Incoming tint</small></span>
      <input type="color" class="color-swatch-input" id="m-theirs-color" value="${esc(t.theirsBg || '#ffffff')}">
    </div>
    <div class="settings-row">
      <span>Wallpaper<small id="m-bg-status">${t.bgImage ? 'Custom photo active' : 'Optional chat background'}</small></span>
      <div style="display:flex;gap:8px;flex:none">
        <input type="file" id="m-bg-file" accept="image/*" hidden>
        <button type="button" class="secondary-btn" id="m-bg-upload">Choose photo</button>
        <button type="button" class="secondary-btn ${t.bgImage ? '' : 'hidden'}" id="m-bg-clear">Remove</button>
      </div>
    </div>
    <div class="settings-row">
      <span>Wallpaper dim<small>Keep text crisp</small></span>
      <input type="range" id="m-bg-dim" min="0" max="75" value="${Math.round((t.bgDim ?? 0.22) * 100)}" style="width:110px">
    </div>
    <div class="modal-actions">
      <button class="secondary-btn" type="button" id="m-theme-reset">Use global default</button>
      <button class="primary-btn" value="cancel">Done</button>
    </div>
  `);

  const syncModalPreview = () => {
    const cur = getEffectiveChatTheme(chat.id);
    const prev = $('#m-ctp-preview');
    const dimEl = $('#m-ctp-dim');
    const mineEl = $('#m-ctp-mine');
    const theirsEl = $('#m-ctp-theirs');
    if (prev) {
      prev.style.backgroundImage = cur.bgImage ? `url("${cur.bgImage}")` : '';
      prev.classList.toggle('has-bg', Boolean(cur.bgImage));
    }
    if (dimEl) dimEl.style.opacity = cur.bgImage ? String(cur.bgDim ?? 0.22) : '0';
    if (mineEl) {
      mineEl.style.background = cur.mineBg || '';
      mineEl.style.color = cur.mineText || '';
    }
    if (theirsEl) {
      theirsEl.style.background = cur.theirsBg || '';
      theirsEl.style.color = cur.theirsText || '';
    }
    const bgStatus = $('#m-bg-status');
    const bgClear = $('#m-bg-clear');
    if (bgStatus) bgStatus.textContent = cur.bgImage ? 'Custom photo active' : 'Optional chat background';
    if (bgClear) bgClear.classList.toggle('hidden', !cur.bgImage);
    document.querySelectorAll('[data-m-preset]').forEach((pill) => {
      const p = CHAT_THEME_PRESETS.find((x) => x.id === pill.dataset.mPreset);
      pill.classList.toggle('active', Boolean(p && (cur.mineBg || '') === p.mineBg && (cur.theirsBg || '') === p.theirsBg));
    });
    onThemeChange?.();
  };

  syncModalPreview();

  document.querySelectorAll('[data-m-preset]').forEach((pill) => {
    pill.onclick = () => {
      const p = CHAT_THEME_PRESETS.find((x) => x.id === pill.dataset.mPreset);
      if (!p) return;
      setPerChatTheme(chat.id, { mineBg: p.mineBg, theirsBg: p.theirsBg });
      syncModalPreview();
    };
  });

  $('#m-mine-color').oninput = (e) => {
    setPerChatTheme(chat.id, { mineBg: e.target.value });
    syncModalPreview();
  };
  $('#m-theirs-color').oninput = (e) => {
    setPerChatTheme(chat.id, { theirsBg: e.target.value });
    syncModalPreview();
  };
  $('#m-bg-upload').onclick = () => $('#m-bg-file')?.click();
  $('#m-bg-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressWallpaperImage(file);
      setPerChatTheme(chat.id, { bgImage: dataUrl });
      syncModalPreview();
      showToast('Chat wallpaper updated');
    } catch (error) {
      showToast(error.message || 'Could not apply wallpaper');
    }
    e.target.value = '';
  };
  $('#m-bg-clear').onclick = () => {
    setPerChatTheme(chat.id, { bgImage: '' });
    syncModalPreview();
    showToast('Chat wallpaper removed');
  };
  $('#m-bg-dim').oninput = (e) => {
    setPerChatTheme(chat.id, { bgDim: Number(e.target.value) / 100 });
    syncModalPreview();
  };
  $('#m-theme-reset').onclick = () => {
    resetPerChatTheme(chat.id);
    syncModalPreview();
    showToast('Restored default chat theme');
  };
}

export function isSettingsPageOpen() {
  return getActiveWorkspacePanel() === 'settings';
}

function renderNotificationSettingsInner() {
  if (isNativeAndroid()) {
    const caps = getNativeCapabilities() || {};
    const granted = Boolean(caps.notificationsGranted);
    return `
      <span>Android notifications<small id="android-notif-status">${granted ? 'Native Android notifications & Quick Reply enabled' : 'Notification permission required for alerts'}</small></span>
      <div style="display:flex;gap:8px;flex:none">
        <button class="secondary-btn" type="button" id="notify-enable">${granted ? 'Manage' : 'Enable'}</button>
        ${granted ? '<button class="secondary-btn" type="button" id="notify-test-btn">Test</button>' : ''}
      </div>
    `;
  }
  if (isNativeWindows()) {
    return `
      <span>Windows notifications<small>Native Windows Toast alerts with Quick Reply</small></span>
      <button class="secondary-btn" type="button" id="notify-test-btn">Test toast</button>
    `;
  }
  return `
    <span>Desktop &amp; push notifications<small>Alerts when Whisper is in the background</small></span>
    <button class="secondary-btn" type="button" id="notify-enable">Enable</button>
  `;
}

function renderPlatformExtraSettings() {
  if (isNativeAndroid()) {
    const caps = getNativeCapabilities() || {};
    const bgOn = Boolean(caps.backgroundSyncEnabled);
    const batteryOptimized = Boolean(caps.batteryOptimized);
    const bubblesOn = caps.bubblesEnabled !== false;
    return `
      <div class="settings-row">
        <span>Floating chat bubbles<small id="android-bubbles-status">${bubblesOn ? 'Android floating chat bubbles allowed' : 'Enable bubbles in Android system settings'}</small></span>
        <button class="secondary-btn" type="button" id="android-bubbles-btn">Manage</button>
      </div>
      <div class="settings-row">
        <span>Instant background socket<small>Keep a persistent connection (shows in Active apps). Periodic silent checks always run.</small></span>
        <input type="checkbox" id="android-bg-toggle" ${bgOn ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <span>Battery optimization<small id="android-battery-status">${batteryOptimized ? 'Battery saver may delay background alerts' : 'Unrestricted background delivery enabled'}</small></span>
        <button class="secondary-btn" type="button" id="android-battery-btn">${batteryOptimized ? 'Allow background' : 'Settings'}</button>
      </div>
    `;
  }
  if (isNativeWindows()) {
    const caps = getNativeCapabilities() || {};
    return `
      <div class="settings-row">
        <span>Launch on Windows startup<small>Start Whisper automatically when you sign into Windows</small></span>
        <input type="checkbox" id="win-startup-toggle" ${caps.launchOnStartup ? 'checked' : ''}>
      </div>
      <div class="settings-row">
        <span>Keep running in system tray<small>Closing the window keeps Whisper listening in the tray</small></span>
        <input type="checkbox" id="win-tray-toggle" ${caps.minimizeToTray !== false ? 'checked' : ''}>
      </div>
    `;
  }
  return '';
}

export function closeSettingsPage(fromPop = false) {
  closeWorkspacePanel(fromPop);
}

function compressWallpaperImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read selected image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file'));
      img.onload = () => {
        const maxEdge = 1280;
        const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || 1) * scale));
        const h = Math.max(1, Math.round((img.height || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export async function openSettingsPage({ onThemeChange, onChatThemeChange, onSignOut }) {
  const page = $('#settings-page');
  if (!page) return;
  activateWorkspacePanel('settings');

  const palette = state.reactionPalette?.length ? state.reactionPalette : [...DEFAULT_REACTION_PALETTE];
  const doubleTap = state.doubleTapEmoji || DEFAULT_DOUBLE_TAP_EMOJI;
  const ct = state.chatTheme || {};

  page.innerHTML = `
    <div class="settings-page-inner">
      <div class="settings-page-head">
        <button type="button" class="settings-back-btn" id="settings-back-btn" aria-label="Back to chats">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div>
          <h2>Settings</h2>
          <p>Make Whisper feel like yours.</p>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Appearance &amp; Alerts</div>
        <div class="settings-row">
          <span>Appearance<small>Choose a visual style</small></span>
          <select id="theme-select" class="field" style="width:135px;padding:8px">
            <option value="aero">Windows Aero</option>
            <option value="minimal">Minimal</option>
            <option value="dark">Dark mode</option>
          </select>
        </div>
        <div class="settings-row" id="notify-settings-block">
          ${renderNotificationSettingsInner()}
        </div>
        ${renderPlatformExtraSettings()}
        <div class="settings-row">
          <span>Sound alerts<small>Play a tone for new messages</small></span>
          <input type="checkbox" id="sound-toggle" ${state.soundEnabled ? 'checked' : ''}>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Chat Theme</div>
        <div class="chat-theme-preview" id="chat-theme-preview">
          <div class="chat-theme-preview-dim" id="chat-theme-preview-dim"></div>
          <div class="ctp-bubble theirs" id="ctp-theirs">Hey, loving the new look!</div>
          <div class="ctp-bubble mine" id="ctp-mine">Wait till you try custom wallpapers ✨</div>
        </div>
        <div class="theme-presets" id="chat-theme-presets">
          ${CHAT_THEME_PRESETS.map((p) => {
            const active = (ct.mineBg || '') === p.mineBg && (ct.theirsBg || '') === p.theirsBg;
            return `<button type="button" class="theme-preset-pill ${active ? 'active' : ''}" data-theme-preset="${esc(p.id)}">${esc(p.label)}</button>`;
          }).join('')}
        </div>
        <div class="settings-row">
          <span>Your bubble color<small>Outgoing messages tint</small></span>
          <input type="color" class="color-swatch-input" id="chat-mine-color" value="${esc(ct.mineBg || '#70a993')}">
        </div>
        <div class="settings-row">
          <span>Their bubble color<small>Incoming messages tint</small></span>
          <input type="color" class="color-swatch-input" id="chat-theirs-color" value="${esc(ct.theirsBg || '#ffffff')}">
        </div>
        <div class="settings-row">
          <span>Chat wallpaper<small id="chat-bg-status">${ct.bgImage ? 'Custom background photo active' : 'Optional image behind conversations'}</small></span>
          <div style="display:flex;gap:8px;flex:none">
            <input type="file" id="chat-bg-file" accept="image/*" hidden>
            <button type="button" class="secondary-btn" id="chat-bg-upload">Choose photo</button>
            <button type="button" class="secondary-btn ${ct.bgImage ? '' : 'hidden'}" id="chat-bg-clear">Remove</button>
          </div>
        </div>
        <div class="settings-row">
          <span>Wallpaper dim<small>Keep chat text easy to read</small></span>
          <input type="range" id="chat-bg-dim" min="0" max="75" value="${Math.round((ct.bgDim ?? 0.22) * 100)}" style="width:120px">
        </div>
        <div class="settings-row">
          <span>Reset chat theme<small>Restore default Whisper bubbles and background</small></span>
          <button type="button" class="secondary-btn" id="reset-chat-theme-btn">Reset</button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Reactions</div>
        <div class="settings-row">
          <span>Double-tap reaction<small>Tap twice quickly on any message</small></span>
          <button type="button" class="reaction-slot-btn" id="double-tap-emoji-btn" aria-label="Customize double-tap reaction">${esc(doubleTap)}</button>
        </div>
        <div class="settings-row settings-row-stack">
          <div class="settings-row-head">
            <span>Press &amp; hold reaction bar<small>Tap any slot below to replace its emoji</small></span>
            <button type="button" class="secondary-btn" id="reset-reactions-btn">Reset</button>
          </div>
          <div class="reaction-slots" id="reaction-slots">
            ${palette.map((emoji, idx) => `<button type="button" class="reaction-slot-btn" data-palette-slot="${idx}" aria-label="Reaction slot ${idx + 1}">${esc(emoji)}</button>`).join('')}
          </div>
          <div class="settings-emoji-picker hidden" id="settings-emoji-picker">
            <div class="settings-emoji-picker-head">
              <span id="settings-emoji-target-label">Pick an emoji</span>
              <button type="button" class="secondary-btn" id="settings-emoji-close">Close</button>
            </div>
            <div class="settings-emoji-custom-row">
              <input id="settings-emoji-search" class="field" type="search" placeholder="Search or paste any emoji…" autocomplete="off">
              <button type="button" class="primary-btn" id="settings-emoji-use">Use</button>
            </div>
            <div class="emoji-grid settings-emoji-grid" id="settings-emoji-grid"></div>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Security &amp; Recovery</div>
        <div class="settings-row">
          <span>Two-factor authentication<small id="mfa-status-text">Checking…</small></span>
          <button class="secondary-btn" type="button" id="mfa-toggle-btn" disabled>…</button>
        </div>
        <div id="mfa-enroll-area" class="hidden"></div>
        <div class="settings-row">
          <span>Backup recovery codes<small id="backup-status-text">Checking…</small></span>
          <button class="secondary-btn" type="button" id="backup-gen-btn" disabled>Generate</button>
        </div>
        <div id="backup-codes-area" class="hidden"></div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Account</div>
        <div class="settings-row">
          <div class="account-row-user">
            <button type="button" class="avatar-click-btn" id="settings-own-avatar" aria-label="View your profile photo">
              ${avatarMarkup(state.user)}
            </button>
            <span>${esc(state.user.name || state.user.username)}<small>@${esc(state.user.username)}</small></span>
          </div>
          <button class="secondary-btn" type="button" id="sign-out">Sign out</button>
        </div>
      </div>
    </div>
  `;

  $('#settings-back-btn', page).onclick = () => closeSettingsPage();
  $('#settings-own-avatar', page)?.addEventListener('click', () => openAvatarLightbox(state.user));

  const themeSelect = $('#theme-select', page);
  themeSelect.value = state.user.theme;
  themeSelect.onchange = (e) => onThemeChange?.(e.target.value);

  $('#sound-toggle', page).onchange = (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem('whisper-sound', state.soundEnabled ? 'true' : 'false');
    renderChats();
  };

  const wirePlatformSettings = () => {
    const notifyBtn = $('#notify-enable', page);
    if (notifyBtn) {
      notifyBtn.onclick = async () => {
        if (isNativeAndroid()) {
          const caps = getNativeCapabilities() || {};
          if (caps.notificationsGranted) {
            openNativeNotificationSettings();
          } else {
            requestNativeNotifications();
          }
          return;
        }
        if (!('Notification' in window)) {
          showToast('Notifications are not supported in this browser');
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          const pushed = await api.registerWebPush().catch(() => false);
          showToast(pushed ? 'Background push notifications enabled' : 'Browser notifications enabled');
        } else {
          showToast('Permission was not granted');
        }
      };
    }

    const testBtn = $('#notify-test-btn', page);
    if (testBtn) {
      testBtn.onclick = () => {
        sendNativeTestNotification();
        showToast('Sent native test notification');
      };
    }

    const bgToggle = $('#android-bg-toggle', page);
    if (bgToggle) {
      bgToggle.onchange = (e) => {
        setNativeBackgroundSync(e.target.checked);
        showToast(e.target.checked ? 'Android background listener enabled' : 'Android background listener paused');
      };
    }

    const batteryBtn = $('#android-battery-btn', page);
    if (batteryBtn) {
      batteryBtn.onclick = () => requestIgnoreBatteryOptimizations();
    }

    const bubblesBtn = $('#android-bubbles-btn', page);
    if (bubblesBtn) {
      bubblesBtn.onclick = () => openNativeBubbleSettings();
    }

    const winStartupToggle = $('#win-startup-toggle', page);
    if (winStartupToggle) {
      winStartupToggle.onchange = (e) => {
        setWindowsStartup(e.target.checked);
        showToast(e.target.checked ? 'Will launch on Windows startup' : 'Removed from Windows startup');
      };
    }

    const winTrayToggle = $('#win-tray-toggle', page);
    if (winTrayToggle) {
      winTrayToggle.onchange = (e) => {
        setWindowsMinimizeToTray(e.target.checked);
        showToast(e.target.checked ? 'Window closes to system tray' : 'Closing window exits Whisper');
      };
    }
  };

  wirePlatformSettings();
  window.WhisperOnNativeCapsChanged = () => {
    if (!isSettingsPageOpen()) return;
    const block = $('#notify-settings-block', page);
    if (block) block.innerHTML = renderNotificationSettingsInner();
    const caps = getNativeCapabilities() || {};
    const bgToggle = $('#android-bg-toggle', page);
    if (bgToggle) bgToggle.checked = Boolean(caps.backgroundSyncEnabled);
    const batStatus = $('#android-battery-status', page);
    const batBtn = $('#android-battery-btn', page);
    if (batStatus && batBtn) {
      batStatus.textContent = caps.batteryOptimized
        ? 'Battery saver may delay background alerts'
        : 'Unrestricted background delivery enabled';
      batBtn.textContent = caps.batteryOptimized ? 'Allow background' : 'Settings';
    }
    const bubStatus = $('#android-bubbles-status', page);
    if (bubStatus) {
      bubStatus.textContent = caps.bubblesEnabled !== false
        ? 'Android floating chat bubbles allowed'
        : 'Enable bubbles in Android system settings';
    }
    const winStartupToggle = $('#win-startup-toggle', page);
    if (winStartupToggle) winStartupToggle.checked = Boolean(caps.launchOnStartup);
    const winTrayToggle = $('#win-tray-toggle', page);
    if (winTrayToggle) winTrayToggle.checked = caps.minimizeToTray !== false;
    wirePlatformSettings();
  };

  // Custom Chat Theme wiring
  const syncThemePreview = () => {
    const t = state.chatTheme || {};
    const prev = $('#chat-theme-preview', page);
    const dimEl = $('#chat-theme-preview-dim', page);
    const mineEl = $('#ctp-mine', page);
    const theirsEl = $('#ctp-theirs', page);
    if (prev) {
      prev.style.backgroundImage = t.bgImage ? `url("${t.bgImage}")` : '';
      prev.classList.toggle('has-bg', Boolean(t.bgImage));
    }
    if (dimEl) {
      dimEl.style.opacity = t.bgImage ? String(t.bgDim ?? 0.22) : '0';
    }
    if (mineEl) {
      mineEl.style.background = t.mineBg || '';
      mineEl.style.color = t.mineText || '';
    }
    if (theirsEl) {
      theirsEl.style.background = t.theirsBg || '';
      theirsEl.style.color = t.theirsText || '';
    }
    const mineInput = $('#chat-mine-color', page);
    const theirsInput = $('#chat-theirs-color', page);
    if (mineInput && t.mineBg) mineInput.value = t.mineBg;
    if (theirsInput && t.theirsBg) theirsInput.value = t.theirsBg;
    const bgStatus = $('#chat-bg-status', page);
    const bgClear = $('#chat-bg-clear', page);
    if (bgStatus) bgStatus.textContent = t.bgImage ? 'Custom background photo active' : 'Optional image behind conversations';
    if (bgClear) bgClear.classList.toggle('hidden', !t.bgImage);
    page.querySelectorAll('[data-theme-preset]').forEach((pill) => {
      const p = CHAT_THEME_PRESETS.find((x) => x.id === pill.dataset.themePreset);
      pill.classList.toggle('active', Boolean(p && (t.mineBg || '') === p.mineBg && (t.theirsBg || '') === p.theirsBg));
    });
    onChatThemeChange?.();
  };

  syncThemePreview();

  page.querySelectorAll('[data-theme-preset]').forEach((pill) => {
    pill.onclick = () => {
      const p = CHAT_THEME_PRESETS.find((x) => x.id === pill.dataset.themePreset);
      if (!p) return;
      setChatTheme({ mineBg: p.mineBg, theirsBg: p.theirsBg });
      syncThemePreview();
    };
  });

  $('#chat-mine-color', page).oninput = (e) => {
    setChatTheme({ mineBg: e.target.value });
    syncThemePreview();
  };

  $('#chat-theirs-color', page).oninput = (e) => {
    setChatTheme({ theirsBg: e.target.value });
    syncThemePreview();
  };

  $('#chat-bg-upload', page).onclick = () => $('#chat-bg-file', page)?.click();
  $('#chat-bg-file', page).onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressWallpaperImage(file);
      setChatTheme({ bgImage: dataUrl });
      syncThemePreview();
      showToast('Chat wallpaper updated');
    } catch (error) {
      showToast(error.message || 'Could not apply wallpaper');
    }
    e.target.value = '';
  };

  $('#chat-bg-clear', page).onclick = () => {
    setChatTheme({ bgImage: '' });
    syncThemePreview();
    showToast('Chat wallpaper removed');
  };

  $('#chat-bg-dim', page).oninput = (e) => {
    setChatTheme({ bgDim: Number(e.target.value) / 100 });
    syncThemePreview();
  };

  $('#reset-chat-theme-btn', page).onclick = () => {
    resetChatTheme();
    const mineInput = $('#chat-mine-color', page);
    const theirsInput = $('#chat-theirs-color', page);
    const dimInput = $('#chat-bg-dim', page);
    if (mineInput) mineInput.value = '#70a993';
    if (theirsInput) theirsInput.value = '#ffffff';
    if (dimInput) dimInput.value = '22';
    syncThemePreview();
    showToast('Chat theme reset to default');
  };

  // Reaction customization
  let activeTarget = null; // { kind: 'double' } | { kind: 'slot', index: number }
  const pickerEl = $('#settings-emoji-picker', page);
  const pickerLabelEl = $('#settings-emoji-target-label', page);
  const pickerSearchEl = $('#settings-emoji-search', page);
  const pickerGridEl = $('#settings-emoji-grid', page);
  const doubleBtn = $('#double-tap-emoji-btn', page);

  const clearEditingHighlight = () => {
    doubleBtn?.classList.remove('editing');
    page.querySelectorAll('[data-palette-slot]').forEach((b) => b.classList.remove('editing'));
  };

  const closeReactionPicker = () => {
    activeTarget = null;
    pickerEl?.classList.add('hidden');
    clearEditingHighlight();
  };

  const applyEmojiChoice = (chosen) => {
    const emoji = String(chosen || '').trim();
    if (!emoji || !activeTarget) return;
    if (activeTarget.kind === 'double') {
      const saved = setDoubleTapEmoji(emoji);
      if (doubleBtn) doubleBtn.textContent = saved;
      showToast('Double-tap reaction updated');
    } else {
      const next = [...(state.reactionPalette?.length ? state.reactionPalette : DEFAULT_REACTION_PALETTE)];
      next[activeTarget.index] = emoji;
      const saved = setReactionPalette(next);
      const slotBtn = page.querySelector(`[data-palette-slot="${activeTarget.index}"]`);
      if (slotBtn) slotBtn.textContent = saved[activeTarget.index] || emoji;
      showToast('Reaction bar updated');
    }
    closeReactionPicker();
  };

  const renderSettingsEmojiGrid = (query = '') => {
    if (!pickerGridEl) return;
    const matches = searchEmojis(query);
    pickerGridEl.innerHTML = matches.length
      ? matches
          .map(
            (item) =>
              `<button type="button" class="emoji-cell" data-settings-emoji="${esc(item.emoji)}" title=":${esc(item.name)}:">${item.emoji}</button>`,
          )
          .join('')
      : '<div class="people-empty">No matching emojis — paste any emoji above and tap Use.</div>';
    pickerGridEl.querySelectorAll('[data-settings-emoji]').forEach((cell) => {
      cell.onclick = () => applyEmojiChoice(cell.dataset.settingsEmoji);
    });
  };

  const openReactionPicker = (target, triggerBtn) => {
    const isSame =
      activeTarget &&
      activeTarget.kind === target.kind &&
      (target.kind === 'double' || activeTarget.index === target.index);
    if (isSame && !pickerEl.classList.contains('hidden')) {
      closeReactionPicker();
      return;
    }
    activeTarget = target;
    clearEditingHighlight();
    triggerBtn?.classList.add('editing');
    pickerLabelEl.textContent =
      target.kind === 'double'
        ? 'Pick emoji for double-tap'
        : `Pick emoji for bar slot ${target.index + 1}`;
    pickerSearchEl.value = '';
    renderSettingsEmojiGrid('');
    pickerEl.classList.remove('hidden');
  };

  doubleBtn.onclick = () => openReactionPicker({ kind: 'double' }, doubleBtn);
  page.querySelectorAll('[data-palette-slot]').forEach((btn) => {
    btn.onclick = () =>
      openReactionPicker({ kind: 'slot', index: Number(btn.dataset.paletteSlot) }, btn);
  });

  pickerSearchEl.oninput = (e) => renderSettingsEmojiGrid(e.target.value);
  $('#settings-emoji-use', page).onclick = () => {
    const raw = pickerSearchEl.value.trim();
    if (!raw) {
      showToast('Type or paste an emoji first');
      return;
    }
    const matches = searchEmojis(raw);
    const chosen = /^\p{Extended_Pictographic}/u.test(raw) ? raw : matches[0]?.emoji || raw;
    applyEmojiChoice(chosen);
  };
  $('#settings-emoji-close', page).onclick = closeReactionPicker;

  $('#reset-reactions-btn', page).onclick = () => {
    const defDouble = setDoubleTapEmoji(DEFAULT_DOUBLE_TAP_EMOJI);
    const defPalette = setReactionPalette(DEFAULT_REACTION_PALETTE);
    if (doubleBtn) doubleBtn.textContent = defDouble;
    page.querySelectorAll('[data-palette-slot]').forEach((btn) => {
      const idx = Number(btn.dataset.paletteSlot);
      if (defPalette[idx]) btn.textContent = defPalette[idx];
    });
    closeReactionPicker();
    showToast('Reactions reset to defaults');
  };

  $('#sign-out', page).onclick = async () => {
    closeSettingsPage(true);
    await onSignOut?.();
  };

  const renderBackupCodesBox = (codes, noticeText = 'Save these single-use codes somewhere safe. They work for 2FA recovery and instant password reset (no email needed).') => {
    const area = $('#backup-codes-area', page);
    if (!area) return;
    area.classList.remove('hidden');
    area.innerHTML = `
      <div class="mfa-enroll-box">
        <p style="margin:0 0 8px;text-align:left">${esc(noticeText)}</p>
        <div class="backup-codes-grid">
          ${codes.map((c) => `<div class="backup-code-chip">${esc(c)}</div>`).join('')}
        </div>
        <div class="backup-actions">
          <button type="button" class="secondary-btn" id="backup-copy-btn">Copy all</button>
          <button type="button" class="secondary-btn" id="backup-dl-btn">Download .txt</button>
        </div>
      </div>
    `;
    const textPayload = `Whisper Aero Backup Recovery Codes (@${state.user.username})\nEach code can be used once for 2FA or password reset.\n\n${codes.join('\n')}\n`;
    $('#backup-copy-btn', area).onclick = async () => {
      try {
        await navigator.clipboard.writeText(textPayload);
        showToast('Backup codes copied');
      } catch {
        showToast('Copy unavailable — use Download .txt');
      }
    };
    $('#backup-dl-btn', area).onclick = () => {
      const blob = new Blob([textPayload], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whisper-backup-codes-${state.user.username || 'account'}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
  };

  let currentRemaining = 0;

  const refreshSecurityState = async () => {
    const mfaText = $('#mfa-status-text', page);
    const mfaBtn = $('#mfa-toggle-btn', page);
    const backupText = $('#backup-status-text', page);
    const backupBtn = $('#backup-gen-btn', page);
    if (!mfaText || !mfaBtn || !backupText || !backupBtn) return;

    try {
      const [mfa, codesStatus] = await Promise.all([
        api.getMfaStatus(),
        api.getBackupCodesStatus().catch(() => ({ remaining: 0 })),
      ]);

      currentRemaining = codesStatus?.remaining || 0;
      backupText.textContent = currentRemaining > 0
        ? `${currentRemaining} unused code${currentRemaining === 1 ? '' : 's'} remaining`
        : 'Not set up (recommended for password reset)';
      backupBtn.textContent = currentRemaining > 0 ? 'Regenerate' : 'Generate';
      backupBtn.disabled = false;

      if (mfa.enabled) {
        const factor = mfa.totpFactors[0];
        mfaText.textContent = 'Enabled (Authenticator app)';
        mfaBtn.textContent = 'Disable';
        mfaBtn.disabled = false;
        mfaBtn.onclick = async () => {
          mfaBtn.disabled = true;
          try {
            await api.unenrollTotp(factor.id);
            showToast('2FA disabled');
            await refreshSecurityState();
          } catch (error) {
            mfaBtn.disabled = false;
            showToast(error.message || 'Could not disable 2FA');
          }
        };
      } else {
        mfaText.textContent = 'Optional · Not enabled';
        mfaBtn.textContent = 'Enable 2FA';
        mfaBtn.disabled = false;
        mfaBtn.onclick = async () => {
          mfaBtn.disabled = true;
          try {
            const enrolled = await api.enrollTotp();
            const area = $('#mfa-enroll-area', page);
            area.classList.remove('hidden');
            area.innerHTML = `
              <div class="mfa-enroll-box">
                <div class="mfa-qr-wrap"><img src="${esc(enrolled.totp.qr_code)}" alt="Scan QR code in your authenticator app"></div>
                <p style="margin:0 0 6px">Scan with Google Authenticator, Authy, or 1Password, or enter key manually:</p>
                <div class="mfa-secret">${esc(enrolled.totp.secret)}</div>
                <input class="field auth-code-input" id="mfa-verify-input" inputmode="numeric" maxlength="8" placeholder="6-digit code">
                <div class="backup-actions" style="margin-top:10px">
                  <button type="button" class="secondary-btn" id="mfa-cancel-btn">Cancel</button>
                  <button type="button" class="primary-btn" id="mfa-confirm-btn">Verify &amp; enable</button>
                </div>
              </div>
            `;
            $('#mfa-cancel-btn', area).onclick = () => {
              area.classList.add('hidden');
              area.innerHTML = '';
              mfaBtn.disabled = false;
            };
            $('#mfa-confirm-btn', area).onclick = async () => {
              const code = $('#mfa-verify-input', area).value.trim();
              if (!/^\d{6}$/.test(code)) {
                showToast('Enter the 6-digit code from your app');
                return;
              }
              $('#mfa-confirm-btn', area).disabled = true;
              try {
                await api.verifyTotp(enrolled.id, code);
                area.classList.add('hidden');
                area.innerHTML = '';
                showToast('2FA enabled!');
                if (currentRemaining === 0) {
                  const generated = await api.generateBackupCodes();
                  renderBackupCodesBox(generated.codes, '2FA enabled! Save these single-use backup codes in case you lose your authenticator app or forget your password:');
                }
                await refreshSecurityState();
              } catch (error) {
                $('#mfa-confirm-btn', area).disabled = false;
                showToast(error.message || 'Invalid verification code');
              }
            };
          } catch (error) {
            mfaBtn.disabled = false;
            showToast(error.message || 'Could not start 2FA setup');
          }
        };
      }

      backupBtn.onclick = async () => {
        backupBtn.disabled = true;
        try {
          const generated = await api.generateBackupCodes();
          renderBackupCodesBox(generated.codes);
          await refreshSecurityState();
          showToast('New backup codes generated');
        } catch (error) {
          backupBtn.disabled = false;
          showToast(error.message || 'Could not generate backup codes');
        }
      };
    } catch {
      mfaText.textContent = 'Unavailable';
      backupText.textContent = 'Unavailable';
    }
  };

  refreshSecurityState();
}
