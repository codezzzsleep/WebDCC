package com.webdcc.android

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

fun obj(vararg fields: Pair<String, Any?>): JSONObject = JSONObject().also { o -> fields.forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) } }
fun JSONObject.str(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
fun JSONObject.items(key: String): List<JSONObject> = optJSONArray(key).objects()
fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }
fun JSONObject.copyJson(): JSONObject = JSONObject(toString())
fun commandId(): String = "android-" + UUID.randomUUID().toString()

data class Project(val id: String, val name: String, val path: String) {
    companion object { fun parse(o: JSONObject) = Project(o.str("id"), o.str("name"), o.str("path")) }
}
data class Task(val id: String, val raw: JSONObject, val feedSeq: Long = 0) {
    val workspaceId get() = raw.str("workspaceId")
    val title get() = raw.str("title").ifBlank { "新任务" }
    val agent get() = raw.str("agent", "codex")
    val status get() = raw.str("status", "idle")
    val lastSeq get() = raw.optLong("lastSeq")
    val model get() = raw.str("model")
    val accessMode get() = raw.str("accessMode")
    val providerId get() = raw.str("providerId")
    val effort get() = raw.str("reasoningEffort")
    val pinned get() = raw.optBoolean("pinned")
    val archived get() = raw.optBoolean("archived")
    val updatedAt get() = raw.str("updatedAt", raw.str("createdAt"))
    fun patch(patch: JSONObject, seq: Long): Task {
        if (seq < feedSeq) return this
        val next = raw.copyJson()
        patch.keys().forEach { next.put(it, patch.get(it)) }
        return copy(raw = next, feedSeq = seq)
    }
}
data class AgentInfo(val id: String, val raw: JSONObject) {
    val installed get() = raw.optBoolean("installed", true)
    val models get() = raw.items("models")
    val modes get() = raw.items("accessModes")
    val label get() = agentLabel(id)
    val reason get() = raw.str("reason").ifBlank { raw.str("note") }
}
data class Provider(val id: String, val raw: JSONObject) {
    val name get() = raw.str("name")
    val models get() = raw.optJSONArray("models").strings()
    val source get() = raw.str("source")
    val protocols get() = raw.optJSONArray("protocols").strings()
    val note get() = raw.str("note")
    fun supports(agent: String) = when (agent) {
        "codex" -> "openai-responses" in protocols
        "claude-code" -> "anthropic-messages" in protocols
        else -> false
    }
    fun modelLabel(id: String) = raw.items("modelDetails").find { it.str("id") == id }?.str("name")?.ifBlank { id } ?: id
    fun efforts(id: String) = raw.items("modelDetails").find { it.str("id") == id }?.optJSONArray("reasoningEfforts").strings()
}
data class Selection(val agent: String = "codex", val providerId: String? = null, val model: String = "", val mode: String = "workspace", val effort: String = "", val explicitModel: Boolean = false)
data class Attachment(val fileId: String, val name: String, val mime: String, val reference: String = "", val localUri: String = "") {
    val isImage get() = mime.startsWith("image/")
    fun json() = obj("fileId" to fileId, "name" to name, "mime" to mime, "reference" to reference)
    companion object { fun parse(o: JSONObject) = Attachment(o.str("fileId"), o.str("name"), o.str("mime"), o.str("reference")) }
}
data class Draft(val text: String = "", val attachments: List<Attachment> = emptyList()) {
    fun json() = obj("text" to text, "attachments" to JSONArray(attachments.map { it.json() }))
    companion object { fun parse(o: JSONObject) = Draft(o.str("text"), o.items("attachments").map { Attachment.parse(it) }) }
}
data class PendingMessage(
    val id: String, val sessionId: String, val text: String, val images: List<String>,
    val at: Long = System.currentTimeMillis(), val status: String = "pending", val error: String = "", val turnId: String = "", val uncertain: Boolean = true
) {
    fun json() = obj("id" to id, "sessionId" to sessionId, "text" to text, "images" to JSONArray(images), "at" to at, "status" to status, "error" to error, "turnId" to turnId, "uncertain" to uncertain)
    companion object { fun parse(o: JSONObject) = PendingMessage(o.str("id"), o.str("sessionId"), o.str("text"), o.optJSONArray("images").strings(), o.optLong("at"), o.str("status"), o.str("error"), o.str("turnId"), o.optBoolean("uncertain", true)) }
}
data class Event(val sessionId: String, val seq: Long, val turnId: String, val key: String, val kind: String, val data: JSONObject, val native: JSONObject = JSONObject(), val at: String = "") {
    fun json() = obj("sessionId" to sessionId, "seq" to seq, "turnId" to turnId.ifBlank { null }, "itemKey" to key, "kind" to kind, "data" to data, "native" to native, "at" to at)
    companion object { fun parse(o: JSONObject, session: String = "") = Event(o.str("sessionId", session), o.optLong("seq"), o.str("turnId"), o.str("itemKey"), o.str("kind"), o.optJSONObject("data") ?: JSONObject(), o.optJSONObject("native") ?: JSONObject(), o.str("at")) }
}
data class ThreadData(val events: List<Event> = emptyList(), val hot: Map<String, Event> = emptyMap(), val loading: Boolean = false, val hasMore: Boolean = false, val error: String = "", val loaded: Boolean = false) {
    val afterSeq get() = events.maxOfOrNull { it.seq } ?: 0
    fun merge(incoming: List<Event>): ThreadData {
        val bySeq = events.associateBy { it.seq }.toMutableMap()
        incoming.forEach { bySeq[it.seq] = it }
        val keys = incoming.map { it.key }.toSet()
        return copy(events = bySeq.values.sortedBy { it.seq }, hot = hot.filterKeys { it !in keys })
    }
}
data class FileChange(val path: String, val kind: String, val added: Int, val removed: Int, val diff: String = "", val diffFileId: String = "", val note: String = "") {
    companion object { fun parse(o: JSONObject) = FileChange(o.str("path"), o.str("kind"), o.optInt("added"), o.optInt("removed"), o.str("diff"), o.str("diffFileId"), o.str("note")) }
}
data class Turn(val id: String, val user: Event?, val state: String, val steps: List<Event>, val live: List<Event>, val answer: List<Event>, val changes: List<FileChange>, val completed: Event?)

