package com.whisperaero.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

object NotificationHelper {
    const val CHANNEL_MESSAGES = "whisper_messages"
    const val CHANNEL_CALLS = "whisper_calls"
    const val CHANNEL_SERVICE = "whisper_service"
    const val SERVICE_NOTIF_ID = 7001

    const val EXTRA_CHAT_ID = "conversationId"
    const val KEY_REPLY_TEXT = "key_reply_text"

    private val chatLines = ConcurrentHashMap<String, MutableList<String>>()
    private val avatarCache = ConcurrentHashMap<String, Bitmap>()
    private val seenIds = LinkedHashSet<String>()
    private val ioPool = Executors.newCachedThreadPool()

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val messages = NotificationChannel(
            CHANNEL_MESSAGES,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Incoming Whisper messages and friend requests"
            enableVibration(true)
        }

        val calls = NotificationChannel(
            CHANNEL_CALLS,
            "Call alerts",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Incoming Whisper call notifications"
            enableVibration(true)
        }

        val service = NotificationChannel(
            CHANNEL_SERVICE,
            "Background connection",
            NotificationManager.IMPORTANCE_MIN,
        ).apply {
            description = "Keeps Whisper connected for real-time Android notifications"
            setShowBadge(false)
            enableLights(false)
            enableVibration(false)
        }

        nm.createNotificationChannel(messages)
        nm.createNotificationChannel(calls)
        nm.createNotificationChannel(service)
    }

    fun isPermissionGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ActivityCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun buildServiceNotification(context: Context): Notification {
        ensureChannels(context)
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            context,
            SERVICE_NOTIF_ID,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Whisper")
            .setContentText("Connected for background messages")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(pi)
            .build()
    }

    fun show(
        context: Context,
        conversationId: String,
        title: String,
        body: String,
        iconUrl: String,
        tag: String,
        messageId: String = "",
    ) {
        ensureChannels(context)
        if (!isPermissionGranted(context)) return

        if (messageId.isNotBlank()) {
            synchronized(seenIds) {
                if (!seenIds.add(messageId)) return
                while (seenIds.size > 120) {
                    val oldest = seenIds.firstOrNull() ?: break
                    seenIds.remove(oldest)
                }
            }
        }

        val key = conversationId.ifBlank { tag.ifBlank { "whisper" } }
        val lines = synchronized(chatLines) {
            val list = chatLines.getOrPut(key) { mutableListOf() }
            list.add(body.ifBlank { "New message" })
            if (list.size > 6) {
                list.subList(0, list.size - 6).clear()
            }
            list.toList()
        }

        val isCall = tag.startsWith("whisper-call")
        val channelId = if (isCall) CHANNEL_CALLS else CHANNEL_MESSAGES
        val notifId = key.hashCode()

        ioPool.execute {
            val largeIcon = loadCircularAvatar(iconUrl)
            val launchIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (conversationId.isNotBlank()) {
                    putExtra(EXTRA_CHAT_ID, conversationId)
                }
            }
            val pendingIntent = PendingIntent.getActivity(
                context,
                notifId,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val inbox = NotificationCompat.InboxStyle()
                .setBigContentTitle(title.ifBlank { "Whisper" })
            lines.forEach { inbox.addLine(it) }

            val builder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title.ifBlank { "Whisper" })
                .setContentText(lines.last())
                .setStyle(inbox)
                .setNumber(lines.size)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(if (isCall) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)

            if (largeIcon != null) {
                builder.setLargeIcon(largeIcon)
            }

            if (conversationId.isNotBlank() && !isCall) {
                val replyIntent = Intent(context, NotificationActionReceiver::class.java).apply {
                    action = NotificationActionReceiver.ACTION_REPLY
                    putExtra(EXTRA_CHAT_ID, conversationId)
                }
                val replyFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }
                val replyPending = PendingIntent.getBroadcast(
                    context,
                    notifId + 10001,
                    replyIntent,
                    replyFlags,
                )
                val remoteInput = RemoteInput.Builder(KEY_REPLY_TEXT)
                    .setLabel("Reply to ${title.ifBlank { "message" }}")
                    .build()
                val replyAction = NotificationCompat.Action.Builder(
                    R.drawable.ic_notification,
                    "Reply",
                    replyPending,
                ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()
                builder.addAction(replyAction)

                val readIntent = Intent(context, NotificationActionReceiver::class.java).apply {
                    action = NotificationActionReceiver.ACTION_MARK_READ
                    putExtra(EXTRA_CHAT_ID, conversationId)
                }
                val readPending = PendingIntent.getBroadcast(
                    context,
                    notifId + 20002,
                    readIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                builder.addAction(
                    NotificationCompat.Action.Builder(0, "Mark read", readPending).build(),
                )
            }

            try {
                NotificationManagerCompat.from(context).notify(notifId, builder.build())
            } catch (_: SecurityException) {
            }
        }
    }

    fun showTest(context: Context) {
        show(
            context = context,
            conversationId = "",
            title = "Whisper Native Alerts",
            body = "Native Android notifications & Quick Reply are working!",
            iconUrl = "",
            tag = "whisper-test",
            messageId = "",
        )
    }

    fun clearChat(context: Context, conversationId: String) {
        if (conversationId.isBlank()) return
        synchronized(chatLines) {
            chatLines.remove(conversationId)
        }
        NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
    }

    private fun loadCircularAvatar(url: String): Bitmap? {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return null
        avatarCache[url]?.let { return it }
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 4000
                readTimeout = 4000
                doInput = true
            }
            conn.inputStream.use { stream ->
                val bmp = BitmapFactory.decodeStream(stream) ?: return null
                val size = 128
                val scaled = Bitmap.createScaledBitmap(bmp, size, size, true)
                val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(output)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                val rect = Rect(0, 0, size, size)
                canvas.drawARGB(0, 0, 0, 0)
                canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
                paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
                canvas.drawBitmap(scaled, rect, rect, paint)
                avatarCache[url] = output
                output
            }
        } catch (_: Exception) {
            null
        }
    }
}
