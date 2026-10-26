package dev.asmcp.bridge

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.components.service
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors

private val LOG = logger<BridgeServer>()

const val BRIDGE_VERSION = "0.1.0"

/** Where the MCP server looks for the port and token. One file per IDE process, so several Studios can coexist. */
val bridgeDir: Path = Path.of(System.getProperty("user.home"), ".android-studio-mcp", "bridges")

class BridgeStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        service<BridgeServer>().ensureStarted()
    }
}

/** A failure the caller caused (bad path, unknown action): reported as HTTP 400 with the message. */
class BridgeError(message: String) : Exception(message)

/**
 * Token-protected HTTP endpoint on 127.0.0.1. Every request is `POST /<method>` with a JSON body
 * and `Authorization: Bearer <token>`; the response is JSON.
 */
@Service(Service.Level.APP)
class BridgeServer : Disposable {
    private val gson: Gson = GsonBuilder().disableHtmlEscaping().serializeNulls().create()
    private var server: HttpServer? = null
    private var file: Path? = null
    private val token: String = ByteArray(24).also { SecureRandom().nextBytes(it) }
        .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    @Synchronized
    fun ensureStarted() {
        if (server != null) return
        val http = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        http.executor = Executors.newCachedThreadPool { r -> Thread(r, "asmcp-bridge").apply { isDaemon = true } }
        http.createContext("/") { ex -> handle(ex) }
        http.start()
        server = http
        SyncTracker.install(this)
        file = writeBridgeFile(http.address.port)
        LOG.info("Android Studio MCP bridge listening on 127.0.0.1:${http.address.port}")
    }

    private fun writeBridgeFile(port: Int): Path {
        Files.createDirectories(bridgeDir)
        val pid = ProcessHandle.current().pid()
        val info = mapOf(
            "port" to port,
            "token" to token,
            "pid" to pid,
            "ide" to ApplicationInfo.getInstance().fullApplicationName,
            "build" to ApplicationInfo.getInstance().build.asString(),
            "bridgeVersion" to BRIDGE_VERSION,
            "startedAt" to System.currentTimeMillis(),
        )
        val target = bridgeDir.resolve("$pid.json")
        val tmp = Files.createTempFile(bridgeDir, "bridge", ".tmp")
        Files.writeString(tmp, gson.toJson(info))
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        return target
    }

    private fun handle(ex: HttpExchange) {
        val (status, body) = try {
            if (ex.requestMethod != "POST") throw BridgeError("use POST")
            val auth = ex.requestHeaders.getFirst("Authorization")?.removePrefix("Bearer ")?.trim() ?: ""
            if (!MessageDigest.isEqual(auth.toByteArray(), token.toByteArray())) {
                401 to mapOf("error" to "invalid token")
            } else {
                val raw = ex.requestBody.readAllBytes().toString(Charsets.UTF_8)
                val args = if (raw.isBlank()) JsonObject() else gson.fromJson(raw, JsonObject::class.java)
                val method = ex.requestURI.path.trim('/')
                200 to Handlers.dispatch(method, args)
            }
        } catch (e: BridgeError) {
            400 to mapOf("error" to e.message)
        } catch (e: Throwable) {
            LOG.warn("bridge request failed", e)
            500 to mapOf("error" to "${e.javaClass.simpleName}: ${e.message}")
        }
        val bytes = gson.toJson(body).toByteArray(Charsets.UTF_8)
        ex.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
        ex.sendResponseHeaders(status, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    override fun dispose() {
        server?.stop(0)
        file?.let { runCatching { Files.deleteIfExists(it) } }
    }
}
