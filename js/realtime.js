import { supabase } from './config.js';
import { touchLastSeen } from './api.js';

let dbChannel = null;
let presenceChannel = null;
let typingChannel = null;
let typingConvId = null;
let heartbeatTimer = null;
let lastTypingSent = 0;

export function startRealtime(userId, handlers) {
  stopRealtime();
  if (!userId) return;

  dbChannel = supabase
    .channel(`whisper-db-${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload) => {
      handlers.onMessageEvent?.(payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (payload) => {
      handlers.onReactionEvent?.(payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attachments' }, (payload) => {
      handlers.onAttachmentEvent?.(payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, (payload) => {
      handlers.onMemberEvent?.(payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'contact_requests' }, (payload) => {
      handlers.onRequestEvent?.(payload);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_invites' }, (payload) => {
      handlers.onCallInvite?.(payload);
    })
    .subscribe();

  presenceChannel = supabase.channel('whisper-presence', {
    config: { presence: { key: userId } },
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      const onlineIds = new Set(Object.keys(state || {}));
      handlers.onPresenceSync?.(onlineIds);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({ user_id: userId, online_at: new Date().toISOString() });
        touchLastSeen().catch(() => {});
      }
    });

  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      touchLastSeen().catch(() => {});
    }
  }, 60000);
}

export function joinConversationTyping(conversationId, currentUserId, onRemoteTyping) {
  if (typingChannel) {
    supabase.removeChannel(typingChannel);
    typingChannel = null;
    typingConvId = null;
  }
  if (!conversationId || !currentUserId) return;
  typingConvId = conversationId;
  typingChannel = supabase
    .channel(`whisper-typing-${conversationId}`)
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (payload?.userId && payload.userId !== currentUserId) {
        onRemoteTyping?.(conversationId, payload.userId, Boolean(payload.isTyping));
      }
    })
    .subscribe();
}

export function sendTypingSignal(conversationId, userId, isTyping = true) {
  if (!typingChannel || typingConvId !== conversationId || !userId) return;
  const now = Date.now();
  if (isTyping && now - lastTypingSent < 1400) return;
  lastTypingSent = isTyping ? now : 0;
  typingChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { userId, isTyping, ts: now },
  }).catch(() => {});
}

export function stopRealtime() {
  if (dbChannel) {
    supabase.removeChannel(dbChannel);
    dbChannel = null;
  }
  if (presenceChannel) {
    supabase.removeChannel(presenceChannel);
    presenceChannel = null;
  }
  if (typingChannel) {
    supabase.removeChannel(typingChannel);
    typingChannel = null;
    typingConvId = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
