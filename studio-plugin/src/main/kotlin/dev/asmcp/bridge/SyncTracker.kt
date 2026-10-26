@file:Suppress("OVERRIDE_DEPRECATION")

package dev.asmcp.bridge

import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.externalSystem.model.task.ExternalSystemTaskId
import com.intellij.openapi.externalSystem.model.task.ExternalSystemTaskNotificationListener
import com.intellij.openapi.externalSystem.model.task.ExternalSystemTaskType
import com.intellij.openapi.externalSystem.service.notification.ExternalSystemProgressNotificationManager
import dev.asmcp.bridge.Handlers.int
import java.util.concurrent.ConcurrentHashMap

/** Tracks Gradle sync (external-system RESOLVE_PROJECT tasks) per project so callers can wait for the outcome. */
object SyncTracker {
    data class Sync(
        val taskId: Long,
        @Volatile var state: String = "running",
        val startedAt: Long = System.currentTimeMillis(),
        @Volatile var finishedAt: Long? = null,
        @Volatile var error: String? = null,
    )

    /** Latest sync per IDE project id. */
    private val latest = ConcurrentHashMap<String, Sync>()

    fun install(parent: Disposable) {
        ExternalSystemProgressNotificationManager.getInstance().addNotificationListener(object : ExternalSystemTaskNotificationListener {
            private fun ExternalSystemTaskId.isSync() = type == ExternalSystemTaskType.RESOLVE_PROJECT

            // The platform has both old (projectPath, id) and new (id) overloads and callers fire either,
            // so handle both; start() and finish() ignore duplicates.
            override fun onStart(projectPath: String, id: ExternalSystemTaskId) = start(id)
            override fun onStart(id: ExternalSystemTaskId, workingDir: String?) = start(id)
            override fun onSuccess(projectPath: String, id: ExternalSystemTaskId) = finish(id, "succeeded", null)
            override fun onSuccess(id: ExternalSystemTaskId) = finish(id, "succeeded", null)
            override fun onFailure(projectPath: String, id: ExternalSystemTaskId, e: Exception) = finish(id, "failed", messages(e))
            override fun onFailure(id: ExternalSystemTaskId, e: Exception) = finish(id, "failed", messages(e))
            override fun onCancel(projectPath: String, id: ExternalSystemTaskId) = finish(id, "cancelled", null)
            override fun onCancel(id: ExternalSystemTaskId) = finish(id, "cancelled", null)
            override fun onEnd(projectPath: String, id: ExternalSystemTaskId) = finish(id, "ended", null)
            override fun onEnd(id: ExternalSystemTaskId) = finish(id, "ended", null)

            private fun messages(e: Throwable) =
                generateSequence(e) { it.cause }.mapNotNull { it.message }.distinct().joinToString("\n").take(4000)

            private fun start(id: ExternalSystemTaskId) {
                if (id.isSync() && latest[id.ideProjectId]?.taskId != id.id) latest[id.ideProjectId] = Sync(id.id)
            }

            private fun finish(id: ExternalSystemTaskId, state: String, error: String?) {
                if (!id.isSync()) return
                val s = latest.getOrPut(id.ideProjectId) { Sync(id.id) }
                if (s.taskId != id.id || s.finishedAt != null) return
                s.state = state
                s.error = error
                s.finishedAt = System.currentTimeMillis()
            }
        }, parent)
    }

    private fun describe(s: Sync?) = s?.let {
        mapOf(
            "state" to it.state,
            "startedAt" to it.startedAt,
            "durationSec" to ((it.finishedAt ?: System.currentTimeMillis()) - it.startedAt) / 1000,
            "error" to it.error,
        )
    } ?: mapOf("state" to "none", "note" to "No sync seen since the IDE started")

    fun status(args: JsonObject): Any {
        val project = Handlers.project(args)
        return mapOf("project" to project.name) + describe(latest[ExternalSystemTaskId.getProjectId(project)])
    }

    /** Start "Sync Project with Gradle Files" and wait (up to waitSec) for it to finish. */
    fun sync(args: JsonObject): Any {
        val project = Handlers.project(args)
        val key = ExternalSystemTaskId.getProjectId(project)
        val previous = latest[key]
        val am = ActionManager.getInstance()
        val actionId = listOf("Android.SyncProject", "ExternalSystem.RefreshAllProjects").firstOrNull { am.getAction(it) != null }
            ?: throw BridgeError("No Gradle sync action available in this IDE")
        if (!Handlers.invokeAction(project, am.getAction(actionId))) {
            throw BridgeError("Sync action is disabled right now (a sync may already be running); see sync_status")
        }
        val deadline = System.currentTimeMillis() + (args.int("waitSec") ?: 100) * 1000L
        while (System.currentTimeMillis() < deadline) {
            val cur = latest[key]
            if (cur != null && cur !== previous && cur.finishedAt != null) break
            Thread.sleep(300)
        }
        val cur = latest[key]
        val result = if (cur === previous) mapOf("state" to "not_started", "note" to "Sync did not start yet; check sync_status shortly")
        else describe(cur)
        return mapOf("project" to project.name, "action" to actionId) + result
    }
}
