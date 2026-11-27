export const DEFAULT_REACTION_PALETTE = ['✨', '😆', '💖', '😢', '😭', '💀', '💜'];
export const DEFAULT_DOUBLE_TAP_EMOJI = '❤️';
export const DEFAULT_CHAT_THEME = {
  mineBg: '',
  mineText: '',
  theirsBg: '',
  theirsText: '',
  bgImage: '',
  bgDim: 0.22,
};
export const CHAT_THEME_PRESETS = [
  { id: 'default', label: 'Default', mineBg: '', theirsBg: '' },
  { id: 'sage', label: 'Sage Glass', mineBg: '#2f7a64', theirsBg: '#f2f7f5' },
  { id: 'dusk', label: 'Dusk Slate', mineBg: '#395b85', theirsBg: '#27313d' },
  { id: 'sand', label: 'Warm Sand', mineBg: '#b86843', theirsBg: '#fbf4ee' },
  { id: 'indigo', label: 'Midnight', mineBg: '#5b4dc7', theirsBg: '#222436' },
  { id: 'rose', label: 'Rose Quartz', mineBg: '#a64d79', theirsBg: '#fdf2f7' },
];

function computeContrastText(hex) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return '';
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.57 ? '#1d2a29' : '#f7fbfa';
}

function loadSavedChatTheme() {
  try {
    const raw = JSON.parse(localStorage.getItem('whisper-chat-theme') || 'null');
    if (raw && typeof raw === 'object') {
      const merged = { ...DEFAULT_CHAT_THEME, ...raw };
      if (merged.mineBg && !merged.mineText) merged.mineText = computeContrastText(merged.mineBg);
      if (merged.theirsBg && !merged.theirsText) merged.theirsText = computeContrastText(merged.theirsBg);
      merged.bgDim = Math.max(0, Math.min(0.75, Number(merged.bgDim) || 0));
      return merged;
    }
  } catch {
    // ignore malformed stored chat theme
  }
  return { ...DEFAULT_CHAT_THEME };
}

function loadSavedReactionPalette() {
  try {
    const raw = JSON.parse(localStorage.getItem('whisper-reaction-palette') || 'null');
    if (Array.isArray(raw)) {
      const cleaned = raw.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8);
      if (cleaned.length) return cleaned;
    }
  } catch {
    // ignore malformed stored palette
  }
  return [...DEFAULT_REACTION_PALETTE];
}

function loadSavedDoubleTapEmoji() {
  const saved = (localStorage.getItem('whisper-double-tap-emoji') || '').trim();
  return saved || DEFAULT_DOUBLE_TAP_EMOJI;
}

const savedTheme = localStorage.getItem('whisper-theme') || 'aero';
const savedSound = localStorage.getItem('whisper-sound') !== 'false';

export const state = {
  user: {
    id: null,
    name: '',
    username: '',
    about: '',
    theme: savedTheme,
    avatar: '',
  },
  chats: [],
  incomingRequests: [],
  outgoingRequests: [],
  activeChatId: null,
  onlineUsers: new Set(),
  typingChats: new Set(),
  replyingTo: null, // { id, senderName, text, fileName }
  editingMessage: null, // { id, conversationId, text }
  pendingAttachments: [], // [{ id, file, previewUrl, isViewOnce }]
  chatSearch: { open: false, term: '', matchIds: [], activeIndex: 0 },
  filter: 'all',
  query: '',
  soundEnabled: savedSound,
  reactionPalette: loadSavedReactionPalette(),
  doubleTapEmoji: loadSavedDoubleTapEmoji(),
  chatTheme: loadSavedChatTheme(),
  mediaUrlCache: new Map(),
  avatarUrlCache: new Map(),
};

export function setChatTheme(patch) {
  const next = { ...state.chatTheme, ...patch };
  if ('mineBg' in patch && !('mineText' in patch)) {
    next.mineText = next.mineBg ? computeContrastText(next.mineBg) : '';
  }
  if ('theirsBg' in patch && !('theirsText' in patch)) {
    next.theirsText = next.theirsBg ? computeContrastText(next.theirsBg) : '';
  }
  next.bgDim = Math.max(0, Math.min(0.75, Number(next.bgDim) || 0));
  state.chatTheme = next;
  try {
    localStorage.setItem('whisper-chat-theme', JSON.stringify(next));
  } catch {
    // quota fallback if image is huge
  }
  return state.chatTheme;
}

export function resetChatTheme() {
  state.chatTheme = { ...DEFAULT_CHAT_THEME };
  localStorage.removeItem('whisper-chat-theme');
  return state.chatTheme;
}

export function setReactionPalette(list) {
  const cleaned = Array.isArray(list)
    ? list.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  state.reactionPalette = cleaned.length ? cleaned : [...DEFAULT_REACTION_PALETTE];
  localStorage.setItem('whisper-reaction-palette', JSON.stringify(state.reactionPalette));
  return state.reactionPalette;
}

export function setDoubleTapEmoji(emoji) {
  const cleaned = String(emoji || '').trim();
  state.doubleTapEmoji = cleaned || DEFAULT_DOUBLE_TAP_EMOJI;
  localStorage.setItem('whisper-double-tap-emoji', state.doubleTapEmoji);
  return state.doubleTapEmoji;
}

export function getChat(chatId) {
  return state.chats.find((c) => c.id === chatId) || null;
}

export function getActiveChat() {
  return getChat(state.activeChatId);
}

export function upsertMessage(chatId, message) {
  const chat = getChat(chatId);
  if (!chat) return false;
  const idx = chat.messages.findIndex(
    (m) => m.id === message.id || (message.clientTempId && m.id === message.clientTempId),
  );
  if (idx >= 0) {
    chat.messages[idx] = { ...chat.messages[idx], ...message };
  } else {
    chat.messages.push(message);
  }
  chat.messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  chat.latestMessage = chat.messages.at(-1) || chat.latestMessage;
  return idx < 0;
}

export function resetState() {
  state.user = {
    id: null,
    name: '',
    username: '',
    about: '',
    theme: localStorage.getItem('whisper-theme') || 'aero',
    avatar: '',
  };
  state.chats = [];
  state.incomingRequests = [];
  state.outgoingRequests = [];
  state.activeChatId = null;
  state.onlineUsers = new Set();
  state.typingChats = new Set();
  state.replyingTo = null;
  state.editingMessage = null;
  for (const item of state.pendingAttachments || []) {
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  state.pendingAttachments = [];
  state.chatSearch = { open: false, term: '', matchIds: [], activeIndex: 0 };
  state.mediaUrlCache.clear();
  state.avatarUrlCache.clear();
}
