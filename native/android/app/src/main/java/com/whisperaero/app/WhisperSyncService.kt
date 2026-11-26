package com.whisperaero.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class WhisperSyncService : Service() {

    companion object {
        fun syncState(context: Context) {
            val shouldRun = SessionStore.hasSession(context) && SessionStore.isBackgroundSyncEnabled(context)
            val intent = Intent(context, WhisperSyncService::class.java)
            if (shouldRun) {
                try {
                    ContextCompat.startForegroundService(context, intent)
                } catch (_: Exception) {
                }
            } else {
                context.stopService(intent)
            }
            WhisperSyncWorker.schedule(context)
        }

        private fun isoNow(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            return fmt.format(Date())
        }
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val refSeq = AtomicInteger(1)

    @Volatile
    private var webSocket: WebSocket? = null
    @Volatile
    private var isStopping = false
    private var heartbeatTask: ScheduledFuture<*>? = null
    private var reconnectTask: ScheduledFuture<*>? = null
    private var backoffSeconds = 2L
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundCompat()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        if (!SessionStore.hasSession(this) || !SessionStore.isBackgroundSyncEnabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (webSocket == null) {
            connectSocket()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isStopping = true
        heartbeatTask?.cancel(true)
        reconnectTask?.cancel(true)
        unregisterNetworkCallback()
        webSocket?.close(1000, "Service stopped")
        webSocket = null
        scheduler.shutdownNow()
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val notif = NotificationHelper.buildServiceNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NotificationHelper.SERVICE_NOTIF_ID,
                notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
            )
        } else {
            startForeground(NotificationHelper.SERVICE_NOTIF_ID, notif)
        }
    }

    private fun connectSocket() {
        if (isStopping) return
        scheduler.execute {
            if (isStopping || webSocket != null) return@execute
            val session = SessionStore.refreshAccessTokenIfNeeded(this, client) ?: return@execute
            val parsed = Uri.parse(session.supabaseUrl)
            val host = parsed.host ?: return@execute
            val wsUrl = "wss://$host/realtime/v1/websocket?apikey=${Uri.encode(session.anonKey)}&vsn=1.0.0"

            val request = Request.Builder().url(wsUrl).build()
            webSocket = client.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(ws: WebSocket, response: Response) {
                        backoffSeconds = 2L
                        sendJoin(ws, session)
                        startHeartbeat()
                        scheduler.execute { catchUpMissedMessages(session) }
                    }

                    override fun onMessage(ws: WebSocket, text: String) {
                        handleSocketMessage(session, text)
                    }

                    override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                        webSocket = null
                        scheduleReconnect()
                    }

                    override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                        webSocket = null
                        scheduleReconnect()
                    }
                },
            )
        }
    }

    private fun sendJoin(ws: WebSocket, session: NativeSession) {
        val changes = JSONArray()
            .put(JSONObject().put("event", "INSERT").put("schema", "public").put("table", "messages"))
            .put(
                JSONObject()
                    .put("event", "INSERT")
                    .put("schema", "public")
                    .put("table", "contact_requests")
                    .put("filter", "receiver_id=eq.${session.userId}"),
            )
            .put(JSONObject().put("event", "INSERT").put("schema", "public").put("table", "call_invites"))

        val payload = JSONObject()
            .put("config", JSONObject().put("postgres_changes", changes))
            .put("access_token", session.accessToken)

        val joinMsg = JSONObject()
            .put("topic", "realtime:whisper-native-db")
            .put("event", "phx_join")
            .put("payload", payload)
            .put("ref", refSeq.getAndIncrement().toString())

        ws.send(joinMsg.toString())
    }

    private fun startHeartbeat() {
        heartbeatTask?.cancel(false)
        heartbeatTask = scheduler.scheduleAtFixedRate(
            {
                val ws = webSocket ?: return@scheduleAtFixedRate
                val refreshed = SessionStore.refreshAccessTokenIfNeeded(this, client)
                val hb = JSONObject()
                    .put("topic", "phoenix")
                    .put("event", "heartbeat")
                    .put("payload", JSONObject())
                    .put("ref", refSeq.getAndIncrement().toString())
                ws.send(hb.toString())

                if (refreshed != null) {
                    val tokenUpdate = JSONObject()
                        .put("topic", "realtime:whisper-native-db")
                        .put("event", "access_token")
                        .put("payload", JSONObject().put("access_token", refreshed.accessToken))
                        .put("ref", refSeq.getAndIncrement().toString())
                    ws.send(tokenUpdate.toString())
                }
            },
            25L,
            25L,
            TimeUnit.SECONDS,
        )
    }

    private fun scheduleReconnect() {
        heartbeatTask?.cancel(false)
        if (isStopping || !SessionStore.hasSession(this) || !SessionStore.isBackgroundSyncEnabled(this)) return
        reconnectTask?.cancel(false)
        val delay = backoffSeconds
        backoffSeconds = (backoffSeconds * 2).coerceAtMost(30L)
        reconnectTask = scheduler.schedule({ connectSocket() }, delay, TimeUnit.SECONDS)
    }

    private fun handleSocketMessage(session: NativeSession, raw: String) {
        try {
            val frame = JSONObject(raw)
            if (frame.optString("event") != "postgres_changes") return
            val data = frame.optJSONObject("payload")?.optJSONObject("data") ?: return
            val table = data.optString("table")
            val record = data.optJSONObject("record") ?: return

            if (MainActivity.isAppInForeground) return

            when (table) {
                "messages" -> {
                    val senderId = record.optString("sender_id")
                    val convId = record.optString("conversation_id")
                    val msgId = record.optString("id")
                    val createdAt = record.optString("created_at")
                    if (createdAt.isNotBlank()) SessionStore.setLastSeenIso(this, createdAt)
                    if (senderId.isBlank() || senderId == session.userId || convId.isBlank()) return

                    val meta = SessionStore.getPeerMeta(this, convId)
                    if (meta.muted) return
                    val textBody = record.optString("body").ifBlank {
                        if (!record.isNull("attachment_id")) "Sent an attachment" else "New message"
                    }
                    NotificationHelper.show(
                        this,
                        conversationId = convId,
                        title = meta.name,
                        body = textBody,
                        iconUrl = meta.avatar,
                        tag = "whisper-msg-$convId",
                        messageId = msgId,
                    )
                }
                "contact_requests" -> {
                    if (record.optString("receiver_id") == session.userId &&
                        record.optString("status") == "pending"
                    ) {
                        NotificationHelper.show(
                            this,
                            conversationId = "",
                            title = "New friend request",
                            body = "Someone would like to connect on Whisper.",
                            iconUrl = "",
                            tag = "whisper-request",
                            messageId = "req-${record.optString("id")}",
                        )
                    }
                }
                "call_invites" -> {
                    if (record.optString("caller_id") == session.userId) return
                    val convId = record.optString("conversation_id")
                    val meta = SessionStore.getPeerMeta(this, convId)
                    NotificationHelper.show(
                        this,
                        conversationId = convId,
                        title = "Incoming call",
                        body = "${meta.name} is trying to reach you.",
                        iconUrl = meta.avatar,
                        tag = if (convId.isNotBlank()) "whisper-call-$convId" else "whisper-call",
                        messageId = "call-${record.optString("id")}",
                    )
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun catchUpMissedMessages(session: NativeSession) {
        val since = SessionStore.getLastSeenIso(this)
        if (since.isNullOrBlank()) {
            SessionStore.setLastSeenIso(this, isoNow())
            return
        }
        try {
            val url = "${session.supabaseUrl}/rest/v1/messages?select=id,conversation_id,sender_id,body,attachment_id,created_at&created_at=gt.${Uri.encode(since)}&sender_id=neq.${Uri.encode(session.userId)}&order=created_at.asc&limit=20"
            val req = Request.Builder()
                .url(url)
                .addHeader("apikey", session.anonKey)
                .addHeader("Authorization", "Bearer ${session.accessToken}")
                .get()
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return
                val arr = JSONArray(resp.body?.string() ?: "[]")
                for (i in 0 until arr.length()) {
                    val row = arr.optJSONObject(i) ?: continue
                    val convId = row.optString("conversation_id")
                    val msgId = row.optString("id")
                    val createdAt = row.optString("created_at")
                    if (createdAt.isNotBlank()) SessionStore.setLastSeenIso(this, createdAt)
                    if (MainActivity.isAppInForeground || convId.isBlank()) continue
                    val meta = SessionStore.getPeerMeta(this, convId)
                    val body = row.optString("body").ifBlank {
                        if (!row.isNull("attachment_id")) "Sent an attachment" else "New message"
                    }
                    NotificationHelper.show(
                        this,
                        conversationId = convId,
                        title = meta.name,
                        body = body,
                        iconUrl = meta.avatar,
                        tag = "whisper-msg-$convId",
                        messageId = msgId,
                    )
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun registerNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (webSocket == null && !isStopping) {
                        backoffSeconds = 2L
                        connectSocket()
                    }
                }
            }
            networkCallback = cb
            cm.registerDefaultNetworkCallback(cb)
        } catch (_: Exception) {
        }
    }

    private fun unregisterNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val cb = networkCallback ?: return
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        }
    }
}
