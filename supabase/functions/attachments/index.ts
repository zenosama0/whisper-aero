import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
};

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body instanceof Blob ? body : JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...(body instanceof Blob ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
  });

const MAX_BYTES = 10 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return reply({ error: "Storage service is not configured." }, 500);
  }

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Sign in to access attachments." }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) {
    return reply({ error: "Your session has expired. Sign in again." }, 401);
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    const conversationId = String(form.get("conversationId") || "");
    const caption = String(form.get("caption") || "").trim().slice(0, 12000);
    const replyToRaw = String(form.get("replyToId") || "").trim();
    const replyToId = UUID_RE.test(replyToRaw) ? replyToRaw : null;
    const isViewOnce = String(form.get("viewOnce") || "false") === "true";

    if (!(file instanceof File) || !UUID_RE.test(conversationId)) {
      return reply({ error: "Choose a file and conversation." }, 400);
    }
    if (file.size < 1 || file.size > MAX_BYTES) {
      return reply({ error: "Attachments must be 10 MB or smaller." }, 413);
    }
    const mimeType = (file.type || "application/octet-stream").trim().slice(0, 160) || "application/octet-stream";

    const { data: membership } = await admin
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return reply({ error: "You are not a member of this conversation." }, 403);
    }

    const attachmentId = crypto.randomUUID();
    const objectPath = `${conversationId}/${attachmentId}`;
    const { error: uploadError } = await admin.storage
      .from("message-files")
      .upload(objectPath, file, { contentType: mimeType, upsert: false });
    if (uploadError) return reply({ error: uploadError.message }, 500);

    const { error: metadataError } = await admin.from("attachments").insert({
      id: attachmentId,
      conversation_id: conversationId,
      uploader_id: user.id,
      object_path: objectPath,
      file_name: (file.name || "attachment").slice(0, 180),
      mime_type: mimeType,
      size_bytes: file.size,
      is_view_once: isViewOnce,
    });
    if (metadataError) {
      await admin.storage.from("message-files").remove([objectPath]);
      return reply({ error: metadataError.message }, 500);
    }

    const { data: messageRow, error: messageError } = await admin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: caption,
        attachment_id: attachmentId,
        reply_to_id: replyToId,
      })
      .select("id")
      .single();

    if (messageError) {
      await admin.storage.from("message-files").remove([objectPath]);
      await admin.from("attachments").delete().eq("id", attachmentId);
      return reply({ error: messageError.message }, 500);
    }

    return reply({ id: attachmentId, messageId: messageRow.id });
  }

  const reqUrl = new URL(request.url);
  const attachmentId = reqUrl.searchParams.get("id") || "";
  const mode = reqUrl.searchParams.get("mode") || "";
  if (!UUID_RE.test(attachmentId)) {
    return reply({ error: "Attachment not found." }, 404);
  }

  const { data: attachment, error: attachmentError } = await admin
    .from("attachments")
    .select("id,conversation_id,uploader_id,object_path,file_name,mime_type,is_view_once,downloaded_at")
    .eq("id", attachmentId)
    .maybeSingle();

  if (attachmentError || !attachment) {
    return reply({ error: "Attachment not found." }, 404);
  }

  const { data: membership } = await admin
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", attachment.conversation_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    return reply({ error: "You are not a member of this conversation." }, 403);
  }

  if (attachment.is_view_once) {
    if (attachment.uploader_id === user.id) {
      return reply({ error: "Only the recipient can open a view-once attachment." }, 403);
    }
    if (attachment.downloaded_at) {
      return reply({ error: "This view-once attachment has already been opened." }, 410);
    }

    if (request.method === "GET") {
      // Atomically claim the one-time view before reading/deleting from storage.
      const { data: claimed, error: claimError } = await admin
        .from("attachments")
        .update({ downloaded_at: new Date().toISOString() })
        .eq("id", attachment.id)
        .is("downloaded_at", null)
        .select("id")
        .maybeSingle();

      if (claimError || !claimed) {
        return reply({ error: "This view-once attachment has already been opened." }, 410);
      }

      const { data: file, error: downloadError } = await admin.storage
        .from("message-files")
        .download(attachment.object_path);

      // Remove from storage immediately regardless so it cannot be fetched again.
      await admin.storage.from("message-files").remove([attachment.object_path]);

      if (downloadError || !file) {
        return reply({ error: "The file is no longer available." }, 410);
      }

      const safeName = encodeURIComponent(attachment.file_name).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return reply(file, 200, {
        "Content-Type": attachment.mime_type,
        "Content-Disposition": `inline; filename*=UTF-8''${safeName}`,
        "Cache-Control": "private, no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        "Access-Control-Expose-Headers": "Content-Disposition, Content-Type",
      });
    }

    if (request.method === "DELETE") {
      await admin.storage.from("message-files").remove([attachment.object_path]);
      await admin
        .from("attachments")
        .update({ downloaded_at: new Date().toISOString() })
        .eq("id", attachment.id)
        .is("downloaded_at", null);
      return reply({ downloaded: true });
    }

    return reply({ error: "Method not allowed." }, 405);
  }

  // Persistent attachment: accessible to any conversation member.
  if (request.method === "GET") {
    if (mode === "url") {
      const { data: signed, error: signError } = await admin.storage
        .from("message-files")
        .createSignedUrl(attachment.object_path, 3600);
      if (signError || !signed?.signedUrl) {
        return reply({ error: "Could not create media URL." }, 500);
      }
      return reply({ url: signed.signedUrl, mimeType: attachment.mime_type, fileName: attachment.file_name });
    }

    const { data: file, error: downloadError } = await admin.storage
      .from("message-files")
      .download(attachment.object_path);
    if (downloadError || !file) {
      return reply({ error: "The file is no longer available." }, 410);
    }

    const safeName = encodeURIComponent(attachment.file_name).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return reply(file, 200, {
      "Content-Type": attachment.mime_type,
      "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`,
      "Cache-Control": "private, max-age=300",
      "Access-Control-Expose-Headers": "Content-Disposition, Content-Type",
    });
  }

  return reply({ error: "Method not allowed." }, 405);
});
