# Keep JavascriptInterface methods intact if minification is ever enabled
-keepclassmembers class com.whisperaero.app.MainActivity$WhisperNativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
