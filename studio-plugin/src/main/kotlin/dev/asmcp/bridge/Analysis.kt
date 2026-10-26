package dev.asmcp.bridge

import com.google.gson.JsonObject
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.codeInsight.daemon.impl.MainPassesRunner
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.util.ProgressIndicatorBase
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.profile.codeInspection.InspectionProjectProfileManager
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.refactoring.rename.RenameProcessor
import dev.asmcp.bridge.Handlers.bool
import dev.asmcp.bridge.Handlers.int
import dev.asmcp.bridge.Handlers.str
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import javax.imageio.ImageIO

/** Code-intelligence methods: usages, rename, batch analysis, and IDE window capture. */
object Analysis {
    private val SOURCE_EXTENSIONS = setOf("kt", "java", "kts", "xml", "gradle", "toml")


    /** The declaration at path:line:column, or the declaration that a reference there resolves to. */
    private fun targetAt(project: Project, args: JsonObject): PsiElement {
        val path = args.str("path") ?: throw BridgeError("path is required")
        val line = args.int("line") ?: throw BridgeError("line is required")
        val col = args.int("column") ?: 1
        val vf = Handlers.file(path)
        val psi = PsiManager.getInstance(project).findFile(vf) ?: throw BridgeError("Not a source file: $path")
        val doc = PsiDocumentManager.getInstance(project).getDocument(psi) ?: throw BridgeError("No document for $path")
        if (line < 1 || line > doc.lineCount) throw BridgeError("line $line is outside 1..${doc.lineCount}")
        val offset = (doc.getLineStartOffset(line - 1) + col - 1).coerceAtMost(doc.getLineEndOffset(line - 1))
        psi.findReferenceAt(offset)?.resolve()?.let { return it }
        val leaf = psi.findElementAt(offset) ?: throw BridgeError("Nothing at $path:$line:$col")
        val owner = PsiTreeUtil.getParentOfType(leaf, PsiNameIdentifierOwner::class.java, false)
        if (owner != null && owner.nameIdentifier?.textRange?.containsOffset(offset) == true) return owner
        return PsiTreeUtil.getParentOfType(leaf, PsiNamedElement::class.java, false)
            ?: throw BridgeError("No symbol at $path:$line:$col; point at a name (declaration or reference)")
    }

    private fun describe(e: PsiElement): Map<String, Any?> {
        val file = e.containingFile?.virtualFile
        val doc = file?.let { FileDocumentManager.getInstance().getDocument(it) }
        val off = (e as? PsiNameIdentifierOwner)?.nameIdentifier?.textOffset ?: e.textOffset
        return mapOf(
            "name" to (e as? PsiNamedElement)?.name,
            "kind" to e.javaClass.simpleName.removeSuffix("Impl"),
            "path" to file?.path,
            "line" to doc?.let { Handlers.line(it, off) },
            "column" to doc?.let { Handlers.column(it, off) },
        )
    }

    fun findUsages(args: JsonObject): Any {
        val project = Handlers.project(args)
        Handlers.requireSmart(project)
        val limit = args.int("limit") ?: 200
        return Handlers.read {
            val target = targetAt(project, args)
            val refs = ReferencesSearch.search(target, GlobalSearchScope.projectScope(project)).findAll()
            val usages = refs.asSequence().mapNotNull { ref ->
                val el = ref.element
                val vf = el.containingFile?.virtualFile ?: return@mapNotNull null
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@mapNotNull null
                val start = el.textRange.startOffset + ref.rangeInElement.startOffset
                val ln = Handlers.line(doc, start)
                mapOf(
                    "path" to vf.path,
                    "line" to ln,
                    "column" to Handlers.column(doc, start),
                    "code" to doc.getText(com.intellij.openapi.util.TextRange(doc.getLineStartOffset(ln - 1), doc.getLineEndOffset(ln - 1))).trim().take(200),
                )
            }.sortedWith(compareBy({ it["path"] as String }, { it["line"] as Int })).toList()
            mapOf("target" to describe(target), "count" to usages.size, "usages" to usages.take(limit))
        }
    }

