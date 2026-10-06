import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body instanceof Blob ? body : JSON.stringify(body), {
    status,
    headers: { ...cors, ...(body instanceof Blob ? {} : { "Content-Type": "application/json" }), ...headers },
  });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return reply({ error: "Storage service is not configured." }, 500);
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Sign in to access attachments." }, 401);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return reply({ error: "Your session has expired. Sign in again." }, 401);

  if (request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    const conversationId = String(form.get("conversationId") || "");
    if (!(file instanceof File) || !conversationId) return reply({ error: "Choose a file and conversation." }, 400);
    const supported = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain"]);
    if (!supported.has(file.type)) return reply({ error: "This file type is not supported." }, 415);
    if (file.size < 1 || file.size > 3 * 1024 * 1024) return reply({ error: "Attachments must be 3 MB or smaller." }, 413);
    const { data: membership } = await admin.from("conversation_members").select("user_id").eq("conversation_id", conversationId).eq("user_id", user.id).maybeSingle();
    if (!membership) return reply({ error: "You are not a member of this conversation." }, 403);
    const attachmentId = crypto.randomUUID();
    const objectPath = `${conversationId}/${attachmentId}`;
    const { error: uploadError } = await admin.storage.from("message-files").upload(objectPath, file, { contentType: file.type, upsert: false });
    if (uploadError) return reply({ error: uploadError.message }, 500);
    const { error: metadataError } = await admin.from("attachments").insert({
      id: attachmentId,
      conversation_id: conversationId,
      uploader_id: user.id,
      object_path: objectPath,
      file_name: file.name.slice(0, 180),
      mime_type: file.type,
      size_bytes: file.size,
    });
    if (metadataError) {
      await admin.storage.from("message-files").remove([objectPath]);
      return reply({ error: metadataError.message }, 500);
    }
    const { error: messageError } = await admin.from("messages").insert({ conversation_id: conversationId, sender_id: user.id, body: "", attachment_id: attachmentId });
    if (messageError) {
      await admin.storage.from("message-files").remove([objectPath]);
      await admin.from("attachments").delete().eq("id", attachmentId);
      return reply({ error: messageError.message }, 500);
    }
    return reply({ id: attachmentId });
  }

  const attachmentId = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return reply({ error: "Attachment not found." }, 404);
  const { data: attachment, error: attachmentError } = await admin.from("attachments").select("id,conversation_id,uploader_id,object_path,file_name,mime_type,downloaded_at").eq("id", attachmentId).maybeSingle();
  if (attachmentError || !attachment) return reply({ error: "Attachment not found." }, 404);
  const { data: membership } = await admin.from("conversation_members").select("user_id").eq("conversation_id", attachment.conversation_id).eq("user_id", user.id).maybeSingle();
  if (!membership || attachment.uploader_id === user.id) return reply({ error: "Only the other conversation member can download this file." }, 403);
  if (attachment.downloaded_at) return reply({ error: "This one-time attachment has already been downloaded." }, 410);

  if (request.method === "GET") {
    const { data: file, error: downloadError } = await admin.storage.from("message-files").download(attachment.object_path);
    if (downloadError || !file) return reply({ error: "The file is no longer available." }, 410);
    const safeName = encodeURIComponent(attachment.file_name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply(file, 200, {
      "Content-Type": attachment.mime_type,
      "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`,
      "Cache-Control": "private, no-store",
      "Access-Control-Expose-Headers": "Content-Disposition",
    });
  }

  if (request.method === "DELETE") {
    const { error: removeError } = await admin.storage.from("message-files").remove([attachment.object_path]);
    if (removeError) return reply({ error: "The download finished, but the server could not remove the file yet." }, 500);
    const { error: updateError } = await admin.from("attachments").update({ downloaded_at: new Date().toISOString() }).eq("id", attachment.id).is("downloaded_at", null);
    if (updateError) return reply({ error: "The file was removed, but its message status could not be updated." }, 500);
    return reply({ downloaded: true });
  }
  return reply({ error: "Method not allowed." }, 405);
});
