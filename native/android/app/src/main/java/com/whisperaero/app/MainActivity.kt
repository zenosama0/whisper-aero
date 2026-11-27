package com.whisperaero.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.provider.Settings
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
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingChatFromIntent: String? = null
    private var pendingSharedText: String? = null

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val data = result.data
        if (result.resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val list = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let { list.add(it) }
            }
        } else {
            data.data?.let { list.add(it) }
        }
        val uris = if (list.isNotEmpty()) {
            list.toTypedArray()
        } else {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
        }
        callback.onReceiveValue(uris)
    }

    companion object {
        private const val BASE_URL = "https://zenosama0.github.io/whisper-aero/"
        private const val REQ_POST_NOTIFICATIONS = 1001

        @Volatile
        var isAppInForeground: Boolean = false

        private val http = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        NotificationHelper.ensureChannels(this)
        requestNotificationPermissionIfNeeded()

        pendingChatFromIntent = extractChatId(intent)
        pendingSharedText = extractSharedText(intent)

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
                val shared = pendingSharedText
                if (!shared.isNullOrBlank()) {
                    pendingSharedText = null
                    deliverSharedText(shared)
                }
                notifyCapabilitiesChanged()
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
                val acceptTypes = fileChooserParams?.acceptTypes?.joinToString(",")?.lowercase().orEmpty()
                val wantsMedia = acceptTypes.contains("image/") || acceptTypes.contains("video/")
                val allowMultiple = fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE

                val primaryIntent = if (wantsMedia) {
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
                    filePickerLauncher.launch(primaryIntent)
                    true
                } catch (_: Exception) {
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
        WhisperSyncService.syncState(this)
        WhisperSyncWorker.schedule(this)
        pendingChatFromIntent?.let { if (it.isNotBlank()) NotificationHelper.clearIncomingCall(this, it) }
        syncFcmIfConfigured()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val chatId = extractChatId(intent)
        if (!chatId.isNullOrBlank()) {
            NotificationHelper.clearIncomingCall(this, chatId)
            openChatInWeb(chatId)
        }
        val shared = extractSharedText(intent)
        if (!shared.isNullOrBlank()) {
            deliverSharedText(shared)
        }
    }

    override fun onResume() {
        super.onResume()
        isAppInForeground = true
        if (::webView.isInitialized) {
            webView.onResume()
            webView.evaluateJavascript(
                "if(typeof window.WhisperOnNativeResume==='function') window.WhisperOnNativeResume();",
                null,
            )
            notifyCapabilitiesChanged()
        }
    }

    override fun onPause() {
        isAppInForeground = false
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_POST_NOTIFICATIONS) {
            notifyCapabilitiesChanged()
        }
    }

    private fun extractChatId(intent: Intent?): String? {
        if (intent == null) return null
        val fromExtra = intent.getStringExtra(NotificationHelper.EXTRA_CHAT_ID)
        if (!fromExtra.isNullOrBlank()) return fromExtra
        return intent.data?.getQueryParameter("chat")
    }

    private fun extractSharedText(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        if (intent.type != "text/plain") return null
        return intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.takeIf { it.isNotEmpty() }
    }

    private fun openChatInWeb(chatId: String) {
        if (!::webView.isInitialized) return
        val quoted = JSONObject.quote(chatId)
        webView.evaluateJavascript(
            "if(typeof window.WhisperOpenChat==='function') window.WhisperOpenChat($quoted);",
            null,
        )
    }

    private fun deliverSharedText(text: String) {
        if (!::webView.isInitialized) return
        val quoted = JSONObject.quote(text)
        webView.evaluateJavascript(
            "if(typeof window.WhisperReceiveSharedText==='function') window.WhisperReceiveSharedText($quoted);",
            null,
        )
    }

    private fun notifyCapabilitiesChanged() {
        if (!::webView.isInitialized) return
        runOnUiThread {
            webView.evaluateJavascript(
                "if(typeof window.WhisperOnNativeCapsChanged==='function') window.WhisperOnNativeCapsChanged();",
                null,
            )
        }
    }

    private fun isBatteryOptimized(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        return !pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    REQ_POST_NOTIFICATIONS,
                )
            }
        }
    }

    private fun syncFcmIfConfigured() {
        try {
            if (FirebaseApp.getApps(this).isEmpty()) return
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (!token.isNullOrBlank()) {
                    SessionStore.saveFcmToken(this, token)
                    Thread { SessionStore.syncFcmTokenToServer(this, http, token) }.start()
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun randomHexNonce(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun sha256Hex(raw: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private inner class WhisperNativeBridge {
        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun getPlatform(): String = "android"

        @JavascriptInterface
        fun getCapabilities(): String {
            return JSONObject()
                .put("platform", "android")
                .put("notificationsGranted", NotificationHelper.isPermissionGranted(this@MainActivity))
                .put("backgroundSyncEnabled", SessionStore.isBackgroundSyncEnabled(this@MainActivity))
                .put("batteryOptimized", isBatteryOptimized())
                .put("bubblesEnabled", NotificationHelper.areBubblesEnabled(this@MainActivity))
                .toString()
        }

        @JavascriptInterface
        fun signInWithGoogle(webClientId: String?) {
            val clientId = webClientId?.trim().orEmpty()
            if (clientId.isEmpty()) {
                runOnUiThread {
                    webView.evaluateJavascript(
                        "if(typeof window.WhisperOnNativeGoogleError==='function') window.WhisperOnNativeGoogleError('missing_client_id');",
                        null,
                    )
                }
                return
            }

            lifecycleScope.launch {
                try {
                    val rawNonce = randomHexNonce()
                    val hashedNonce = sha256Hex(rawNonce)
                    val googleIdOption = GetGoogleIdOption.Builder()
                        .setFilterByAuthorizedAccounts(false)
                        .setServerClientId(clientId)
                        .setAutoSelectEnabled(false)
                        .setNonce(hashedNonce)
                        .build()
                    val request = GetCredentialRequest.Builder()
                        .addCredentialOption(googleIdOption)
                        .build()

                    val credentialManager = CredentialManager.create(this@MainActivity)
                    val result = credentialManager.getCredential(this@MainActivity, request)
                    val googleCred = GoogleIdTokenCredential.createFrom(result.credential.data)
                    val qToken = JSONObject.quote(googleCred.idToken)
                    val qNonce = JSONObject.quote(rawNonce)
                    webView.evaluateJavascript(
                        "if(typeof window.WhisperOnNativeGoogleToken==='function') window.WhisperOnNativeGoogleToken($qToken, $qNonce);",
                        null,
                    )
                } catch (_: GetCredentialCancellationException) {
                    webView.evaluateJavascript(
                        "if(typeof window.WhisperOnNativeGoogleError==='function') window.WhisperOnNativeGoogleError('cancelled');",
                        null,
                    )
                } catch (e: Exception) {
                    val qErr = JSONObject.quote(e.message ?: "Native Google sign-in failed")
                    webView.evaluateJavascript(
                        "if(typeof window.WhisperOnNativeGoogleError==='function') window.WhisperOnNativeGoogleError($qErr);",
                        null,
                    )
                }
            }
        }

        @JavascriptInterface
        fun requestNotificationPermission() {
            runOnUiThread {
                if (NotificationHelper.isPermissionGranted(this@MainActivity)) {
                    openNotificationSettings()
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                        REQ_POST_NOTIFICATIONS,
                    )
                }
            }
        }

        @JavascriptInterface
        fun openNotificationSettings() {
            runOnUiThread {
                val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                }
                startActivity(intent)
            }
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
                    openNotificationSettings()
                }
            }
        }

        @JavascriptInterface
        fun pushChatShortcuts(json: String?) {
            if (json.isNullOrBlank()) return
            NotificationHelper.publishShortcutsFromJson(this@MainActivity, json)
        }

        @JavascriptInterface
        fun openChatBubble(conversationId: String?, title: String?, iconUrl: String?): Boolean {
            val id = conversationId?.trim().orEmpty()
            if (id.isEmpty()) return false
            val opened = NotificationHelper.openChatAsBubble(
                this@MainActivity,
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
        fun setBackgroundSyncEnabled(enabled: Boolean) {
            SessionStore.setBackgroundSyncEnabled(this@MainActivity, enabled)
            WhisperSyncService.syncState(this@MainActivity)
            notifyCapabilitiesChanged()
        }

        @JavascriptInterface
        fun requestIgnoreBatteryOptimizations() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    try {
                        val intent = if (isBatteryOptimized()) {
                            Intent(
                                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                Uri.parse("package:$packageName"),
                            )
                        } else {
                            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        }
                        startActivity(intent)
                    } catch (_: Exception) {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                }
            }
        }

        @JavascriptInterface
        fun sendTestNotification() {
            NotificationHelper.showTest(this@MainActivity)
        }

        @JavascriptInterface
        fun syncSession(json: String?) {
            if (json.isNullOrBlank()) return
            SessionStore.saveFromJson(this@MainActivity, json)
            WhisperSyncService.syncState(this@MainActivity)
            syncFcmIfConfigured()
            Thread { SessionStore.syncFcmTokenToServer(this@MainActivity, http) }.start()
        }

        @JavascriptInterface
        fun getStoredSession(): String {
            return SessionStore.getSessionJson(this@MainActivity)
        }

        @JavascriptInterface
        fun clearSession() {
            Thread {
                SessionStore.unsubscribeFcmTokenFromServer(this@MainActivity, http)
                SessionStore.clear(this@MainActivity)
                WhisperSyncService.syncState(this@MainActivity)
            }.start()
        }

        @JavascriptInterface
        fun showIncomingCallAlarm(conversationId: String?, title: String?, iconUrl: String?) {
            NotificationHelper.showIncomingCallAlarm(
                this@MainActivity,
                conversationId ?: "",
                title ?: "Whisper contact",
                iconUrl ?: "",
            )
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
                rootContainer.setBackgroundColor(statusColor)
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
