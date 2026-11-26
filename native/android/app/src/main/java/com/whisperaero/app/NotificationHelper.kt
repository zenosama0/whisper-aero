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
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

data class BufferedMsgLine(
    val text: String,
    val timestamp: Long,
)

object NotificationHelper {
    const val CHANNEL_MESSAGES = "whisper_messages"
    const val CHANNEL_CALLS = "whisper_calls"
    const val CHANNEL_SERVICE = "whisper_service"
    const val SERVICE_NOTIF_ID = 7001

    const val EXTRA_CHAT_ID = "conversationId"
    const val KEY_REPLY_TEXT = "key_reply_text"

    private val chatHistory = ConcurrentHashMap<String, MutableList<BufferedMsgLine>>()
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
            description = "Incoming Whisper messages and floating chat bubbles"
            enableVibration(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                setAllowBubbles(true)
            }
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
            description = "Keeps Whisper connected for real-time Android alerts & bubbles"
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

    fun areBubblesEnabled(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        ensureChannels(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (nm.bubblePreference == NotificationManager.BUBBLE_PREFERENCE_NONE) return false
            val ch = nm.getNotificationChannel(CHANNEL_MESSAGES)
            return ch?.canBubble() ?: true
        }
        return true
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
            .setContentText("Connected for messages & chat bubbles")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(pi)
            .build()
    }

    fun publishShortcutsFromJson(context: Context, json: String) {
        ioPool.execute {
            try {
                val arr = JSONArray(json)
                val shortcuts = mutableListOf<ShortcutInfoCompat>()
                for (i in 0 until arr.length().coerceAtMost(5)) {
                    val item = arr.optJSONObject(i) ?: continue
                    val id = item.optString("id")
                    val name = item.optString("name", "Whisper").ifBlank { "Whisper" }
                    val avatar = item.optString("avatar", "")
                    if (id.isBlank()) continue
                    val bmp = loadCircularAvatar(avatar) ?: buildFallbackAvatar(name)
                    val icon = IconCompat.createWithAdaptiveBitmap(bmp)
                    val person = Person.Builder()
                        .setName(name)
                        .setKey("chat_$id")
                        .setIcon(icon)
                        .setImportant(true)
                        .build()
                    val intent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        putExtra(EXTRA_CHAT_ID, id)
                    }
                    shortcuts.add(
                        ShortcutInfoCompat.Builder(context, "chat_$id")
                            .setShortLabel(name)
                            .setLongLabel(name)
                            .setLongLived(true)
                            .setIcon(icon)
                            .setPerson(person)
                            .setLocusId(LocusIdCompat("chat_$id"))
                            .setIntent(intent)
                            .build(),
                    )
                }
                if (shortcuts.isNotEmpty()) {
                    ShortcutManagerCompat.addDynamicShortcuts(context, shortcuts)
                }
            } catch (_: Exception) {
            }
        }
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
        val nowMs = System.currentTimeMillis()
        val lines = synchronized(chatHistory) {
            val list = chatHistory.getOrPut(key) { mutableListOf() }
            list.add(BufferedMsgLine(body.ifBlank { "New message" }, nowMs))
            if (list.size > 6) {
                list.subList(0, list.size - 6).clear()
            }
            list.toList()
        }

        val isCall = tag.startsWith("whisper-call")
        val channelId = if (isCall) CHANNEL_CALLS else CHANNEL_MESSAGES
        val notifId = key.hashCode()
        val peerTitle = title.ifBlank { "Whisper" }

