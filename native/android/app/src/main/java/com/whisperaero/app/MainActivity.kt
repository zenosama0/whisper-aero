package com.whisperaero.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingChatFromIntent: String? = null

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        callback.onReceiveValue(uris)
    }

    companion object {
        private const val BASE_URL = "https://zenosama0.github.io/whisper-aero/"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        NotificationHelper.ensureChannels(this)
        requestNotificationPermissionIfNeeded()

        pendingChatFromIntent = extractChatId(intent)

        webView = WebView(this)
        setContentView(webView)

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

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
            setSupportMultipleWindows(false)
            userAgentString = userAgentString.replace("; wv", "")
        }

        webView.addJavascriptInterface(WhisperNativeBridge(), "WhisperNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val host = (uri.host ?: "").lowercase()
                val scheme = (uri.scheme ?: "").lowercase()

                if (scheme == "whisperaero") {
                    val chatId = uri.getQueryParameter("chat")
                    if (!chatId.isNullOrBlank()) {
                        openChatInWeb(chatId)
                    }
                    return true
                }

                val allowedInApp = host == "zenosama0.github.io" ||
                    host.endsWith(".supabase.co") ||
                    host == "accounts.google.com" ||
                    host.endsWith(".google.com") ||
                    host.endsWith(".gstatic.com") ||
                    host.endsWith(".googleusercontent.com")

                if (allowedInApp) return false

                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    false
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                val targetChat = pendingChatFromIntent
                if (!targetChat.isNullOrBlank()) {
                    pendingChatFromIntent = null
                    openChatInWeb(targetChat)
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val originHost = (request.origin?.host ?: "").lowercase()
                if (originHost == "zenosama0.github.io") {
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
                    val chooserIntent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    filePickerLauncher.launch(chooserIntent)
                    true
                } catch (_: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }

        webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setMimeType(mimetype)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    addRequestHeader("User-Agent", userAgent)
                    val fileName = URLUtil.guessFileName(url, contentDisposition, mimetype)
                    setTitle(fileName)
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                }
                val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
            } catch (_: Exception) {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: Exception) {
                }
            }
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript(
                        "(function(){return typeof window.WhisperHandleNativeBack==='function' && window.WhisperHandleNativeBack();})()",
                    ) { result ->
                        if (result != "true") {
                            if (webView.canGoBack() && (webView.url ?: "").startsWith("https://accounts.google.com")) {
                                webView.goBack()
                            } else {
                                moveTaskToBack(true)
                            }
                        }
                    }
                }
            },
        )

        val initialUrl = if (!pendingChatFromIntent.isNullOrBlank()) {
            "$BASE_URL?chat=${Uri.encode(pendingChatFromIntent)}"
        } else {
            BASE_URL
        }
        webView.loadUrl(initialUrl)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val chatId = extractChatId(intent)
        if (!chatId.isNullOrBlank()) {
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

    private fun extractChatId(intent: Intent?): String? {
        if (intent == null) return null
        val fromExtra = intent.getStringExtra(NotificationHelper.EXTRA_CHAT_ID)
        if (!fromExtra.isNullOrBlank()) return fromExtra
        return intent.data?.getQueryParameter("chat")
    }

    private fun openChatInWeb(chatId: String) {
        if (!::webView.isInitialized) return
        val quoted = JSONObject.quote(chatId)
        webView.evaluateJavascript(
            "if(typeof window.WhisperOpenChat==='function') window.WhisperOpenChat($quoted);",
            null,
        )
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    1001,
                )
            }
        }
    }

    private inner class WhisperNativeBridge {
        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun getPlatform(): String = "android"

        @JavascriptInterface
        fun showNotification(conversationId: String?, title: String?, body: String?, iconUrl: String?, tag: String?) {
            NotificationHelper.show(
                this@MainActivity,
                conversationId ?: "",
                title ?: "Whisper",
                body ?: "",
                iconUrl ?: "",
                tag ?: "whisper",
            )
        }

        @JavascriptInterface
        fun clearNotification(conversationId: String?) {
            NotificationHelper.clearChat(this@MainActivity, conversationId ?: "")
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
                val statusColor = if (isDark) Color.parseColor("#202B29") else Color.parseColor("#EEF6F8")
                val navColor = if (isDark) Color.parseColor("#17201E") else Color.parseColor("#FFFFFF")
                @Suppress("DEPRECATION")
                window.statusBarColor = statusColor
                @Suppress("DEPRECATION")
                window.navigationBarColor = navColor
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                controller.isAppearanceLightStatusBars = !isDark
                controller.isAppearanceLightNavigationBars = !isDark
            }
        }
    }
}
