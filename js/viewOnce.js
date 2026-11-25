import { fetchViewOnceBlob } from './api.js';
import { state } from './state.js';
import { $, esc, openModal, showToast } from './utils.js';

export async function openViewOnceMedia(attachment, onConsumed) {
  if (!attachment?.id) return;
  if (attachment.downloaded) {
    showToast('This view-once media has already been opened.');
    return;
  }

  openModal(`
    <div class="vo-viewer-head">
      <span class="vo-badge">1× View once</span>
      <strong>${esc(attachment.name || 'Private media')}</strong>
    </div>
    <div class="vo-stage" id="vo-stage">
      <div class="people-empty">Loading protected media…</div>
    </div>
    <p class="vo-note">Server copy is deleted on open. Switching tabs, blurring the window, or capture shortcuts automatically hide the media.</p>
    <div class="modal-actions">
      <button class="primary-btn" type="button" id="vo-close-btn">Close &amp; destroy</button>
    </div>
  `);

  const modal = $('#modal');
  const stage = $('#vo-stage');
  const closeBtn = $('#vo-close-btn');
  let objectUrl = '';
  let autoTimer = 0;

  const cleanup = () => {
    clearTimeout(autoTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('keydown', onKeyDown, true);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
    if (stage) stage.innerHTML = '<div class="people-empty">Media closed.</div>';
  };

  const protect = (reason) => {
    if (!stage) return;
    stage.classList.add('vo-shielded');
    const video = stage.querySelector('video');
    if (video && !video.paused) video.pause();
    let shield = stage.querySelector('.vo-shield');
    if (!shield) {
      shield = document.createElement('div');
      shield.className = 'vo-shield';
      shield.innerHTML = `
        <div>
          <strong>Protected view paused</strong>
          <p>${esc(reason)}</p>
          <button type="button" class="secondary-btn" id="vo-resume-btn">Hold / Click to resume</button>
        </div>
      `;
      stage.append(shield);
      shield.querySelector('#vo-resume-btn').onclick = () => {
        stage.classList.remove('vo-shielded');
        shield.remove();
      };
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') protect('Tab hidden — media shielded.');
  };
  const onBlur = () => protect('Window lost focus — media shielded.');
  const onKeyDown = (e) => {
    const key = (e.key || '').toLowerCase();
    const captureShortcut =
      e.key === 'PrintScreen'
      || ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(key))
      || ((e.metaKey || e.ctrlKey) && e.shiftKey && ['3', '4', '5', 's'].includes(key));
    if (captureShortcut) {
      e.preventDefault();
      e.stopPropagation();
      protect('Capture shortcut detected — media shielded.');
    }
  };

  modal?.addEventListener('close', cleanup, { once: true });
  closeBtn.onclick = () => modal?.close();

  try {
    const { blob, mimeType } = await fetchViewOnceBlob(attachment.id);
    onConsumed?.(attachment.id);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKeyDown, true);

    const watermarkText = `@${state.user.username || 'whisper'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    stage.innerHTML = `
      <div class="vo-media-wrap" oncontextmenu="return false;" ondragstart="return false;">
        <div class="vo-surface" id="vo-surface"></div>
        <div class="vo-watermark" aria-hidden="true">${esc(watermarkText)}</div>
      </div>
    `;
    const surface = $('#vo-surface', stage);

    if (mimeType.startsWith('image/')) {
      objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 720;
        const scale = img.width > maxW ? maxW / img.width : 1;
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.className = 'vo-canvas';
        surface.append(canvas);
        URL.revokeObjectURL(objectUrl);
        objectUrl = '';
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        objectUrl = '';
        surface.innerHTML = '<div class="people-empty">Could not render image.</div>';
      };
      img.src = objectUrl;
    } else if (mimeType.startsWith('video/')) {
      objectUrl = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.src = objectUrl;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      video.setAttribute('controlsList', 'nodownload noplaybackrate');
      video.className = 'vo-video';
      surface.append(video);
    } else if (mimeType.startsWith('text/')) {
      const text = await blob.text();
      const pre = document.createElement('pre');
      pre.className = 'vo-text';
      pre.textContent = text;
      surface.append(pre);
    } else {
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = attachment.name || 'file';
      link.click();
      surface.innerHTML = '<div class="people-empty">File downloaded once and removed from server.</div>';
    }

    autoTimer = setTimeout(() => {
      if (modal?.open) modal.close();
    }, 60000);
  } catch (error) {
    cleanup();
    if (stage) stage.innerHTML = `<div class="people-empty people-error">${esc(error.message || 'Could not open view-once media.')}</div>`;
  }
}
