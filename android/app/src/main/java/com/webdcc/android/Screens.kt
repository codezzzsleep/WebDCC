package com.webdcc.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.*
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable fun ConnectionBanner(s: AppState, vm: MobileViewModel) {
    if (s.connection == "online") return
    val expired = s.connection == "expired"
    Row(Modifier.fillMaxWidth().background(if (expired) Red.copy(alpha = .06f) else Soft).padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (expired) "登录已过期，重新绑定后继续" else if (s.connection == "connecting") "正在同步电脑上的任务…" else "连接已断开 · 正在重连", color = if (expired) Red else Muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
        TextButton(onClick = { if (expired) vm.showConnection() else vm.retryConnection() }, modifier = Modifier.height(36.dp), contentPadding = PaddingValues(horizontal = 8.dp)) { Text(if (expired) "重新绑定" else "重试", fontSize = 12.sp) }
    }
}
@Composable fun ConnectScreen(s: AppState, vm: MobileViewModel, sheet: (String) -> Unit) {
    var text by remember(s.launchText) { mutableStateOf(s.launchText) }
    var host by remember { mutableStateOf("") }
    var autoAttempt by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    val parsed = remember(text) { runCatching { LaunchLink.fromText(text) }.getOrNull() }
    val local = parsed?.isLocalAddress == true
    LaunchedEffect(text) {
        if (parsed != null && !local && text != autoAttempt && !s.binding) { delay(800); autoAttempt = text; vm.bind(text) }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
        Row(Modifier.fillMaxWidth().height(54.dp), verticalAlignment = Alignment.CenterVertically) {
            if (s.address.isNotBlank()) TextButton(onClick = vm::back) { Text("返回任务") }
            Spacer(Modifier.weight(1f))
            RoundButton(Icons.Outlined.Brightness6, "外观", { sheet("theme") })
        }
        Box(Modifier.size(52.dp).background(Ink, RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) { Text(">_", color = OnAction, fontFamily = Mono, fontSize = 23.sp) }
        Spacer(Modifier.height(28.dp))
        Text("把开发任务\n带到手机上。", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(14.dp))
        Text("连接电脑上的 WebDCC，继续你的项目和对话。", style = MaterialTheme.typography.bodyMedium, color = Muted)
        Spacer(Modifier.height(36.dp))
        Text("粘贴完整启动链接", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(9.dp))
        OutlinedTextField(value = text, onValueChange = { text = it }, enabled = !s.binding,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "完整 token 启动链接" }, minLines = 3, maxLines = 5,
            placeholder = { Text("http://电脑IP:端口/?token=完整token", fontSize = 13.sp) }, shape = RoundedCornerShape(14.dp), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), textStyle = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = { clipboard.getText()?.text?.let { text = it } }, enabled = !s.binding, contentPadding = PaddingValues(0.dp)) { Glyph(Icons.Outlined.ContentPaste, null, Muted, 16); Spacer(Modifier.width(6.dp)); Text("从剪贴板粘贴", fontSize = 13.sp) }
        if (local) {
            Text("链接里的本机地址需要换成电脑的可访问地址。token 会自动保留。", color = Amber, fontSize = 13.sp, lineHeight = 20.sp)
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(host, { host = it }, label = { Text("电脑 IP 或服务地址") }, placeholder = { Text("192.168.1.10") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), enabled = !s.binding)
        }
        if (s.connectionError.isNotBlank()) { Spacer(Modifier.height(12.dp)); Text(s.connectionError, color = Red, fontSize = 13.sp, lineHeight = 21.sp) }
        Spacer(Modifier.height(20.dp))
        Button(onClick = { autoAttempt = text; vm.bind(text, host) }, enabled = text.isNotBlank() && !s.binding && (!local || host.isNotBlank()), modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
            if (s.binding) { CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp, color = OnAction); Spacer(Modifier.width(10.dp)); Text("正在绑定…") }
            else { Text("连接并自动绑定"); Spacer(Modifier.width(10.dp)); Glyph(Icons.AutoMirrored.Outlined.ArrowForward, null, OnAction, 18) }
        }
        Spacer(Modifier.height(18.dp))
        Text("复制终端中带 token 的整条链接即可，也可以把整行提示粘贴进来。连接成功后会记住登录状态。", color = Muted, fontSize = 12.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(30.dp))
    }
}

