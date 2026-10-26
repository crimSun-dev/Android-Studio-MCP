package dev.asmcp.bridge

import com.google.gson.JsonObject
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.ide.impl.ProjectUtil
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** The bridge's RPC methods. Each takes the request's JSON object and returns something Gson can serialize. */
object Handlers {
    private val methods: Map<String, (JsonObject) -> Any?> = mapOf(
        "status" to ::status,
        "editors" to ::editors,
        "document" to ::document,
        "problems" to ::problems,
        "open" to ::open,
        "save_all" to ::saveAll,
        "actions" to ::actions,
        "action" to ::action,
        "run_configurations" to ::runConfigurations,
        "run" to ::run,
        "find_files" to ::findFiles,
        "find_usages" to Analysis::findUsages,
        "rename" to Analysis::rename,
        "project_problems" to Analysis::projectProblems,
        "gradle_sync" to SyncTracker::sync,
        "sync_status" to SyncTracker::status,
        "screenshot" to Analysis::screenshot,
    )

    fun dispatch(method: String, args: JsonObject): Any? {
        val fn = methods[method] ?: throw BridgeError("unknown method '$method'; available: ${methods.keys.joinToString()}")
        return fn(args)
    }

    // ---- helpers -------------------------------------------------------------------------------

    internal fun JsonObject.str(key: String): String? = get(key)?.takeIf { !it.isJsonNull }?.asString
    internal fun JsonObject.int(key: String): Int? = get(key)?.takeIf { !it.isJsonNull }?.asInt
    internal fun JsonObject.bool(key: String): Boolean = get(key)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    internal fun openProjects(): List<Project> = ProjectManager.getInstance().openProjects.filter { !it.isDisposed && !it.isDefault }

    private fun norm(p: String) = Path.of(p).toAbsolutePath().normalize().toString().lowercase()

    /** Pick a project by `project` (name or base path), by the project containing `path`, or the active one. */
    internal fun project(args: JsonObject): Project {
        val projects = openProjects()
        if (projects.isEmpty()) throw BridgeError("No project is open in the IDE")
        args.str("project")?.let { key ->
            return projects.firstOrNull { it.name == key || (it.basePath != null && norm(it.basePath!!) == norm(key)) }
                ?: throw BridgeError("No open project '$key'. Open: ${projects.joinToString { it.name }}")
        }
        args.str("path")?.let { p ->
            val n = norm(p)
            projects.filter { it.basePath != null && n.startsWith(norm(it.basePath!!)) }
                .maxByOrNull { it.basePath!!.length }?.let { return it }
        }
        return ProjectUtil.getActiveProject() ?: projects.first()
    }

    internal fun file(path: String): VirtualFile =
        LocalFileSystem.getInstance().refreshAndFindFileByPath(path.replace('\\', '/'))
            ?: throw BridgeError("File not found: $path")

