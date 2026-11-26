export function isNativeAndroid() {
  return typeof window !== 'undefined' && Boolean(window.WhisperNative?.isNative?.());
}

export function isNativeWindows() {
  return typeof window !== 'undefined' && Boolean(window.chrome?.webview?.postMessage);
}

export function isNativeApp() {
  return isNativeAndroid() || isNativeWindows();
}

export function startNativeGoogleSignIn(webClientId) {
  try {
    if (isNativeAndroid() && typeof window.WhisperNative.signInWithGoogle === 'function') {
      window.WhisperNative.signInWithGoogle(String(webClientId || ''));
      return true;
    }
  } catch {
    // Fall back to standard OAuth
  }
  return false;
}

export function isBubbleWindow() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('bubble') === '1';
}

export function getNativeCapabilities() {
  if (isNativeAndroid()) {
    try {
      const raw = window.WhisperNative.getCapabilities?.();
      return raw ? JSON.parse(raw) : { platform: 'android', notificationsGranted: true, backgroundSyncEnabled: true, batteryOptimized: false, bubblesEnabled: true };
    } catch {
      return { platform: 'android', notificationsGranted: true, backgroundSyncEnabled: true, batteryOptimized: false, bubblesEnabled: true };
    }
  }
  if (isNativeWindows()) {
    return window.__WHISPER_WINDOWS_STATE__ || {
      platform: 'windows',
      notificationsGranted: true,
      launchOnStartup: false,
      minimizeToTray: true,
    };
  }
  return null;
}

export function sendNativeNotification({
  conversationId = '',
  title = 'Whisper',
  body = '',
  icon = '',
  tag = 'whisper',
  messageId = '',
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
        messageId: String(messageId || ''),
      });
      return true;
    }
  } catch {
    // Allow fallback to web notifications if host call throws
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

export function requestNativeNotifications() {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.requestNotificationPermission?.();
      return true;
    }
    if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'testNotification' });
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function openNativeNotificationSettings() {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.openNotificationSettings?.();
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function openNativeBubbleSettings() {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.openBubbleSettings?.();
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function pushNativeChatShortcuts(chats) {
  try {
    if (isNativeAndroid() && typeof window.WhisperNative.pushChatShortcuts === 'function') {
      const top = (chats || []).slice(0, 6).map((c) => ({
        id: c.id,
        name: c.name || 'Whisper',
        avatar: c.avatar || '',
      }));
      window.WhisperNative.pushChatShortcuts(JSON.stringify(top));
    }
  } catch {
    // Ignore
  }
}

export function setNativeBackgroundSync(enabled) {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.setBackgroundSyncEnabled?.(Boolean(enabled));
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function requestIgnoreBatteryOptimizations() {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.requestIgnoreBatteryOptimizations?.();
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function sendNativeTestNotification() {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.sendTestNotification?.();
      return true;
    }
    if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'testNotification' });
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function setWindowsStartup(enabled) {
  try {
    if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'setStartup', enabled: Boolean(enabled) });
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function setWindowsMinimizeToTray(enabled) {
  try {
    if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'setMinimizeToTray', enabled: Boolean(enabled) });
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function syncNativeSession(payload) {
  if (!payload?.accessToken || !payload?.userId) return;
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.syncSession?.(JSON.stringify(payload));
    } else if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'syncSession', payload });
    }
  } catch {
    // Ignore
  }
}

export function clearNativeSession() {
  try {
    if (isNativeAndroid()) {
      window.WhisperNative.clearSession?.();
    } else if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'clearSession' });
    }
  } catch {
    // Ignore
  }
}

export function nativeCopyText(text) {
  try {
    if (isNativeAndroid() && typeof window.WhisperNative.copyToClipboard === 'function') {
      window.WhisperNative.copyToClipboard(String(text || ''));
      return true;
    }
    if (isNativeWindows()) {
      window.chrome.webview.postMessage({ type: 'copy', text: String(text || '') });
      return true;
    }
  } catch {
    // Fall back to browser clipboard API
  }
  return false;
}

export function nativeShareText(title, text) {
  try {
    if (isNativeAndroid() && typeof window.WhisperNative.shareText === 'function') {
      window.WhisperNative.shareText(String(title || 'Whisper'), String(text || ''));
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}
