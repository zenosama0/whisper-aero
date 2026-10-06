import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.WHISPER_CONFIG || {};
const ready = Boolean(config.supabaseUrl && config.supabaseAnonKey);
export const supabase = ready ? createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
export const configured = ready;
let liveChannel;

export async function signUp({ email, password, username, displayName }) {
  return supabase.auth.signUp({ email, password, options: { data: { username: username.toLowerCase(), display_name: displayName }, emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
}
export async function signIn(email, password) { return supabase.auth.signInWithPassword({ email, password }); }
export async function signOut() { return supabase.auth.signOut(); }
export async function getSession() { return supabase.auth.getSession(); }
export function onAuthStateChange(callback) { return supabase.auth.onAuthStateChange(callback); }
export async function getProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('id,username,display_name,about,avatar_path').eq('id', userId).single();
  if (error) throw error;
  let avatar = '';
  if (data.avatar_path) {
    const { data: signed } = await supabase.storage.from('profile-avatars').createSignedUrl(data.avatar_path, 3600);
    avatar = signed?.signedUrl || '';
  }
  return { ...data, avatar };
}

export async function loadInbox(userId) {
  const { data: ownMemberships, error: memberError } = await supabase.from('conversation_members').select('conversation_id').eq('user_id', userId);
  if (memberError) throw memberError;
  const conversationIds = [...new Set((ownMemberships || []).map(row => row.conversation_id))];
  let chats = [];
  if (conversationIds.length) {
    const { data: memberships, error } = await supabase.from('conversation_members').select('conversation_id,user_id').in('conversation_id', conversationIds);
    if (error) throw error;
    const peerIds = [...new Set((memberships || []).map(row => row.user_id).filter(id => id !== userId))];
    const { data: peers, error: profilesError } = peerIds.length
      ? await supabase.from('profiles').select('id,username,display_name,about,avatar_path').in('id', peerIds)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const peerMap = new Map((peers || []).map(p => [p.id, p]));
    const peerAvatarMap = new Map();
    for (const peer of peers || []) {
      if (peer.avatar_path) {
        const { data: signed } = await supabase.storage.from('profile-avatars').createSignedUrl(peer.avatar_path, 3600);
        if (signed?.signedUrl) peerAvatarMap.set(peer.id, signed.signedUrl);
      }
    }
    const { data: rows, error: messageError } = await supabase.from('messages').select('id,conversation_id,sender_id,body,attachment_id,created_at').in('conversation_id', conversationIds).order('created_at');
    if (messageError) throw messageError;
    const messageIds = (rows || []).map(m => m.id);
    const { data: reactions, error: reactionError } = messageIds.length
      ? await supabase.from('message_reactions').select('message_id,user_id,emoji').in('message_id', messageIds)
      : { data: [], error: null };
    if (reactionError) throw reactionError;
    const attachmentIds = [...new Set((rows || []).map(m => m.attachment_id).filter(Boolean))];
    const { data: attachments, error: attachmentError } = attachmentIds.length
      ? await supabase.from('attachments').select('id,file_name,mime_type,size_bytes,downloaded_at').in('id', attachmentIds)
      : { data: [], error: null };
    if (attachmentError) throw attachmentError;
    const attachmentMap = new Map((attachments || []).map(a => [a.id, a]));
    const grouped = new Map();
    for (const m of rows || []) {
      const list = grouped.get(m.conversation_id) || [];
      const groupedReactions = new Map();
      for (const reaction of (reactions || []).filter(r => r.message_id === m.id)) {
        const item = groupedReactions.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false };
        item.count++;
        item.mine ||= reaction.user_id === userId;
        groupedReactions.set(reaction.emoji, item);
      }
      const file = m.attachment_id ? attachmentMap.get(m.attachment_id) : null;
      list.push({ id: m.id, from: m.sender_id === userId ? 'me' : 'them', text: m.body, createdAt: m.created_at, time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), reactions: [...groupedReactions.values()], file: file ? { id: file.id, name: file.file_name, type: file.mime_type, size: file.size_bytes < 1048576 ? `${Math.max(1, Math.round(file.size_bytes / 1024))} KB` : `${(file.size_bytes / 1048576).toFixed(1)} MB`, downloaded: Boolean(file.downloaded_at) } : null });
      grouped.set(m.conversation_id, list);
    }
    chats = memberships.filter(row => row.user_id !== userId).map(row => {
      const peer = peerMap.get(row.user_id);
      if (!peer) return null;
      return { id: row.conversation_id, peerId: peer.id, name: peer.display_name, username: peer.username, about: peer.about, avatar: peerAvatarMap.get(peer.id) || '', initial: peer.display_name.slice(0, 1).toUpperCase(), color: '#dce8e2', online: false, favorite: false, unread: 0, messages: grouped.get(row.conversation_id) || [] };
    }).filter(Boolean);
  }
  const { data: requestRows, error: requestsError } = await supabase.from('contact_requests').select('id,sender_id,created_at').eq('receiver_id', userId).eq('status', 'pending').order('created_at', { ascending: false });
  if (requestsError) throw requestsError;
  const senderIds = [...new Set((requestRows || []).map(r => r.sender_id))];
  const { data: senders, error: sendersError } = senderIds.length
    ? await supabase.from('profiles').select('id,username,display_name,about').in('id', senderIds)
    : { data: [], error: null };
  if (sendersError) throw sendersError;
  const senderMap = new Map((senders || []).map(p => [p.id, p]));
  const requests = (requestRows || []).map(r => {
    const p = senderMap.get(r.sender_id);
    return p && { id: r.id, name: p.display_name, username: p.username, initial: p.display_name.slice(0, 1).toUpperCase(), color: '#dce8e2', text: 'Would like to connect with you.' };
  }).filter(Boolean);
  return { chats, requests };
}

