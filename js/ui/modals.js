import * as api from '../api.js';
import { state } from '../state.js';
import { $, avatarMarkup, closeModal, esc, openModal, showToast } from '../utils.js';
import { renderChats, selectChat } from './chat.js';

export function renderRequestsModal(activeTab = 'incoming', onRefreshInbox) {
  const incoming = state.incomingRequests || [];
  const outgoing = state.outgoingRequests || [];
  const list = activeTab === 'incoming' ? incoming : outgoing;

  openModal(`
    <h2>Friend requests</h2>
    <p>Confirm incoming requests or manage requests you sent.</p>
    <div class="modal-tabs">
      <button type="button" class="modal-tab ${activeTab === 'incoming' ? 'active' : ''}" data-req-tab="incoming">Incoming (${incoming.length})</button>
      <button type="button" class="modal-tab ${activeTab === 'outgoing' ? 'active' : ''}" data-req-tab="outgoing">Sent (${outgoing.length})</button>
    </div>
    <div class="people-results">
      ${list.length
        ? list
            .map((r) => `
              <div class="request-card">
                ${avatarMarkup(r)}
                <div class="request-person">
                  <strong>${esc(r.name)}</strong>
                  <small>@${esc(r.username)} · ${esc(r.text)}</small>
                </div>
                ${activeTab === 'incoming'
                  ? `<button type="button" class="accept" data-accept="${esc(r.id)}">Confirm</button><button type="button" data-decline="${esc(r.id)}" aria-label="Decline">×</button>`
                  : `<button type="button" data-cancel="${esc(r.id)}">Cancel</button>`}
              </div>
            `)
            .join('')
        : `<p class="people-empty">${activeTab === 'incoming' ? 'No incoming friend requests.' : 'No pending sent requests.'}</p>`}
    </div>
    <div class="modal-actions"><button class="secondary-btn" value="cancel">Done</button></div>
  `);

  $('#modal-body').querySelectorAll('[data-req-tab]').forEach((btn) => {
    btn.onclick = () => renderRequestsModal(btn.dataset.reqTab, onRefreshInbox);
  });

  $('#modal-body').querySelectorAll('[data-accept]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const convId = await api.acceptContactRequest(btn.dataset.accept);
        await onRefreshInbox?.();
        closeModal();
        if (convId) await selectChat(convId);
        showToast('Friend request accepted');
      } catch (error) {
        btn.disabled = false;
        showToast(error.message || 'Request could not be accepted');
      }
    };
  });

  $('#modal-body').querySelectorAll('[data-decline]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.declineContactRequest(btn.dataset.decline);
        await onRefreshInbox?.();
        renderRequestsModal('incoming', onRefreshInbox);
        showToast('Request declined');
      } catch (error) {
        btn.disabled = false;
        showToast(error.message || 'Request could not be declined');
      }
    };
  });

  $('#modal-body').querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.cancelFriendRequest(btn.dataset.cancel);
        await onRefreshInbox?.();
        renderRequestsModal('outgoing', onRefreshInbox);
        showToast('Friend request cancelled');
      } catch (error) {
        btn.disabled = false;
        showToast(error.message || 'Could not cancel request');
      }
    };
  });
}

export function openFindPeopleModal(onRefreshInbox) {
  openModal(`
    <h2>Find people</h2>
    <p>Search by display name or @username to add friends.</p>
    <label class="field-label" for="people-search">Search people</label>
    <input class="field" id="people-search" placeholder="Name or @username" autocomplete="off" maxlength="48">
    <div class="people-results" id="people-results" aria-live="polite">
      <div class="people-empty">Type at least two characters to search.</div>
    </div>
    <div class="modal-actions"><button class="secondary-btn" value="cancel">Done</button></div>
  `);

  const input = $('#people-search');
  const results = $('#people-results');
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
            closeModal();
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
          closeModal();
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
        closeModal();
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
  setTimeout(() => input?.focus(), 30);
}

export function openProfileModal(onProfileUpdated) {
  openModal(`
    <h2>Your profile</h2>
    <p>This name and photo appear in your conversations.</p>
    <label class="field-label">Display name</label>
    <input class="field" id="profile-name-input" maxlength="48" value="${esc(state.user.name)}">
    <label class="field-label">Username</label>
    <input class="field" value="@${esc(state.user.username)}" disabled>
    <label class="field-label">About</label>
    <input class="field" id="profile-about" maxlength="160" value="${esc(state.user.about)}">
    <label class="field-label">Profile photo</label>
    <input class="field" id="profile-photo" type="file" accept="image/jpeg,image/png,image/webp,image/gif">
    <div class="field-help">Image up to 500 KB.</div>
    <div class="modal-actions">
      <button class="secondary-btn" value="cancel">Cancel</button>
      <button class="primary-btn" type="button" id="save-profile">Save changes</button>
    </div>
  `);

  $('#save-profile').onclick = async () => {
    const displayName = $('#profile-name-input').value.trim();
    const about = $('#profile-about').value.trim();
    const file = $('#profile-photo').files[0];
    if (!displayName) {
      showToast('Display name is required');
      return;
    }
    if (file && file.size > 512000) {
      showToast('Profile photo must be under 500 KB');
      return;
    }
    $('#save-profile').disabled = true;
    try {
      const updated = await api.updateProfile({ displayName, about, file });
      state.user.name = updated.display_name;
      state.user.about = updated.about;
      state.user.avatar = updated.avatar;
      onProfileUpdated?.();
      closeModal();
      showToast('Profile updated');
    } catch (error) {
      $('#save-profile').disabled = false;
      showToast(error.message || 'Profile could not be saved');
    }
  };
}

export function openSettingsModal({ onThemeChange, onSignOut }) {
  openModal(`
    <h2>Settings</h2>
    <p>Make Whisper feel like yours.</p>
    <div class="settings-row">
      <span>Appearance<small>Choose a visual style</small></span>
      <select id="theme-select" class="field" style="width:135px;padding:8px">
        <option value="aero">Windows Aero</option>
        <option value="minimal">Minimal</option>
        <option value="dark">Dark mode</option>
      </select>
    </div>
    <div class="settings-row">
      <span>Desktop notifications<small>Alerts while this browser is open</small></span>
      <button class="secondary-btn" type="button" id="notify-enable">Enable</button>
    </div>
    <div class="settings-row">
      <span>Sound alerts<small>Play a tone for new messages</small></span>
      <input type="checkbox" id="sound-toggle" ${state.soundEnabled ? 'checked' : ''}>
    </div>
    <div class="settings-row">
      <span>Account<small>Signed in as @${esc(state.user.username)}</small></span>
      <button class="secondary-btn" type="button" id="sign-out">Sign out</button>
    </div>
    <div class="modal-actions"><button class="primary-btn" value="cancel">Done</button></div>
  `);

  const themeSelect = $('#theme-select');
  themeSelect.value = state.user.theme;
  themeSelect.onchange = (e) => onThemeChange?.(e.target.value);

  $('#sound-toggle').onchange = (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem('whisper-sound', state.soundEnabled ? 'true' : 'false');
    renderChats();
  };

  $('#notify-enable').onclick = async () => {
    if (!('Notification' in window)) {
      showToast('Notifications are not supported in this browser');
      return;
    }
    const perm = await Notification.requestPermission();
    showToast(perm === 'granted' ? 'Notifications enabled' : 'Permission was not granted');
  };

  $('#sign-out').onclick = async () => {
    await onSignOut?.();
  };
}
