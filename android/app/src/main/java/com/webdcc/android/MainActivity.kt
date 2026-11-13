package com.webdcc.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val vm: MobileViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { val theme by vm.themeMode.collectAsStateWithLifecycle(); MobileTheme(theme) { MobileApp(vm) } }
        if (savedInstanceState == null) receive(intent)
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receive(intent) }
    private fun receive(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") vm.handleIncoming(intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty())
    }
    override fun onStart() { super.onStart(); vm.setForeground(true) }
    override fun onStop() { vm.setForeground(false); super.onStop() }
}

data class SheetTarget(val name: String, val event: Event? = null, val turn: Turn? = null)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun MobileApp(vm: MobileViewModel) {
    val s by vm.state.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf<SheetTarget?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val pages = rememberSaveableStateHolder()
    var pickKey by rememberSaveable { mutableStateOf("") }
    var pickProject by rememberSaveable { mutableStateOf("") }
    var pickOrigin by rememberSaveable { mutableStateOf("") }
    // Registration outlives the sheet and survives the system document picker.
    val documentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) vm.upload(uri, pickKey, pickProject, pickOrigin)
        pickKey = ""; pickProject = ""; pickOrigin = ""
    }
    LaunchedEffect(s.notice) { if (s.notice.isNotBlank()) { snackbar.showSnackbar(s.notice, duration = SnackbarDuration.Short); vm.clearNotice() } }
    BackHandler(enabled = s.route != "home" && sheet == null && !(s.route == "connect" && s.address.isBlank())) { vm.back() }
    Surface(color = Paper, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Column(Modifier.fillMaxSize()) {
                if (s.route != "connect") ConnectionBanner(s, vm)
                when (s.route) {
                    "connect" -> ConnectScreen(s, vm) { sheet = SheetTarget(it) }
                    "home" -> pages.SaveableStateProvider("home") { HomeScreen(s, vm) { sheet = SheetTarget(it) } }
                    "new" -> pages.SaveableStateProvider("new:${s.projectId}") { NewTaskScreen(s, vm) { sheet = SheetTarget(it) } }
                    "chat" -> pages.SaveableStateProvider("chat:${s.sessionId}") { ChatScreen(s, vm, { sheet = SheetTarget(it) }, { sheet = SheetTarget("activity", turn = it) }, { sheet = SheetTarget("request", event = it) }) }
                    "viewer" -> s.viewer?.let { v -> pages.SaveableStateProvider("viewer:${v.diffMode}:${v.path}:${v.changes.hashCode()}") { ViewerScreen(s, vm) } }
                }
            }
            SnackbarHost(snackbar, modifier = Modifier.align(androidx.compose.ui.Alignment.BottomCenter).padding(bottom = if (s.route in setOf("new", "chat")) 145.dp else 12.dp))
        }
    }
    sheet?.let { target ->
        ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Paper, dragHandle = { BottomSheetDefaults.DragHandle(color = Line) }) {
            val requestId = target.event?.let { it.data.str(if (it.kind == "question") "questionId" else "approvalId") }.orEmpty()
            pages.SaveableStateProvider("sheet:${target.name}:${s.projectId}:${s.sessionId}:$requestId") {
                SheetContent(target, s, vm, { sheet = null }, { sheet = SheetTarget(it) }) { types ->
                    pickKey = s.draftKey; pickProject = s.task?.workspaceId ?: s.projectId; pickOrigin = s.address
                    documentPicker.launch(types)
                }
            }
        }
    }
}
