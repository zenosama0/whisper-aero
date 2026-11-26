export function isNativeAndroid() {
  return typeof window !== 'undefined' && Boolean(window.WhisperNative?.isNative?.());
}

export function isNativeWindows() {
  return typeof window !== 'undefined' && Boolean(window.chrome?.webview?.postMessage);
}

export function isNativeApp() {
  return isNativeAndroid() || isNativeWindows();
}

export function sendNativeNotification({
  conversationId = '',
  title = 'Whisper',
  body = '',
  icon = '',
  tag = 'whisper',
} = {}) {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.showNotification(
        String(conversationId || ''),
        String(title || 'Whisper'),
        String(body || ''),
        String(icon || ''),
        String(tag || 'whisper'),
      );
      return true;
    }
    if (isNativeWindows()) {
      window.chrome.webview.postMessage({
        type: 'notify',
        conversationId: String(conversationId || ''),
        title: String(title || 'Whisper'),
        body: String(body || ''),
        icon: String(icon || ''),
        tag: String(tag || 'whisper'),
      });
      return true;
    }
  } catch {
    // Ignore native bridge error and allow web Notification fallback
  }
  return false;
}

export function clearNativeNotification(conversationId = '') {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.clearNotification?.(String(conversationId || ''));
    } else if (isNativeWindows()) {
      window.chrome.webview.postMessage({
        type: 'clearNotification',
        conversationId: String(conversationId || ''),
      });
    }
  } catch {
    // Ignore
  }
}

export function syncNativeTheme(theme = 'aero') {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.setTheme?.(String(theme || 'aero'));
    } else if (isNativeWindows()) {
      window.chrome.webview.postMessage({
        type: 'theme',
        theme: String(theme || 'aero'),
      });
    }
  } catch {
    // Ignore
  }
}