        ioPool.execute {
            val largeIcon = loadCircularAvatar(iconUrl) ?: buildFallbackAvatar(peerTitle)
            val personIcon = IconCompat.createWithBitmap(largeIcon)
            val shortcutAvatar = IconCompat.createWithAdaptiveBitmap(largeIcon)

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

            val builder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(peerTitle)
                .setContentText(lines.last().text)
                .setLargeIcon(largeIcon)
                .setNumber(lines.size)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(if (isCall) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)

            if (conversationId.isNotBlank() && !isCall) {
                val shortcutId = "chat_$conversationId"
                val senderPerson = Person.Builder()
                    .setName(peerTitle)
                    .setKey(shortcutId)
                    .setIcon(personIcon)
                    .setImportant(true)
                    .build()

                val mePerson = Person.Builder()
                    .setName("You")
                    .setKey("me")
                    .build()

                val shortcut = ShortcutInfoCompat.Builder(context, shortcutId)
                    .setShortLabel(peerTitle)
                    .setLongLabel(peerTitle)
                    .setLongLived(true)
                    .setIcon(shortcutAvatar)
                    .setPerson(senderPerson)
                    .setLocusId(LocusIdCompat(shortcutId))
                    .setIntent(
                        Intent(context, MainActivity::class.java).apply {
                            action = Intent.ACTION_VIEW
                            putExtra(EXTRA_CHAT_ID, conversationId)
                        },
                    )
                    .build()
                ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)

                val messagingStyle = NotificationCompat.MessagingStyle(mePerson)
                lines.forEach { entry ->
                    messagingStyle.addMessage(entry.text, entry.timestamp, senderPerson)
                }
                builder.setStyle(messagingStyle)
                    .setShortcutId(shortcutId)
                    .setLocusId(LocusIdCompat(shortcutId))

                // Floating Android Chat Bubble (API 29+ / 30+)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val bubbleIntent = Intent(context, BubbleActivity::class.java).apply {
                        putExtra(EXTRA_CHAT_ID, conversationId)
                    }
                    val bubbleFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                    } else {
                        PendingIntent.FLAG_UPDATE_CURRENT
                    }
                    val bubblePending = PendingIntent.getActivity(
                        context,
                        notifId + 30003,
                        bubbleIntent,
                        bubbleFlags,
                    )
                    val bubbleMeta = NotificationCompat.BubbleMetadata.Builder(bubblePending, shortcutAvatar)
                        .setDesiredHeight(580)
                        .setAutoExpandBubble(false)
                        .setSuppressNotification(false)
                        .build()
                    builder.setBubbleMetadata(bubbleMeta)
                }

                // Inline Quick Reply
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
                    .setLabel("Reply to $peerTitle")
                    .build()
                val replyAction = NotificationCompat.Action.Builder(
                    R.drawable.ic_notification,
                    "Reply",
                    replyPending,
                ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()
                builder.addAction(replyAction)

                // Mark Read
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
            } else {
                val inbox = NotificationCompat.InboxStyle().setBigContentTitle(peerTitle)
                lines.forEach { inbox.addLine(it.text) }
                builder.setStyle(inbox)
            }

            try {
                NotificationManagerCompat.from(context).notify(notifId, builder.build())
            } catch (_: SecurityException) {
            }
        }
    }

    fun showTest(context: Context) {
        val sampleId = SessionStore.getFirstChatId(context) ?: "whisper-preview"
        show(
            context = context,
            conversationId = sampleId,
            title = "Whisper Native",
            body = "Notifications, Quick Reply & Chat Bubbles are active!",
            iconUrl = "",
            tag = "whisper-test",
            messageId = "",
        )
    }

    fun clearChat(context: Context, conversationId: String) {
        if (conversationId.isBlank()) return
        synchronized(chatHistory) {
            chatHistory.remove(conversationId)
        }
        NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
    }

    private fun buildFallbackAvatar(name: String): Bitmap {
        val size = 128
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#66A7AA") }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, bgPaint)
        val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 54f
            textAlign = Paint.Align.CENTER
            isFakeBoldText = true
        }
        val letter = name.trim().take(1).uppercase().ifEmpty { "W" }
        val y = size / 2f - (textPaint.descent() + textPaint.ascent()) / 2f
        canvas.drawText(letter, size / 2f, y, textPaint)
        return bmp
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
