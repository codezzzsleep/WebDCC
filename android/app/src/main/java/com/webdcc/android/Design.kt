package com.webdcc.android

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import androidx.core.view.WindowCompat

@Immutable data class MobilePalette(
    val ink: Color, val paper: Color, val soft: Color, val line: Color, val muted: Color,
    val blue: Color, val green: Color, val amber: Color, val red: Color, val onAction: Color,
    val primaryContainer: Color, val warningSurface: Color, val diffAdd: Color, val diffRemove: Color
)
val LightPalette = MobilePalette(
    Color(0xFF15181D), Color(0xFFFCFCFD), Color(0xFFF2F3F5), Color(0xFFE3E5E9), Color(0xFF707681),
    Color(0xFF3562D6), Color(0xFF217A53), Color(0xFF98621E), Color(0xFFBA3D3C), Color.White,
    Color(0xFFEAF0FF), Color(0xFFFFF7EA), Color(0xFFE9F6ED), Color(0xFFFFEDED)
)
val DarkPalette = MobilePalette(
    Color(0xFFE9ECF1), Color(0xFF101318), Color(0xFF1D222B), Color(0xFF373E49), Color(0xFFA5AFBD),
    Color(0xFF98B7FF), Color(0xFF78D7AA), Color(0xFFF0C680), Color(0xFFFFB4AB), Color(0xFF101318),
    Color(0xFF233655), Color(0xFF342A1A), Color(0xFF18382A), Color(0xFF412528)
)
val LocalMobilePalette = staticCompositionLocalOf { LightPalette }
val Ink: Color @Composable get() = LocalMobilePalette.current.ink
val Paper: Color @Composable get() = LocalMobilePalette.current.paper
val Soft: Color @Composable get() = LocalMobilePalette.current.soft
val Line: Color @Composable get() = LocalMobilePalette.current.line
val Muted: Color @Composable get() = LocalMobilePalette.current.muted
val Blue: Color @Composable get() = LocalMobilePalette.current.blue
val Green: Color @Composable get() = LocalMobilePalette.current.green
val Amber: Color @Composable get() = LocalMobilePalette.current.amber
val Red: Color @Composable get() = LocalMobilePalette.current.red
val OnAction: Color @Composable get() = LocalMobilePalette.current.onAction
val WarningSurface: Color @Composable get() = LocalMobilePalette.current.warningSurface
val DiffAdd: Color @Composable get() = LocalMobilePalette.current.diffAdd
val DiffRemove: Color @Composable get() = LocalMobilePalette.current.diffRemove
val Mono = FontFamily.Monospace

