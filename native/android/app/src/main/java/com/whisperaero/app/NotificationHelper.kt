package com.whisperaero.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

object NotificationHelper {
    const val CHANNEL_MESSAGES = "whisper_messages"
    const val CHANNEL_CALLS = "whisper_calls"
    const val EXTRA_CHAT_ID = "conversationId"

    private val chatLines = ConcurrentHashMap<String, MutableList<String>>()
    private val avatarCache = ConcurrentHashMap<String, Bitmap>()
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

        nm.createNotificationChannel(messages)
        nm.createNotificationChannel(calls)
    }

    fun show(
        context: Context,
        conversationId: String,
        title: String,
        body: String,
        iconUrl: String,
        tag: String,
    ) {
        ensureChannels(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ActivityCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return
        }

        val key = conversationId.ifBlank { tag.ifBlank { "whisper" } }
        val lines = synchronized(chatLines) {
            val list = chatLines.getOrPut(key) { mutableListOf() }
            list.add(body.ifBlank { "New notification" })
            if (list.size > 6) {
                list.subList(0, list.size - 6).clear()
            }
            list.toList()
        }

        val isCall = tag.startsWith("whisper-call")
        val channelId = if (isCall) CHANNEL_CALLS else CHANNEL_MESSAGES
        val notifId = key.hashCode()

        ioPool.execute {
            val largeIcon = loadAvatar(iconUrl)
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
                .setBigContentTitle(title)
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

            try {
                NotificationManagerCompat.from(context).notify(notifId, builder.build())
            } catch (_: SecurityException) {
            }
        }
    }

    fun clearChat(context: Context, conversationId: String) {
        if (conversationId.isBlank()) return
        synchronized(chatLines) {
            chatLines.remove(conversationId)
        }
        NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
    }

    private fun loadAvatar(url: String): Bitmap? {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return null
        avatarCache[url]?.let { return it }
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 4000
                readTimeout = 4000
                doInput = true
            }
            conn.inputStream.use { stream ->
                val bmp = BitmapFactory.decodeStream(stream)
                if (bmp != null) {
                    val scaled = Bitmap.createScaledBitmap(bmp, 128, 128, true)
                    avatarCache[url] = scaled
                    scaled
                } else {
                    null
                }
            }
        } catch (_: Exception) {
            null
        }
    }
}