/** Port of WebDCC's authoritative turn reducer. Final answers are not guessed from stream order. */
fun reduceTurns(thread: ThreadData): List<Turn> {
    val groups = linkedMapOf<String, MutableList<Event>>()
    thread.events.filter { it.turnId.isNotEmpty() }.forEach { groups.getOrPut(it.turnId) { mutableListOf() }.add(it) }
    thread.hot.values.filter { it.turnId.isNotEmpty() }.forEach { groups.getOrPut(it.turnId) { mutableListOf() } }
    val resolvedApprovals = thread.events.filter { it.kind == "approval.resolved" }.map { it.data.str("approvalId") }.toSet()
    val answered = thread.events.filter { it.kind == "question" && it.data.str("status") in listOf("answered", "skipped") }.map { it.data.str("questionId") }.toSet()
    return groups.map { (id, events) ->
        val hot = thread.hot.values.filter { it.turnId == id }
        val complete = events.lastOrNull { it.kind == "turn.completed" }
        val pending = (events + hot).any { (it.kind == "approval.request" && it.data.str("approvalId") !in resolvedApprovals) || (it.kind == "question" && it.data.str("questionId") !in answered && it.data.str("status") !in listOf("answered", "skipped")) }
        val status = complete?.data?.str("status") ?: if (pending) "waiting" else if (events.any { it.kind == "turn.started" }) "running" else "starting"
        val terminal = complete != null
        val assistants = events.filter { it.kind == "assistant.message" && it.data.str("text").isNotBlank() }
        val answerKeys = complete?.data?.optJSONArray("answerItemKeys")?.strings()
        val answers = if (!terminal) emptyList() else if (answerKeys != null) answerKeys.mapNotNull { key -> assistants.find { it.key == key } } else {
            val result = complete?.native?.str("result").orEmpty()
            val resultMatch = assistants.lastOrNull { result.isNotBlank() && it.data.str("text") == result }
            val explicit = assistants.filter {
                val phase = it.data.str("nativePhase", it.native.str("phase", if (it.data.str("phase") == "final") "final_answer" else ""))
                val stop = it.native.str("stop_reason", it.native.optJSONObject("message")?.str("stop_reason") ?: "")
                it.native.items("questions").isEmpty() && (phase in listOf("final_answer", "partial_answer", "final_result") || (stop.isNotEmpty() && stop != "tool_use"))
            }
            val actionIndex = events.indexOfLast { it.kind in setOf("command", "file.read", "file.change", "turn.diff", "tool.call", "approval.request", "question") }
            when {
                resultMatch != null -> listOf(resultMatch)
                result.isNotBlank() && assistants.any { it.data.str("nativePhase") == "final_result" } -> listOf(assistants.last { it.data.str("nativePhase") == "final_result" })
                explicit.isNotEmpty() -> explicit
                else -> assistants.filter { events.indexOf(it) > actionIndex }.ifEmpty { assistants.takeLast(1) }
            }
        }
        val cumulative = (events + hot).lastOrNull { it.kind == "turn.diff" }
        val changeSources = if (cumulative != null) listOf(cumulative) else (events + hot).filter { it.kind == "file.change" }
        val changes = linkedMapOf<String, FileChange>()
        changeSources.forEach { e -> e.data.items("changes").map { FileChange.parse(it) }.forEach { changes[it.path] = it } }
        Turn(id, events.find { it.kind == "user.message" }, status,
            events.filter { it.kind !in setOf("user.message", "turn.started", "turn.completed", "internal") }, if (terminal) emptyList() else hot,
            answers, changes.values.toList(), complete)
    }
}
fun pendingRequests(thread: ThreadData): List<Event> {
    val resolved = thread.events.filter { it.kind == "approval.resolved" }.map { it.data.str("approvalId") }.toSet()
    val answered = thread.events.filter { it.kind == "question" && it.data.str("status") in setOf("answered", "skipped") }.map { it.data.str("questionId") }.toSet()
    val completed = thread.events.filter { it.kind == "turn.completed" }.map { it.turnId }.toSet()
    return (thread.events + thread.hot.values).filter { e ->
        e.turnId !in completed && when (e.kind) {
            "approval.request" -> e.data.str("approvalId") !in resolved
            "question" -> e.data.str("questionId") !in answered && e.data.str("status") !in setOf("answered", "skipped")
            else -> false
        }
    }.distinctBy { it.kind + it.data.str(if (it.kind == "question") "questionId" else "approvalId") }
}
fun agentLabel(id: String) = when (id) { "codex" -> "Codex"; "claude-code" -> "Claude Code"; "dsh" -> "DSH"; else -> id }
fun modeLabel(mode: String) = when (mode.removePrefix(":")) { "workspace", "workspace-write" -> "编辑项目 · 需要时询问"; "default" -> "标准权限 · 需要时询问"; "read-only", "plan" -> "只读 / 规划"; "workspace-auto" -> "编辑项目 · 自动审核"; "danger-full-access", "bypassPermissions" -> "完全访问"; else -> mode.ifBlank { "默认权限" } }
data class Viewer(val title: String, val content: String = "", val loading: Boolean = false, val error: String = "", val path: String = "", val changes: List<FileChange> = emptyList(), val selected: Int = 0, val diffMode: Boolean = false, val returnRoute: String = "chat")
data class AppState(
    val route: String = "connect", val address: String = "", val connection: String = "connecting", val connectionError: String = "", val binding: Boolean = false,
    val projects: List<Project> = emptyList(), val tasks: Map<String, Task> = emptyMap(), val agents: List<AgentInfo> = emptyList(), val providers: List<Provider> = emptyList(), val root: Boolean = false,
    val projectId: String = "", val sessionId: String = "", val selection: Selection = Selection(), val threads: Map<String, ThreadData> = emptyMap(),
    val drafts: Map<String, Draft> = emptyMap(), val pending: List<PendingMessage> = emptyList(), val creating: Boolean = false, val uploading: Boolean = false, val uploadProgress: String = "",
    val busyActions: Set<String> = emptySet(), val actionError: String = "", val notice: String = "", val viewer: Viewer? = null, val refresh: Boolean = false,
    val archiveFilter: Boolean = false, val launchText: String = "", val viewerTrail: List<Viewer> = emptyList(), val scrollRequests: Map<String, Long> = emptyMap(), val dshSettings: JSONObject? = null
) {
    val project get() = projects.find { it.id == projectId }
    val task get() = tasks[sessionId]
    val thread get() = threads[sessionId] ?: ThreadData()
    val draftKey get() = if (route == "new") "new:$projectId" else "session:$sessionId"
    val draft get() = drafts[draftKey] ?: Draft()
    val live get() = task?.status in setOf("running", "waiting") || reduceTurns(thread).lastOrNull()?.state in setOf("running", "waiting", "starting")
}
