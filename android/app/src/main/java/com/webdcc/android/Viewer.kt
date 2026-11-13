package com.webdcc.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class CodeLine(val text: String, val old: String, val new: String, val kind: Char)
fun diffLines(text: String): List<CodeLine> {
    var old = 0; var new = 0
    val hunk = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@.*")
    return text.lines().filterNot { it.isEmpty() || it.startsWith("diff --git ") || it.startsWith("index ") || it.startsWith("--- ") || it.startsWith("+++ ") }.map { line ->
        val match = hunk.matchEntire(line)
        when {
            match != null -> { old = match.groupValues[1].toInt(); new = match.groupValues[2].toInt(); CodeLine(line, "", "", '@') }
            line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") -> CodeLine(line, "", "", '@')
            line.startsWith("+") -> CodeLine(line, "", (new++).toString(), '+')
            line.startsWith("-") -> CodeLine(line, (old++).toString(), "", '-')
            line.startsWith(" ") -> CodeLine(line, (old++).toString(), (new++).toString(), ' ')
            else -> CodeLine(line, "", "", ' ')
        }
    }
}
@Composable fun ViewerScreen(s: AppState, vm: MobileViewModel) {
    val v = s.viewer ?: return
    val clipboard = LocalClipboardManager.current
    var commenting by rememberSaveable(v.path, v.selected, v.diffMode) { mutableStateOf(false) }
    var selectedLine by rememberSaveable(v.path, v.selected, v.diffMode) { mutableStateOf("") }
    var comment by rememberSaveable(v.path, v.selected, v.diffMode) { mutableStateOf("") }
    val lines = remember(v.content, v.diffMode) { if (v.diffMode) diffLines(v.content) else v.content.lines().mapIndexed { index, line -> CodeLine(line, "", (index + 1).toString(), ' ') } }
    val codeWidth = maxOf(LocalConfiguration.current.screenWidthDp, minOf(2400, (lines.maxOfOrNull { it.text.length } ?: 0) * 8 + 94)).dp
    Column(Modifier.fillMaxSize()) {
        MobileBar(if (v.diffMode) "改动审阅" else v.title, v.path, vm::back) {
            RoundButton(Icons.Outlined.ContentCopy, "复制文件内容", { clipboard.setText(AnnotatedString(v.content)) }, enabled = !v.loading && v.content.isNotEmpty())
            if (v.diffMode) RoundButton(Icons.Outlined.ChatBubbleOutline, "添加审阅意见", { selectedLine = ""; commenting = true })
        }
        if (v.diffMode) {
            LazyRow(contentPadding = PaddingValues(horizontal = 15.dp, vertical = 7.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                itemsIndexed(v.changes) { i, c -> FilterChip(selected = v.selected == i, onClick = { vm.selectChange(i) }, label = { Text(c.path, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 240.dp)) }) }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("+${v.changes[v.selected].added}", color = Green, fontFamily = Mono, fontSize = 12.sp); Spacer(Modifier.width(8.dp)); Text("−${v.changes[v.selected].removed}", color = Red, fontFamily = Mono, fontSize = 12.sp)
                Spacer(Modifier.weight(1f)); TextButton(onClick = { vm.showFile(v.path) }, modifier = Modifier.height(30.dp), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("查看源文件", fontSize = 12.sp) }
            }
            Text("点击代码行可添加审阅意见", color = Muted, fontSize = 11.sp, modifier = Modifier.padding(start = 20.dp, bottom = 12.dp))
        } else Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${lines.size} 行", color = Muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = vm::referenceViewedFile) { Text("引用到消息", fontSize = 12.sp) }
        }
        HorizontalDivider(color = Line)
        when {
            v.loading -> BusyLine("正在读取文件…")
            v.error.isNotBlank() -> Column { ErrorStrip(v.error); TextButton(onClick = { if (v.diffMode) vm.selectChange(v.selected) else vm.showFile(v.path) }) { Text("重试") } }
            v.content.isBlank() -> Text(if (v.diffMode) "Agent 没有提供可显示的 diff，可查看源文件或添加审阅意见。" else "这个文件是空的。", color = Muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(24.dp))
            else -> Box(Modifier.weight(1f).fillMaxWidth().horizontalScroll(rememberScrollState())) {
                LazyColumn(Modifier.width(codeWidth).fillMaxHeight(), state = rememberLazyListState(), contentPadding = PaddingValues(vertical = 10.dp)) {
                    itemsIndexed(lines) { _, line ->
                        val bg = when (line.kind) { '+' -> DiffAdd; '-' -> DiffRemove; '@' -> Soft; else -> Paper }
                        Row(Modifier.fillMaxWidth().background(bg).then(if (v.diffMode) Modifier.clickable { selectedLine = line.new.ifBlank { line.old }; commenting = true }.semantics { contentDescription = "审阅第 ${line.new.ifBlank { line.old }} 行" } else Modifier).padding(vertical = 3.dp)) {
                            Text(if (v.diffMode) line.old.padStart(4) + " " + line.new.padStart(4) else line.new.padStart(4), color = Muted, fontFamily = Mono, fontSize = 11.sp, modifier = Modifier.width(if (v.diffMode) 76.dp else 45.dp).padding(start = 7.dp))
                            SelectionContainer { Text(line.text.ifEmpty { " " }, fontFamily = Mono, fontSize = 13.sp, lineHeight = 19.sp, softWrap = false, color = if (line.kind == '@') Muted else Ink, modifier = Modifier.padding(start = 8.dp, end = 16.dp)) }
                        }
                    }
                }
            }
        }
    }
    if (commenting) AlertDialog(onDismissRequest = { commenting = false }, title = { Text(if (selectedLine.isBlank()) "添加审阅意见" else "第 $selectedLine 行") }, text = {
        Column { Text(v.path, color = Muted, fontFamily = Mono, fontSize = 12.sp); Spacer(Modifier.height(12.dp)); OutlinedTextField(comment, { comment = it }, label = { Text("需要 Agent 检查或修改什么？") }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth()) }
    }, confirmButton = { TextButton(onClick = { commenting = false; vm.reviewComment(selectedLine, comment) }, enabled = comment.isNotBlank()) { Text("放入输入框") } }, dismissButton = { TextButton(onClick = { commenting = false }) { Text("取消") } })
}