export async function createContactRequest(username) {
  const { error } = await supabase.rpc('create_contact_request', { target_username: username });
  if (error) throw error;
}
export async function acceptContactRequest(requestId) {
  const { data, error } = await supabase.rpc('accept_contact_request', { request_id: requestId });
  if (error) throw error;
  return data;
}
export async function declineContactRequest(requestId) {
  const { error } = await supabase.rpc('decline_contact_request', { request_id: requestId });
  if (error) throw error;
}
export async function createCallInvite(conversationId) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Sign in again to send a call notification.');
  const { error } = await supabase.from('call_invites').insert({ conversation_id: conversationId, caller_id: user.id });
  if (error) throw error;
}
export async function sendMessage(conversationId, body) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Sign in again to send a message.');
  const { error } = await supabase.from('messages').insert({ conversation_id: conversationId, sender_id: user.id, body });
  if (error) throw error;
}
export async function sendAttachment(conversationId, file) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in again to send a file.');
  const form = new FormData();
  form.set('conversationId', conversationId);
  form.set('file', file);
  const response = await fetch(`${config.supabaseUrl}/functions/v1/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, apikey: config.supabaseAnonKey }, body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The attachment could not be sent.');
}
export async function downloadAttachment(attachmentId, fileName) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in again to download this file.');
  const endpoint = `${config.supabaseUrl}/functions/v1/attachments?id=${encodeURIComponent(attachmentId)}`;
  const headers = { Authorization: `Bearer ${session.access_token}`, apikey: config.supabaseAnonKey };
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The file could not be downloaded.');
  }
  const blob = await response.blob();
  const removal = await fetch(endpoint, { method: 'DELETE', headers });
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
  if (!removal.ok) {
    const error = await removal.json().catch(() => ({}));
    throw new Error(error.error || 'The file downloaded, but server cleanup did not finish.');
  }
}
export async function toggleReaction(messageId, emoji, mine) {
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) throw new Error('Sign in again to react.');
  const query = supabase.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', user.id).eq('emoji', emoji);
  const result = mine ? await query : await supabase.from('message_reactions').insert({ message_id: messageId, user_id: user.id, emoji });
  if (result.error) throw result.error;
}
export async function updateProfile({ displayName, about, file }) {
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) throw new Error('Sign in again to update your profile.');
  const changes = { display_name: displayName, about };
  if (file) {
    const path = `${user.id}/${crypto.randomUUID()}.${file.name.split('.').pop().toLowerCase()}`;
    const { error: uploadError } = await supabase.storage.from('profile-avatars').upload(path, file, { upsert: true, contentType: file.type });
    if (uploadError) throw uploadError;
    changes.avatar_path = path;
  }
  const { error } = await supabase.from('profiles').update(changes).eq('id', user.id);
  if (error) throw error;
  return getProfile(user.id);
}
export function subscribe(callback) {
  if (liveChannel) supabase.removeChannel(liveChannel);
  liveChannel = supabase.channel('whisper-inbox').on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, callback).on('postgres_changes', { event: '*', schema: 'public', table: 'contact_requests' }, callback).on('postgres_changes', { event: '*', schema: 'public', table: 'attachments' }, callback).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_invites' }, callback).subscribe();
  return () => { if (liveChannel) supabase.removeChannel(liveChannel); liveChannel = null; };
}
export function unsubscribe() {
  if (liveChannel) supabase.removeChannel(liveChannel);
  liveChannel = null;
}