    /** Rename a symbol and every reference to it, the way Shift+F6 does (without the preview dialog). */
    fun rename(args: JsonObject): Any {
        val newName = args.str("newName") ?: throw BridgeError("newName is required")
        val project = Handlers.project(args)
        Handlers.requireSmart(project)
        val target = Handlers.read { targetAt(project, args) }
        val before = Handlers.read { describe(target) }
        val usageCount = Handlers.read { ReferencesSearch.search(target, GlobalSearchScope.projectScope(project)).findAll().size }
        Handlers.onEdt(timeoutSec = 120) {
            val processor = RenameProcessor(project, target, newName, args.bool("searchInComments"), args.bool("searchTextOccurrences"))
            processor.setPreviewUsages(false)
            processor.run()
            if (args.str("save") != "false") FileDocumentManager.getInstance().saveAllDocuments()
        }
        return mapOf("renamed" to before, "newName" to newName, "referencesUpdated" to usageCount)
    }

    private fun collectFiles(project: Project, args: JsonObject): List<VirtualFile> {
        val max = args.int("maxFiles") ?: 300
        val index = ProjectFileIndex.getInstance(project)
        val roots: List<VirtualFile> = args.getAsJsonArray("paths")?.map { Handlers.file(it.asString) }
            ?: listOfNotNull(project.basePath?.let { Handlers.file(it) })
        val out = LinkedHashSet<VirtualFile>()
        for (root in roots) {
            if (!root.isDirectory) {
                out += root
                continue
            }
            index.iterateContentUnderDirectory(root) { f ->
                if (!f.isDirectory && f.extension?.lowercase() in SOURCE_EXTENSIONS && !index.isExcluded(f) &&
                    !f.path.contains("/build/")
                ) out += f
                out.size < max
            }
        }
        return out.take(max)
    }

    /**
     * Run the IDE's highlighting passes (compiler checks, inspections, Android Lint on-the-fly checks) over many
     * files without opening them, like the pre-commit "Analyze code" check.
     */
    fun projectProblems(args: JsonObject): Any {
        val project = Handlers.project(args)
        Handlers.requireSmart(project)
        val minSeverity = when (args.str("minSeverity")?.lowercase()) {
            "warning" -> HighlightSeverity.WARNING
            "weak_warning" -> HighlightSeverity.WEAK_WARNING
            else -> HighlightSeverity.ERROR
        }
        val files = Handlers.read { collectFiles(project, args) }
        val profile = InspectionProjectProfileManager.getInstance(project).currentProfile
        // runMainPasses needs a progress indicator when called off the EDT (our HTTP threads).
        val results = ProgressManager.getInstance().runProcess<Map<Document, List<HighlightInfo>>>(
            { MainPassesRunner(project, "Analyzing for MCP", profile).runMainPasses(files, minSeverity) },
            ProgressIndicatorBase(), // must be a ProgressIndicatorEx
        )
        val byFile = Handlers.read {
            results.mapNotNull { (doc, infos) ->
                val vf = FileDocumentManager.getInstance().getFile(doc) ?: return@mapNotNull null
                val problems = infos.filter { it.description != null && it.severity >= minSeverity }
                    .map {
                        mapOf(
                            "severity" to it.severity.name,
                            "line" to Handlers.line(doc, it.startOffset),
                            "column" to Handlers.column(doc, it.startOffset),
                            "message" to it.description,
                        )
                    }.distinct()
                if (problems.isEmpty()) null else mapOf("path" to vf.path, "problems" to problems)
            }.sortedBy { it["path"] as String }
        }
        return mapOf(
            "filesAnalyzed" to files.size,
            "filesWithProblems" to byFile.size,
            "problemCount" to byFile.sumOf { (it["problems"] as List<*>).size },
            "files" to byFile,
        )
    }

    /**
     * PNG of the project's IDE window (or just the active editor/preview area), so an agent can see what the
     * user sees: Compose previews, layout editor, tool windows, error balloons.
     */
    fun screenshot(args: JsonObject): Any {
        val project = Handlers.project(args)
        val png = Handlers.onEdt {
            val frame = WindowManager.getInstance().getFrame(project) ?: throw BridgeError("No IDE window for ${project.name}")
            val component = if (args.str("target") == "editor") {
                FileEditorManager.getInstance(project).selectedEditor?.component ?: frame.rootPane
            } else frame.rootPane
            if (component.width <= 0 || component.height <= 0) throw BridgeError("IDE window is minimized")
            val img = BufferedImage(component.width, component.height, BufferedImage.TYPE_INT_RGB)
            val g = img.createGraphics()
            try {
                component.paint(g)
            } finally {
                g.dispose()
            }
            ByteArrayOutputStream().also { ImageIO.write(img, "png", it) }.toByteArray()
        }
        return mapOf("mimeType" to "image/png", "data" to Base64.getEncoder().encodeToString(png))
    }
}
