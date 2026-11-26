import { config, supabase } from './config.js';
import { state } from './state.js';
import { formatFileSize, formatTime, initials, isUuid } from './utils.js';

function requireConversationId(value) {
  if (!isUuid(value)) {
    throw new Error('This conversation is not ready yet. The recipient must accept the friend request first.');
  }
}

export async function getSignedAvatarUrl(avatarPath) {
  if (!avatarPath) return '';
  const cached = state.avatarUrlCache.get(avatarPath);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from('profile-avatars').createSignedUrl(avatarPath, 3600);
  if (error || !data?.signedUrl) return '';
  state.avatarUrlCache.set(avatarPath, { url: data.signedUrl, expiresAt: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

export async function checkUsernameAvailable(username) {
  const clean = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(clean)) return false;
  const { data, error } = await supabase.rpc('check_username_available', { candidate: clean });
  if (error) return true;
  return Boolean(data);
}

export async function signUp({ email, password, username, displayName }) {
  return supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username: username.toLowerCase(), display_name: displayName },
      emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });
}

export async function refreshSession() {
  return supabase.auth.refreshSession();
}

export async function getMfaStatus() {
  const [{ data: aal }, { data: factorsData, error: factorsError }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  if (factorsError) throw factorsError;
  const verifiedTotp = (factorsData?.totp || []).filter((f) => f.status === 'verified');
  return {
    currentLevel: aal?.currentLevel || 'aal1',
    nextLevel: aal?.nextLevel || 'aal1',
    totpFactors: verifiedTotp,
    enabled: verifiedTotp.length > 0,
  };
}

export async function enrollTotp() {
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const factor of existing?.all || []) {
    if (factor.factor_type === 'totp' && factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => {});
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Whisper Authenticator',
  });
  if (error) throw error;
  return data;
}

export async function verifyTotp(factorId, code) {
  const cleanCode = String(code || '').replace(/\s+/g, '');
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: cleanCode,
  });
  if (error) throw error;
  return data;
}

