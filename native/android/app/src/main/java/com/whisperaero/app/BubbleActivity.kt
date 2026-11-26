package com.whisperaero.app

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class BubbleActivity : AppCompatActivity() {

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var activeChatId: String = ""

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
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
                if (activeChatId.isNotBlank() && activeChatId != "whisper-preview") {
                    openChatInWeb(activeChatId)
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                if ((request.origin?.host ?: "").equals("zenosama0.github.io", ignoreCase = true)) {
                    request.grant(request.resources)
                } else {
                    request.deny()
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    val chooser = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    filePickerLauncher.launch(chooser)
                    true
                } catch (_: Exception) {
                    filePathCallback = null
                    false
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
        fun getPlatform(): String = "android"

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
