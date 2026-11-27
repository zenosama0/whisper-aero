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

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

let cachedSaToken: { token: string; expiresAt: number } | null = null;

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function getServiceAccount(): ServiceAccount | null {
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (parsed.project_id && parsed.client_email && parsed.private_key) {
      return {
        project_id: parsed.project_id,
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    }
  } catch {
    // Ignore malformed secret
  }
  return null;
}

async function getFcmAccessToken(sa: ServiceAccount): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedSaToken && cachedSaToken.expiresAt - nowSec > 120) {
    return cachedSaToken.token;
  }

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(sigBuf))}`;

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const tokenJson = await tokenResp.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!tokenResp.ok || !tokenJson.access_token) {
    throw new Error("Could not mint FCM OAuth access token");
  }
  cachedSaToken = {
    token: tokenJson.access_token,
    expiresAt: nowSec + Number(tokenJson.expires_in || 3600),
  };
  return cachedSaToken.token;
}

async function sendFcmDataMessage(
  sa: ServiceAccount,
  fcmToken: string,
  dataPayload: Record<string, string>,
): Promise<{ ok: boolean; remove?: boolean }> {
  const accessToken = await getFcmAccessToken(sa);
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        android: {
          priority: "HIGH",
          ttl: dataPayload.type === "call" ? "45s" : "86400s",
        },
        data: dataPayload,
      },
    }),
  });
  if (resp.ok) return { ok: true };
  const errText = await resp.text().catch(() => "");
  const remove = resp.status === 404 || errText.includes("UNREGISTERED");
  return { ok: false, remove };
}

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

  if (action === "subscribe_fcm") {
    const fcmToken = String(body.token || "").trim();
    if (!fcmToken || fcmToken.length < 16) {
      return reply({ error: "Valid FCM token required." }, 400);
    }
    const endpoint = `fcm:${fcmToken}`;
    const { error } = await admin
      .from("push_subscriptions")
      .upsert(
        {
          user_id: user.id,
          endpoint,
          subscription: { type: "fcm", token: fcmToken, platform: "android" },
        },
        { onConflict: "endpoint" },
      );
    if (error) return reply({ error: error.message }, 500);
    return reply({ subscribed: true, platform: "android" });
  }

  if (action === "unsubscribe_fcm") {
    const fcmToken = String(body.token || "").trim();
    if (!fcmToken) return reply({ error: "Token required." }, 400);
    await admin.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", `fcm:${fcmToken}`);
    return reply({ unsubscribed: true });
  }

  if (action === "notify") {
    const conversationId = String(body.conversationId || "");
    const targetUserId = String(body.targetUserId || "");
    const title = String(body.title || "Whisper").slice(0, 80);
    const msgBody = String(body.body || "You have a new notification.").slice(0, 200);
    const tag = String(body.tag || "whisper").slice(0, 64);
    const kind = String(body.kind || (tag.startsWith("whisper-call") ? "call" : "message"));

    let recipientIds: string[] = [];

    if (UUID_RE.test(conversationId)) {
      const { data: members } = await admin
        .from("conversation_members")
        .select("user_id,is_muted")
        .eq("conversation_id", conversationId);

      const isMember = (members || []).some((m) => m.user_id === user.id);
      if (!isMember) return reply({ error: "Not a conversation member." }, 403);
      recipientIds = (members || [])
        .filter((m) => m.user_id !== user.id && (kind === "call" || !m.is_muted))
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

    let senderIcon = "";
    let senderDisplay = title;
    const { data: senderProfile } = await admin
      .from("profiles")
      .select("display_name,username,avatar_path")
      .eq("id", user.id)
      .maybeSingle();

    if (senderProfile?.display_name || senderProfile?.username) {
      senderDisplay = senderProfile.display_name || senderProfile.username || title;
    }
    if (senderProfile?.avatar_path) {
      const { data: signed } = await admin.storage
        .from("profile-avatars")
        .createSignedUrl(senderProfile.avatar_path, 86400);
      if (signed?.signedUrl) senderIcon = signed.signedUrl;
    }

    const chatIdParam = UUID_RE.test(conversationId) ? conversationId : "";
    const targetUrl = chatIdParam ? `./?chat=${chatIdParam}` : "./";
    const payload = JSON.stringify({
      title,
      body: msgBody,
      tag,
      kind,
      icon: senderIcon,
      conversationId: chatIdParam,
      url: targetUrl,
    });
    const sa = getServiceAccount();
    let sent = 0;

    await Promise.all(
      subs.map(async (row) => {
        const subObj = row.subscription as { type?: string; token?: string } | null;
        if (subObj?.type === "fcm" && subObj?.token) {
          if (!sa) return;
          try {
            const res = await sendFcmDataMessage(sa, subObj.token, {
              type: kind,
              conversationId: chatIdParam,
              title,
              senderName: senderDisplay,
              body: msgBody,
              icon: senderIcon,
              tag,
              sentAt: String(Date.now()),
            });
            if (res.ok) sent++;
            else if (res.remove) {
              await admin.from("push_subscriptions").delete().eq("id", row.id);
            }
          } catch {
            // Keep going for other subscriptions
          }
          return;
        }
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
