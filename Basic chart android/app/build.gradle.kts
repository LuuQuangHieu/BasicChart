plugins {
    id("com.android.application")
}

android {
    namespace = "com.basicchart.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.basicchart.app"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // signed with the local debug key so the APK installs directly (no store release key)
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // the web app, built by `npm run build` in the folder above, is packed into the APK as its assets
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/web"))
}

val copyWeb by tasks.registering(Copy::class) {
    val dist = rootProject.file("../dist")
    doFirst {
        check(dist.resolve("index.html").exists()) { "Run `npm run build` in ${dist.parentFile} first" }
    }
    from(dist)
    into(layout.buildDirectory.dir("generated/web"))
}
tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
}
