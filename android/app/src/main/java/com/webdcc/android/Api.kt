package com.webdcc.android

import android.content.Context
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiError(message: String, val code: String = "", val uncertain: Boolean = false) : IOException(message)

class MobileApi(val address: String, val cookie: String) {
    val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).writeTimeout(45, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    val origin: String = LaunchLink.saved(address).origin()
    fun request(path: String): Request.Builder = Request.Builder().url(origin + path)
        .header("Cookie", cookie).header("User-Agent", "WebDCC-Native-Android/3.0").header("Accept", "application/json")
    suspend fun json(path: String, method: String = "GET", data: JSONObject? = null): Any = withContext(Dispatchers.IO) {
        val request = request(path).apply {
            if (method != "GET") method(method, (data ?: JSONObject()).toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
        }.build()
        try {
            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    if (response.code == 401 || response.code == 403) throw ApiError("登录已过期，请用新的完整 token 链接重新绑定。", "auth")
                    val detail = runCatching { JSONObject(body).str("error") }.getOrDefault("")
                    throw ApiError(detail.ifBlank { "服务返回 HTTP ${response.code}，请稍后重试。" }, "http-${response.code}")
                }
                if (body.isBlank()) JSONObject() else runCatching { JSONTokener(body).nextValue() }.getOrElse { throw ApiError("服务返回的内容无法识别，请确认是 WebDCC 地址。", "format") }
            }
        } catch (e: ApiError) { throw e } catch (e: Exception) {
            throw ApiError("网络连接中断，请确认电脑上的 WebDCC 仍在运行。", "network", true)
        }
    }
    suspend fun command(command: JSONObject): JSONObject {
        val result = json("/api/commands", "POST", obj("command" to command)) as JSONObject
        if (!result.optBoolean("ok")) throw ApiError(result.str("error", "操作失败，请重试。"), result.str("code"))
        return result.optJSONObject("value") ?: JSONObject()
    }
    suspend fun bytes(path: String): String = withContext(Dispatchers.IO) {
        try {
            client.newCall(request(path).build()).execute().use { response ->
                if (!response.isSuccessful) throw ApiError("无法读取文件（HTTP ${response.code}）。")
                val body = response.body ?: throw ApiError("文件为空。")
                if (body.contentLength() > 4 * 1024 * 1024) throw ApiError("文件超过 4 MB，请在电脑上查看。")
                body.source().use { source ->
                    val buffer = okio.Buffer()
                    var total = 0L
                    while (true) {
                        val count = source.read(buffer, 8192)
                        if (count < 0) break
                        total += count
                        if (total > 4 * 1024 * 1024) throw ApiError("文件超过 4 MB，请在电脑上查看。")
                    }
                    buffer.readUtf8()
                }
            }
        } catch (e: ApiError) { throw e } catch (_: Exception) { throw ApiError("文件读取失败，请检查连接。") }
    }
    suspend fun chunk(path: String, data: ByteArray) = withContext(Dispatchers.IO) {
        try {
            client.newCall(request(path).put(data.toRequestBody("application/octet-stream".toMediaType())).build()).execute().use {
                if (!it.isSuccessful) throw ApiError("附件上传失败（HTTP ${it.code}）。")
            }
        } catch (e: ApiError) { throw e } catch (_: Exception) { throw ApiError("附件上传中断，请重试。") }
    }
}

/** Atomic, app-private conversation cache. Auth cookies are stored separately in Android Keystore. */
class LocalStore(context: Context) {
    private val folder = File(context.filesDir, "mobile-v3").apply { mkdirs() }
    private var name = "unbound"
    fun useServer(origin: String) {
        name = java.security.MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
    }
    @Synchronized fun read(): JSONObject = try {
        JSONObject(AtomicFile(File(folder, "$name.json")).openRead().bufferedReader().use { it.readText() })
    } catch (_: Exception) { JSONObject() }
    @Synchronized fun currentKey(): String = name
    @Synchronized fun write(data: JSONObject, key: String = name): Boolean {
        val file = AtomicFile(File(folder, "$key.json"))
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(data.toString().toByteArray())
            file.finishWrite(stream)
            return true
        } catch (_: Exception) { if (stream != null) file.failWrite(stream); return false }
    }
}
