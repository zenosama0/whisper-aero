package com.whisperaero.app

import android.content.Context
import android.net.Uri
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class NativeSession(
    val supabaseUrl: String,
    val anonKey: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long,
    val userId: String,
)

data class PeerMeta(
    val name: String,
    val avatar: String,
    val avatarPath: String = "",
    val muted: Boolean = false,
)

object SessionStore {
    private const val PREFS = "whisper_native_session"
    private const val KEY_URL = "supabase_url"
    private const val KEY_ANON = "anon_key"
    private const val KEY_ACCESS = "access_token"
    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_EXPIRES = "expires_at"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_CHATS = "chats_json"
    private const val KEY_BG_SYNC = "foreground_socket_enabled"
    private const val KEY_LAST_SEEN_ISO = "last_seen_iso"
    private const val KEY_FCM_TOKEN = "fcm_token"

    private val lock = Any()

    fun saveFromJson(context: Context, json: String) {
        try {
            val obj = JSONObject(json)
            val supabaseUrl = obj.optString("supabaseUrl").trim().trimEnd('/')
            val anonKey = obj.optString("anonKey").trim()
            val accessToken = obj.optString("accessToken").trim()
            val refreshToken = obj.optString("refreshToken").trim()
            val expiresAt = obj.optLong("expiresAt", 0L)
            val userId = obj.optString("userId").trim()
            if (supabaseUrl.isEmpty() || anonKey.isEmpty() || accessToken.isEmpty() || userId.isEmpty()) {
                return
            }

            val chatsObj = JSONObject()
            val arr = obj.optJSONArray("chats")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val id = item.optString("id")
                    if (id.isBlank()) continue
                    chatsObj.put(
                        id,
                        JSONObject().apply {
                            put("name", item.optString("name", "Whisper"))
                            put("avatar", item.optString("avatar", ""))
                            put("avatarPath", item.optString("avatarPath", ""))
                            put("muted", item.optBoolean("muted", false))
                        },
                    )
                }
            }

