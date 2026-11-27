package com.whisperaero.app

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class IncomingCallActivity : AppCompatActivity() {

    companion object {
        const val ACTION_STOP_RING = "com.whisperaero.app.ACTION_STOP_RING"
        const val EXTRA_CALLER_NAME = "callerName"
        const val EXTRA_ICON_URL = "iconUrl"

        private val http = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()
        private val pool = Executors.newSingleThreadExecutor()
    }

    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var conversationId: String = ""
    private var receiverRegistered = false

    private val stopReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            stopAlarmMedia()
            finish()
        }
    }

    private val autoTimeout = Runnable {
        stopAlarmMedia()
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            )
        }

        conversationId = intent.getStringExtra(NotificationHelper.EXTRA_CHAT_ID) ?: ""
        val meta = if (conversationId.isNotBlank()) SessionStore.getPeerMeta(this, conversationId) else null
        val callerName = (intent.getStringExtra(EXTRA_CALLER_NAME)?.takeIf { it.isNotBlank() }
            ?: meta?.name
            ?: "Whisper contact")
        val iconUrl = intent.getStringExtra(EXTRA_ICON_URL)?.takeIf { it.isNotBlank() }
            ?: meta?.avatar
            ?: ""

        buildCallUi(callerName, iconUrl)
        ContextCompat.registerReceiver(
            this,
            stopReceiver,
            IntentFilter(ACTION_STOP_RING),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiverRegistered = true

        startAlarmMedia()
        timeoutHandler.postDelayed(autoTimeout, 45_000L)
    }

    private fun buildCallUi(callerName: String, iconUrl: String) {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#111B1A"))
            setPadding(dp(24), dp(48), dp(24), dp(44))
        }

        val centerCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val badge = TextView(this).apply {
            text = "WHISPER VOICE CALL"
            textSize = 11.5f
            letterSpacing = 0.14f
            setTextColor(Color.parseColor("#8ACAB5"))
            setTypeface(null, Typeface.BOLD)
        }
        centerCol.addView(badge, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(24) })

        val avatarFrame = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#2A443E"))
                setStroke(dp(3), Color.parseColor("#60B396"))
            }
        }
        val initialView = TextView(this).apply {
            text = callerName.trim().take(1).uppercase().ifEmpty { "W" }
            textSize = 42f
            setTextColor(Color.WHITE)
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        val avatarImage = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            clipToOutline = true
        }
        avatarFrame.addView(initialView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        avatarFrame.addView(avatarImage, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        centerCol.addView(avatarFrame, LinearLayout.LayoutParams(dp(116), dp(116)).apply {
            topMargin = dp(42)
        })

        if (iconUrl.startsWith("http")) {
            pool.execute {
                try {
                    val req = Request.Builder().url(iconUrl).get().build()
                    http.newCall(req).execute().use { resp ->
                        val bytes = if (resp.isSuccessful) resp.body?.bytes() else null
                        if (bytes != null) {
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            if (bmp != null) {
                                runOnUiThread {
                                    if (!isDestroyed && !isFinishing) {
                                        avatarImage.setImageBitmap(bmp)
                                    }
                                }
                            }
                        }
                    }
                } catch (_: Exception) {
                }
            }
        }

        val nameView = TextView(this).apply {
            text = callerName
            textSize = 27f
            setTextColor(Color.WHITE)
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        centerCol.addView(nameView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(22) })

        val subView = TextView(this).apply {
            text = "Ringing · Tap Answer to open chat"
            textSize = 14.5f
            setTextColor(Color.parseColor("#B6C8C4"))
            gravity = Gravity.CENTER
        }
        centerCol.addView(subView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(8) })

        root.addView(centerCol, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.CENTER_HORIZONTAL,
        ))

        val actionsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        val dismissBtn = Button(this).apply {
            text = "Dismiss"
            textSize = 15f
            setTextColor(Color.WHITE)
            isAllCaps = false
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setColor(Color.parseColor("#C24640"))
            }
            setOnClickListener {
                NotificationHelper.clearIncomingCall(this@IncomingCallActivity, conversationId)
                stopAlarmMedia()
                finish()
            }
        }

        val answerBtn = Button(this).apply {
            text = "Open Chat"
            textSize = 15f
            setTextColor(Color.WHITE)
            isAllCaps = false
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setColor(Color.parseColor("#3B9B7B"))
            }
            setOnClickListener {
                NotificationHelper.clearIncomingCall(this@IncomingCallActivity, conversationId)
                stopAlarmMedia()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
                    km.requestDismissKeyguard(this@IncomingCallActivity, null)
                }
                val openIntent = Intent(this@IncomingCallActivity, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    if (conversationId.isNotBlank()) putExtra(NotificationHelper.EXTRA_CHAT_ID, conversationId)
                }
                startActivity(openIntent)
                finish()
            }
        }

        actionsRow.addView(dismissBtn, LinearLayout.LayoutParams(0, dp(54), 1f).apply {
            marginEnd = dp(10)
        })
        actionsRow.addView(answerBtn, LinearLayout.LayoutParams(0, dp(54), 1f).apply {
            marginStart = dp(10)
        })

        root.addView(actionsRow, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))

        setContentView(root)
    }

    private fun startAlarmMedia() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            if (uri != null) {
                mediaPlayer = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    setDataSource(this@IncomingCallActivity, uri)
                    isLooping = true
                    prepare()
                    start()
                }
            }
        } catch (_: Exception) {
        }

        try {
            val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(VIBRATOR_SERVICE) as Vibrator
            }
            vibrator = vib
            val pattern = longArrayOf(0, 650, 350, 650, 350)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                vib.vibrate(pattern, 0)
            }
        } catch (_: Exception) {
        }
    }

    private fun stopAlarmMedia() {
        timeoutHandler.removeCallbacks(autoTimeout)
        try {
            mediaPlayer?.stop()
        } catch (_: Exception) {
        }
        try {
            mediaPlayer?.release()
        } catch (_: Exception) {
        }
        mediaPlayer = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
        vibrator = null
    }

    override fun onDestroy() {
        stopAlarmMedia()
        if (receiverRegistered) {
            receiverRegistered = false
            try {
                unregisterReceiver(stopReceiver)
            } catch (_: Exception) {
            }
        }
        super.onDestroy()
    }
}
