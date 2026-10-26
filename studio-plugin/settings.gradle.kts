pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "android-studio-mcp-bridge"

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}
