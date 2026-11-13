package com.webdcc.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@Composable fun SheetContent(target: SheetTarget, s: AppState, vm: MobileViewModel, close: () -> Unit, open: (String) -> Unit, pickFile: (Array<String>) -> Unit) {
    val max = (LocalConfiguration.current.screenHeightDp * .85f).dp
    Column(Modifier.fillMaxWidth().heightIn(max = max).navigationBarsPadding().padding(bottom = 16.dp)) {
        when (target.name) {
            "projects" -> ProjectsSheet(s, vm, close, open)
            "addProject" -> AddProjectSheet(vm, close)
            "agent" -> AgentSheet(s, vm, close)
            "model" -> ModelSheet(s, vm, close, open)
            "effort" -> EffortSheet(s, vm, close)
            "theme" -> ThemeSheet(vm, close)
            "permissions" -> PermissionSheet(s, vm, close)
            "config" -> ConfigSheet(s, open)
            "files" -> FilesSheet(vm, close)
            "attach" -> AttachSheet(close, open, pickFile)
            "task" -> TaskSheet(s, vm, close, open)
            "settings" -> SettingsSheet(s, vm, close, open)
            "providers" -> ProvidersSheet(s, vm, open)
            "addProvider" -> ProviderEditor(vm, close)
            "dsh" -> DshSheet(vm)
            "activity" -> target.turn?.let { ActivitySheet(it) }
            "request" -> target.event?.let { RequestSheet(it, s, vm, close) }
        }
    }
}
@Composable fun SheetTitle(title: String, caption: String = "") {
    Column(Modifier.padding(start = 24.dp, end = 24.dp, bottom = 18.dp)) { Text(title, style = MaterialTheme.typography.titleLarge); if (caption.isNotBlank()) { Spacer(Modifier.height(7.dp)); Text(caption, color = Muted, style = MaterialTheme.typography.bodyMedium) } }
}
@Composable private fun SheetRow(title: String, subtitle: String = "", icon: androidx.compose.ui.graphics.vector.ImageVector = Icons.Outlined.ChevronRight, selected: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 24.dp, vertical = 15.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(title, fontSize = 15.sp, color = if (enabled) Ink else Muted, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal); if (subtitle.isNotBlank()) { Spacer(Modifier.height(4.dp)); Text(subtitle, fontSize = 12.sp, color = Muted, lineHeight = 18.sp) } }
        Spacer(Modifier.width(12.dp)); Glyph(if (selected) Icons.Outlined.Check else icon, null, if (selected) Blue else Muted, 20)
    }
}
@Composable private fun ColumnScope.ProjectsSheet(s: AppState, vm: MobileViewModel, close: () -> Unit, open: (String) -> Unit) {
    SheetTitle("选择项目", "任务会在这台电脑上的项目目录里执行。")
    LazyColumn(Modifier.weight(1f, fill = false)) { items(s.projects, key = { it.id }) { p -> SheetRow(p.name, p.path, Icons.Outlined.FolderOpen, p.id == s.projectId) { vm.selectProject(p.id); close() } } }
    HorizontalDivider(color = Line)
    SheetRow("添加电脑上的目录", "浏览服务器上的项目文件夹", Icons.Outlined.CreateNewFolder) { open("addProject") }
}
@Composable private fun ColumnScope.AddProjectSheet(vm: MobileViewModel, close: () -> Unit) {
    var path by rememberSaveable { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var error by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(path) { loading = true; error = ""; try { data = vm.browse(path); address = data!!.str("path") } catch (e: Exception) { error = e.message.orEmpty() }; loading = false }
    SheetTitle("添加项目", "选择电脑上的目录。手机文件夹不会作为项目。")
    Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(address, { address = it }, label = { Text("电脑目录") }, singleLine = true, modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp))
        TextButton(onClick = { path = address }, enabled = address.isNotBlank()) { Text("前往") }
    }
    ErrorStrip(error)
    if (loading) BusyLine("读取目录…")
    LazyColumn(Modifier.weight(1f, fill = false).heightIn(min = 100.dp, max = 290.dp)) {
        val current = data?.str("path").orEmpty()
        if (current.isNotBlank() && current != "/") item("parent") { SheetRow("..", "上一级", Icons.Outlined.DriveFolderUpload) { path = current.substringBeforeLast('/', "").ifBlank { "/" } } }
        items(data?.items("entries").orEmpty()) { row -> SheetRow(row.str("name"), icon = Icons.Outlined.FolderOpen) { path = row.str("path") } }
    }
    Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(name, { name = it }, label = { Text("项目名称（可选）") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp))
        Button(onClick = { saving = true; scope.launch { try { vm.addProject(address, name); close() } catch (e: Exception) { error = e.message.orEmpty() }; saving = false } }, enabled = address.startsWith('/') && !saving && !loading, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(14.dp)) { Text(if (saving) "正在添加…" else "使用此目录") }
    }
}
@Composable private fun AgentSheet(s: AppState, vm: MobileViewModel, close: () -> Unit) {
    SheetTitle("选择 Agent", "使用电脑上已经安装和配置的开发助手。")
    s.agents.forEach { a ->
        Row(Modifier.fillMaxWidth().clickable(enabled = a.installed) { vm.selectAgent(a.id); close() }.padding(horizontal = 24.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            AgentMark(a.id); Spacer(Modifier.width(13.dp)); Column(Modifier.weight(1f)) { Text(a.label, fontSize = 16.sp); Text(if (a.installed) "在电脑上运行" else a.reason.ifBlank { "电脑上尚未安装" }, color = Muted, fontSize = 12.sp) }; if (a.id == s.selection.agent) Glyph(Icons.Outlined.Check, null, Blue)
        }
    }
}
@Composable private fun ColumnScope.ModelSheet(s: AppState, vm: MobileViewModel, close: () -> Unit, open: (String) -> Unit) {
    val newTask = s.route == "new"
    val agent = if (newTask) s.selection.agent else s.task?.agent.orEmpty()
    val providerId = if (newTask) s.selection.providerId else s.task?.providerId?.ifBlank { null }
    val current = if (newTask) s.selection.model else s.task?.model.orEmpty()
    val providers = s.providers.filter { it.supports(agent) && (newTask || it.id == providerId) }
    val nativeModels = s.agents.find { it.id == agent }?.models.orEmpty()
    var custom by remember { mutableStateOf("") }
    SheetTitle("模型", if (newTask) "选择服务商和模型，配置直接使用电脑上的 WebDCC。" else "切换当前任务的模型。切换服务商请新建任务。")
    if (newTask) SheetRow("Agent", agentLabel(agent), Icons.Outlined.UnfoldMore) { open("agent") }
    SheetRow("思考强度", effortLabel(if (newTask) s.selection.effort else s.task?.effort.orEmpty()), Icons.Outlined.Tune) { open("effort") }
    LazyColumn(Modifier.weight(1f, fill = false)) {
        providers.forEach { provider ->
            item("provider:${provider.id}") { Column(Modifier.padding(horizontal = 24.dp, vertical = 10.dp)) { Text(provider.name, fontSize = 12.sp, color = Muted, fontWeight = FontWeight.SemiBold); if (provider.note.isNotBlank()) Text(provider.note, fontSize = 11.sp, color = Amber) } }
            items(provider.models, key = { "${provider.id}:$it" }) { model -> SheetRow(provider.modelLabel(model), if (provider.modelLabel(model) != model) model else "", selected = current == model && providerId == provider.id) { vm.selectModel(provider.id, model); close() } }
        }
        if (newTask || providerId == null) {
            item("native") { Text("${agentLabel(agent)} 本机配置", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 10.dp)) }
            items(nativeModels) { row -> SheetRow(row.str("label", row.str("id")), selected = providerId == null && current == row.str("id")) { vm.selectModel(null, row.str("id")); close() } }
        }
        if (providers.isEmpty() && nativeModels.isEmpty()) item("none") { Text("电脑没有返回模型列表。可填写模型 ID，或在服务商设置里扫描本机配置。", color = Muted, fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp)) }
    }
    if (providers.isEmpty() || nativeModels.isEmpty()) Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(custom, { custom = it }, label = { Text("模型 ID") }, singleLine = true, modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp))
        TextButton(onClick = { vm.selectModel(providerId, custom.trim()); close() }, enabled = custom.isNotBlank()) { Text("使用") }
    }
    SheetRow("服务商设置", "扫描本机配置或添加 API 服务商", Icons.Outlined.Settings) { open("providers") }
}
@Composable private fun PermissionSheet(s: AppState, vm: MobileViewModel, close: () -> Unit) {
    val newTask = s.route == "new"
    val agent = if (newTask) s.selection.agent else s.task?.agent.orEmpty()
    val current = if (newTask) s.selection.mode else s.task?.accessMode.orEmpty()
    val modes = s.agents.find { it.id == agent }?.modes.orEmpty().filterNot { s.root && agent == "claude-code" && it.str("id") == "bypassPermissions" }
    SheetTitle("任务权限", "标准编辑权限允许修改项目，额外操作由 Agent 发起审批。")
    modes.forEach { mode -> SheetRow(modeLabel(mode.str("id")), mode.str("label"), selected = current == mode.str("id")) { vm.selectMode(mode.str("id")); close() } }
    if (modes.isEmpty()) Text("服务端没有提供可切换的权限模式。", color = Muted, modifier = Modifier.padding(24.dp))
}
@Composable private fun ConfigSheet(s: AppState, open: (String) -> Unit) {
    SheetTitle("任务配置")
    SheetRow("Agent", agentLabel(s.selection.agent)) { open("agent") }
    SheetRow("模型", s.selection.model.ifBlank { "使用本机默认模型" }) { open("model") }
    SheetRow("思考强度", effortLabel(s.selection.effort), Icons.Outlined.Tune) { open("effort") }
    SheetRow("权限", modeLabel(s.selection.mode)) { open("permissions") }
}
@Composable private fun ColumnScope.FilesSheet(vm: MobileViewModel, close: () -> Unit) {
    var path by rememberSaveable { mutableStateOf("") }
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var error by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(path) { loading = true; error = ""; try { data = vm.projectFiles(path) } catch (e: Exception) { error = e.message.orEmpty() }; loading = false }
    SheetTitle("项目文件", path.ifBlank { "项目根目录" })
    ErrorStrip(error)
    if (loading) BusyLine("正在读取文件…")
    LazyColumn(Modifier.weight(1f, fill = false)) {
        if (path.isNotBlank()) item("parent") { SheetRow("..", "上一级", Icons.Outlined.DriveFolderUpload) { path = path.substringBeforeLast('/', "") } }
        items(data?.items("entries").orEmpty()) { row ->
            val directory = row.str("type") == "dir"
            Row(Modifier.fillMaxWidth().clickable { if (directory) path = row.str("path") else { close(); vm.showFile(row.str("path")) } }.padding(start = 24.dp, end = 14.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph(if (directory) Icons.Outlined.FolderOpen else Icons.AutoMirrored.Outlined.InsertDriveFile, null, Muted, 19); Spacer(Modifier.width(10.dp)); Text(row.str("name"), fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!directory) TextButton(onClick = { vm.insertReference(row.str("path")); close() }) { Text("引用", fontSize = 12.sp) } else Glyph(Icons.Outlined.ChevronRight, null, Muted, 18)
            }
        }
        if (!loading && data?.items("entries")?.isEmpty() == true) item("empty") { Text("这个目录是空的。", color = Muted, modifier = Modifier.padding(24.dp)) }
    }
}
@Composable private fun AttachSheet(close: () -> Unit, open: (String) -> Unit, pickFile: (Array<String>) -> Unit) {
    SheetTitle("添加到消息")
    SheetRow("照片或图片", "作为图片交给 Agent", Icons.Outlined.Image) { pickFile(arrayOf("image/*")); close() }
    SheetRow("手机上的文件", "上传到电脑项目，并插入可见的 @引用", Icons.Outlined.UploadFile) { pickFile(arrayOf("*/*")); close() }
    SheetRow("引用项目文件", "选择电脑项目里已有的文件", Icons.Outlined.FolderOpen) { open("files") }
}
@Composable private fun TaskSheet(s: AppState, vm: MobileViewModel, close: () -> Unit, open: (String) -> Unit) {
    var renaming by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf(s.task?.title.orEmpty()) }
    Column(Modifier.verticalScroll(rememberScrollState())) {
    SheetTitle("任务选项", "${agentLabel(s.task?.agent.orEmpty())} · ${s.task?.model.orEmpty()}")
    if (renaming) Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(title, { title = it }, singleLine = true, modifier = Modifier.weight(1f), label = { Text("任务名称") }); TextButton(onClick = { vm.rename(title); close() }, enabled = title.isNotBlank()) { Text("保存") } }
    else SheetRow("重命名", icon = Icons.Outlined.Edit) { renaming = true }
    SheetRow(if (s.task?.pinned == true) "取消置顶" else "置顶任务", icon = Icons.Outlined.PushPin) { vm.togglePin(); close() }
    SheetRow("模型", s.task?.model.orEmpty()) { open("model") }
    SheetRow("思考强度", effortLabel(s.task?.effort.orEmpty()), Icons.Outlined.Tune) { open("effort") }
    SheetRow("权限", modeLabel(s.task?.accessMode.orEmpty())) { open("permissions") }
    if (s.live) SheetRow("停止当前轮", "正在排队的消息会在之后继续执行", Icons.Outlined.StopCircle) { vm.stop(); close() }
    SheetRow(if (s.task?.archived == true) "恢复到任务列表" else "归档任务", "归档后仍可从设置中查看", Icons.Outlined.Archive) { vm.toggleArchive(); close() }
    }
}
@Composable private fun SettingsSheet(s: AppState, vm: MobileViewModel, close: () -> Unit, open: (String) -> Unit) {
    val theme by vm.themeMode.collectAsStateWithLifecycle()
    Column(Modifier.verticalScroll(rememberScrollState())) {
    SheetTitle("连接与设置", s.address)
    SheetRow("外观", theme.label + if (theme == ThemeMode.SYSTEM) if (isSystemInDarkTheme()) " · 当前暗色" else " · 当前亮色" else "", Icons.Outlined.Brightness6) { open("theme") }
    SheetRow("连接状态", when (s.connection) { "online" -> "实时同步已连接"; "expired" -> "登录过期"; else -> s.connectionError.ifBlank { "正在连接" } }, Icons.Outlined.Refresh) { vm.retryConnection(); close() }
    SheetRow("服务商与模型", "使用电脑配置，也可手动添加") { open("providers") }
    SheetRow("连接 DSH", "粘贴 DSH 侧车的完整启动链接") { open("dsh") }
    SheetRow(if (s.archiveFilter) "返回当前任务" else "查看已归档任务", icon = Icons.Outlined.Archive) { vm.setArchiveFilter(!s.archiveFilter); close() }
    SheetRow("更换服务器 / 重新绑定", icon = Icons.Outlined.Link) { close(); vm.showConnection() }
    Text("WebDCC Android ${BuildConfig.VERSION_NAME} · 原生界面", color = Muted, fontSize = 11.sp, modifier = Modifier.padding(start = 24.dp, top = 17.dp))
    }
}