@Composable fun HomeScreen(s: AppState, vm: MobileViewModel, sheet: (String) -> Unit) {
    var filter by rememberSaveable { mutableStateOf("全部") }
    var search by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    val tasks = s.tasks.values.filter { it.archived == s.archiveFilter && (s.projectId.isBlank() || it.workspaceId == s.projectId) }
        .filter { search.isBlank() || it.title.contains(search, true) }
        .filter { when (filter) { "进行中" -> it.status == "running"; "待处理" -> it.status in setOf("waiting", "error"); "已完成" -> it.status == "idle"; else -> true } }
        .sortedWith(compareByDescending<Task> { it.pinned }.thenByDescending { it.updatedAt })
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            MobileBar("WebDCC", if (s.connection == "online") "已连接到电脑" else "") {
                RoundButton(Icons.Outlined.Search, "搜索任务", { searching = !searching })
                RoundButton(Icons.Outlined.Settings, "连接与设置", { sheet("settings") })
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp).clickable { sheet("projects") }, verticalAlignment = Alignment.CenterVertically) {
                Glyph(Icons.Outlined.FolderOpen, null, Muted, 19); Spacer(Modifier.width(9.dp))
                Text(s.project?.name ?: "选择项目", fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Glyph(Icons.Outlined.UnfoldMore, "选择项目", Muted, 19)
            }
            if (searching) OutlinedTextField(search, { search = it }, placeholder = { Text("搜索任务名称") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp), shape = RoundedCornerShape(13.dp), trailingIcon = { IconButton(onClick = { search = ""; searching = false }) { Glyph(Icons.Outlined.Close, "关闭搜索") } })
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, top = 18.dp, end = 14.dp, bottom = 13.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (s.archiveFilter) "已归档" else "任务", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                if (s.refresh) CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp) else RoundButton(Icons.Outlined.Refresh, "同步任务", vm::refresh)
            }
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("全部", "进行中", "待处理", "已完成").forEach { label -> Pill(label + if (label == "待处理") tasks.count { it.status in setOf("waiting", "error") }.takeIf { it > 0 }?.let { " $it" }.orEmpty() else "", selected = filter == label) { filter = label } }
            }
            Spacer(Modifier.height(15.dp))
            if (tasks.isEmpty()) {
                Column(Modifier.weight(1f).fillMaxWidth().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Glyph(if (s.projects.isEmpty()) Icons.Outlined.CreateNewFolder else Icons.Outlined.ChatBubbleOutline, null, Muted, 34)
                    Spacer(Modifier.height(18.dp)); Text(if (s.projects.isEmpty()) "先连接一个项目" else if (filter == "全部" && search.isBlank()) "从一个任务开始" else "这里还没有任务", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp)); Text(if (s.projects.isEmpty()) "选择电脑上的项目目录，然后描述你想做的事。" else "描述要修改的内容，跟进进展，审阅结果。", color = Muted, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium)
                    if (s.projects.isEmpty()) TextButton(onClick = { sheet("projects") }) { Text("添加项目") }
                }
            } else LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 110.dp)) {
                items(tasks, key = { it.id }) { task ->
                    Column(Modifier.fillMaxWidth().clickable { vm.openTask(task.id) }.padding(start = 20.dp, end = 20.dp, top = 17.dp, bottom = 17.dp)) {
                        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                            AgentMark(task.agent)
                            Column(Modifier.weight(1f)) {
                                Text(task.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Spacer(Modifier.height(6.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) { StatusDot(task.status); Text(" · ${agentLabel(task.agent)}", color = Muted, fontSize = 12.sp); if (task.pinned) { Spacer(Modifier.width(6.dp)); Glyph(Icons.Outlined.PushPin, "已置顶", Muted, 12) } }
                            }
                            Text(relativeTime(task.updatedAt), fontSize = 11.sp, color = Muted, modifier = Modifier.padding(top = 3.dp))
                        }
                    }
                    HorizontalDivider(Modifier.padding(start = 63.dp), color = Line.copy(alpha = .7f))
                }
            }
        }
        ExtendedFloatingActionButton(onClick = vm::newTask, icon = { Glyph(Icons.Outlined.Add, null, OnAction) }, text = { Text("新任务") }, containerColor = Ink, contentColor = OnAction, shape = RoundedCornerShape(24.dp), modifier = Modifier.align(Alignment.BottomEnd).padding(22.dp).semantics { contentDescription = "新任务" })
    }
}