private fun Context.activity(): Activity? = when (this) { is Activity -> this; is ContextWrapper -> baseContext.activity(); else -> null }
@Composable fun MobileTheme(mode: ThemeMode = ThemeMode.SYSTEM, content: @Composable () -> Unit) {
    val dark = mode.isDark(isSystemInDarkTheme())
    val p = if (dark) DarkPalette else LightPalette
    val activity = LocalContext.current.activity()
    SideEffect {
        activity?.window?.let { window ->
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            @Suppress("DEPRECATION")
            run { window.statusBarColor = android.graphics.Color.TRANSPARENT; window.navigationBarColor = if (Build.VERSION.SDK_INT < 27) LightPalette.ink.toArgb() else android.graphics.Color.TRANSPARENT }
            if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        }
    }
    val base = if (dark) darkColorScheme() else lightColorScheme()
    CompositionLocalProvider(LocalMobilePalette provides p) {
    MaterialTheme(
        colorScheme = base.copy(primary = p.ink, onPrimary = p.onAction, secondary = p.blue, background = p.paper, onBackground = p.ink, surface = p.paper,
            primaryContainer = p.primaryContainer, onPrimaryContainer = p.blue, secondaryContainer = p.soft, onSecondaryContainer = p.ink,
            surfaceContainer = p.soft, surfaceContainerLow = p.soft, surfaceContainerHigh = p.soft, surfaceContainerHighest = p.soft,
            surfaceVariant = p.soft, surfaceTint = Color.Transparent, onSurface = p.ink, onSurfaceVariant = p.muted, outline = p.line, outlineVariant = p.line, error = p.red),
        typography = Typography(
            headlineLarge = androidx.compose.ui.text.TextStyle(fontSize = 30.sp, lineHeight = 39.sp, fontWeight = FontWeight.SemiBold),
            headlineMedium = androidx.compose.ui.text.TextStyle(fontSize = 25.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
            titleLarge = androidx.compose.ui.text.TextStyle(fontSize = 21.sp, lineHeight = 29.sp, fontWeight = FontWeight.SemiBold),
            titleMedium = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium),
            bodyLarge = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 25.sp),
            bodyMedium = androidx.compose.ui.text.TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
            labelSmall = androidx.compose.ui.text.TextStyle(fontSize = 11.sp, lineHeight = 16.sp)
        ), content = content
    )
    }
}
@Composable fun Glyph(icon: ImageVector, description: String? = null, tint: Color = Ink, size: Int = 20) { Icon(icon, description, tint = tint, modifier = Modifier.size(size.dp)) }
@Composable fun RoundButton(icon: ImageVector, description: String, onClick: () -> Unit, enabled: Boolean = true, filled: Boolean = false) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(46.dp).then(if (filled) Modifier.background(if (enabled) Ink else Line, CircleShape) else Modifier)) {
        Glyph(icon, description, if (filled) OnAction else if (enabled) Ink else Muted, 22)
    }
}
@Composable fun MobileBar(title: String, subtitle: String = "", back: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Row(Modifier.fillMaxWidth().heightIn(min = 62.dp).padding(start = if (back == null) 20.dp else 4.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (back != null) RoundButton(Icons.AutoMirrored.Outlined.ArrowBack, "返回", back)
        Column(Modifier.weight(1f).padding(start = if (back == null) 0.dp else 4.dp, end = 8.dp)) {
            Text(title, style = if (back == null) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, fontSize = 12.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}
@Composable fun Pill(label: String, icon: ImageVector? = null, selected: Boolean = false, onClick: () -> Unit) {
    Row(Modifier.heightIn(min = 36.dp).background(if (selected) Ink else Color.Transparent, RoundedCornerShape(20.dp))
        .border(1.dp, if (selected) Ink else Line, RoundedCornerShape(20.dp)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        if (icon != null) Glyph(icon, null, if (selected) OnAction else Muted, 16)
        Text(label, color = if (selected) OnAction else Ink, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
@Composable fun AgentMark(agent: String, size: Int = 32) {
    Box(Modifier.size(size.dp).background(Soft, RoundedCornerShape((size / 3).dp)), contentAlignment = Alignment.Center) {
        Text(when (agent) { "codex" -> ">_"; "claude-code" -> "✳"; else -> "dsh" }, fontFamily = Mono, fontWeight = FontWeight.Medium, fontSize = (size * .4f).sp)
    }
}
fun statusName(status: String) = when (status) { "running" -> "进行中"; "waiting" -> "待处理"; "error", "failed" -> "异常"; "starting" -> "启动中"; "interrupted" -> "已停止"; else -> "已完成" }
@Composable fun statusColor(status: String) = when (status) { "running", "starting" -> Blue; "waiting" -> Amber; "error", "failed" -> Red; "interrupted" -> Muted; else -> Green }
@Composable fun StatusDot(status: String, showLabel: Boolean = true) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(6.dp).background(statusColor(status), CircleShape))
        if (showLabel) Text(statusName(status), color = statusColor(status), fontSize = 12.sp)
    }
}
@Composable fun ErrorStrip(message: String, onDismiss: (() -> Unit)? = null) {
    if (message.isBlank()) return
    var expanded by remember(message) { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().background(Red.copy(alpha = .06f)).padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(message, color = Red, fontSize = 13.sp, lineHeight = 19.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).clickable { expanded = true })
        if (onDismiss != null) IconButton(onClick = onDismiss, modifier = Modifier.size(36.dp)) { Glyph(Icons.Outlined.Close, "关闭错误提示", Red, 18) }
    }
    if (expanded) AlertDialog(onDismissRequest = { expanded = false }, title = { Text("错误详情") }, text = { androidx.compose.foundation.text.selection.SelectionContainer { Text(message, fontSize = 13.sp) } }, confirmButton = { TextButton(onClick = { expanded = false }) { Text("关闭") } })
}
@Composable fun BusyLine(label: String) { Row(Modifier.padding(20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text(label, fontSize = 13.sp, color = Muted) } }
fun relativeTime(value: String): String = runCatching {
    val instant = Instant.parse(value)
    val minutes = (System.currentTimeMillis() - instant.toEpochMilli()) / 60000
    when { minutes < 1 -> "刚刚"; minutes < 60 -> "${minutes}分钟前"; minutes < 1440 -> "${minutes / 60}小时前"; else -> DateTimeFormatter.ofPattern("MM/dd").withZone(ZoneId.systemDefault()).format(instant) }
}.getOrDefault("")
