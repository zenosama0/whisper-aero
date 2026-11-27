package com.whisperaero.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class WhisperFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private val http = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        SessionStore.saveFcmToken(this, token)
        Thread {
            SessionStore.syncFcmTokenToServer(this, http, token)
        }.start()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        if (data.isEmpty()) return

        val type = data["type"] ?: "message"
        val convId = data["conversationId"] ?: ""
        val meta = if (convId.isNotBlank()) SessionStore.getPeerMeta(this, convId) else null
        val title = (meta?.name?.takeIf { it.isNotBlank() && it != "Whisper" }
            ?: data["senderName"]
            ?: data["title"]
            ?: "Whisper")
        val icon = meta?.avatar?.takeIf { it.isNotBlank() } ?: (data["icon"] ?: "")

        if (type == "call") {
            NotificationHelper.showIncomingCallAlarm(
                context = this,
                conversationId = convId,
                callerName = title,
                iconUrl = icon,
            )
            return
        }

        if (MainActivity.isAppInForeground) return
        if (convId.isNotBlank() && meta?.muted == true) return

        val body = data["body"] ?: "New message"
        val tag = data["tag"] ?: if (convId.isNotBlank()) "whisper-msg-$convId" else "whisper"
        val msgId = data["messageId"] ?: (data["sentAt"] ?: "")

        NotificationHelper.show(
            context = this,
            conversationId = convId,
            title = title,
            body = body,
            iconUrl = icon,
            tag = tag,
            messageId = msgId,
        )
    }
}
