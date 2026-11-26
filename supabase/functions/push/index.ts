import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function getOrCreateVapidKeys(admin: ReturnType<typeof createClient>) {
  const { data: existing } = await admin
    .from("vapid_keyring")
    .select("public_key,private_key")
    .eq("id", 1)
    .maybeSingle();

  if (existing?.public_key && existing?.private_key) {
    return { publicKey: existing.public_key, privateKey: existing.private_key };
  }

  const generated = webpush.generateVAPIDKeys();
  await admin
    .from("vapid_keyring")
    .upsert({ id: 1, public_key: generated.publicKey, private_key: generated.privateKey }, { onConflict: "id" });

  const { data: saved } = await admin
    .from("vapid_keyring")
    .select("public_key,private_key")
    .eq("id", 1)
    .single();

  return { publicKey: saved.public_key, privateKey: saved.private_key };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return reply({ error: "Push service is not configured." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (request.method === "GET") {
    const action = new URL(request.url).searchParams.get("action") || "vapid-public-key";
    if (action !== "vapid-public-key") return reply({ error: "Unknown action." }, 400);
    const keys = await getOrCreateVapidKeys(admin);
    return reply({ publicKey: keys.publicKey });
  }

  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Sign in required." }, 401);

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return reply({ error: "Session expired." }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "Invalid request body." }, 400);
  }

  const action = String(body.action || "");

  if (action === "subscribe") {
    const subscription = body.subscription as { endpoint?: string; keys?: unknown } | undefined;
    if (!subscription?.endpoint || !subscription?.keys) {
      return reply({ error: "Invalid push subscription." }, 400);
    }
    const { error } = await admin
      .from("push_subscriptions")
      .upsert(
        { user_id: user.id, endpoint: subscription.endpoint, subscription },
        { onConflict: "endpoint" },
      );
    if (error) return reply({ error: error.message }, 500);
    return reply({ subscribed: true });
  }

  if (action === "unsubscribe") {
    const endpoint = String(body.endpoint || "");
    if (!endpoint) return reply({ error: "Endpoint required." }, 400);
    await admin.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", endpoint);
    return reply({ unsubscribed: true });
  }

  if (action === "notify") {
    const conversationId = String(body.conversationId || "");
    const targetUserId = String(body.targetUserId || "");
    const title = String(body.title || "Whisper").slice(0, 80);
    const msgBody = String(body.body || "You have a new notification.").slice(0, 200);
    const tag = String(body.tag || "whisper").slice(0, 64);

    let recipientIds: string[] = [];

    if (UUID_RE.test(conversationId)) {
      const { data: members } = await admin
        .from("conversation_members")
        .select("user_id,is_muted")
        .eq("conversation_id", conversationId);

      const isMember = (members || []).some((m) => m.user_id === user.id);
      if (!isMember) return reply({ error: "Not a conversation member." }, 403);
      recipientIds = (members || [])
        .filter((m) => m.user_id !== user.id && !m.is_muted)
        .map((m) => m.user_id);
    } else if (UUID_RE.test(targetUserId)) {
      recipientIds = [targetUserId];
    } else {
      return reply({ error: "Target conversation or user required." }, 400);
    }

    if (!recipientIds.length) return reply({ sent: 0 });

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id,endpoint,subscription")
      .in("user_id", recipientIds);

    if (!subs?.length) return reply({ sent: 0 });

    const keys = await getOrCreateVapidKeys(admin);
    webpush.setVapidDetails(
      "mailto:whisper-aero@users.noreply.github.com",
      keys.publicKey,
      keys.privateKey,
    );

    const payload = JSON.stringify({ title, body: msgBody, tag, url: "./" });
    let sent = 0;

    await Promise.all(
      subs.map(async (row) => {
        try {
          await webpush.sendNotification(row.subscription, payload);
          sent++;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            await admin.from("push_subscriptions").delete().eq("id", row.id);
          }
        }
      }),
    );

    return reply({ sent });
  }

  return reply({ error: "Unknown action." }, 400);
});
