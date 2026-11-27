plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.whisperaero.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.whisperaero.app"
        minSdk = 24
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE")?.toIntOrNull() ?: 29)
        versionName = (System.getenv("VERSION_NAME") ?: "2026.11.27.29")
    }

    signingConfigs {
        create("whisper") {
            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "whisper-signing.p12")
            storeType = System.getenv("ANDROID_KEYSTORE_TYPE") ?: "PKCS12"
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "whisperaero-signing"
            keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "whisper"
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: "whisperaero-signing"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("whisper")
        }
        release {
            signingConfig = signingConfigs.getByName("whisper")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
