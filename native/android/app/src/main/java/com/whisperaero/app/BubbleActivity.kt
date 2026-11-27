package com.whisperaero.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File

class BubbleActivity : AppCompatActivity() {

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraUri: Uri? = null
    private var pendingWebPermRequest: PermissionRequest? = null
    private var activeChatId: String = ""
    private var initialChatDelivered = false

    private val audioPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val req = pendingWebPermRequest ?: return@registerForActivityResult
        pendingWebPermRequest = null
        if (granted) req.grant(req.resources) else req.deny()
    }

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val capturedUri = pendingCameraUri
        pendingCameraUri = null
        if (result.resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val data = result.data
        val list = mutableListOf<Uri>()
        val clip = data?.clipData
        if (clip != null && clip.itemCount > 0) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let { list.add(it) }
            }
        } else {
            data?.data?.let { list.add(it) }
        }
        if (list.isEmpty() && capturedUri != null) {
            list.add(capturedUri)
        }
        val uris = if (list.isNotEmpty()) {
            list.toTypedArray()
        } else if (data != null) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
        } else {
            null
        }
        callback.onReceiveValue(uris)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        rootContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#EEF6F8"))
        }
        webView = WebView(this)
        rootContainer.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(rootContainer)

        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    or WindowInsetsCompat.Type.displayCutout()
                    or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(rootContainer)

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(webView, true)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = userAgentString.replace("; wv", "")
        }

        webView.addJavascriptInterface(BubbleNativeBridge(), "WhisperNative")

        activeChatId = intent.getStringExtra(NotificationHelper.EXTRA_CHAT_ID) ?: ""

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val host = (uri.host ?: "").lowercase()
                val allowed = host == "zenosama0.github.io" ||
                    host.endsWith(".supabase.co") ||
                    host.endsWith(".google.com") ||
                    host.endsWith(".gstatic.com") ||
                    host.endsWith(".googleusercontent.com")
                if (allowed) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    false
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (!initialChatDelivered && activeChatId.isNotBlank() && activeChatId != "whisper-preview") {
                    initialChatDelivered = true
                    openChatInWeb(activeChatId)
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val originHost = (request.origin?.host ?: "").lowercase()
                if (!originHost.equals("zenosama0.github.io", ignoreCase = true)) {
                    request.deny()
                    return
                }
                val needsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (needsAudio && ContextCompat.checkSelfPermission(
                        this@BubbleActivity,
                        Manifest.permission.RECORD_AUDIO,
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    pendingWebPermRequest?.deny()
                    pendingWebPermRequest = request
                    audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                } else {
                    request.grant(request.resources)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                pendingCameraUri = null
                val acceptTypes = fileChooserParams?.acceptTypes?.joinToString(",")?.lowercase().orEmpty()
                val wantsCapture = fileChooserParams?.isCaptureEnabled == true
                val wantsMedia = acceptTypes.contains("image/") || acceptTypes.contains("video/")
                val allowMultiple = fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE

                val primaryIntent = if (wantsCapture) {
                    try {
                        val camDir = File(cacheDir, "camera").apply { mkdirs() }
                        val photoFile = File(camDir, "whisper-cam-${System.currentTimeMillis()}.jpg")
                        val outUri = FileProvider.getUriForFile(
                            this@BubbleActivity,
                            "${packageName}.fileprovider",
                            photoFile,
                        )
                        pendingCameraUri = outUri
                        Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                            putExtra(MediaStore.EXTRA_OUTPUT, outUri)
                            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                    } catch (_: Exception) {
                        pendingCameraUri = null
                        null
                    }
                } else if (wantsMedia) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                            if (allowMultiple) {
                                putExtra(
                                    MediaStore.EXTRA_PICK_IMAGES_MAX,
                                    MediaStore.getPickImagesMaxLimit().coerceAtMost(20),
                                )
                            }
                        }
                    } else {
                        Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                        }
                    }
                } else {
                    Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                    }
                }

                return try {
                    if (primaryIntent != null) {
                        filePickerLauncher.launch(primaryIntent)
                        true
                    } else {
                        throw IllegalStateException("No primary intent")
                    }
                } catch (_: Exception) {
                    pendingCameraUri = null
                    try {
                        val fallback = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                        }
                        filePickerLauncher.launch(fallback)
                        true
                    } catch (_: Exception) {
                        filePathCallback = null
                        false
                    }
                }
            }
        }

        val url = if (activeChatId.isNotBlank() && activeChatId != "whisper-preview") {
            "https://zenosama0.github.io/whisper-aero/?bubble=1&chat=${Uri.encode(activeChatId)}"
        } else {
            "https://zenosama0.github.io/whisper-aero/?bubble=1"
        }
        webView.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val chatId = intent.getStringExtra(NotificationHelper.EXTRA_CHAT_ID) ?: ""
        if (chatId.isNotBlank() && chatId != "whisper-preview") {
            activeChatId = chatId
            openChatInWeb(chatId)
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.evaluateJavascript(
                "if(typeof window.WhisperOnNativeResume==='function') window.WhisperOnNativeResume();",
                null,
            )
        }
    }

    private fun openChatInWeb(chatId: String) {
        val quoted = JSONObject.quote(chatId)
        webView.evaluateJavascript(
            "if(typeof window.WhisperOpenChat==='function') window.WhisperOpenChat($quoted);",
            null,
        )
    }

    private inner class BubbleNativeBridge {
        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun isBubble(): Boolean = true

        @JavascriptInterface
        fun getBubbleChatId(): String = activeChatId

        @JavascriptInterface
        fun getPlatform(): String = "android"

        @JavascriptInterface
        fun getStoredSession(): String {
            return SessionStore.getSessionJson(this@BubbleActivity)
        }

        @JavascriptInterface
        fun syncSession(json: String?) {
            if (json.isNullOrBlank()) return
            SessionStore.saveFromJson(this@BubbleActivity, json)
        }

        @JavascriptInterface
        fun openBubbleSettings() {
            runOnUiThread {
                try {
                    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        Intent(Settings.ACTION_APP_NOTIFICATION_BUBBLE_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    } else {
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                    }
                    startActivity(intent)
                } catch (_: Exception) {
                }
            }
        }

        @JavascriptInterface
        fun openChatBubble(conversationId: String?, title: String?, iconUrl: String?): Boolean {
            val id = conversationId?.trim().orEmpty()
            if (id.isEmpty()) return false
            val opened = NotificationHelper.openChatAsBubble(
                this@BubbleActivity,
                conversationId = id,
                title = title ?: "Whisper",
                iconUrl = iconUrl ?: "",
            )
            if (!opened) {
                openBubbleSettings()
            }
            return opened
        }

        @JavascriptInterface
        fun clearNotification(conversationId: String?) {
            // Intentional no-op: cancelling a bubble notification closes the floating bubble itself.
        }

        @JavascriptInterface
        fun copyToClipboard(text: String?) {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("Whisper", text ?: ""))
        }

        @JavascriptInterface
        fun shareText(title: String?, text: String?) {
            runOnUiThread {
                val sendIntent = Intent(Intent.ACTION_SEND).apply {
                    putExtra(Intent.EXTRA_SUBJECT, title ?: "Whisper")
                    putExtra(Intent.EXTRA_TEXT, text ?: "")
                    type = "text/plain"
                }
                startActivity(Intent.createChooser(sendIntent, title ?: "Share via"))
            }
        }

        @JavascriptInterface
        fun vibrate(ms: Int) {
            val duration = ms.coerceIn(5, 300).toLong()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator.vibrate(
                    VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE),
                )
            } else {
                @Suppress("DEPRECATION")
                val vibrator = getSystemService(VIBRATOR_SERVICE) as Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(
                        VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE),
                    )
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(duration)
                }
            }
        }

        @JavascriptInterface
        fun setTheme(theme: String?) {
            val isDark = theme == "dark"
            runOnUiThread {
                rootContainer.setBackgroundColor(
                    Color.parseColor(if (isDark) "#202B29" else "#EEF6F8"),
                )
            }
        }
    }
}
