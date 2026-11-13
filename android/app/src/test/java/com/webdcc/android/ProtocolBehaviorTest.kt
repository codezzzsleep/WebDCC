package com.webdcc.android

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class ProtocolBehaviorTest {
    private fun event(seq: Long, key: String, kind: String, data: org.json.JSONObject, turn: String = "t") = Event("s", seq, turn, key, kind, data)
    @Test fun completedAnswerUsesAuthoritativeKeysAndPreservesMarkdown() {
        val thread = ThreadData(events = listOf(
            event(1, "u", "user.message", obj("text" to "修复")),
            event(2, "start", "turn.started", obj()),
            event(3, "comment", "assistant.message", obj("text" to "先检查文件")),
            event(4, "tool", "command", obj("command" to "ls", "status" to "completed")),
            event(5, "answer", "assistant.message", obj("text" to "已修复。\n\n```kt\nval a = 1\n```")),
            event(6, "done", "turn.completed", obj("status" to "completed", "answerItemKeys" to JSONArray(listOf("answer"))))
        ))
        val turn = reduceTurns(thread).single()
        assertEquals("completed", turn.state)
        assertEquals(listOf("answer"), turn.answer.map { it.key })
        assertTrue(turn.answer.single().data.str("text").contains("```kt"))
        assertTrue(turn.steps.any { it.key == "comment" })
    }
    @Test fun emptyAuthoritativeAnswerDoesNotTurnInterimTextIntoResult() {
        val thread = ThreadData(events = listOf(
            event(1, "comment", "assistant.message", obj("text" to "正在修改")),
            event(2, "done", "turn.completed", obj("status" to "interrupted", "answerItemKeys" to JSONArray()))
        ))
        assertTrue(reduceTurns(thread).single().answer.isEmpty())
    }
    @Test fun questionCanResolveUnderDifferentItemKeyAndOutsideTurn() {
        val question = event(1, "ask", "question", obj("questionId" to "q", "prompt" to "选择方案"))
        val resolved = event(2, "answer-event", "question", obj("questionId" to "q", "status" to "answered"), "")
        assertEquals(1, pendingRequests(ThreadData(events = listOf(question))).size)
        assertTrue(pendingRequests(ThreadData(events = listOf(question, resolved), hot = mapOf("ask" to question))).isEmpty())
    }
    @Test fun cumulativeDiffReplacesIntermediateEditsWithoutDoubleCounting() {
        val thread = ThreadData(events = listOf(
            event(1, "edit", "file.change", obj("changes" to JSONArray(listOf(obj("path" to "a.kt", "added" to 10, "removed" to 3))))),
            event(2, "diff", "turn.diff", obj("changes" to JSONArray(listOf(obj("path" to "a.kt", "added" to 2, "removed" to 1, "diff" to "+a")))))
        ))
        val change = reduceTurns(thread).single().changes.single()
        assertEquals(2, change.added)
        assertEquals("+a", change.diff)
    }
    @Test fun persistedEventReplacesStreamingItemAndDuplicateReplayIsIdempotent() {
        val hot = event(0, "answer", "assistant.message", obj("text" to "你"))
        val complete = event(7, "answer", "assistant.message", obj("text" to "你好"))
        val thread = ThreadData(hot = mapOf("answer" to hot)).merge(listOf(complete)).merge(listOf(complete))
        assertEquals(1, thread.events.size)
        assertTrue(thread.hot.isEmpty())
        assertEquals(7, thread.afterSeq)
    }
    @Test fun lateRestFeedCannotUndoLiveStatusOrRename() {
        val task = Task("s", obj("title" to "原名称", "status" to "running"), 11)
            .patch(obj("title" to "新名称", "status" to "waiting"), 12)
            .patch(obj("title" to "原名称", "status" to "idle"), 10)
        assertEquals("新名称", task.title)
        assertEquals("waiting", task.status)
    }
    @Test fun fullTerminalLineKeepsEntireEncodedTokenAndDropsItFromSavedAddress() {
        val link = LaunchLink.fromText("dsh → http://192.168.1.8:3000/?token=a%2Bb%3D%3D")
        assertEquals("http://192.168.1.8:3000/?token=a%2Bb%3D%3D", link.launchUrl())
        assertFalse(link.cleanUrl().contains("token"))
    }
    @Test fun pendingMessageRetainsExactTextAndIdAcrossColdStart() {
        val text = "  first\n\nsecond 🙂  "
        val p = PendingMessage("stable", "s", text, listOf("image"), status = "queued")
        val restored = PendingMessage.parse(p.json())
        assertEquals(text, restored.text)
        assertEquals("stable", restored.id)
        assertEquals("queued", restored.status)
    }
    @Test fun diffLineNumbersHandleInsertionsAndDeletions() {
        val lines = diffLines("@@ -4,2 +4,2 @@\n-old\n+new\n context")
        assertEquals("4", lines[1].old)
        assertEquals("", lines[1].new)
        assertEquals("4", lines[2].new)
        assertEquals("5", lines[3].new)
    }
}
