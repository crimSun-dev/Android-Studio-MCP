plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.0"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.asmcp"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

// Compile against an installed Android Studio instead of downloading one.
// Set -PstudioHome=... (or studioHome in ~/.gradle/gradle.properties) or ANDROID_STUDIO_HOME if it isn't in the default place.
val defaultStudioHome = when {
    System.getProperty("os.name").startsWith("Windows") -> "C:/Program Files/Android/Android Studio"
    System.getProperty("os.name").startsWith("Mac") -> "/Applications/Android Studio.app/Contents"
    else -> "/opt/android-studio"
}
val studioHome: String = providers.gradleProperty("studioHome")
    .orElse(providers.environmentVariable("ANDROID_STUDIO_HOME"))
    .getOrElse(defaultStudioHome)

dependencies {
    intellijPlatform {
        local(studioHome)
    }
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "252"
            untilBuild = provider { null }
        }
    }
    // The local IDE has no matching verifier target configured; skip searchable options to keep builds fast.
    buildSearchableOptions = false
    instrumentCode = false
}
