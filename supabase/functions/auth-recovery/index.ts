import { createClient } from "npm:@supabase/supabase-js@2";

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

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateReadableCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeCode(code: string): string {
  return String(code || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return reply({ error: "Recovery service is not configured." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "Invalid request body." }, 400);
  }

  const action = String(body.action || "");

  if (action === "reset-password-with-code") {
    const identifier = String(body.identifier || "").trim().toLowerCase();
    const rawCode = normalizeCode(String(body.code || ""));
    const newPassword = String(body.newPassword || "");

    if (!identifier) return reply({ error: "Enter your email address or @username." }, 400);
    if (rawCode.length < 6) return reply({ error: "Enter a valid backup code." }, 400);
    if (newPassword.length < 8) return reply({ error: "Choose a password with at least 8 characters." }, 400);

    const { data: attemptRow } = await admin
      .from("recovery_attempts")
      .select("identifier,attempts,window_started_at")
      .eq("identifier", identifier)
      .maybeSingle();

    const now = Date.now();
    const windowExpired = !attemptRow
      || (now - new Date(attemptRow.window_started_at).getTime()) > 15 * 60 * 1000;
    const currentAttempts = windowExpired ? 0 : (attemptRow?.attempts || 0);

    if (currentAttempts >= 5) {
      return reply({ error: "Too many failed recovery attempts. Wait 15 minutes or use email fallback." }, 429);
    }

    const recordFailure = async () => {
      await admin.from("recovery_attempts").upsert({
        identifier,
        attempts: currentAttempts + 1,
        window_started_at: windowExpired ? new Date().toISOString() : attemptRow.window_started_at,
      });
    };

    const { data: userId, error: lookupError } = await admin.rpc("find_user_id_by_identifier", {
      p_identifier: identifier,
    });

    if (lookupError || !userId) {
      await recordFailure();
      return reply({ error: "Invalid email/username or backup code." }, 400);
    }

    const hash = await sha256Hex(`${userId}:${rawCode}`);
    const { data: claimed, error: claimError } = await admin
      .from("user_recovery_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("code_hash", hash)
      .is("used_at", null)
      .select("id")
      .limit(1)
      .maybeSingle();

    if (claimError || !claimed) {
      await recordFailure();
      return reply({ error: "Invalid email/username or backup code." }, 400);
    }

    const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (updateErr) {
      return reply({ error: updateErr.message || "Could not update password." }, 500);
    }

    await admin.from("recovery_attempts").delete().eq("identifier", identifier);
    return reply({ ok: true });
  }

  // All remaining actions require a signed-in user JWT.
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Sign in required." }, 401);

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return reply({ error: "Session expired. Sign in again." }, 401);

  if (action === "codes-status") {
    const { count, error } = await admin
      .from("user_recovery_codes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("used_at", null);
    if (error) return reply({ error: error.message }, 500);
    return reply({ remaining: count || 0 });
  }

  if (action === "generate-codes") {
    const plainCodes: string[] = [];
    const rows: { user_id: string; code_hash: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const code = generateReadableCode();
      plainCodes.push(code);
      rows.push({
        user_id: user.id,
        code_hash: await sha256Hex(`${user.id}:${normalizeCode(code)}`),
      });
    }

    await admin.from("user_recovery_codes").delete().eq("user_id", user.id).is("used_at", null);
    const { error: insertErr } = await admin.from("user_recovery_codes").insert(rows);
    if (insertErr) return reply({ error: insertErr.message }, 500);

    return reply({ codes: plainCodes, remaining: plainCodes.length });
  }

  if (action === "consume-2fa-backup") {
    const rawCode = normalizeCode(String(body.code || ""));
    if (rawCode.length < 6) return reply({ error: "Enter a valid backup code." }, 400);

    const hash = await sha256Hex(`${user.id}:${rawCode}`);
    const { data: claimed, error: claimErr } = await admin
      .from("user_recovery_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("code_hash", hash)
      .is("used_at", null)
      .select("id")
      .limit(1)
      .maybeSingle();

    if (claimErr || !claimed) {
      return reply({ error: "Invalid or already-used backup code." }, 400);
    }

    const { data: factorData } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
    for (const factor of factorData?.factors || []) {
      await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id });
    }

    const { count } = await admin
      .from("user_recovery_codes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("used_at", null);

    return reply({ unlocked: true, remaining: count || 0 });
  }

  return reply({ error: "Unknown action." }, 400);
});