    /** Run on the EDT and wait, without hanging the HTTP thread forever if a modal dialog blocks the queue. */
    internal fun <T> onEdt(timeoutSec: Long = 20, block: () -> T): T {
        val future = CompletableFuture<T>()
        ApplicationManager.getApplication().invokeLater({
            try {
                future.complete(block())
            } catch (e: Throwable) {
                future.completeExceptionally(e)
            }
        }, ModalityState.defaultModalityState())
        return try {
            future.get(timeoutSec, TimeUnit.SECONDS)
        } catch (e: TimeoutException) {
            throw BridgeError("IDE UI thread busy for ${timeoutSec}s (a modal dialog may be open)")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    /** Index-based features need smart mode; indexing often restarts briefly after a sync, so wait for it. */
    internal fun requireSmart(project: Project, timeoutSec: Long = 60) {
        if (DumbService.isDumb(project) && !DumbService.getInstance(project).waitForSmartMode(timeoutSec * 1000)) {
            throw BridgeError("The IDE is still indexing after ${timeoutSec}s; try again shortly")
        }
    }

    internal fun <T> read(block: () -> T): T = ReadAction.nonBlocking<T> { block() }.executeSynchronously()

    internal fun line(doc: Document, offset: Int) = doc.getLineNumber(offset.coerceIn(0, doc.textLength)) + 1
    internal fun column(doc: Document, offset: Int): Int {
        val o = offset.coerceIn(0, doc.textLength)
        return o - doc.getLineStartOffset(doc.getLineNumber(o)) + 1
    }

    // ---- methods -------------------------------------------------------------------------------

    private fun status(@Suppress("UNUSED_PARAMETER") args: JsonObject): Any {
        val app = ApplicationInfo.getInstance()
        val active = ProjectUtil.getActiveProject()
        return mapOf(
            "ide" to app.fullApplicationName,
            "build" to app.build.asString(),
            "bridgeVersion" to BRIDGE_VERSION,
            "projects" to openProjects().map {
                mapOf(
                    "name" to it.name,
                    "basePath" to it.basePath,
                    "active" to (it == active),
                    "indexing" to DumbService.isDumb(it),
                )
            },
        )
    }

    private fun editors(args: JsonObject): Any {
        val project = project(args)
        return onEdt {
            val fem = FileEditorManager.getInstance(project)
            val fdm = FileDocumentManager.getInstance()
            val selected = fem.selectedTextEditor
            val selectedFile = selected?.let { fdm.getFile(it.document) }
            mapOf(
                "project" to project.name,
                "openFiles" to fem.openFiles.map {
                    mapOf("path" to it.path, "modified" to fdm.isFileModified(it), "selected" to (it == selectedFile))
                },
                "active" to selected?.let { ed ->
                    val caret = ed.caretModel.primaryCaret
                    mapOf(
                        "path" to selectedFile?.path,
                        "line" to caret.logicalPosition.line + 1,
                        "column" to caret.logicalPosition.column + 1,
                        "selection" to caret.selectedText,
                    )
                },
            )
        }
    }

    /** The document's current text, including edits not yet saved to disk. */
    private fun document(args: JsonObject): Any {
        val path = args.str("path") ?: throw BridgeError("path is required")
        val vf = file(path)
        return read {
            val fdm = FileDocumentManager.getInstance()
            val doc = fdm.getDocument(vf) ?: throw BridgeError("Not a text file: $path")
            val from = (args.int("startLine") ?: 1).coerceAtLeast(1)
            val to = (args.int("endLine") ?: doc.lineCount).coerceAtMost(doc.lineCount)
            val text = if (doc.lineCount == 0 || (from == 1 && to == doc.lineCount)) doc.text
            else doc.getText(com.intellij.openapi.util.TextRange(doc.getLineStartOffset(from - 1), doc.getLineEndOffset(to - 1)))
            mapOf("path" to vf.path, "modified" to fdm.isFileModified(vf), "lineCount" to doc.lineCount, "startLine" to from, "text" to text)
        }
    }

    /**
     * Errors and warnings from the IDE's on-the-fly analysis. Highlighting only runs for files open in an editor,
     * so a closed file is opened (without stealing focus) and given time to analyze.
     */
    private fun problems(args: JsonObject): Any {
        val path = args.str("path") ?: throw BridgeError("path is required")
        val project = project(args)
        val vf = file(path)
        val minSeverity = when (args.str("minSeverity")?.lowercase()) {
            "error" -> HighlightSeverity.ERROR
            "weak_warning" -> HighlightSeverity.WEAK_WARNING
            else -> HighlightSeverity.WARNING
        }
        val wasOpen = onEdt { FileEditorManager.getInstance(project).isFileOpen(vf) }
        if (!wasOpen) onEdt { FileEditorManager.getInstance(project).openFile(vf, false) }

        val waitMs = (args.int("waitSec") ?: 8) * 1000L
        val deadline = System.currentTimeMillis() + waitMs
        var analyzed: Boolean
        var result: List<Map<String, Any?>>
        do {
            val snapshot = read {
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: throw BridgeError("Not a text file: $path")
                val psi = com.intellij.psi.PsiManager.getInstance(project).findFile(vf)
                val done = psi != null && DaemonCodeAnalyzer.getInstance(project).let {
                    (it as? DaemonCodeAnalyzerImpl)?.isErrorAnalyzingFinished(psi) ?: true
                }
                val infos = DaemonCodeAnalyzerImpl.getHighlights(doc, minSeverity, project)
                    .filter { it.description != null }
                    .map {
                        mapOf(
                            "severity" to it.severity.name,
                            "line" to line(doc, it.startOffset),
                            "column" to column(doc, it.startOffset),
                            "message" to it.description,
                            "text" to doc.getText(com.intellij.openapi.util.TextRange(it.startOffset, it.endOffset.coerceAtMost(doc.textLength))).take(120),
                        )
                    }
                    .distinct()
                done to infos
            }
            analyzed = snapshot.first
            result = snapshot.second
            if (analyzed || System.currentTimeMillis() > deadline) break
            Thread.sleep(300)
        } while (true)

        return mapOf(
            "path" to vf.path,
            "analysisComplete" to analyzed,
            "indexing" to DumbService.isDumb(project),
            "openedForAnalysis" to !wasOpen,
            "count" to result.size,
            "problems" to result,
        )
    }

    private fun open(args: JsonObject): Any {
        val path = args.str("path") ?: throw BridgeError("path is required")
        val project = project(args)
        val vf = file(path)
        val line = (args.int("line") ?: 1) - 1
        val col = (args.int("column") ?: 1) - 1
        onEdt {
            OpenFileDescriptor(project, vf, line.coerceAtLeast(0), col.coerceAtLeast(0)).navigate(true)
            WindowManager.getInstance().getFrame(project)?.toFront()
        }
        return mapOf("opened" to vf.path, "line" to line + 1, "project" to project.name)
    }

    private fun saveAll(@Suppress("UNUSED_PARAMETER") args: JsonObject): Any {
        val unsaved = onEdt {
            val fdm = FileDocumentManager.getInstance()
            val paths = fdm.unsavedDocuments.mapNotNull { fdm.getFile(it)?.path }
            fdm.saveAllDocuments()
            paths
        }
        return mapOf("saved" to unsaved)
    }

    /** Search registered IDE actions by id or menu text. */
    private fun actions(args: JsonObject): Any {
        val query = args.str("query")?.lowercase() ?: ""
        val limit = args.int("limit") ?: 50
        val am = ActionManager.getInstance()
        return am.getActionIdList("").asSequence()
            .mapNotNull { id ->
                val text = am.getAction(id)?.templatePresentation?.text
                if (query.isEmpty() || id.lowercase().contains(query) || text?.lowercase()?.contains(query) == true) {
                    mapOf("id" to id, "text" to text)
                } else null
            }
            .take(limit)
            .toList()
    }

    /** Invoke an IDE action by id (e.g. Android.SyncProject, ReformatCode, OptimizeImports) in the project's frame. */
    private fun action(args: JsonObject): Any {
        val id = args.str("id") ?: throw BridgeError("id is required")
        val project = project(args)
        val am = ActionManager.getInstance()
        val action = am.getAction(id) ?: throw BridgeError("Unknown action '$id'. Use the actions method to search.")
        onEdt {
            // Use the selected editor (or the frame) as the context component so the action sees this project.
            val component = FileEditorManager.getInstance(project).selectedTextEditor?.contentComponent
                ?: WindowManager.getInstance().getFrame(project)?.rootPane
            am.tryToExecute(action, null, component, ActionPlaces.UNKNOWN, true)
        }
        return mapOf("invoked" to id, "project" to project.name)
    }

    private fun runConfigurations(args: JsonObject): Any {
        val project = project(args)
        val rm = RunManager.getInstance(project)
        val selected = rm.selectedConfiguration
        return rm.allSettings.map {
            mapOf("name" to it.name, "type" to it.type.displayName, "temporary" to it.isTemporary, "selected" to (it == selected))
        }
    }

    /** Run or debug a run configuration exactly as the toolbar button would. */
    private fun run(args: JsonObject): Any {
        val project = project(args)
        val rm = RunManager.getInstance(project)
        val name = args.str("name")
        val settings = (if (name != null) rm.findConfigurationByName(name) else rm.selectedConfiguration)
            ?: throw BridgeError(
                if (name != null) "No run configuration '$name'. Available: ${rm.allSettings.joinToString { it.name }}"
                else "No run configuration is selected",
            )
        val executor = if (args.bool("debug")) DefaultDebugExecutor.getDebugExecutorInstance() else DefaultRunExecutor.getRunExecutorInstance()
        onEdt { ProgramRunnerUtil.executeConfiguration(settings, executor) }
        return mapOf("started" to settings.name, "executor" to executor.id, "project" to project.name)
    }

    /** Find project files by exact name, or by a glob like `*Activity.kt`. Requires indexing to be finished. */
    private fun findFiles(args: JsonObject): Any {
        val query = args.str("name") ?: throw BridgeError("name is required")
        val project = project(args)
        requireSmart(project)
        val limit = args.int("limit") ?: 100
        return read {
            val scope = GlobalSearchScope.projectScope(project)
            val names = if ('*' in query || '?' in query) {
                val re = Regex(query.split('*').joinToString(".*") { part -> part.split('?').joinToString(".") { Regex.escape(it) } }, RegexOption.IGNORE_CASE)
                FilenameIndex.getAllFilenames(project).filter { re.matches(it) }
            } else listOf(query)
            names.asSequence()
                .flatMap { FilenameIndex.getVirtualFilesByName(it, scope).asSequence() }
                .map { it.path }
                .take(limit)
                .toList()
        }
    }
}