@Composable fun NewTaskScreen(s: AppState, vm: MobileViewModel, sheet: (String) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        MobileBar("新任务", back = vm::back) { RoundButton(Icons.Outlined.Tune, "任务配置", { sheet("config") }) }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 26.dp), verticalArrangement = Arrangement.Center) {
            AgentMark(s.selection.agent, 43)
            Spacer(Modifier.height(21.dp))
            Text("想在这个项目里\n完成什么？", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(18.dp))
            Row(Modifier.fillMaxWidth().clickable { sheet("projects") }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph(Icons.Outlined.FolderOpen, null, Blue, 19); Spacer(Modifier.width(9.dp))
                Column(Modifier.weight(1f)) { Text(s.project?.name ?: "选择项目", fontSize = 15.sp, color = Blue); s.project?.let { Text(it.path, fontSize = 11.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis) } }
                Glyph(Icons.Outlined.ExpandMore, null, Muted, 18)
            }
            Spacer(Modifier.height(15.dp))
        }
        ErrorStrip(s.actionError, vm::clearError)
        Composer(s, vm, sheet)
    }
}

@Composable fun Composer(s: AppState, vm: MobileViewModel, sheet: (String) -> Unit) {
    val newTask = s.route == "new"
    val task = s.task
    val agent = if (newTask) s.selection.agent else task?.agent ?: "codex"
    val model = if (newTask) s.selection.model else task?.model.orEmpty()
    val permissions = if (newTask) s.selection.mode else task?.accessMode.orEmpty()
    val effort = if (newTask) s.selection.effort else task?.effort.orEmpty()
    var preview by remember { mutableStateOf<Attachment?>(null) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    Column(Modifier.fillMaxWidth().background(Paper).padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 9.dp)) {
        if (s.uploading) Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp); Spacer(Modifier.width(9.dp)); Text(s.uploadProgress, color = Muted, fontSize = 12.sp) }
        if (s.draft.attachments.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            s.draft.attachments.forEach { a -> InputChip(selected = false, onClick = { preview = a }, label = { Text(a.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 170.dp), fontSize = 12.sp) }, leadingIcon = { Glyph(if (a.isImage) Icons.Outlined.Image else Icons.AutoMirrored.Outlined.InsertDriveFile, null, Muted, 16) }, trailingIcon = { IconButton(onClick = { vm.removeAttachment(a.fileId) }, modifier = Modifier.size(25.dp)) { Glyph(Icons.Outlined.Close, "移除附件 ${a.name}", Muted, 14) } }) }
        }
        Surface(shape = RoundedCornerShape(24.dp), color = Soft.copy(alpha = .65f), border = BorderStroke(1.dp, Line), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(top = if (newTask) 15.dp else 12.dp, start = 14.dp, end = 10.dp, bottom = 7.dp)) {
                BasicTextField(value = s.draft.text, onValueChange = vm::editDraft, modifier = Modifier.fillMaxWidth().heightIn(min = if (newTask) 32.dp else 25.dp, max = 160.dp).padding(start = 3.dp, end = 5.dp).focusRequester(focus).semantics { contentDescription = "任务输入框" },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = Ink), cursorBrush = SolidColor(Blue), enabled = !s.creating, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    decorationBox = { input -> Box { if (s.draft.text.isEmpty()) Text(if (newTask) "描述任务，或先提一个问题…" else if (s.live) "补充要求，将在当前轮后执行…" else "继续对话…", color = Muted, fontSize = 15.sp); input() } })
                Spacer(Modifier.height(if (newTask) 12.dp else 5.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RoundButton(Icons.Outlined.Add, "添加附件或引用", { sheet("attach") }, enabled = !s.uploading && !s.creating)
                    TextButton(onClick = { sheet("model") }, contentPadding = PaddingValues(horizontal = 5.dp), modifier = Modifier.weight(1f).height(36.dp).semantics { contentDescription = "选择模型" }) {
                        Text(if (newTask) agentLabel(agent).removeSuffix(" Code") + model.let { if (it.isBlank()) "" else " · $it" } else model.ifBlank { agentLabel(agent) }, fontSize = 12.sp, color = Ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)); Glyph(Icons.Outlined.ExpandMore, null, Muted, 14)
                    }
                    TextButton(onClick = { sheet("effort") }, enabled = "effort:${s.sessionId}" !in s.busyActions, contentPadding = PaddingValues(horizontal = 5.dp), modifier = Modifier.height(36.dp).semantics { contentDescription = "思考强度：${effortLabel(effort)}" }) {
                        Text("思考 ${effortLabel(effort)}", fontSize = 12.sp, color = Ink, maxLines = 1); Glyph(Icons.Outlined.ExpandMore, null, Muted, 14)
                    }
                    IconButton(onClick = { sheet("permissions") }, modifier = Modifier.size(32.dp)) { Glyph(if (permissions.removePrefix(":") in setOf("read-only", "plan")) Icons.Outlined.Lock else Icons.Outlined.Shield, "权限：${modeLabel(permissions)}", Muted, 18) }
                    val canSend = (s.draft.text.isNotBlank() || s.draft.attachments.any { it.isImage }) && !s.uploading && !s.creating
                    if (!newTask && s.live && !canSend) RoundButton(Icons.Outlined.Stop, "停止当前任务", vm::stop, enabled = "stop:${s.sessionId}" !in s.busyActions, filled = true)
                    else if (s.creating) Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(23.dp), strokeWidth = 2.dp) }
                    else RoundButton(if (s.live) Icons.Outlined.PlaylistAdd else Icons.Outlined.ArrowUpward, if (s.live) "排队发送" else "发送任务", { vm.send(); focusManager.clearFocus(); keyboard?.hide() }, enabled = canSend, filled = true)
                }
            }
        }
        if (!newTask && s.live) Row(Modifier.fillMaxWidth().padding(start = 7.dp, end = 5.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("追加消息会排队，在当前轮结束后执行", fontSize = 10.sp, color = Muted, modifier = Modifier.weight(1f))
            if (s.draft.text.isNotBlank()) TextButton(onClick = vm::stop, enabled = "stop:${s.sessionId}" !in s.busyActions, modifier = Modifier.height(29.dp), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("停止当前轮", fontSize = 11.sp, color = Red) }
        }
    }
    preview?.let { a -> AlertDialog(onDismissRequest = { preview = null }, title = { Text(a.name) }, text = { if (a.isImage) AsyncImage(vm.authenticatedImage(a.fileId), "附件预览", modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp, max = 300.dp)) else SelectionContainer { Text(a.reference.ifBlank { "附件已上传至电脑。" }, fontFamily = Mono, fontSize = 12.sp) } }, confirmButton = { TextButton(onClick = { preview = null }) { Text("完成") } }, dismissButton = { TextButton(onClick = { vm.removeAttachment(a.fileId); preview = null }) { Text("移除附件") } }) }
}

