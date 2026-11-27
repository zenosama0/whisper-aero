import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_STORED_BYTES = 490 * 1024;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return reply({ error: "Storage service is not configured." }, 500);
  }

  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Sign in to update your profile photo." }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return reply({ error: "Session expired." }, 401);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) {
    return reply({ error: "Choose an image to upload." }, 400);
  }
  if (file.size > MAX_INPUT_BYTES) {
    return reply({ error: "Source image must be 12 MB or smaller." }, 413);
  }

  const rawBytes = new Uint8Array(await file.arrayBuffer());
  let outBytes = rawBytes;
  let contentType = file.type || "image/jpeg";
  let ext = "jpg";

  try {
    const decoded = await Image.decode(rawBytes);
    const side = Math.min(decoded.width, decoded.height);
    const cropX = Math.max(0, Math.floor((decoded.width - side) / 2));
    const cropY = Math.max(0, Math.floor((decoded.height - side) / 2));
    const square = decoded.crop(cropX, cropY, side, side);
    const target = Math.min(512, side);
    if (square.width > target || square.height > target) {
      square.resize(target, target);
    }

    let encoded = await square.encodeJPEG(84);
    if (encoded.byteLength > MAX_STORED_BYTES) {
      encoded = await square.encodeJPEG(68);
    }
    if (encoded.byteLength > MAX_STORED_BYTES) {
      square.resize(320, 320);
      encoded = await square.encodeJPEG(62);
    }
    outBytes = encoded;
    contentType = "image/jpeg";
    ext = "jpg";
  } catch {
    const allowedRaw = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    if (rawBytes.byteLength > MAX_STORED_BYTES || !allowedRaw.has(contentType)) {
      return reply({ error: "Could not compress this image. Please choose a JPEG, PNG, or WebP photo." }, 415);
    }
    ext = (contentType.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  }

  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await admin.storage
    .from("profile-avatars")
    .upload(path, outBytes, { contentType, upsert: true });
  if (uploadError) return reply({ error: uploadError.message }, 500);

  const { error: updateError } = await admin
    .from("profiles")
    .update({ avatar_path: path })
    .eq("id", user.id);
  if (updateError) return reply({ error: updateError.message }, 500);

  const { data: signed } = await admin.storage
    .from("profile-avatars")
    .createSignedUrl(path, 3600);

  return reply({
    avatar_path: path,
    avatar: signed?.signedUrl || "",
    size_bytes: outBytes.byteLength,
  });
});