export async function unenrollTotp(factorId) {
  const { data, error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
  return data;
}

async function callAuthRecovery(payload, { requireAuth = true } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: config.supabaseAnonKey,
  };
  if (requireAuth) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Sign in again to continue.');
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  const response = await fetch(`${config.supabaseUrl}/functions/v1/auth-recovery`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Recovery request failed.');
  return result;
}

export async function generateBackupCodes() {
  return callAuthRecovery({ action: 'generate-codes' });
}

export async function getBackupCodesStatus() {
  return callAuthRecovery({ action: 'codes-status' });
}

export async function consume2faBackupCode(code) {
  return callAuthRecovery({ action: 'consume-2fa-backup', code });
}

export async function resetPasswordWithBackupCode({ identifier, code, newPassword }) {
  return callAuthRecovery(
    { action: 'reset-password-with-code', identifier, code, newPassword },
    { requireAuth: false },
  );
}

export async function requestPasswordReset(email) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}${window.location.pathname}`,
  });
}

export async function updatePassword(newPassword) {
  return supabase.auth.updateUser({ password: newPassword });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getSession() {
  return supabase.auth.getSession();
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,username,display_name,about,avatar_path,last_seen_at')
    .eq('id', userId)
    .single();
  if (error) throw error;
  const avatar = await getSignedAvatarUrl(data.avatar_path);
  return { ...data, avatar };
}

export async function updateProfile({ displayName, about, file }) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in again to update your profile.');
  const changes = { display_name: displayName, about };
  if (file) {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('profile-avatars')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (uploadError) throw uploadError;
    changes.avatar_path = path;
  }
  const { error } = await supabase.from('profiles').update(changes).eq('id', user.id);
  if (error) throw error;
  return getProfile(user.id);
}

export async function touchLastSeen() {
  if (!state.user.id) return;
  await supabase.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', state.user.id);
}

export function mapAttachment(fileRow) {
  if (!fileRow) return null;
  return {
    id: fileRow.id,
    name: fileRow.file_name,
    type: fileRow.mime_type,
    sizeBytes: fileRow.size_bytes,
    size: formatFileSize(fileRow.size_bytes),
    isViewOnce: Boolean(fileRow.is_view_once),
    downloaded: Boolean(fileRow.downloaded_at),
  };
}

export async function loadInboxSummary(userId) {
  const { data: ownMemberships, error: memberError } = await supabase
    .from('conversation_members')
    .select('conversation_id,last_read_at,is_favorite,is_muted')
    .eq('user_id', userId);
  if (memberError) throw memberError;

  const ownMap = new Map((ownMemberships || []).map((row) => [row.conversation_id, row]));
  const conversationIds = [...ownMap.keys()];
  let chats = [];

  if (conversationIds.length) {
    const { data: memberships, error: allMembersError } = await supabase
      .from('conversation_members')
      .select('conversation_id,user_id,last_read_at')
      .in('conversation_id', conversationIds);
    if (allMembersError) throw allMembersError;

    const peerIds = [...new Set((memberships || []).map((r) => r.user_id).filter((id) => id !== userId))];
    const { data: peers, error: profilesError } = peerIds.length
      ? await supabase.from('profiles').select('id,username,display_name,about,avatar_path,last_seen_at').in('id', peerIds)
      : { data: [], error: null };
    if (profilesError) throw profilesError;

    const peerMap = new Map((peers || []).map((p) => [p.id, p]));
    const avatarEntries = await Promise.all(
      (peers || []).map(async (peer) => [peer.id, await getSignedAvatarUrl(peer.avatar_path)]),
    );
    const peerAvatarMap = new Map(avatarEntries);

    const { data: recentRows, error: msgError } = await supabase
      .from('messages')
      .select('id,conversation_id,sender_id,body,attachment_id,deleted_at,created_at')
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: false })
      .limit(300);
    if (msgError) throw msgError;

    const attachmentIds = [...new Set((recentRows || []).map((m) => m.attachment_id).filter(Boolean))];
    const { data: attachments, error: attError } = attachmentIds.length
      ? await supabase.from('attachments').select('id,file_name,mime_type,size_bytes,is_view_once,downloaded_at').in('id', attachmentIds)
      : { data: [], error: null };
    if (attError) throw attError;
    const attachmentMap = new Map((attachments || []).map((a) => [a.id, a]));

    const latestByConv = new Map();
    const unreadByConv = new Map();

    for (const m of recentRows || []) {
      const own = ownMap.get(m.conversation_id);
      if (!latestByConv.has(m.conversation_id)) {
        const file = m.attachment_id ? attachmentMap.get(m.attachment_id) : null;
        latestByConv.set(m.conversation_id, {
          id: m.id,
          from: m.sender_id === userId ? 'me' : 'them',
          text: m.deleted_at ? 'Message deleted' : (m.body || ''),
          deletedAt: m.deleted_at,
          createdAt: m.created_at,
          time: formatTime(m.created_at),
          file: m.deleted_at ? null : mapAttachment(file),
        });
      }
      if (
        m.sender_id !== userId
        && !m.deleted_at
        && own?.last_read_at
        && new Date(m.created_at) > new Date(own.last_read_at)
      ) {
        unreadByConv.set(m.conversation_id, (unreadByConv.get(m.conversation_id) || 0) + 1);
      }
    }

    const seenConv = new Set();
    chats = (memberships || [])
      .filter((row) => row.user_id !== userId)
      .map((row) => {
        if (seenConv.has(row.conversation_id)) return null;
        seenConv.add(row.conversation_id);
        const peer = peerMap.get(row.user_id);
        if (!peer) return null;
        const own = ownMap.get(row.conversation_id);
        return {
          id: row.conversation_id,
          peerId: peer.id,
          name: peer.display_name,
          username: peer.username,
          about: peer.about || '',
          avatar: peerAvatarMap.get(peer.id) || '',
          avatarPath: peer.avatar_path || '',
          initial: initials(peer.display_name),
          color: '#dce8e2',
          lastSeenAt: peer.last_seen_at,
          lastReadAt: own?.last_read_at || null,
          peerLastReadAt: row.last_read_at || null,
          favorite: Boolean(own?.is_favorite),
          muted: Boolean(own?.is_muted),
          unread: unreadByConv.get(row.conversation_id) || 0,
          latestMessage: latestByConv.get(row.conversation_id) || null,
          messages: [],
          hasMore: true,
          loadingMore: false,
          loaded: false,
          sharedMedia: [],
        };
      })
      .filter(Boolean);
  }

  const [{ data: incomingRows, error: inErr }, { data: outgoingRows, error: outErr }] = await Promise.all([
    supabase
      .from('contact_requests')
      .select('id,sender_id,created_at')
      .eq('receiver_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supabase
      .from('contact_requests')
      .select('id,receiver_id,created_at')
      .eq('sender_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
  ]);
  if (inErr) throw inErr;
  if (outErr) throw outErr;

  const requestUserIds = [
    ...new Set([
      ...(incomingRows || []).map((r) => r.sender_id),
      ...(outgoingRows || []).map((r) => r.receiver_id),
    ]),
  ];
  const { data: reqProfiles, error: reqProfErr } = requestUserIds.length
    ? await supabase.from('profiles').select('id,username,display_name,about,avatar_path').in('id', requestUserIds)
    : { data: [], error: null };
  if (reqProfErr) throw reqProfErr;

  const reqAvatarEntries = await Promise.all(
    (reqProfiles || []).map(async (p) => [p.id, await getSignedAvatarUrl(p.avatar_path)]),
  );
  const reqAvatarMap = new Map(reqAvatarEntries);
  const reqProfileMap = new Map((reqProfiles || []).map((p) => [p.id, p]));

  const incomingRequests = (incomingRows || [])
    .map((r) => {
      const p = reqProfileMap.get(r.sender_id);
      if (!p) return null;
      return {
        id: r.id,
        peerId: p.id,
        name: p.display_name,
        username: p.username,
        about: p.about || '',
        avatar: reqAvatarMap.get(p.id) || '',
        initial: initials(p.display_name),
        color: '#dce8e2',
        text: 'Would like to connect with you.',
        createdAt: r.created_at,
      };
    })
    .filter(Boolean);

  const outgoingRequests = (outgoingRows || [])
    .map((r) => {
      const p = reqProfileMap.get(r.receiver_id);
      if (!p) return null;
      return {
        id: r.id,
        peerId: p.id,
        name: p.display_name,
        username: p.username,
        about: p.about || '',
        avatar: reqAvatarMap.get(p.id) || '',
        initial: initials(p.display_name),
        color: '#dce8e2',
        text: 'Request pending acceptance',
        createdAt: r.created_at,
      };
    })
    .filter(Boolean);

  return { chats, incomingRequests, outgoingRequests };
}

export async function hydrateMessages(rows, userId) {
  if (!rows?.length) return [];
  const messageIds = rows.map((m) => m.id);
  const attachmentIds = [...new Set(rows.map((m) => m.attachment_id).filter(Boolean))];
  const replyIds = [...new Set(rows.map((m) => m.reply_to_id).filter(Boolean))];
  const missingReplyIds = replyIds.filter((id) => !messageIds.includes(id));

  const [{ data: reactions, error: reactErr }, { data: attachments, error: attErr }, { data: extraReplies }] =
    await Promise.all([
      supabase.from('message_reactions').select('message_id,user_id,emoji').in('message_id', messageIds),
      attachmentIds.length
        ? supabase.from('attachments').select('id,file_name,mime_type,size_bytes,is_view_once,downloaded_at').in('id', attachmentIds)
        : Promise.resolve({ data: [], error: null }),
      missingReplyIds.length
        ? supabase.from('messages').select('id,sender_id,body,attachment_id,deleted_at').in('id', missingReplyIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

  if (reactErr) throw reactErr;
  if (attErr) throw attErr;

  const attachmentMap = new Map((attachments || []).map((a) => [a.id, a]));
  const allById = new Map();
  for (const r of rows) allById.set(r.id, r);
  for (const r of extraReplies || []) allById.set(r.id, r);

  return rows.map((m) => {
    const groupedReactions = new Map();
    for (const reaction of (reactions || []).filter((r) => r.message_id === m.id)) {
      const item = groupedReactions.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false };
      item.count++;
      item.mine ||= reaction.user_id === userId;
      groupedReactions.set(reaction.emoji, item);
    }
    const att = m.attachment_id ? attachmentMap.get(m.attachment_id) : null;
    const replySrc = m.reply_to_id ? allById.get(m.reply_to_id) : null;
    return {
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      from: m.sender_id === userId ? 'me' : 'them',
      text: m.body || '',
      createdAt: m.created_at,
      time: formatTime(m.created_at),
      editedAt: m.edited_at || null,
      deletedAt: m.deleted_at || null,
      replyToId: m.reply_to_id || null,
      replyPreview: replySrc
        ? {
            id: replySrc.id,
            senderId: replySrc.sender_id,
            text: replySrc.deleted_at
              ? 'Message deleted'
              : (replySrc.body || 'Attachment'),
          }
        : null,
      reactions: [...groupedReactions.values()],
      file: m.deleted_at ? null : mapAttachment(att),
      pending: false,
    };
  });
}

export async function loadMessages(conversationId, userId, { before = null, limit = 50 } = {}) {
  let req = supabase
    .from('messages')
    .select('id,conversation_id,sender_id,body,attachment_id,reply_to_id,edited_at,deleted_at,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) req = req.lt('created_at', before);
  const { data: rows, error } = await req;
  if (error) throw error;
  const chronological = [...(rows || [])].reverse();
  const messages = await hydrateMessages(chronological, userId);
  return { messages, hasMore: (rows || []).length === limit };
}

export async function loadSharedMedia(conversationId) {
  const { data, error } = await supabase
    .from('attachments')
    .select('id,file_name,mime_type,size_bytes,is_view_once,downloaded_at,created_at')
    .eq('conversation_id', conversationId)
    .eq('is_view_once', false)
    .is('downloaded_at', null)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return [];
  return (data || [])
    .filter((a) => a.mime_type?.startsWith('image/') || a.mime_type?.startsWith('video/'))
    .map(mapAttachment);
}

export async function searchPeople(searchText) {
  const term = String(searchText || '').trim().replace(/^@/, '');
  if (term.length < 2) return [];
  const { data, error } = await supabase.rpc('search_people', { search_text: term });
  if (error) throw error;
  return Promise.all(
    (data || []).map(async (person) => {
      const avatar = await getSignedAvatarUrl(person.avatar_path);
      return {
        id: person.id,
        username: person.username,
        name: person.display_name,
        about: person.about || '',
        avatar,
        initial: initials(person.display_name),
        color: '#dce8e2',
        relationship: person.relationship_status,
        requestId: person.request_id,
        conversationId: person.conversation_id,
      };
    }),
  );
}

export async function sendFriendRequest(targetUserId) {
  if (!isUuid(targetUserId)) {
    throw new Error('Choose a person from the search results, then send the friend request.');
  }
  const { data, error } = await supabase.rpc('send_friend_request', { target_user: targetUserId });
  if (error) throw error;
  return data;
}

export async function acceptContactRequest(requestId) {
  if (!isUuid(requestId)) throw new Error('This request is invalid. Refresh your requests and try again.');
  const { data, error } = await supabase.rpc('accept_contact_request', { request_id: requestId });
  if (error) throw error;
  return data;
}

export async function declineContactRequest(requestId) {
  if (!isUuid(requestId)) throw new Error('This request is invalid. Refresh your requests and try again.');
  const { error } = await supabase.rpc('decline_contact_request', { request_id: requestId });
  if (error) throw error;
}

export async function cancelFriendRequest(requestId) {
  if (!isUuid(requestId)) throw new Error('This request is invalid.');
  const { error } = await supabase.rpc('cancel_friend_request', { request_id: requestId });
  if (error) throw error;
}

export async function removeFriend(peerId) {
  if (!isUuid(peerId)) throw new Error('Invalid contact.');
  const { error } = await supabase.rpc('remove_friend', { peer_id: peerId });
  if (error) throw error;
}

export async function blockUser(peerId) {
  if (!isUuid(peerId)) throw new Error('Invalid user.');
  const { error } = await supabase.rpc('block_user', { peer_id: peerId });
  if (error) throw error;
}

export async function sendMessage({ conversationId, body, replyToId = null }) {
  requireConversationId(conversationId);
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Sign in again to send a message.');
  const payload = { conversation_id: conversationId, sender_id: user.id, body };
  if (isUuid(replyToId)) payload.reply_to_id = replyToId;
  const { data, error } = await supabase
    .from('messages')
    .insert(payload)
    .select('id,conversation_id,sender_id,body,attachment_id,reply_to_id,edited_at,deleted_at,created_at')
    .single();
  if (error) throw error;
  return data;
}

export async function editMessage(messageId, body) {
  if (!isUuid(messageId)) throw new Error('Invalid message.');
  const trimmed = String(body || '').trim();
  if (!trimmed) throw new Error('Message cannot be empty.');
  const { data, error } = await supabase
    .from('messages')
    .update({ body: trimmed, edited_at: new Date().toISOString() })
    .eq('id', messageId)
    .select('id,body,edited_at')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteMessage(messageId) {
  if (!isUuid(messageId)) throw new Error('Invalid message.');
  const { data, error } = await supabase
    .from('messages')
    .update({ body: '', deleted_at: new Date().toISOString() })
    .eq('id', messageId)
    .select('id,deleted_at')
    .single();
  if (error) throw error;
  return data;
}

export async function toggleReaction(messageId, emoji, mine) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in again to react.');
  if (mine) {
    const { error } = await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', user.id)
      .eq('emoji', emoji);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('message_reactions')
      .insert({ message_id: messageId, user_id: user.id, emoji });
    if (error) throw error;
  }
}

export async function markConversationRead(conversationId, userId) {
  if (!isUuid(conversationId) || !userId) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('conversation_members')
    .update({ last_read_at: now })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);
  if (!error) return now;
  return null;
}

export async function setConversationFavorite(conversationId, userId, isFavorite) {
  requireConversationId(conversationId);
  const { error } = await supabase
    .from('conversation_members')
    .update({ is_favorite: Boolean(isFavorite) })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function sendAttachment({ conversationId, file, caption = '', replyToId = null, viewOnce = false }) {
  requireConversationId(conversationId);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in again to send a file.');
  const form = new FormData();
  form.set('conversationId', conversationId);
  form.set('file', file);
  if (caption) form.set('caption', caption);
  if (isUuid(replyToId)) form.set('replyToId', replyToId);
  form.set('viewOnce', viewOnce ? 'true' : 'false');

  const response = await fetch(`${config.supabaseUrl}/functions/v1/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: config.supabaseAnonKey,
    },
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The attachment could not be sent.');
  return result;
}