@Composable fun ChatScreen(s: AppState, vm: MobileViewModel, sheet: (String) -> Unit, activity: (Turn) -> Unit, request: (Event) -> Unit) {
    val task = s.task
    val turns = remember(s.thread.events, s.thread.hot) { reduceTurns(s.thread) }
    val requests = remember(s.thread.events, s.thread.hot) { pendingRequests(s.thread) }
    val pending = s.pending.filter { it.sessionId == s.sessionId }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val latest by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 140 } }
    val newest = pending.lastOrNull()?.let { "pending:${it.id}" } ?: turns.lastOrNull()?.let { "turn:${it.id}" }.orEmpty()
    // Capture the old reading position before the new item is measured and anchored.
    val followNewItem = remember(newest) { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 140 }
    LaunchedEffect(newest) { if (newest.isNotBlank() && followNewItem) list.scrollToItem(0) }
    val ownRequest = s.scrollRequests[s.sessionId] ?: 0L
    var handledRequest by rememberSaveable { mutableLongStateOf(ownRequest) }
    LaunchedEffect(ownRequest) {
        if (ownRequest > handledRequest) { handledRequest = ownRequest; list.scrollToItem(0) }
    }
    Column(Modifier.fillMaxSize()) {
        MobileBar(task?.title ?: "加载任务…", (s.projects.find { it.id == task?.workspaceId }?.name ?: "") + " · " + agentLabel(task?.agent ?: "codex"), vm::back) {
            RoundButton(Icons.Outlined.FolderOpen, "项目文件", { sheet("files") })
            RoundButton(Icons.Outlined.MoreHoriz, "任务菜单", { sheet("task") })
        }
        HorizontalDivider(color = Line.copy(alpha = .55f))
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(state = list, reverseLayout = true, modifier = Modifier.fillMaxSize().semantics { contentDescription = "对话时间线" }, contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                items(pending.asReversed(), key = { "pending:${it.id}" }) { message -> PendingBubble(message, s.connection, vm) }
                items(turns.asReversed(), key = { "turn:${it.id}" }) { turn -> TurnBlock(turn, vm, { activity(turn) }, { request(it) }) }
                if (s.thread.error.isNotBlank()) item("error") { Column { ErrorStrip(s.thread.error); TextButton(onClick = vm::refresh) { Text("重新加载") } } }
                if (s.thread.hasMore) item("older") { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TextButton(onClick = vm::loadOlder, enabled = !s.thread.loading) { Text(if (s.thread.loading) "正在加载…" else "加载更早的对话", fontSize = 13.sp) } } }
                else if (s.thread.loading) item("loading") { BusyLine("正在同步对话") }
                else if (turns.isEmpty() && pending.isEmpty()) item("empty") { Column(Modifier.fillMaxWidth().padding(vertical = 45.dp), horizontalAlignment = Alignment.CenterHorizontally) { AgentMark(task?.agent ?: "codex", 40); Spacer(Modifier.height(15.dp)); Text("这个任务还没有消息", color = Muted); Text("在下方描述要做的事", fontSize = 13.sp, color = Muted) } }
            }
            if (!latest && turns.isNotEmpty()) FilledTonalIconButton(onClick = { scope.launch { list.animateScrollToItem(0) } }, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp).size(38.dp)) { Glyph(Icons.Outlined.ArrowDownward, "回到最新", Ink, 19) }
        }
        if (requests.isNotEmpty()) {
            val first = requests.first()
            Row(Modifier.fillMaxWidth().background(WarningSurface).clickable { request(first) }.padding(horizontal = 17.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph(if (first.kind == "question") Icons.Outlined.ChatBubbleOutline else Icons.Outlined.Shield, null, Amber, 20)
                Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) {
                    Text(if (first.kind == "question") "需要你回答" else "需要你批准", fontSize = 13.sp, color = Amber, fontWeight = FontWeight.SemiBold)
                    Text(first.data.str(if (first.kind == "question") "prompt" else "title"), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = Amber)
                }
                Text("处理" + if (requests.size > 1) " ${requests.size}" else "", color = Amber, fontSize = 13.sp); Glyph(Icons.Outlined.ChevronRight, null, Amber, 18)
            }
        }
        ErrorStrip(s.actionError, vm::clearError)
        Composer(s, vm, sheet)
    }
}

