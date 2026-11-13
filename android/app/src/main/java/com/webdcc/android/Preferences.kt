package com.webdcc.android

enum class ThemeMode(val id: String, val label: String) {
    SYSTEM("system", "跟随系统"), LIGHT("light", "亮色"), DARK("dark", "暗色");
    companion object { fun parse(value: String?) = entries.find { it.id == value } ?: SYSTEM }
}
fun ThemeMode.isDark(systemDark: Boolean) = when (this) { ThemeMode.SYSTEM -> systemDark; ThemeMode.LIGHT -> false; ThemeMode.DARK -> true }

/** No model guessing: declared capabilities win; fallbacks match the pinned WebDCC Agent UI. */
data class ReasoningChoices(val values: List<String>, val default: String, val declared: Boolean = false)

private val codexEfforts = listOf("minimal", "low", "medium", "high", "xhigh", "max")
private val claudeEfforts = listOf("low", "medium", "high", "xhigh", "max")

fun reasoningChoices(agent: String, declared: List<String>? = null, modelDefault: String = ""): ReasoningChoices {
    val values = (declared ?: when (agent) { "codex" -> codexEfforts; "claude-code" -> claudeEfforts; else -> emptyList() })
        .filter { it.isNotBlank() && (agent != "claude-code" || it in claudeEfforts) }.distinct()
    val preferred = modelDefault.takeIf { it in values } ?: "medium".takeIf { it in values } ?: values.firstOrNull().orEmpty()
    return ReasoningChoices(values, preferred, declared != null)
}
fun preservedEffort(choices: ReasoningChoices, previous: String = "", remembered: String = ""): String =
    previous.takeIf { it in choices.values } ?: remembered.takeIf { it in choices.values } ?: choices.default

fun effortLabel(id: String) = when (id) {
    "none", "off", "disabled" -> "关闭"
    "minimal" -> "最小"
    "low" -> "低"
    "medium" -> "中"
    "high" -> "高"
    "xhigh" -> "超高"
    "max" -> "最高"
    else -> id.ifBlank { "模型默认" }
}
fun effortDescription(id: String) = when (id) {
    "none", "off", "disabled" -> "使用模型提供的不启用思考选项。"
    "minimal" -> "优先响应速度，适合简单操作。"
    "low" -> "较快响应，适合常规小任务。"
    "medium" -> "平衡响应速度与思考深度。"
    "high" -> "投入更多思考，适合较复杂的修改。"
    "xhigh" -> "更深入地分析复杂问题，可能需要更长时间。"
    "max" -> "使用模型提供的最高思考等级。"
    else -> "模型提供的自定义思考等级。"
}

private fun org.json.JSONObject.effortDeclaration(): List<String>? {
    if (has("reasoningEfforts")) return when (val value = opt("reasoningEfforts")) {
        is org.json.JSONArray -> value.strings()
        is org.json.JSONObject -> value.keys().asSequence().toList()
        else -> null
    }
    if (has("supportedReasoningEfforts")) return optJSONArray("supportedReasoningEfforts")?.let { a ->
        (0 until a.length()).mapNotNull { i -> when (val value = a.opt(i)) { is org.json.JSONObject -> value.str("reasoningEffort", value.str("id")); is String -> value; else -> null } }
    }
    return null
}
fun AppState.reasoningFor(agent: String, providerId: String?, model: String): ReasoningChoices {
    val native = agents.find { it.id == agent }?.models?.find { it.str("id") == model }
    val detail = providers.find { it.id == providerId }?.raw?.items("modelDetails")?.find { it.str("id") == model }
    var declared = detail?.effortDeclaration() ?: native?.effortDeclaration()
    var modelDefault = detail?.str("defaultReasoningEffort", detail.str("defaultReasoning"))
        ?: native?.str("defaultReasoningEffort", native.str("defaultReasoning")).orEmpty()
    if (agent == "dsh" && declared == null) {
        val config = dshSettings
        val provider = config?.optJSONObject("provider")
        val dshModel = provider?.items("models")?.find { it.str("id") == model }
        val isDefaultModel = config?.optJSONObject("defaultModel")?.str("model") == model
        declared = if (config?.optBoolean("official") == true || isDefaultModel) config?.optJSONArray("reasoningEfforts")?.strings()
            else dshModel?.effortDeclaration() ?: provider?.effortDeclaration()
        modelDefault = dshModel?.str("reasoning").orEmpty().ifBlank { config?.str("defaultReasoning").orEmpty() }
    }
    return reasoningChoices(agent, declared, modelDefault)
}
fun AppState.currentReasoningChoices(): ReasoningChoices = if (route == "new") reasoningFor(selection.agent, selection.providerId, selection.model)
    else task?.let { reasoningFor(it.agent, it.providerId.ifBlank { null }, it.model) } ?: reasoningChoices("")
