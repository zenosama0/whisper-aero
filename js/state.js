export const DEFAULT_REACTION_PALETTE = ['✨', '😆', '💖', '😢', '😭', '💀', '💜'];
export const DEFAULT_DOUBLE_TAP_EMOJI = '❤️';

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
  pendingAttachment: null, // { file, previewUrl, isViewOnce }
  chatSearch: { open: false, term: '', matchIds: [], activeIndex: 0 },
  filter: 'all',
  query: '',
  soundEnabled: savedSound,
  reactionPalette: loadSavedReactionPalette(),
  doubleTapEmoji: loadSavedDoubleTapEmoji(),
  mediaUrlCache: new Map(),
  avatarUrlCache: new Map(),
};

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
  if (state.pendingAttachment?.previewUrl) {
    URL.revokeObjectURL(state.pendingAttachment.previewUrl);
  }
  state.pendingAttachment = null;
  state.chatSearch = { open: false, term: '', matchIds: [], activeIndex: 0 };
  state.mediaUrlCache.clear();
  state.avatarUrlCache.clear();
}