@Composable private fun UserBubble(text: String, images: List<String>, vm: MobileViewModel) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        if (images.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) { images.forEach { id -> AsyncImage(vm.authenticatedImage(id), "已发送的图片", modifier = Modifier.size(130.dp).background(Soft, RoundedCornerShape(12.dp))) } }
        if (text.isNotEmpty()) Surface(color = Soft, shape = RoundedCornerShape(20.dp, 20.dp, 5.dp, 20.dp), modifier = Modifier.widthIn(max = 310.dp)) { SelectionContainer { Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 15.dp, vertical = 12.dp)) } }
    }
}
@Composable private fun PendingBubble(p: PendingMessage, connection: String, vm: MobileViewModel) {
    Column {
        UserBubble(p.text, p.images, vm)
        Row(Modifier.fillMaxWidth().padding(top = 5.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            Text(when (p.status) { "queued" -> "已排队 · 当前轮结束后执行"; "sent" -> "已送达 · 等待开始"; "sending" -> "正在发送…"; "failed" -> "发送失败"; else -> if (connection == "online") "等待发送" else "连接恢复后发送" }, color = if (p.status == "failed") Red else Muted, fontSize = 11.sp)
            if (p.status == "failed") TextButton(onClick = { vm.retryMessage(p.id) }, contentPadding = PaddingValues(horizontal = 7.dp), modifier = Modifier.height(30.dp)) { Text("重试", fontSize = 12.sp) }
            if (p.status == "pending") TextButton(onClick = { vm.cancelPending(p.id) }, contentPadding = PaddingValues(horizontal = 7.dp), modifier = Modifier.height(30.dp)) { Text("取消", fontSize = 12.sp) }
        }
        if (p.status == "failed") Text(p.error, color = Red, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.fillMaxWidth().padding(top = 3.dp), textAlign = TextAlign.End)
    }
}
@Composable private fun TurnBlock(turn: Turn, vm: MobileViewModel, activity: () -> Unit, request: (Event) -> Unit) {
    val terminal = turn.state in setOf("completed", "failed", "interrupted")
    val clipboard = LocalClipboardManager.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(15.dp)) {
        turn.user?.let { UserBubble(it.data.str("text"), it.data.optJSONArray("images").strings(), vm) }
        val work = turn.steps.filter { it.kind !in setOf("assistant.message", "usage", "approval.resolved") }
        val live = turn.live.lastOrNull { it.kind in setOf("command", "tool.call", "reasoning", "assistant.message") }
        if (work.isNotEmpty() || !terminal) Row(Modifier.fillMaxWidth().clickable(onClick = activity).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!terminal && turn.state != "waiting") CircularProgressIndicator(Modifier.size(13.dp), color = Muted, strokeWidth = 1.5.dp) else Glyph(if (turn.state == "completed") Icons.Outlined.Check else if (turn.state == "waiting") Icons.Outlined.PauseCircleOutline else Icons.Outlined.Info, null, if (turn.state == "failed") Red else Muted, 16)
            Spacer(Modifier.width(8.dp))
            Text(if (terminal) "${if (turn.state == "completed") "已完成" else statusName(turn.state)} · ${work.size} 个步骤" else when (turn.state) { "waiting" -> "等待你处理请求"; "starting" -> "正在启动任务…"; else -> when (live?.kind) { "command" -> live.data.str("label").ifBlank { "正在运行命令" }; "tool.call" -> "正在使用 ${live.data.str("name")}"; "assistant.message" -> "正在回复…"; else -> "正在思考…" } }, color = if (turn.state == "waiting") Amber else Muted, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Glyph(Icons.Outlined.ChevronRight, "查看执行步骤", Muted, 16)
        }
        val plan = (turn.live + turn.steps.asReversed()).firstOrNull { it.kind == "plan" }
        if (plan != null && !terminal) Column(Modifier.background(Soft, RoundedCornerShape(12.dp)).padding(13.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            plan.data.items("items").forEach { row -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Glyph(if (row.str("status") == "completed") Icons.Outlined.CheckCircleOutline else Icons.Outlined.RadioButtonUnchecked, null, if (row.str("status") == "in_progress") Blue else Muted, 15); Text(row.str("text"), fontSize = 13.sp, lineHeight = 20.sp) } }
        }
        if (!terminal) {
            val assistants = (turn.steps.filter { it.kind == "assistant.message" } + turn.live.filter { it.kind == "assistant.message" }).distinctBy { it.key }
            assistants.forEach { if (it.data.str("text").isNotBlank()) RichText(it.data.str("text")) }
        } else turn.answer.forEach { RichText(it.data.str("text")) }
        if (turn.state == "failed") {
            val error = turn.steps.lastOrNull { it.kind == "error" }?.data?.str("message") ?: turn.completed?.data?.str("reason").orEmpty()
            Text(error.ifBlank { "这一轮执行失败。可以补充说明后继续发送。" }, color = Red, fontSize = 13.sp, lineHeight = 21.sp)
        } else if (turn.state == "interrupted" && turn.answer.isEmpty()) Text("这一轮已停止。你可以继续补充要求。", color = Muted, fontSize = 13.sp)
        if (turn.changes.isNotEmpty()) Surface(onClick = { vm.showChanges(turn.changes) }, shape = RoundedCornerShape(13.dp), color = Paper, border = BorderStroke(1.dp, Line)) {
            Row(Modifier.fillMaxWidth().padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph(Icons.Outlined.Difference, null, Muted, 19); Spacer(Modifier.width(9.dp)); Text("审阅 ${turn.changes.size} 个文件的改动", fontSize = 13.sp, modifier = Modifier.weight(1f))
                Text("+${turn.changes.sumOf { it.added }}", color = Green, fontFamily = Mono, fontSize = 12.sp); Spacer(Modifier.width(5.dp)); Text("−${turn.changes.sumOf { it.removed }}", color = Red, fontFamily = Mono, fontSize = 12.sp); Glyph(Icons.Outlined.ChevronRight, null, Muted, 16)
            }
        }
        if (terminal && turn.answer.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
            IconButton(onClick = { clipboard.setText(AnnotatedString(turn.answer.joinToString("\n\n") { it.data.str("text") })) }, modifier = Modifier.size(30.dp)) { Glyph(Icons.Outlined.ContentCopy, "复制回复", Muted, 16) }
            TextButton(onClick = activity, modifier = Modifier.height(30.dp), contentPadding = PaddingValues(horizontal = 8.dp)) { Text("执行详情", fontSize = 11.sp, color = Muted) }
        }
    }
}
