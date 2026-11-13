package com.webdcc.android

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest

class MobileViewModel(app: Application) : AndroidViewModel(app) {
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state
    private val preferences = app.getSharedPreferences("appearance", Application.MODE_PRIVATE)
    private val _themeMode = MutableStateFlow(ThemeMode.parse(preferences.getString("theme_mode", null)))
    val themeMode: StateFlow<ThemeMode> = _themeMode
    private val effortPreferences = mutableMapOf<String, String>()
    private val vault = ConnectionVault(app)
    private val local = LocalStore(app)
    private var api: MobileApi? = null
    private var socket: WebSocket? = null
    private var reconnect: Job? = null
    private var saveJob: Job? = null
    private var draftJob: Job? = null
    private var foreground = true
    private var epoch = 0
    private var feedAfter = 0L
    private var retryCount = 0
    private val sends = Mutex()
    private val writes = Mutex()
    private val loads = mutableSetOf<String>()
    private val clientId = commandId()
    private var creation: JSONObject? = null
    private val actionCommands = mutableMapOf<String, JSONObject>()

    init {
        val cookie = vault.cookie()
        val address = vault.address()
        if (!cookie.isNullOrBlank() && address.isNotBlank()) {
            api = MobileApi(address, cookie)
            local.useServer(api!!.origin)
            restore()
            _state.update { it.copy(address = api!!.origin, route = "home", connection = "connecting") }
            viewModelScope.launch { refreshAll(); openSocket() }
        } else _state.update { it.copy(connection = "unbound") }
    }
    private fun restore() {
        val saved = local.read()
        effortPreferences.clear()
        saved.optJSONObject("effortPreferences")?.let { o -> o.keys().forEach { effortPreferences[it] = o.str(it) } }
        feedAfter = saved.optLong("feedAfter")
        creation = saved.optJSONObject("creation")
        val threads = saved.items("threads").associate { row ->
            row.str("sessionId") to ThreadData(events = row.items("events").map { Event.parse(it) }, hasMore = row.optBoolean("hasMore"), loaded = false)
        }
        val drafts = saved.optJSONObject("drafts")?.let { o -> o.keys().asSequence().associateWith { Draft.parse(o.getJSONObject(it)) } } ?: emptyMap()
        val selection = saved.optJSONObject("selection")
        _state.update { it.copy(
            projects = saved.items("projects").map { Project.parse(it) },
            tasks = saved.items("tasks").map { Task(it.str("id"), it.getJSONObject("raw"), it.optLong("feedSeq")) }.associateBy { it.id },
            threads = threads, drafts = drafts, pending = saved.items("pending").map { PendingMessage.parse(it) }.map { p -> if (p.status == "sending") p.copy(status = "pending") else p },
            projectId = saved.str("projectId"), selection = if (selection == null) Selection() else Selection(selection.str("agent", "codex"), selection.str("providerId").ifBlank { null }, selection.str("model"), selection.str("mode", "workspace"), selection.str("effort"), selection.optBoolean("explicitModel"))
        ) }
    }
    private fun save(immediate: Boolean = false) {
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            if (!immediate) delay(250)
            val data = snapshotData()
            val key = local.currentKey()
            writes.withLock { withContext(Dispatchers.IO) { local.write(data, key) } }
        }
    }
    private fun snapshotData(): JSONObject {
            val s = _state.value
            val draftJson = JSONObject().also { o -> s.drafts.forEach { (k, v) -> o.put(k, v.json()) } }
            val data = obj("feedAfter" to feedAfter, "projectId" to s.projectId, "effortPreferences" to JSONObject(effortPreferences as Map<*, *>),
                "projects" to JSONArray(s.projects.map { obj("id" to it.id, "name" to it.name, "path" to it.path) }),
                "tasks" to JSONArray(s.tasks.values.map { obj("id" to it.id, "raw" to it.raw, "feedSeq" to it.feedSeq) }),
                "drafts" to draftJson, "pending" to JSONArray(s.pending.map { it.json() }), "creation" to creation,
                "selection" to obj("agent" to s.selection.agent, "providerId" to s.selection.providerId, "model" to s.selection.model, "mode" to s.selection.mode, "effort" to s.selection.effort, "explicitModel" to s.selection.explicitModel),
                "threads" to JSONArray(s.threads.entries.toList().takeLast(8).map { (id, thread) -> obj("sessionId" to id, "hasMore" to (thread.hasMore || thread.events.size > 4000), "events" to JSONArray(thread.events.takeLast(4000).map { it.json() })) }))
            return data
    }
    private suspend fun persistBeforeSending() {
        saveJob?.cancel()
        val data = snapshotData()
        val key = local.currentKey()
        val stored = writes.withLock { withContext(Dispatchers.IO) { local.write(data, key) } }
        if (!stored) throw ApiError("无法保存待发送消息，请检查手机存储后重试。", "storage")
    }
    fun setForeground(active: Boolean) {
        foreground = active
        if (active) {
            if (api != null && socket == null) { viewModelScope.launch { refreshAll(); openSocket() } }
        } else {
            reconnect?.cancel(); socket?.close(1000, "background"); socket = null; save(true)
        }
    }
    fun handleIncoming(text: String) {
        if (text.isBlank()) return
        _state.update { it.copy(route = "connect", launchText = text, connectionError = "", actionError = "") }
        val link = runCatching { LaunchLink.fromText(text) }.getOrNull()
        if (link != null && !link.isLocalAddress) bind(text)
    }
    fun showConnection() { _state.update { it.copy(route = "connect", launchText = "", actionError = "") } }
    fun bind(text: String, override: String = "") {
        if (_state.value.binding) return
        val link = try {
            val parsed = LaunchLink.fromText(text)
            if (parsed.isLocalAddress && override.isBlank()) throw ApiError("链接指向电脑本机。请在下方填写这台电脑的局域网 IP 或可访问的服务地址。")
            if (override.isNotBlank()) parsed.withServerAddress(override) else parsed
        } catch (e: Exception) { _state.update { it.copy(connectionError = e.message ?: "请复制完整 token 链接。") }; return }
        _state.update { it.copy(binding = true, connectionError = "") }
        val generation = ++epoch
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { SessionAuth.bind(link) }
                if (generation != epoch) return@launch
                withContext(Dispatchers.IO) { vault.save(result) }
                socket?.cancel(); socket = null; reconnect?.cancel(); saveJob?.cancel(); draftJob?.cancel()
                api = MobileApi(result.cleanUrl, result.cookieHeader)
                local.useServer(api!!.origin)
                feedAfter = 0; creation = null; loads.clear(); actionCommands.clear()
                _state.value = AppState(route = "home", address = api!!.origin, connection = "connecting")
                restore()
                _state.update { it.copy(route = "home", address = api!!.origin, binding = false, launchText = "", notice = "已绑定服务器") }
                refreshAll(); openSocket()
            } catch (e: Exception) {
                if (generation == epoch) _state.update { it.copy(binding = false, connectionError = e.message ?: "绑定失败，请检查服务地址。") }
            }
        }
    }
    fun retryConnection() { viewModelScope.launch { reconnect?.cancel(); refreshAll(); openSocket() } }
    private fun failure(e: Exception) {
        if (e is CancellationException) throw e
        if (e is ApiError && e.code == "auth") {
            socket?.cancel(); socket = null; reconnect?.cancel()
            _state.update { it.copy(connection = "expired", connectionError = e.message.orEmpty()) }
        } else {
            _state.update { it.copy(connection = "offline", connectionError = e.message ?: "连接中断") }
        }
    }
    fun refresh() { viewModelScope.launch { refreshAll(); if (_state.value.route == "chat") loadThread(_state.value.sessionId, force = true); if (socket == null) openSocket() } }
    private suspend fun refreshAll() {
        val active = api ?: return
        val generation = epoch
        _state.update { it.copy(refresh = true) }
        try {
            val (projects, meta, providers) = coroutineScope {
                val p = async { active.json("/api/workspaces") as JSONArray }
                val m = async { active.json("/api/meta") as JSONObject }
                val v = async { active.json("/api/providers") as JSONArray }
                Triple(p.await(), m.await(), v.await())
            }
            if (generation != epoch) return
            val ps = projects.objects().map { Project.parse(it) }
            val agentsObject = meta.optJSONObject("agents") ?: JSONObject()
            val agents = agentsObject.keys().asSequence().map { AgentInfo(it, agentsObject.getJSONObject(it)) }.toList().sortedBy { listOf("codex", "claude-code", "dsh").indexOf(it.id) }
            _state.update { s -> s.copy(projects = ps, agents = agents, providers = providers.objects().map { Provider(it.str("id"), it) }, root = meta.optBoolean("runningAsRoot"),
                projectId = s.projectId.takeIf { id -> ps.any { it.id == id } } ?: ps.firstOrNull()?.id.orEmpty(), connectionError = "") }
            normalizeSelection()
            var cursor = feedAfter
            // REST catches up before WS hello; per-session sequence checks reject stale REST patches.
            while (true) {
                val page = active.json("/api/feed?after=$cursor") as JSONObject
                if (generation != epoch) return
                val entries = page.items("entries")
                entries.forEach { applyFeed(it) }
                val next = entries.maxOfOrNull { it.optLong("feedSeq") } ?: cursor
                if (entries.size < 1000 || next <= cursor) break
                cursor = next
            }
            _state.update { it.copy(connection = if (socket != null) "online" else "connecting", refresh = false) }
            save()
        } catch (e: Exception) { if (generation == epoch) { failure(e); _state.update { it.copy(refresh = false) } } }
    }
    private fun applyFeed(o: JSONObject) {
        val id = o.str("sessionId")
        if (id.isBlank()) return
        val seq = o.optLong("feedSeq")
        val patch = o.optJSONObject("patch") ?: return
        _state.update { s ->
            val task = (s.tasks[id] ?: Task(id, obj("id" to id))).patch(patch, seq)
            s.copy(tasks = s.tasks + (id to task))
        }
        feedAfter = maxOf(feedAfter, seq)
    }
    private fun openSocket() {
        if (!foreground || socket != null || _state.value.connection == "expired") return
        val active = api ?: return
        val generation = epoch
        val wsRequest = active.request("/api/ws").url(active.origin.replaceFirst("http", "ws") + "/api/ws").build()
        socket = active.client.newWebSocket(wsRequest, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { viewModelScope.launch {
                if (generation != epoch || !foreground) { webSocket.cancel(); return@launch }
                socket = webSocket; retryCount = 0
                _state.update { it.copy(connection = "online", connectionError = "") }
                val s = _state.value
                val subscriptions = if (s.sessionId.isNotBlank() && s.threads[s.sessionId]?.loaded == true) listOf(obj("sessionId" to s.sessionId, "afterSeq" to s.thread.afterSeq)) else emptyList()
                webSocket.send(obj("op" to "hello", "clientId" to clientId, "feedAfter" to feedAfter, "subscribe" to JSONArray(subscriptions)).toString())
                flushPending()
            } }
            override fun onMessage(webSocket: WebSocket, text: String) { viewModelScope.launch {
                if (generation != epoch || socket !== webSocket) return@launch
                runCatching { handleFrame(JSONObject(text)) }.onFailure { _state.update { it.copy(notice = "有一条实时更新未能读取，正在重新同步") }; if (_state.value.sessionId.isNotEmpty()) loadThread(_state.value.sessionId, force = true) }
            } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { viewModelScope.launch {
                if (generation != epoch || socket !== webSocket) return@launch
                socket = null
                if (response?.code in listOf(401, 403)) failure(ApiError("登录已过期，请重新绑定。", "auth")) else scheduleReconnect()
            } }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { viewModelScope.launch {
                if (generation == epoch && socket === webSocket) { socket = null; if (foreground) scheduleReconnect() }
            } }
        })
    }
    private fun scheduleReconnect() {
        if (!foreground || _state.value.connection == "expired") return
        _state.update { it.copy(connection = "offline", connectionError = "实时连接已断开；任务仍在电脑上继续。") }
        reconnect?.cancel()
        reconnect = viewModelScope.launch {
            delay(minOf(20000L, 1200L * (1 shl minOf(retryCount++, 4))))
            refreshAll(); openSocket()
        }
    }
    private fun handleFrame(o: JSONObject) {
        when (o.str("op")) {
            "ping" -> socket?.send(obj("op" to "pong").toString())
            "feed" -> { applyFeed(o); save() }
            "event" -> {
                val event = Event.parse(o.getJSONObject("event"))
                updateThread(event.sessionId) { it.merge(listOf(event)) }
                if (event.kind == "user.message") _state.update { s -> s.copy(pending = s.pending.filterNot { p -> p.id == event.data.str("clientCommandId") || (p.turnId.isNotBlank() && p.turnId == event.turnId) }) }
                save()
            }
            "snapshot" -> {
                val id = o.str("sessionId")
                val items = o.items("items").map { Event.parse(it, id) }
                updateThread(id) { thread ->
                    val persisted = thread.events.map { it.key }.toSet()
                    thread.copy(hot = items.filter { it.key !in persisted }.associateBy { it.key })
                }
            }
            "update" -> {
                val id = o.str("sessionId"); val key = o.str("itemKey")
                val payload = o.optJSONObject("data") ?: return
                updateThread(id) { thread ->
                    if (thread.events.any { it.key == key }) thread else {
                        val old = thread.hot[key]
                        val item = if (payload.optBoolean("started")) Event(id, 0, o.str("turnId", payload.str("turnId")), key, payload.str("kind"), payload.optJSONObject("data") ?: JSONObject())
                            else old?.copy(data = payload, turnId = o.str("turnId", old.turnId))
                        if (item == null) thread else thread.copy(hot = thread.hot + (key to item))
                    }
                }
            }
            "delta" -> {
                val id = o.str("sessionId"); val key = o.str("itemKey")
                updateThread(id) { thread ->
                    val old = thread.hot[key]
                    if (old == null) thread else {
                        val field = if (o.str("field") == "output") "outputTail" else "text"
                        val data = old.data.copyJson().put(field, old.data.str(field) + o.str("append"))
                        thread.copy(hot = thread.hot + (key to old.copy(data = data)))
                    }
                }
            }
        }
    }
    private fun updateThread(id: String, block: (ThreadData) -> ThreadData) { _state.update { s -> s.copy(threads = s.threads + (id to block(s.threads[id] ?: ThreadData()))) } }
    fun openTask(id: String) {
        val old = _state.value.sessionId
        if (old.isNotBlank() && old != id) socket?.send(obj("op" to "unsubscribe", "sessionIds" to JSONArray(listOf(old))).toString())
        val task = _state.value.tasks[id]
        _state.update { it.copy(route = "chat", sessionId = id, projectId = task?.workspaceId ?: it.projectId, viewer = null, actionError = "") }
        viewModelScope.launch { loadThread(id) }
    }
    private suspend fun loadThread(id: String, force: Boolean = false, older: Boolean = false) {
        val active = api ?: return
        if (id.isBlank() || !loads.add(id)) return
        val generation = epoch
        val before = if (older) _state.value.threads[id]?.events?.minOfOrNull { it.seq } else null
        updateThread(id) { it.copy(loading = true, error = "") }
        try {
            val detail = if (!older) active.json("/api/sessions/${enc(id)}") as JSONObject else null
            val upper = detail?.optLong("lastSeq") ?: 0L
            val page = active.json("/api/sessions/${enc(id)}/events?limit=100&before=${before ?: (upper + 1)}") as JSONObject
            if (generation != epoch) return
            val events = page.items("events").map { Event.parse(it) }
            updateThread(id) { thread ->
                var next = thread.merge(events).copy(loading = false, error = "", loaded = true, hasMore = if (older || thread.events.isEmpty() || force) page.optBoolean("hasMore") else thread.hasMore)
                if (detail != null && thread.hot.isEmpty()) next = next.copy(hot = detail.items("snapshot").map { Event.parse(it, id) }.filter { item -> next.events.none { it.key == item.key } }.associateBy { it.key })
                next
            }
            if (detail != null) _state.update { s ->
                // REST detail must never overwrite newer feed changes.
                val existing = s.tasks[id]
                val base = detail.copyJson().also { it.remove("snapshot") }
                val merged = if (existing == null) Task(id, base) else Task(id, base, existing.feedSeq).patch(existing.raw, existing.feedSeq)
                s.copy(tasks = s.tasks + (id to merged), pending = s.pending.filterNot { p -> p.sessionId == id && events.any { it.kind == "user.message" && (it.data.str("clientCommandId") == p.id || (p.turnId.isNotBlank() && it.turnId == p.turnId)) } })
            }
            if (!older) socket?.send(obj("op" to "subscribe", "subscribe" to JSONArray(listOf(obj("sessionId" to id, "afterSeq" to upper)))).toString())
            if (!_state.value.drafts.containsKey("session:$id")) {
                val remote = runCatching { active.json("/api/sessions/${enc(id)}/draft") as JSONObject }.getOrNull()
                if (remote != null && remote.str("text").isNotBlank()) _state.update { s -> if (s.drafts.containsKey("session:$id")) s else s.copy(drafts = s.drafts + ("session:$id" to Draft(remote.str("text")))) }
            }
            save()
        } catch (e: Exception) {
            if (generation == epoch) { updateThread(id) { it.copy(loading = false, error = e.message ?: "对话加载失败") }; if (e is ApiError && e.code == "auth") failure(e) }
        } finally { loads.remove(id) }
    }
    fun loadOlder() { val id = _state.value.sessionId; viewModelScope.launch { loadThread(id, older = true) } }
    fun back() {
        val s = _state.value
        if (s.viewer != null) {
            _state.update { if (s.viewerTrail.isNotEmpty()) it.copy(viewer = s.viewerTrail.last(), viewerTrail = s.viewerTrail.dropLast(1)) else it.copy(viewer = null, route = s.viewer.returnRoute) }
            return
        }
        if (s.route == "connect" && api != null) _state.update { it.copy(route = "home", connectionError = "") }
        else _state.update { it.copy(route = "home", actionError = "") }
    }
    fun newTask() { _state.update { it.copy(route = "new", sessionId = "", viewer = null, actionError = "") }; normalizeSelection(); save() }
    fun selectProject(id: String) { _state.update { it.copy(projectId = id) }; save() }
    fun setArchiveFilter(value: Boolean) { _state.update { it.copy(archiveFilter = value) } }
    fun setTheme(mode: ThemeMode) { preferences.edit().putString("theme_mode", mode.id).apply(); _themeMode.value = mode }
    private fun normalizeSelection(agentOverride: String? = null) {
        val s = _state.value
        val agent = agentOverride ?: s.selection.agent.takeIf { a -> s.agents.any { it.id == a && it.installed } } ?: s.agents.firstOrNull { it.installed }?.id ?: "codex"
        val providers = s.providers.filter { it.supports(agent) && it.models.isNotEmpty() }
        val remembered = s.selection.takeIf { it.agent == agent }
        val provider = if (remembered?.explicitModel == true && remembered.providerId == null) {
            null
        } else {
            providers.find { it.id == remembered?.providerId }
                ?: providers.find { it.source == (if (agent == "codex") "codex-config" else "claude-settings") }
                ?: providers.firstOrNull()
        }
        val nativeModels = s.agents.find { it.id == agent }?.models.orEmpty().map { it.str("id") }
        val models = provider?.models ?: nativeModels
        val model = remembered?.model?.takeIf { it in models || (remembered.explicitModel && remembered.providerId == provider?.id && it.isNotBlank()) } ?: models.firstOrNull().orEmpty()
        val modes = s.agents.find { it.id == agent }?.modes.orEmpty().map { it.str("id") }
        val preferred = when (agent) { "codex" -> "workspace"; "claude-code" -> "default"; else -> "workspace-write" }
        val mode = remembered?.mode?.takeIf { it in modes } ?: modes.find { it.removePrefix(":") == preferred } ?: modes.firstOrNull().orEmpty()
        val choices = s.reasoningFor(agent, provider?.id, model)
        val effort = preservedEffort(choices, effortPreferences[agent].orEmpty(), remembered?.effort.orEmpty())
        _state.update { it.copy(selection = Selection(agent, provider?.id, model, mode, effort, remembered?.explicitModel == true && remembered.providerId == provider?.id)) }
    }
    fun selectAgent(id: String) { normalizeSelection(id); save() }
    fun selectModel(provider: String?, model: String) {
        val s = _state.value
        if (s.route == "new") {
            val effort = preservedEffort(s.reasoningFor(s.selection.agent, provider, model), s.selection.effort, effortPreferences[s.selection.agent].orEmpty())
            _state.update { it.copy(selection = it.selection.copy(providerId = provider, model = model, effort = effort, explicitModel = true)) }; save()
        }
        else if (provider == s.task?.providerId.orEmpty().ifBlank { null }) {
            val task = s.task ?: return
            val choices = s.reasoningFor(task.agent, provider, model)
            val nextEffort = preservedEffort(choices, task.effort, effortPreferences[task.agent].orEmpty())
            perform("model", obj("op" to "set-model", "sessionId" to s.sessionId, "model" to model)) {
                if (task.effort.isNotBlank() && task.effort !in choices.values && nextEffort.isNotBlank()) {
                    perform("effort:${s.sessionId}", obj("op" to "set-reasoning-effort", "sessionId" to s.sessionId, "reasoningEffort" to nextEffort)) {
                        effortPreferences[task.agent] = nextEffort; save()
                    }
                }
            }
        }
    }
    fun selectMode(mode: String) {
        val s = _state.value
        if (s.route == "new") { _state.update { it.copy(selection = it.selection.copy(mode = mode)) }; save() }
        else perform("mode", obj("op" to "set-access-mode", "sessionId" to s.sessionId, "accessMode" to mode))
    }
    fun selectEffort(effort: String) {
        val s = _state.value
        if (effort !in s.currentReasoningChoices().values) { _state.update { it.copy(actionError = "这个模型没有提供该思考等级，请重新选择。") }; return }
        val agent = if (s.route == "new") s.selection.agent else s.task?.agent.orEmpty()
        if (s.route == "new") { effortPreferences[agent] = effort; _state.update { it.copy(selection = it.selection.copy(effort = effort)) }; save() }
        else perform("effort:${s.sessionId}", obj("op" to "set-reasoning-effort", "sessionId" to s.sessionId, "reasoningEffort" to effort)) {
            effortPreferences[agent] = effort; save()
        }
    }
    suspend fun refreshReasoningMetadata() {
        val active = api ?: throw ApiError("请先连接服务器。")
        val generation = epoch
        val config = active.json("/api/dsh/provider") as JSONObject
        if (generation != epoch) return
        _state.update { it.copy(dshSettings = config) }
        if (_state.value.route == "new" && _state.value.selection.agent == "dsh") normalizeSelection()
    }
    fun editDraft(text: String) { val key = _state.value.draftKey; _state.update { it.copy(drafts = it.drafts + (key to (it.drafts[key] ?: Draft()).copy(text = text))) }; save(); syncDraft(key) }
    fun insertReference(path: String) { val old = _state.value.draft.text; editDraft(old + (if (old.isBlank() || old.endsWith("\n") || old.endsWith(" ")) "" else " ") + "@$path ") }
    fun removeAttachment(fileId: String) {
        val key = _state.value.draftKey
        _state.update { s ->
            val removed = s.draft.attachments.find { it.fileId == fileId }
            val text = if (removed?.reference?.isNotBlank() == true) s.draft.text.replace("@${removed.reference} ", "") else s.draft.text
            s.copy(drafts = s.drafts + (key to s.draft.copy(text = text, attachments = s.draft.attachments.filterNot { it.fileId == fileId })))
        }
        save(); syncDraft(key)
    }
    private fun syncDraft(key: String) {
        if (!key.startsWith("session:")) return
        draftJob?.cancel()
        draftJob = viewModelScope.launch {
            delay(800)
            val d = _state.value.drafts[key] ?: Draft()
            runCatching { api?.json("/api/sessions/${enc(key.removePrefix("session:"))}/draft", "PUT", obj("text" to d.text, "fileIds" to JSONArray(d.attachments.map { it.fileId }))) }
        }
    }
    fun send() {
        val s = _state.value
        if (s.creating || s.uploading || (s.draft.text.isBlank() && s.draft.attachments.none { it.isImage })) return
        if (s.route == "new") createAndSend(s) else enqueue(s.sessionId, s.draft, s.draftKey)
    }
    private fun createAndSend(s: AppState) {
        val active = api ?: return
        if (s.projectId.isBlank()) { _state.update { it.copy(actionError = "先选择或添加一个电脑上的项目。") }; return }
        if (s.connection != "online") { _state.update { it.copy(actionError = "连接恢复后即可创建任务；输入已保存在手机上。") }; return }
        if (s.agents.find { it.id == s.selection.agent }?.installed == false) { _state.update { it.copy(actionError = "电脑上尚未安装 ${agentLabel(s.selection.agent)}，请切换 Agent 或在电脑上安装。") }; return }
        if (s.selection.providerId != null && s.selection.model.isBlank()) { _state.update { it.copy(actionError = "请先选择一个可用模型。") }; return }
        _state.update { it.copy(creating = true, actionError = "") }
        val selection = s.selection
        val create = obj("op" to "create-session", "workspaceId" to s.projectId, "agent" to selection.agent, "providerId" to selection.providerId)
        if (selection.model.isNotBlank()) create.put("model", selection.model)
        if (selection.mode.isNotBlank()) create.put("accessMode", selection.mode)
        if (selection.effort.isNotBlank()) create.put("reasoningEffort", selection.effort)
        val signature = create.toString()
        val existing = creation?.takeIf { it.str("signature") == signature }
        val id = existing?.str("id") ?: commandId()
        creation = obj("signature" to signature, "id" to id)
        save(true)
        create.put("clientCommandId", id)
        val generation = epoch
        viewModelScope.launch {
            try {
                persistBeforeSending()
                val result = active.command(create)
                if (generation != epoch) return@launch
                val sessionId = result.str("sessionId")
                if (sessionId.isBlank()) throw ApiError("服务没有返回任务编号，请重试。")
                val raw = obj("id" to sessionId, "workspaceId" to s.projectId, "agent" to selection.agent, "providerId" to selection.providerId, "model" to selection.model, "accessMode" to selection.mode, "reasoningEffort" to selection.effort, "status" to "idle", "title" to s.draft.text.lineSequence().first().take(50))
                creation = null
                _state.update { current ->
                    val stillComposing = current.route == "new" && current.projectId == s.projectId
                    current.copy(creating = false, route = if (stillComposing) "chat" else current.route, sessionId = if (stillComposing) sessionId else current.sessionId, projectId = if (stillComposing) s.projectId else current.projectId, tasks = if (current.tasks.containsKey(sessionId)) current.tasks else current.tasks + (sessionId to Task(sessionId, raw)))
                }
                enqueue(sessionId, s.draft, s.draftKey)
                loadThread(sessionId)
            } catch (e: Exception) {
                if (generation == epoch) {
                    if (e is ApiError && !e.uncertain) creation = null
                    _state.update { it.copy(creating = false, actionError = e.message ?: "任务创建失败，输入仍然保留。") }
                    if (e is ApiError && e.code == "auth") failure(e)
                    save(true)
                }
            }
        }
    }
    private fun enqueue(session: String, draft: Draft, draftKey: String) {
        if (session.isBlank()) return
        val pending = PendingMessage(commandId(), session, draft.text, draft.attachments.filter { it.isImage }.map { it.fileId })
        _state.update { s -> s.copy(pending = s.pending + pending, drafts = if (s.drafts[draftKey] == draft) s.drafts + (draftKey to Draft()) else s.drafts, actionError = "", scrollRequests = s.scrollRequests + (session to ((s.scrollRequests[session] ?: 0L) + 1))) }
        save(true); syncDraft(draftKey); flushPending()
    }
    private fun flushPending() { viewModelScope.launch { sends.withLock {
        while (_state.value.connection == "online") {
            val p = _state.value.pending.firstOrNull { it.status == "pending" } ?: break
            val active = api ?: break
            val generation = epoch
            _state.update { s -> s.copy(pending = s.pending.map { if (it.id == p.id) it.copy(status = "sending", error = "") else it }) }; save(true)
            try {
                persistBeforeSending()
                val result = active.command(obj("op" to "send", "clientCommandId" to p.id, "sessionId" to p.sessionId, "text" to p.text, "images" to JSONArray(p.images)))
                if (generation != epoch) break
                _state.update { s -> s.copy(pending = s.pending.map { if (it.id == p.id) it.copy(status = if (result.optBoolean("queued")) "queued" else "sent", turnId = result.str("turnId")) else it }) }
                // Backfill also reconciles an ack whose event arrived before the local optimistic row.
                loadThread(p.sessionId, force = true)
            } catch (e: Exception) {
                if (generation != epoch) break
                _state.update { s -> s.copy(pending = s.pending.map { if (it.id == p.id) it.copy(status = "failed", error = e.message.orEmpty(), uncertain = (e as? ApiError)?.uncertain ?: true) else it }) }
                if (e is ApiError && e.code == "auth") failure(e)
            }
            save(true)
        }
    } } }
    fun retryMessage(id: String) {
        _state.update { s -> s.copy(pending = s.pending.map { if (it.id == id) it.copy(id = if (it.uncertain) it.id else commandId(), status = "pending", error = "") else it }) }
        save(true); flushPending()
    }
    fun cancelPending(id: String) { _state.update { s -> s.copy(pending = s.pending.filterNot { it.id == id && it.status == "pending" }) }; save(true) }
    fun restoreFailed(id: String) {
        val p = _state.value.pending.find { it.id == id && it.status == "failed" } ?: return
        val key = "session:${p.sessionId}"
        _state.update { s -> s.copy(drafts = s.drafts + (key to Draft(p.text + if ((s.drafts[key]?.text ?: "").isNotBlank()) "\n" + s.drafts[key]!!.text else ""))) }
        // The failed row remains: an uncertain delivery can still arrive later, and retains its idempotency key.
        save(true)
    }
    fun stop() { val id = _state.value.sessionId; perform("stop:$id", obj("op" to "interrupt", "sessionId" to id, "createdAt" to System.currentTimeMillis())) }
    fun approve(event: Event, optionId: String) { perform("approval:${event.data.str("approvalId")}", obj("op" to "approve", "sessionId" to event.sessionId, "approvalId" to event.data.str("approvalId"), "optionId" to optionId)) }
    fun answer(event: Event, selected: List<String>, custom: String) { perform("question:${event.data.str("questionId")}", obj("op" to "answer", "sessionId" to event.sessionId, "questionId" to event.data.str("questionId"), "answer" to obj("selected" to JSONArray(selected), "custom" to custom))) }
    private fun perform(key: String, cmd: JSONObject, onSuccess: () -> Unit = {}) {
        if (key in _state.value.busyActions) return
        val active = api ?: return
        val signature = cmd.toString()
        val previous = actionCommands[key]
        val command = if (previous?.str("signature") == signature) previous.getJSONObject("command") else cmd.copyJson().put("clientCommandId", commandId()).also { actionCommands[key] = obj("signature" to signature, "command" to it) }
        _state.update { it.copy(busyActions = it.busyActions + key, actionError = "") }
        val generation = epoch
        viewModelScope.launch {
            try {
                active.command(command)
                if (generation != epoch) return@launch
                onSuccess()
                actionCommands.remove(key)
                _state.update { it.copy(notice = when { key.startsWith("stop:") -> "已请求停止"; key.startsWith("approval:") -> "已提交审批选择"; key.startsWith("question:") -> "已发送回答"; else -> "已更新" }) }
                if (cmd.str("sessionId").isNotBlank()) loadThread(cmd.str("sessionId"), force = true)
                refreshAll()
            } catch (e: Exception) {
                if (generation == epoch) {
                    if (e is ApiError && e.code == "already-resolved") { _state.update { it.copy(notice = "这条请求已在其他端处理") }; loadThread(cmd.str("sessionId"), force = true) }
                    else _state.update { it.copy(actionError = e.message ?: "操作失败，请重试。") }
                    if (e is ApiError && e.code == "auth") failure(e)
                    if (e is ApiError && !e.uncertain) actionCommands.remove(key)
                }
            } finally { if (generation == epoch) _state.update { it.copy(busyActions = it.busyActions - key) } }
        }
    }
    fun rename(title: String) { val id = _state.value.sessionId; if (title.isNotBlank()) perform("rename", obj("op" to "rename", "sessionId" to id, "title" to title.trim())) }
    fun togglePin() { val s = _state.value; perform("pin", obj("op" to "pin", "sessionId" to s.sessionId, "pinned" to !(s.task?.pinned ?: false))) }
    fun toggleArchive() { val s = _state.value; perform("archive", obj("op" to "archive", "sessionId" to s.sessionId, "archived" to !(s.task?.archived ?: false))) }
    fun clearError() { _state.update { it.copy(actionError = "") } }
    fun clearNotice() { _state.update { it.copy(notice = "") } }
    suspend fun browse(path: String): JSONObject = (api ?: throw ApiError("请先连接服务器。")).json("/api/fs/browse?path=${enc(path)}") as JSONObject
    suspend fun projectFiles(path: String): JSONObject {
        val id = _state.value.task?.workspaceId ?: _state.value.projectId
        return (api ?: throw ApiError("请先连接服务器。")).json("/api/workspaces/${enc(id)}/fs?path=${enc(path)}") as JSONObject
    }
    suspend fun addProject(path: String, name: String) {
        val o = (api ?: throw ApiError("请先连接服务器。")).json("/api/workspaces", "POST", obj("path" to path, "name" to name.ifBlank { path.substringAfterLast('/') })) as JSONObject
        val p = Project.parse(o)
        _state.update { it.copy(projects = it.projects.filterNot { p2 -> p2.id == p.id } + p, projectId = p.id) }
        save(true)
    }
    fun showChanges(changes: List<FileChange>) {
        if (changes.isEmpty()) return
        _state.update { it.copy(viewer = Viewer("改动审阅", changes = changes, diffMode = true, returnRoute = it.route), viewerTrail = emptyList(), route = "viewer") }
        selectChange(0)
    }
    fun selectChange(index: Int) {
        val generation = epoch
        val viewer = _state.value.viewer ?: return
        val change = viewer.changes.getOrNull(index) ?: return
        _state.update { it.copy(viewer = viewer.copy(selected = index, title = change.path.substringAfterLast('/'), path = change.path, content = change.diff.ifBlank { change.note }, loading = change.diff.isBlank() && change.diffFileId.isNotBlank(), error = "")) }
        if (change.diff.isBlank() && change.diffFileId.isNotBlank()) viewModelScope.launch {
            try { val text = api?.bytes("/files/${enc(change.diffFileId)}").orEmpty(); if (generation == epoch && _state.value.viewer?.changes == viewer.changes && _state.value.viewer?.selected == index) _state.update { it.copy(viewer = it.viewer?.copy(content = text, loading = false)) } }
            catch (e: Exception) { if (generation == epoch) _state.update { it.copy(viewer = it.viewer?.copy(error = e.message.orEmpty(), loading = false)) } }
        }
    }
    fun showFile(path: String) {
        val s = _state.value
        val generation = epoch
        val returnRoute = s.viewer?.returnRoute ?: s.route
        _state.update { it.copy(viewer = Viewer(path.substringAfterLast('/'), loading = true, path = path, returnRoute = returnRoute), viewerTrail = if (s.route == "viewer" && s.viewer != null) s.viewerTrail + s.viewer else emptyList(), route = "viewer") }
        viewModelScope.launch {
            try {
                val file = projectFiles(path)
                if (generation == epoch && _state.value.viewer?.path == path && _state.value.viewer?.diffMode == false) _state.update { it.copy(viewer = it.viewer?.copy(content = file.str("content") + if (file.optBoolean("truncated")) "\n\n[服务端已截断文件]" else "", loading = false)) }
            } catch (e: Exception) { if (generation == epoch && _state.value.viewer?.path == path) _state.update { it.copy(viewer = it.viewer?.copy(error = e.message.orEmpty(), loading = false)) } }
        }
    }
    fun reviewComment(line: String, comment: String) {
        val path = _state.value.viewer?.path.orEmpty()
        closeViewerToComposer()
        val s = _state.value
        val prefix = s.draft.text.let { if (it.isBlank()) "" else "$it\n\n" }
        editDraft(prefix + "请检查 @$path" + if (line.isNotBlank()) " 的第 $line 行：\n$comment" else "：\n$comment")
        _state.update { it.copy(notice = "审阅意见已放入输入框，确认后发送") }
    }
    private fun closeViewerToComposer() { val v = _state.value.viewer ?: return; _state.update { it.copy(route = v.returnRoute, viewer = null, viewerTrail = emptyList()) } }
    fun referenceViewedFile() { val path = _state.value.viewer?.path.orEmpty(); closeViewerToComposer(); insertReference(path) }
    fun upload(uri: Uri, targetKey: String = "", targetProject: String = "", targetOrigin: String = "") {
        val s = _state.value
        val active = api ?: return
        if (s.uploading) return
        if (targetOrigin.isNotBlank() && targetOrigin != active.origin) { _state.update { it.copy(actionError = "服务器已切换，请在当前任务中重新选择附件。") }; return }
        val key = targetKey.ifBlank { s.draftKey }
        val project = targetProject.ifBlank { s.task?.workspaceId ?: s.projectId }
        if (project.isBlank()) { _state.update { it.copy(actionError = "请先选择项目。") }; return }
        val generation = epoch
        _state.update { it.copy(uploading = true, uploadProgress = "正在读取附件", actionError = "", projectId = project, route = if (key.startsWith("new:")) "new" else "chat", sessionId = if (key.startsWith("session:")) key.removePrefix("session:") else "") }
        viewModelScope.launch {
            var temp: File? = null
            try {
                val resolver = getApplication<Application>().contentResolver
                var name = "attachment"; var size = -1L
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) { val ni = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); val si = cursor.getColumnIndex(OpenableColumns.SIZE); if (ni >= 0) name = cursor.getString(ni); if (si >= 0 && !cursor.isNull(si)) size = cursor.getLong(si) }
                }
                if (size > 100L * 1024 * 1024) throw ApiError("单个附件最大 100 MB。")
                val mime = resolver.getType(uri) ?: "application/octet-stream"
                val tempFile = File.createTempFile("upload-", ".bin", getApplication<Application>().cacheDir)
                temp = tempFile
                val sha = withContext(Dispatchers.IO) {
                    val digest = MessageDigest.getInstance("SHA-256")
                    resolver.openInputStream(uri).use { input ->
                        if (input == null) throw ApiError("无法读取所选文件。")
                        tempFile.outputStream().use { out ->
                            val buffer = ByteArray(64 * 1024); var total = 0L
                            while (true) { val count = input.read(buffer); if (count < 0) break; total += count; if (total > 100L * 1024 * 1024) throw ApiError("单个附件最大 100 MB。"); out.write(buffer, 0, count); digest.update(buffer, 0, count) }
                        }
                    }
                    digest.digest().joinToString("") { "%02x".format(it) }
                }
                val init = active.json("/api/uploads", "POST", obj("name" to name, "size" to tempFile.length(), "sha256" to sha, "mime" to mime)) as JSONObject
                var fileId = init.str("existingFileId")
                if (fileId.isBlank()) {
                    val uploadId = init.str("uploadId"); val chunkSize = init.optInt("chunkSize", 1048576)
                    val received = init.optJSONArray("received").let { a -> if (a == null) emptySet() else (0 until a.length()).map { a.optInt(it) }.toSet() }
                    withContext(Dispatchers.IO) {
                        tempFile.inputStream().use { input ->
                            var index = 0; var sent = 0L
                            while (true) {
                                val buffer = ByteArray(chunkSize)
                                var count = 0
                                while (count < chunkSize) { val n = input.read(buffer, count, chunkSize - count); if (n < 0) break; count += n }
                                val data = buffer.copyOf(count)
                                if (data.isEmpty()) break
                                if (index !in received) active.chunk("/api/uploads/${enc(uploadId)}/chunks/$index", data)
                                sent += data.size; index++
                                _state.update { it.copy(uploadProgress = "正在上传 ${(sent * 100 / maxOf(1, tempFile.length())).toInt()}%") }
                            }
                        }
                    }
                    fileId = (active.json("/api/uploads/${enc(uploadId)}/complete", "POST") as JSONObject).str("fileId")
                }
                var reference = ""
                if (!mime.startsWith("image/")) reference = (active.json("/api/workspaces/${enc(project)}/attach", "POST", obj("fileId" to fileId, "name" to name)) as JSONObject).str("path")
                if (generation != epoch) return@launch
                val attachment = Attachment(fileId, name, mime, reference, uri.toString())
                _state.update { current ->
                    val d = current.drafts[key] ?: Draft()
                    current.copy(drafts = current.drafts + (key to d.copy(text = d.text + if (reference.isNotBlank()) (if (d.text.isBlank()) "" else "\n") + "@$reference " else "", attachments = d.attachments + attachment)), uploading = false, uploadProgress = "")
                }
                save(true); syncDraft(key)
            } catch (e: Exception) { if (generation == epoch) _state.update { it.copy(uploading = false, uploadProgress = "", actionError = e.message ?: "附件上传失败，请重试。") } }
            finally { temp?.delete() }
        }
    }
    fun authenticatedImage(fileId: String): coil.request.ImageRequest = coil.request.ImageRequest.Builder(getApplication<Application>()).data(api?.origin.orEmpty() + "/files/" + enc(fileId)).addHeader("Cookie", api?.cookie.orEmpty()).build()
    suspend fun dshStatus(): JSONObject = (api ?: throw ApiError("请先连接服务器。")).json("/api/dsh") as JSONObject
    suspend fun connectDsh(link: String) { (api ?: throw ApiError("请先连接服务器。")).json("/api/dsh/connect", "POST", obj("link" to link)); refreshAll() }
    suspend fun scanProviders(): JSONObject { val result = (api ?: throw ApiError("请先连接服务器。")).json("/api/providers/scan", "POST") as JSONObject; refreshAll(); return result }
    suspend fun saveProvider(data: JSONObject, id: String = "") { (api ?: throw ApiError("请先连接服务器。")).json(if (id.isBlank()) "/api/providers" else "/api/providers/${enc(id)}", if (id.isBlank()) "POST" else "PATCH", data); refreshAll() }
    private fun enc(text: String): String = URLEncoder.encode(text, "UTF-8")
    override fun onCleared() { socket?.cancel(); api?.client?.dispatcher?.executorService?.shutdown(); super.onCleared() }
}
