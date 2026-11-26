package com.whisperaero.app

import android.content.Context
import android.net.Uri
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

class WhisperSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {

    companion object {
        private const val PERIODIC_WORK_NAME = "whisper_periodic_sync"
        private const val ONESHOT_WORK_NAME = "whisper_immediate_sync"
        private val http = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build()

        fun schedule(context: Context) {
            val wm = WorkManager.getInstance(context)
            if (!SessionStore.hasSession(context) || !SessionStore.isBackgroundSyncEnabled(context)) {
                wm.cancelUniqueWork(PERIODIC_WORK_NAME)
                return
            }
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val periodic = PeriodicWorkRequestBuilder<WhisperSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()

            wm.enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                periodic,
            )
        }

        fun enqueueNow(context: Context) {
            if (!SessionStore.hasSession(context) || !SessionStore.isBackgroundSyncEnabled(context)) return
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val work = OneTimeWorkRequestBuilder<WhisperSyncWorker>()
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONESHOT_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                work,
            )
        }

        private fun isoNow(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            return fmt.format(Date())
        }
    }

    override fun doWork(): Result {
        if (!SessionStore.hasSession(applicationContext) || !SessionStore.isBackgroundSyncEnabled(applicationContext)) {
            return Result.success()
        }

        // Ensure persistent foreground Realtime listener service stays alive
        WhisperSyncService.syncState(applicationContext)

        val session = SessionStore.refreshAccessTokenIfNeeded(applicationContext, http)
            ?: return Result.success()

        val since = SessionStore.getLastSeenIso(applicationContext)
        if (since.isNullOrBlank()) {
            SessionStore.setLastSeenIso(applicationContext, isoNow())
            return Result.success()
        }

        return try {
            val url = "${session.supabaseUrl}/rest/v1/messages?select=id,conversation_id,sender_id,body,attachment_id,created_at&created_at=gt.${Uri.encode(since)}&sender_id=neq.${Uri.encode(session.userId)}&order=created_at.asc&limit=25"
            val req = Request.Builder()
                .url(url)
                .addHeader("apikey", session.anonKey)
                .addHeader("Authorization", "Bearer ${session.accessToken}")
                .get()
                .build()

            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return Result.retry()
                val arr = JSONArray(resp.body?.string() ?: "[]")
                for (i in 0 until arr.length()) {
                    val row = arr.optJSONObject(i) ?: continue
                    val convId = row.optString("conversation_id")
                    val msgId = row.optString("id")
                    val createdAt = row.optString("created_at")
                    if (createdAt.isNotBlank()) SessionStore.setLastSeenIso(applicationContext, createdAt)
                    if (MainActivity.isAppInForeground || convId.isBlank()) continue

                    val meta = SessionStore.getPeerMeta(applicationContext, convId)
                    val body = row.optString("body").ifBlank {
                        if (!row.isNull("attachment_id")) "Sent an attachment" else "New message"
                    }
                    NotificationHelper.show(
                        applicationContext,
                        conversationId = convId,
                        title = meta.name,
                        body = body,
                        iconUrl = meta.avatar,
                        tag = "whisper-msg-$convId",
                        messageId = msgId,
                    )
                }
            }
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
