import * as api from '../api.js';
import { searchEmojis } from '../emoji.js?v=21';
import {
  DEFAULT_DOUBLE_TAP_EMOJI,
  DEFAULT_REACTION_PALETTE,
  setDoubleTapEmoji,
  setReactionPalette,
  state,
} from '../state.js';
import { $, avatarMarkup, closeModal, esc, openModal, popUiLayer, pushUiLayer, showToast } from '../utils.js';
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

export function isSettingsPageOpen() {
  const page = $('#settings-page');
  return Boolean(page && !page.classList.contains('hidden'));
}

export function closeSettingsPage(fromPop = false) {
  const page = $('#settings-page');
  if (!page || page.classList.contains('hidden')) return;
  page.classList.add('hidden');
  $('.workspace')?.classList.remove('settings-open');
  $('#settings-open')?.classList.remove('selected');
  $('#chats-tab')?.classList.add('selected');
  if (!fromPop) popUiLayer();
}

export async function openSettingsPage({ onThemeChange, onSignOut }) {
  const page = $('#settings-page');
  if (!page) return;
  const alreadyOpen = isSettingsPageOpen();
  page.classList.remove('hidden');
  $('.workspace')?.classList.add('settings-open');
  $('#chats-tab')?.classList.remove('selected');
  $('#settings-open')?.classList.add('selected');
  if (!alreadyOpen) pushUiLayer('settings');

  const palette = state.reactionPalette?.length ? state.reactionPalette : [...DEFAULT_REACTION_PALETTE];
  const doubleTap = state.doubleTapEmoji || DEFAULT_DOUBLE_TAP_EMOJI;

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
        <div class="settings-row">
          <span>Desktop &amp; push notifications<small>Alerts when Whisper is in the background</small></span>
          <button class="secondary-btn" type="button" id="notify-enable">Enable</button>
        </div>
        <div class="settings-row">
          <span>Sound alerts<small>Play a tone for new messages</small></span>
          <input type="checkbox" id="sound-toggle" ${state.soundEnabled ? 'checked' : ''}>
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
          <span>Signed in<small>@${esc(state.user.username)}</small></span>
          <button class="secondary-btn" type="button" id="sign-out">Sign out</button>
        </div>
      </div>
    </div>
  `;

  $('#settings-back-btn', page).onclick = () => closeSettingsPage();

  const themeSelect = $('#theme-select', page);
  themeSelect.value = state.user.theme;
  themeSelect.onchange = (e) => onThemeChange?.(e.target.value);

  $('#sound-toggle', page).onchange = (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem('whisper-sound', state.soundEnabled ? 'true' : 'false');
    renderChats();
  };

  $('#notify-enable', page).onclick = async () => {
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
