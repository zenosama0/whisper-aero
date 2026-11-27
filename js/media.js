const heicPreviewCache = new Map();
let heic2anyPromise = null;

function extOf(fileOrMeta) {
  const name = String(fileOrMeta?.name || '');
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function mimeOf(fileOrMeta) {
  return String(fileOrMeta?.type || '').toLowerCase();
}

export function isHeicFile(fileOrMeta) {
  const mime = mimeOf(fileOrMeta);
  const ext = extOf(fileOrMeta);
  return mime.includes('heic') || mime.includes('heif') || ext === 'heic' || ext === 'heif';
}

export function isImageFile(fileOrMeta) {
  const mime = mimeOf(fileOrMeta);
  const ext = extOf(fileOrMeta);
  return (
    mime.startsWith('image/')
    || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'jfif', 'tif', 'tiff'].includes(ext)
  );
}

export function isVideoFile(fileOrMeta) {
  const mime = mimeOf(fileOrMeta);
  const ext = extOf(fileOrMeta);
  return (
    mime.startsWith('video/')
    || ['mp4', 'm4v', 'webm', 'mov', 'mkv', '3gp', '3gpp', 'ogv', 'avi', 'mpeg', 'mpg'].includes(ext)
  );
}

export function isAudioFile(fileOrMeta) {
  const mime = mimeOf(fileOrMeta);
  const ext = extOf(fileOrMeta);
  const name = String(fileOrMeta?.name || '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  if (['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac', 'flac', 'amr', 'weba', 'caf'].includes(ext)) return true;
  return ext === 'webm' && name.startsWith('voice-message-');
}

async function loadHeic2Any() {
  if (!heic2anyPromise) {
    heic2anyPromise = import('https://esm.sh/heic2any@0.0.4')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        heic2anyPromise = null;
        throw err;
      });
  }
  return heic2anyPromise;
}

export async function convertHeicBlobToJpeg(blob) {
  const heic2any = await loadHeic2Any();
  const res = await heic2any({ blob, toType: 'image/jpeg', quality: 0.86 });
  return Array.isArray(res) ? res[0] : res;
}

export async function normalizeUploadFile(file) {
  if (!file || !isHeicFile(file)) return file;
  try {
    const converted = await convertHeicBlobToJpeg(file);
    const baseName = String(file.name || 'photo').replace(/\.(heic|heif)$/i, '');
    return new File([converted], `${baseName}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export async function resolveHeicPreviewUrl(attachmentId, signedUrl) {
  if (!attachmentId || !signedUrl) return '';
  if (heicPreviewCache.has(attachmentId)) return heicPreviewCache.get(attachmentId);
  try {
    const resp = await fetch(signedUrl);
    if (!resp.ok) return '';
    const blob = await resp.blob();
    const converted = await convertHeicBlobToJpeg(blob);
    const objectUrl = URL.createObjectURL(converted);
    heicPreviewCache.set(attachmentId, objectUrl);
    return objectUrl;
  } catch {
    return '';
  }
}

export function formatAudioClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