            synchronized(lock) {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_URL, supabaseUrl)
                    .putString(KEY_ANON, anonKey)
                    .putString(KEY_ACCESS, accessToken)
                    .putString(KEY_REFRESH, refreshToken)
                    .putLong(KEY_EXPIRES, expiresAt)
                    .putString(KEY_USER_ID, userId)
                    .putString(KEY_CHATS, chatsObj.toString())
                    .apply()
            }
        } catch (_: Exception) {
        }
    }

    fun getSession(context: Context): NativeSession? {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val url = prefs.getString(KEY_URL, "") ?: ""
            val anon = prefs.getString(KEY_ANON, "") ?: ""
            val access = prefs.getString(KEY_ACCESS, "") ?: ""
            val refresh = prefs.getString(KEY_REFRESH, "") ?: ""
            val expiresAt = prefs.getLong(KEY_EXPIRES, 0L)
            val userId = prefs.getString(KEY_USER_ID, "") ?: ""
            if (url.isBlank() || anon.isBlank() || access.isBlank() || userId.isBlank()) return null
            return NativeSession(url, anon, access, refresh, expiresAt, userId)
        }
    }

    fun getSessionJson(context: Context): String {
        val s = getSession(context) ?: return ""
        return JSONObject()
            .put("accessToken", s.accessToken)
            .put("refreshToken", s.refreshToken)
            .put("expiresAt", s.expiresAt)
            .put("userId", s.userId)
            .toString()
    }

    fun hasSession(context: Context): Boolean = getSession(context) != null

    fun clear(context: Context) {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val bg = prefs.getBoolean(KEY_BG_SYNC, false)
            val fcm = prefs.getString(KEY_FCM_TOKEN, "") ?: ""
            prefs.edit().clear().putBoolean(KEY_BG_SYNC, bg).putString(KEY_FCM_TOKEN, fcm).apply()
        }
    }

    fun saveFcmToken(context: Context, token: String) {
        val clean = token.trim()
        if (clean.isEmpty()) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_FCM_TOKEN, clean)
            .apply()
    }

    fun getFcmToken(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_FCM_TOKEN, "") ?: ""
    }

    fun syncFcmTokenToServer(context: Context, client: OkHttpClient, explicitToken: String? = null) {
        val token = (explicitToken ?: getFcmToken(context)).trim()
        if (token.length < 16) return
        val session = refreshAccessTokenIfNeeded(context, client) ?: return
        try {
            val payload = JSONObject()
                .put("action", "subscribe_fcm")
                .put("token", token)
                .put("platform", "android")
                .toString()
            val req = Request.Builder()
                .url("${session.supabaseUrl}/functions/v1/push")
                .addHeader("apikey", session.anonKey)
                .addHeader("Authorization", "Bearer ${session.accessToken}")
                .addHeader("Content-Type", "application/json")
                .post(payload.toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(req).execute().close()
        } catch (_: Exception) {
        }
    }

    fun unsubscribeFcmTokenFromServer(context: Context, client: OkHttpClient) {
        val token = getFcmToken(context).trim()
        if (token.isEmpty()) return
        val session = getSession(context) ?: return
        try {
            val payload = JSONObject()
                .put("action", "unsubscribe_fcm")
                .put("token", token)
                .toString()
            val req = Request.Builder()
                .url("${session.supabaseUrl}/functions/v1/push")
                .addHeader("apikey", session.anonKey)
                .addHeader("Authorization", "Bearer ${session.accessToken}")
                .addHeader("Content-Type", "application/json")
                .post(payload.toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(req).execute().close()
        } catch (_: Exception) {
        }
    }

    fun isBackgroundSyncEnabled(context: Context): Boolean {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_BG_SYNC, false)
    }

    fun setBackgroundSyncEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_BG_SYNC, enabled)
            .apply()
    }

    fun getLastSeenIso(context: Context): String? {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LAST_SEEN_ISO, null)
    }

    fun setLastSeenIso(context: Context, iso: String) {
        if (iso.isBlank()) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_LAST_SEEN_ISO, iso)
            .apply()
    }

    fun getPeerMeta(context: Context, conversationId: String): PeerMeta {
        synchronized(lock) {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CHATS, null)
                ?: return PeerMeta("Whisper", "")
            return try {
                val obj = JSONObject(raw).optJSONObject(conversationId)
                    ?: return PeerMeta("Whisper", "")
                PeerMeta(
                    obj.optString("name", "Whisper").ifBlank { "Whisper" },
                    obj.optString("avatar", ""),
                    obj.optString("avatarPath", ""),
                    obj.optBoolean("muted", false),
                )
            } catch (_: Exception) {
                PeerMeta("Whisper", "")
            }
        }
    }

    fun getFirstChat(context: Context): Pair<String, PeerMeta>? {
        synchronized(lock) {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CHATS, null)
                ?: return null
            return try {
                val obj = JSONObject(raw)
                val keys = obj.keys()
                if (!keys.hasNext()) return null
                val id = keys.next()
                val item = obj.optJSONObject(id) ?: return null
                id to PeerMeta(
                    item.optString("name", "Whisper").ifBlank { "Whisper" },
                    item.optString("avatar", ""),
                    item.optString("avatarPath", ""),
                    item.optBoolean("muted", false),
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    fun getFirstChatId(context: Context): String? = getFirstChat(context)?.first

    fun resolveFreshAvatarUrl(context: Context, client: OkHttpClient, avatarPath: String): String? {
        val clean = avatarPath.trim().trimStart('/')
        if (clean.isEmpty()) return null
        val session = refreshAccessTokenIfNeeded(context, client) ?: return null
        return try {
            val encodedPath = Uri.encode(clean, "/")
            val bodyJson = JSONObject().put("expiresIn", 3600).toString()
            val req = Request.Builder()
                .url("${session.supabaseUrl}/storage/v1/object/sign/profile-avatars/$encodedPath")
                .addHeader("apikey", session.anonKey)
                .addHeader("Authorization", "Bearer ${session.accessToken}")
                .addHeader("Content-Type", "application/json")
                .post(bodyJson.toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val signedPart = JSONObject(resp.body?.string() ?: "{}").optString("signedURL")
                if (signedPart.isBlank()) return null
                when {
                    signedPart.startsWith("https://") || signedPart.startsWith("http://") -> signedPart
                    signedPart.startsWith("/storage/v1") -> "${session.supabaseUrl}$signedPart"
                    signedPart.startsWith("/") -> "${session.supabaseUrl}/storage/v1$signedPart"
                    else -> "${session.supabaseUrl}/storage/v1/$signedPart"
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    fun refreshAccessTokenIfNeeded(context: Context, client: OkHttpClient): NativeSession? {
        val current = getSession(context) ?: return null
        val nowSec = System.currentTimeMillis() / 1000L
        if (current.expiresAt > 0 && current.expiresAt - nowSec > 90L) {
            return current
        }
        if (current.refreshToken.isBlank()) return current

        synchronized(lock) {
            val latest = getSession(context) ?: return null
            val latestNow = System.currentTimeMillis() / 1000L
            if (latest.expiresAt > 0 && latest.expiresAt - latestNow > 90L) {
                return latest
            }

            return try {
                val bodyJson = JSONObject().put("refresh_token", latest.refreshToken).toString()
                val req = Request.Builder()
                    .url("${latest.supabaseUrl}/auth/v1/token?grant_type=refresh_token")
                    .addHeader("apikey", latest.anonKey)
                    .addHeader("Content-Type", "application/json")
                    .post(bodyJson.toRequestBody("application/json".toMediaType()))
                    .build()

                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return latest
                    val raw = resp.body?.string() ?: return latest
                    val data = JSONObject(raw)
                    val newAccess = data.optString("access_token")
                    val newRefresh = data.optString("refresh_token").ifBlank { latest.refreshToken }
                    val expiresIn = data.optLong("expires_in", 3600L)
                    val newExpiresAt = data.optLong("expires_at", (System.currentTimeMillis() / 1000L) + expiresIn)
                    if (newAccess.isBlank()) return latest

                    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .putString(KEY_ACCESS, newAccess)
                        .putString(KEY_REFRESH, newRefresh)
                        .putLong(KEY_EXPIRES, newExpiresAt)
                        .apply()

                    latest.copy(
                        accessToken = newAccess,
                        refreshToken = newRefresh,
                        expiresAt = newExpiresAt,
                    )
                }
            } catch (_: Exception) {
                latest
            }
        }
    }
}