export async function getAttachmentUrl(attachmentId) {
  if (!isUuid(attachmentId)) return '';
  const cached = state.mediaUrlCache.get(attachmentId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return '';
  const endpoint = `${config.supabaseUrl}/functions/v1/attachments?id=${encodeURIComponent(attachmentId)}&mode=url`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: config.supabaseAnonKey,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.url) return '';
  state.mediaUrlCache.set(attachmentId, { url: result.url, expiresAt: Date.now() + 50 * 60 * 1000 });
  return result.url;
}

export async function downloadAttachment(attachmentId, fileName) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in again to download this file.');
  const endpoint = `${config.supabaseUrl}/functions/v1/attachments?id=${encodeURIComponent(attachmentId)}`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: config.supabaseAnonKey,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The file could not be downloaded.');
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = fileName || 'attachment';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
}

export async function fetchViewOnceBlob(attachmentId) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in again to view this media.');
  const endpoint = `${config.supabaseUrl}/functions/v1/attachments?id=${encodeURIComponent(attachmentId)}`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: config.supabaseAnonKey,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'This view-once media is no longer available.');
  }
  const blob = await response.blob();
  return { blob, mimeType: response.headers.get('Content-Type') || blob.type };
}

export async function createCallInvite(conversationId) {
  requireConversationId(conversationId);
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Sign in again to send a call notification.');
  const { error } = await supabase.from('call_invites').insert({ conversation_id: conversationId, caller_id: user.id });
  if (error) throw error;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export async function getVapidPublicKey() {
  const res = await fetch(`${config.supabaseUrl}/functions/v1/push?action=vapid-public-key`, {
    headers: { apikey: config.supabaseAnonKey },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.publicKey) throw new Error(data.error || 'Could not load push key.');
  return data.publicKey;
}

export async function registerWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return false;

  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await getVapidPublicKey();
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const res = await fetch(`${config.supabaseUrl}/functions/v1/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action: 'subscribe', subscription: subscription.toJSON() }),
  });
  return res.ok;
}

export async function triggerPushNotification({ conversationId = '', targetUserId = '', title = 'Whisper', body = '', tag = 'whisper' }) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    await fetch(`${config.supabaseUrl}/functions/v1/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'notify', conversationId, targetUserId, title, body, tag }),
    });
  } catch {
    // Background push is best-effort and must not block foreground messaging.
  }
}
