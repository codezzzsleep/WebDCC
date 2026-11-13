package com.webdcc.android

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.commonmark.Extension
import org.commonmark.ext.gfm.tables.*
import org.commonmark.node.*
import org.commonmark.parser.Parser

private val markdownParser: Parser = Parser.builder().extensions(listOf<Extension>(TablesExtension.create())).build()
private fun Node.children(): List<Node> = buildList { var n = firstChild; while (n != null) { add(n); n = n.next } }

@Composable fun RichText(text: String, modifier: Modifier = Modifier) {
    val document = remember(text) { markdownParser.parse(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(11.dp)) { document.children().forEach { MarkdownBlock(it) } }
}
@Composable private fun MarkdownBlock(node: Node) {
    when (node) {
        is org.commonmark.node.Paragraph -> SelectionContainer { Text(inlineText(node), style = MaterialTheme.typography.bodyLarge) }
        is Heading -> SelectionContainer { Text(inlineText(node), fontSize = (when (node.level) { 1 -> 24; 2 -> 21; else -> 18 }).sp, fontWeight = FontWeight.SemiBold, lineHeight = 29.sp, modifier = Modifier.padding(top = 6.dp)) }
        is FencedCodeBlock -> CodeBlock(node.literal.trimEnd('\n'), node.info.orEmpty().substringBefore(' '))
        is IndentedCodeBlock -> CodeBlock(node.literal.trimEnd('\n'), "")
        is BulletList -> Column(verticalArrangement = Arrangement.spacedBy(7.dp)) { node.children().forEach { child -> Row { Text("•", color = Muted, modifier = Modifier.width(20.dp)); Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { child.children().forEach { MarkdownBlock(it) } } } } }
        is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(7.dp)) { node.children().forEachIndexed { i, child -> Row { Text("${node.markerStartNumber + i}.", color = Muted, modifier = Modifier.width(27.dp)); Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { child.children().forEach { MarkdownBlock(it) } } } } }
        is BlockQuote -> Row { Box(Modifier.width(3.dp).heightIn(min = 24.dp).background(Line)); Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) { node.children().forEach { MarkdownBlock(it) } } }
        is ThematicBreak -> HorizontalDivider(Modifier.padding(vertical = 5.dp), color = Line)
        is TableBlock -> MarkdownTable(node)
        is HtmlBlock -> SelectionContainer { Text(node.literal, color = Muted, style = MaterialTheme.typography.bodyMedium) }
        else -> Column(verticalArrangement = Arrangement.spacedBy(7.dp)) { node.children().forEach { MarkdownBlock(it) } }
    }
}
@Composable private fun inlineText(node: Node): AnnotatedString {
    val codeBackground = Soft
    val linkColor = Blue
    return buildAnnotatedString {
    fun appendNode(n: Node) {
        when (n) {
            is org.commonmark.node.Text -> append(n.literal)
            is Code -> withStyle(SpanStyle(fontFamily = Mono, fontSize = 14.sp, background = codeBackground)) { append(n.literal) }
            is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { n.children().forEach { appendNode(it) } }
            is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { n.children().forEach { appendNode(it) } }
            is Link -> {
                val safe = n.destination.startsWith("https://") || n.destination.startsWith("http://") || n.destination.startsWith("mailto:")
                if (safe) withLink(LinkAnnotation.Url(n.destination, TextLinkStyles(style = SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)))) { n.children().forEach { appendNode(it) } }
                else n.children().forEach { appendNode(it) }
            }
            is SoftLineBreak -> append("\n")
            is HardLineBreak -> append("\n")
            is HtmlInline -> append(n.literal)
            is Image -> { append("[图片] "); n.children().forEach { appendNode(it) } }
            else -> n.children().forEach { appendNode(it) }
        }
    }
    node.children().forEach { appendNode(it) }
    }
}
@Composable fun CodeBlock(code: String, language: String = "", title: String = "") {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { kotlinx.coroutines.delay(1600); copied = false } }
    Surface(color = Soft, shape = RoundedCornerShape(13.dp), modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 13.dp, end = 5.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(title.ifBlank { language.ifBlank { "代码" } }, fontSize = 11.sp, color = Muted, modifier = Modifier.weight(1f))
                TextButton(onClick = { clipboard.setText(AnnotatedString(code)); copied = true }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.height(34.dp)) {
                    Glyph(Icons.Outlined.ContentCopy, null, Muted, 13); Spacer(Modifier.width(5.dp)); Text(if (copied) "已复制" else "复制", fontSize = 11.sp, color = Muted)
                }
            }
            SelectionContainer { Text(code, fontFamily = Mono, fontSize = 13.sp, lineHeight = 20.sp, modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 13.dp, end = 13.dp, bottom = 14.dp)) }
        }
    }
}
@Composable private fun MarkdownTable(table: TableBlock) {
    val rows = table.children().flatMap { it.children() }
    Column(Modifier.horizontalScroll(rememberScrollState()).background(Soft, RoundedCornerShape(8.dp))) {
        rows.forEach { row ->
            Row(Modifier.padding(vertical = 8.dp)) {
                row.children().forEach { cell -> SelectionContainer { Text(inlineText(cell), fontSize = 13.sp, lineHeight = 20.sp, fontWeight = if (cell is TableCell && cell.isHeader) FontWeight.SemiBold else FontWeight.Normal, modifier = Modifier.width(160.dp).padding(horizontal = 10.dp)) } }
            }
            HorizontalDivider(color = Line)
        }
    }
}
