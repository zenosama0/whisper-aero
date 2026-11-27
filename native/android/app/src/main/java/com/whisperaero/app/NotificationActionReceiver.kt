package com.whisperaero.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REPLY = "com.whisperaero.app.ACTION_REPLY"
        const val ACTION_MARK_READ = "com.whisperaero.app.ACTION_MARK_READ"
        const val ACTION_DISMISS_CALL = "com.whisperaero.app.ACTION_DISMISS_CALL"

        private val http = OkHttpClient()
        private val executor = Executors.newSingleThreadExecutor()

        private fun isoNow(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            return fmt.format(Date())
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val convId = intent.getStringExtra(NotificationHelper.EXTRA_CHAT_ID) ?: ""
        if (intent.action == ACTION_DISMISS_CALL) {
            NotificationHelper.clearIncomingCall(context, convId)
            return
        }
        if (convId.isBlank()) return

        val pendingResult = goAsync()
        executor.execute {
            try {
                val session = SessionStore.refreshAccessTokenIfNeeded(context, http) ?: return@execute
                when (intent.action) {
                    ACTION_REPLY -> {
                        val replyText = RemoteInput.getResultsFromIntent(intent)
                            ?.getCharSequence(NotificationHelper.KEY_REPLY_TEXT)
                            ?.toString()
                            ?.trim()
                            ?: ""
                        if (replyText.isNotEmpty()) {
                            sendReply(session, convId, replyText)
                            markRead(session, convId)
                            NotificationHelper.clearChat(context, convId)
                        }
                    }
                    ACTION_MARK_READ -> {
                        markRead(session, convId)
                        NotificationHelper.clearChat(context, convId)
                    }
                }
            } catch (_: Exception) {
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun sendReply(session: NativeSession, convId: String, body: String) {
        val payload = JSONObject()
            .put("conversation_id", convId)
            .put("sender_id", session.userId)
            .put("body", body)
            .toString()

        val req = Request.Builder()
            .url("${session.supabaseUrl}/rest/v1/messages")
            .addHeader("apikey", session.anonKey)
            .addHeader("Authorization", "Bearer ${session.accessToken}")
            .addHeader("Content-Type", "application/json")
            .addHeader("Prefer", "return=minimal")
            .post(payload.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().close()

        // Best-effort push notification trigger for peer's offline/browser devices
        val pushBody = JSONObject()
            .put("action", "notify")
            .put("conversationId", convId)
            .put("title", "Whisper")
            .put("body", body)
            .put("tag", "whisper-msg-$convId")
            .toString()
        val pushReq = Request.Builder()
            .url("${session.supabaseUrl}/functions/v1/push")
            .addHeader("apikey", session.anonKey)
            .addHeader("Authorization", "Bearer ${session.accessToken}")
            .addHeader("Content-Type", "application/json")
            .post(pushBody.toRequestBody("application/json".toMediaType()))
            .build()
        try {
            http.newCall(pushReq).execute().close()
        } catch (_: Exception) {
        }
    }

    private fun markRead(session: NativeSession, convId: String) {
        val payload = JSONObject().put("last_read_at", isoNow()).toString()
        val req = Request.Builder()
            .url("${session.supabaseUrl}/rest/v1/conversation_members?conversation_id=eq.$convId&user_id=eq.${session.userId}")
            .addHeader("apikey", session.anonKey)
            .addHeader("Authorization", "Bearer ${session.accessToken}")
            .addHeader("Content-Type", "application/json")
            .patch(payload.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().close()
    }
}