@Composable private fun ThemeSheet(vm: MobileViewModel, close: () -> Unit) {
    val mode by vm.themeMode.collectAsStateWithLifecycle()
    SheetTitle("外观", "默认跟随手机的系统外观，选择后立即生效。")
    ThemeMode.entries.forEach { value -> SheetRow(value.label, when (value) { ThemeMode.SYSTEM -> "随系统自动切换亮色和暗色"; ThemeMode.LIGHT -> "始终使用亮色界面"; ThemeMode.DARK -> "始终使用暗色界面" }, selected = mode == value) { vm.setTheme(value); close() } }
}

@Composable private fun ColumnScope.EffortSheet(s: AppState, vm: MobileViewModel, close: () -> Unit) {
    val newTask = s.route == "new"
    val agent = if (newTask) s.selection.agent else s.task?.agent.orEmpty()
    val current = if (newTask) s.selection.effort else s.task?.effort.orEmpty()
    val choices = s.currentReasoningChoices()
    val busy = "effort:${s.sessionId}" in s.busyActions
    var pending by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(agent) {
        if (agent == "dsh") { loading = true; try { vm.refreshReasoningMetadata() } catch (e: Exception) { error = e.message.orEmpty() }; loading = false }
    }
    LaunchedEffect(current, busy) { if (pending != null && current == pending && !busy) close() }
    SheetTitle("思考强度", (if (newTask) "${agentLabel(agent)} · " else "后续回复使用所选强度 · ") + "当前：${effortLabel(current)}")
    if (loading) BusyLine("正在读取模型的可选等级…")
    LazyColumn(Modifier.weight(1f, fill = false)) {
        items(choices.values, key = { it }) { value ->
            SheetRow(effortLabel(value) + "  ·  $value", effortDescription(value), selected = current == value, enabled = !busy) {
                vm.clearError(); pending = value; vm.selectEffort(value); if (newTask) close()
            }
        }
    }
    if (busy) BusyLine("正在应用思考强度…")
    ErrorStrip(s.actionError, vm::clearError)
    if (choices.values.isEmpty() && !loading) Text(if (error.isNotBlank()) error else "当前模型没有提供可选的思考等级。", color = Muted, fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 15.dp))
    if (agent == "dsh" && error.isNotBlank()) TextButton(onClick = { loading = true; error = ""; scope.launch { try { vm.refreshReasoningMetadata() } catch (e: Exception) { error = e.message.orEmpty() }; loading = false } }, modifier = Modifier.padding(horizontal = 16.dp)) { Text("重新读取") }
}
@Composable private fun ColumnScope.ProvidersSheet(s: AppState, vm: MobileViewModel, open: (String) -> Unit) {
    var loading by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    SheetTitle("服务商与模型", "密钥保存在电脑上的 WebDCC，手机不会读取已有密钥。")
    LazyColumn(Modifier.weight(1f, fill = false)) {
        items(s.providers, key = { it.id }) { p -> Column(Modifier.padding(horizontal = 24.dp, vertical = 13.dp)) { Text(p.name, fontSize = 15.sp); Text(p.raw.str("baseUrl"), color = Muted, fontSize = 12.sp); Text("${p.models.size} 个模型" + if (p.note.isBlank()) "" else " · ${p.note}", color = if (p.note.isBlank()) Muted else Amber, fontSize = 12.sp) } }
    }
    if (message.isNotBlank()) Text(message, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 24.dp))
    SheetRow(if (loading) "正在扫描…" else "扫描电脑上的配置", "导入 Codex / Claude 已配置的服务商", Icons.Outlined.Refresh, enabled = !loading) { loading = true; scope.launch { message = try { val result = vm.scanProviders(); "已导入 ${result.optInt("imported")} 项配置" } catch (e: Exception) { e.message.orEmpty() }; loading = false } }
    SheetRow("添加服务商", icon = Icons.Outlined.Add) { open("addProvider") }
}
@Composable private fun ProviderEditor(vm: MobileViewModel, close: () -> Unit) {
    var name by remember { mutableStateOf("") }; var base by remember { mutableStateOf("") }; var key by remember { mutableStateOf("") }; var models by remember { mutableStateOf("") }; var protocol by remember { mutableStateOf("openai-responses") }; var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    SheetTitle("添加服务商")
    Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(name, { name = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(base, { base = it }, label = { Text("API Base URL") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(key, { key = it }, label = { Text("API Key（可选）") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), singleLine = true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Pill("Codex", selected = protocol == "openai-responses") { protocol = "openai-responses" }; Pill("Claude", selected = protocol == "anthropic-messages") { protocol = "anthropic-messages" } }
        OutlinedTextField(models, { models = it }, label = { Text("模型 ID，多个用逗号分隔") }, modifier = Modifier.fillMaxWidth())
        if (error.isNotBlank()) Text(error, color = Red, fontSize = 13.sp)
        Button(onClick = { busy = true; scope.launch { try { vm.saveProvider(obj("name" to name.trim(), "baseUrl" to base.trim(), "apiKey" to key, "models" to JSONArray(models.split(',', '，', '\n').map { it.trim() }.filter { it.isNotBlank() }), "protocols" to JSONArray(listOf(protocol)))); close() } catch (e: Exception) { error = e.message.orEmpty() }; busy = false } }, enabled = !busy && name.isNotBlank() && base.isNotBlank() && models.isNotBlank(), modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (busy) "保存中…" else "保存到电脑") }
    }
}
@Composable private fun DshSheet(vm: MobileViewModel) {
    var link by remember { mutableStateOf("") }; var status by remember { mutableStateOf("正在检查连接…") }; var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { status = try { val data = vm.dshStatus(); if (data.optBoolean("connected")) "DSH 已连接" else "DSH 尚未连接" } catch (e: Exception) { e.message.orEmpty() } }
    SheetTitle("连接 DSH", status)
    Column(Modifier.padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(link, { link = it }, label = { Text("DSH 完整启动链接") }, minLines = 3, maxLines = 5, modifier = Modifier.fillMaxWidth())
        Text("这里填写 DSH 侧车链接，由电脑上的 WebDCC 连接。电脑本机的 localhost 链接可以直接使用。", fontSize = 12.sp, lineHeight = 20.sp, color = Muted)
        if (error.isNotBlank()) Text(error, fontSize = 13.sp, color = Red)
        Button(onClick = { busy = true; error = ""; scope.launch { try { vm.connectDsh(link); status = "DSH 已连接"; link = "" } catch (e: Exception) { error = e.message.orEmpty() }; busy = false } }, enabled = link.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (busy) "正在连接…" else "绑定 DSH") }
    }
}

@Composable private fun RequestSheet(event: Event, s: AppState, vm: MobileViewModel, close: () -> Unit) {
    val question = event.kind == "question"
    val id = event.data.str(if (question) "questionId" else "approvalId")
    val busyKey = (if (question) "question:" else "approval:") + id
    val busy = busyKey in s.busyActions
    var selected by rememberSaveable(id) { mutableStateOf(listOf<String>()) }
    var custom by rememberSaveable(id) { mutableStateOf("") }
    val pending = pendingRequests(s.thread).any { it.data.str(if (question) "questionId" else "approvalId") == id }
    LaunchedEffect(pending) { if (!pending) close() }
    SheetTitle(if (question) "需要你回答" else "需要你批准", if (question) event.data.str("header") else event.data.str("title"))
    Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (question) {
            RichText(event.data.str("prompt"))
            val multi = event.data.optBoolean("multiSelect")
            event.data.items("options").forEach { option ->
                val optionId = option.str("id")
                Surface(onClick = { selected = if (multi) if (optionId in selected) selected - optionId else selected + optionId else listOf(optionId) }, enabled = !busy, shape = RoundedCornerShape(13.dp), border = BorderStroke(1.dp, if (optionId in selected) Blue else Line), color = if (optionId in selected) Blue.copy(alpha = .05f) else Paper) {
                    Row(Modifier.fillMaxWidth().padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                        Glyph(if (optionId in selected) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked, null, if (optionId in selected) Blue else Muted, 20); Spacer(Modifier.width(10.dp))
                        Column { Text(option.str("label"), fontSize = 14.sp); if (option.str("description").isNotBlank()) Text(option.str("description"), color = Muted, fontSize = 12.sp, lineHeight = 19.sp) }
                    }
                }
            }
            if (event.data.optBoolean("allowsFreeText", true)) OutlinedTextField(custom, { custom = it }, label = { Text("补充回答") }, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 5, enabled = !busy, shape = RoundedCornerShape(12.dp))
            ErrorStrip(s.actionError, vm::clearError)
            Button(onClick = { vm.answer(event, selected, custom) }, enabled = !busy && (selected.isNotEmpty() || custom.isNotBlank()), modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(14.dp)) { Text(if (busy) "正在发送…" else "发送回答并继续") }
        } else {
            val detail = event.data.str("detail")
            if (detail.isNotBlank()) CodeBlock(detail, title = "请求的操作")
            if (event.data.str("reason").isNotBlank()) Text(event.data.str("reason"), color = Muted, fontSize = 13.sp)
            if (event.data.str("planMarkdown").isNotBlank()) RichText(event.data.str("planMarkdown"))
            ErrorStrip(s.actionError, vm::clearError)
            event.data.items("options").forEachIndexed { index, option ->
                if (index == 0) Button(onClick = { vm.approve(event, option.str("id")) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(14.dp)) { Text(if (busy) "正在提交…" else option.str("label")) }
                else OutlinedButton(onClick = { vm.approve(event, option.str("id")) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(14.dp)) { Text(option.str("label")) }
            }
        }
    }
}
@Composable private fun ColumnScope.ActivitySheet(turn: Turn) {
    SheetTitle("执行详情", statusName(turn.state))
    val events = (turn.steps + turn.live).distinctBy { it.key }
    LazyColumn(Modifier.weight(1f, fill = false), contentPadding = PaddingValues(horizontal = 22.dp, vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(events, key = { it.key }) { e ->
            when (e.kind) {
                "command" -> Column(verticalArrangement = Arrangement.spacedBy(5.dp)) { Text(e.data.str("label").ifBlank { "运行命令" }, fontSize = 12.sp, color = Muted); CodeBlock(e.data.str("command") + e.data.str("outputTail").let { if (it.isBlank()) "" else "\n\n$it" }, title = "命令 · " + if (e.data.isNull("exitCode")) e.data.str("status") else "退出 ${e.data.optInt("exitCode")}") }
                "reasoning" -> Column { Text("思考过程", fontSize = 12.sp, color = Muted); RichText(e.data.str("text")) }
                "assistant.message" -> RichText(e.data.str("text"))
                "tool.call" -> CodeBlock(e.data.opt("input")?.toString().orEmpty() + e.data.opt("output").let { if (it == null || it == JSONObject.NULL) "" else "\n\n$it" }, title = e.data.str("label", e.data.str("name")))
                "file.read" -> Text("读取 ${e.data.str("path")}", fontFamily = Mono, fontSize = 12.sp)
                "file.change", "turn.diff" -> Column { Text("文件改动", fontSize = 12.sp, color = Muted); e.data.items("changes").forEach { Text(it.str("path"), fontFamily = Mono, fontSize = 12.sp) } }
                "error" -> Text(e.data.str("message"), color = Red, fontSize = 13.sp)
                "notice" -> Text(e.data.str("text"), color = Muted, fontSize = 13.sp)
                "plan" -> e.data.items("items").forEach { Text("${if (it.str("status") == "completed") "✓" else "○"} ${it.str("text")}", fontSize = 13.sp) }
                "goal" -> Text("目标：${e.data.str("objective")} · ${e.data.str("status")}", fontSize = 13.sp)
                "question" -> Text("提问：${e.data.str("prompt")} · ${e.data.str("status", "pending")}", fontSize = 13.sp, color = Muted)
                "approval.request" -> Text("审批：${e.data.str("title")}", fontSize = 13.sp, color = Muted)
                "approval.resolved" -> Text("审批已处理：${e.data.str("optionId")}", fontSize = 12.sp, color = Muted)
                "usage" -> Text("用量 · 输入 ${e.data.optLong("inputTokens")} / 输出 ${e.data.optLong("outputTokens")} tokens", fontSize = 12.sp, color = Muted)
            }
        }
    }
}
