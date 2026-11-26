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
  mediaUrlCache: new Map(),
  avatarUrlCache: new Map(),
};

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
