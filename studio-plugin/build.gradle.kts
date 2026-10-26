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
// scripts/install-plugin.mjs finds Studio automatically and passes ANDROID_STUDIO_HOME; when running Gradle
// directly, set -PstudioHome=... or ANDROID_STUDIO_HOME if Studio isn't in its default place.
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

// Compile with the IDE's own JDK version (found via ANDROID_STUDIO_JBR or downloaded), but emit Java 21 bytecode
// so the plugin also loads in older Studio releases that run on JBR 21.
java {
    targetCompatibility = JavaVersion.VERSION_21
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
}
tasks.withType<JavaCompile>().configureEach {
    options.release.set(21)
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
