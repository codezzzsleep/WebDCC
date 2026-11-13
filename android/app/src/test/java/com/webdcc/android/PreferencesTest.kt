package com.webdcc.android

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class PreferencesTest {
    @Test fun firstInstallAndUnknownStoredValuesFollowTheSystem() {
        assertEquals(ThemeMode.SYSTEM, ThemeMode.parse(null))
        assertEquals(ThemeMode.SYSTEM, ThemeMode.parse("old-invalid-setting"))
        assertFalse(ThemeMode.SYSTEM.isDark(false))
        assertTrue(ThemeMode.SYSTEM.isDark(true))
        assertTrue(ThemeMode.DARK.isDark(false))
        assertFalse(ThemeMode.LIGHT.isDark(true))
    }
    @Test fun nativeAgentsExposeTheirActualUpstreamEffortChoices() {
        assertEquals(listOf("minimal", "low", "medium", "high", "xhigh", "max"), reasoningChoices("codex").values)
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), reasoningChoices("claude-code").values)
        assertEquals("medium", reasoningChoices("codex").default)
        assertTrue(reasoningChoices("dsh").values.isEmpty())
    }
    @Test fun declaredModelCapabilitiesReplaceGenericDefaultsAndPreserveCustomCodexLevels() {
        val limited = reasoningChoices("codex", listOf("low", "high", "high"), "high")
        assertEquals(listOf("low", "high"), limited.values)
        assertEquals("high", limited.default)
        assertEquals("high", preservedEffort(limited, "xhigh"))
        assertEquals("low", preservedEffort(limited, "low", "high"))
        assertEquals(listOf("reasoning-v2"), reasoningChoices("codex", listOf("reasoning-v2")).values)
        assertTrue(reasoningChoices("codex", emptyList()).values.isEmpty())
        assertEquals(listOf("high"), reasoningChoices("claude-code", listOf("minimal", "off", "high")).values)
    }
    @Test fun providerAndNativeModelMetadataAreBothUnderstood() {
        val provider = Provider("p", obj("modelDetails" to JSONArray(listOf(obj("id" to "m", "reasoningEfforts" to JSONArray(listOf("low", "high")))))))
        val native = AgentInfo("codex", obj("models" to JSONArray(listOf(obj("id" to "native", "supportedReasoningEfforts" to JSONArray(listOf(obj("reasoningEffort" to "xhigh"))))))))
        val s = AppState(providers = listOf(provider), agents = listOf(native))
        assertEquals(listOf("low", "high"), s.reasoningFor("codex", "p", "m").values)
        assertEquals(listOf("xhigh"), s.reasoningFor("codex", null, "native").values)
    }
    @Test fun dshUsesTheSelectedModelsCapabilitiesInsteadOfAnUnrelatedDefaultModel() {
        val config = obj("official" to false, "defaultModel" to obj("model" to "a"), "reasoningEfforts" to JSONArray(listOf("high")),
            "provider" to obj("models" to JSONArray(listOf(obj("id" to "b", "reasoningEfforts" to obj("off" to "Off", "deep" to "Deep"))))))
        val s = AppState(dshSettings = config)
        assertEquals(listOf("high"), s.reasoningFor("dsh", null, "a").values)
        assertEquals(setOf("off", "deep"), s.reasoningFor("dsh", null, "b").values.toSet())
    }
}
