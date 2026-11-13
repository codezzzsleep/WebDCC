package com.webdcc.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.net.ssl.SSLException;

/** Same token -> HttpOnly cookie exchange as WebDCC's browser, with no token persistence. */
public final class SessionAuth {
    private SessionAuth() {}

    public static Result bind(LaunchLink link) throws AuthException {
        HttpURLConnection connection = null;
        try {
            connection = open(link.launchUrl());
            int code = connection.getResponseCode();
            if (code == 401 || code == 403) throw new AuthException("token 无效或已过期。请重新复制 WebDCC 当前启动时打印的完整链接。");
            if (!((code >= 200 && code < 300) || code == 302 || code == 303 || code == 307 || code == 308)) {
                throw new AuthException("服务器未能完成登录（HTTP " + code + "）。请确认 WebDCC 已正常启动。");
            }
            String cleanUrl = link.cleanUrl();
            String location = connection.getHeaderField("Location");
            if (location != null) cleanUrl = link.resolveCleanRedirect(location);
            List<String> setCookies = new ArrayList<>();
            List<String> pairs = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() == null || !entry.getKey().equalsIgnoreCase("Set-Cookie")) continue;
                for (String header : entry.getValue()) {
                    for (HttpCookie cookie : HttpCookie.parse(header)) {
                        if (isAuthCookie(cookie.getName()) && !cookie.hasExpired()) {
                            // A WebDCC login cookie is always host-only, HttpOnly, Path=/.
                            if (cookie.getDomain() != null || !cookie.isHttpOnly()
                                    || (cookie.getPath() != null && !cookie.getPath().equals("/"))) continue;
                            pairs.add(cookie.getName() + "=" + cookie.getValue());
                            setCookies.add(header);
                        }
                    }
                }
            }
            if (setCookies.isEmpty()) throw new AuthException("没有收到 WebDCC 登录 Cookie。请使用 WebDCC 的完整启动链接，而不是 DSH 侧车链接。");
            StringBuilder cookies = new StringBuilder();
            for (String pair : pairs) { if (cookies.length() > 0) cookies.append("; "); cookies.append(pair); }
            connection.disconnect();
            connection = null;
            verify(LaunchLink.saved(cleanUrl), cookies.toString());
            return new Result(cleanUrl, setCookies, cookies.toString());
        } catch (AuthException e) { throw e; }
        catch (LaunchLink.LinkException e) { throw new AuthException(e.getMessage()); }
        catch (SSLException e) { throw new AuthException("HTTPS 证书验证失败。请使用证书有效的服务地址。"); }
        catch (Exception e) { throw new AuthException("无法连接服务器。请检查地址、端口、网络以及电脑上的 WebDCC 服务。"); }
        finally { if (connection != null) connection.disconnect(); }
    }

    public static void verify(LaunchLink server, String cookie) throws AuthException {
        if (!hasAuthCookie(cookie)) throw new AuthException("登录状态已失效，请粘贴新的完整 token 链接重新绑定。");
        HttpURLConnection connection = null;
        try {
            connection = open(server.origin() + "/api/workspaces");
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Accept", "application/json");
            int code = connection.getResponseCode();
            if (code == 401 || code == 403) throw new AuthException("登录状态已失效，请粘贴当前启动时打印的完整 token 链接。");
            if (code != 200) throw new AuthException("WebDCC 接口暂时不可用（HTTP " + code + "）。请确认服务正常运行。");
            String type = connection.getContentType();
            if (type == null || !type.toLowerCase(java.util.Locale.ROOT).contains("application/json")) {
                throw new AuthException("这个地址没有返回 WebDCC 接口，请检查服务器地址和端口。");
            }
            String prefix = readPrefix(connection.getInputStream(), 512).trim();
            if (!prefix.startsWith("[")) throw new AuthException("这个地址没有返回 WebDCC 工作区，请检查服务器地址和端口。");
        } catch (AuthException e) { throw e; }
        catch (SSLException e) { throw new AuthException("HTTPS 证书验证失败。请使用证书有效的服务地址。"); }
        catch (Exception e) { throw new AuthException("无法连接已绑定的服务器。请确认网络畅通，WebDCC 保持运行。"); }
        finally { if (connection != null) connection.disconnect(); }
    }

    public static boolean hasAuthCookie(String value) {
        if (value == null) return false;
        for (String part : value.split(";")) {
            int index = part.indexOf('=');
            if (index > 0 && isAuthCookie(part.substring(0, index).trim()) && !part.substring(index + 1).trim().isEmpty()) return true;
        }
        return false;
    }

    private static boolean isAuthCookie(String name) { return name.equals("wdcc-auth") || name.startsWith("wdcc-auth-"); }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(18000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", "WebDCC-Native-Android/3.0");
        return connection;
    }

    private static String readPrefix(InputStream input, int limit) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[256];
            int count;
            while (out.size() < limit && (count = in.read(buffer, 0, Math.min(buffer.length, limit - out.size()))) != -1) out.write(buffer, 0, count);
            return new String(out.toByteArray(), "UTF-8");
        }
    }

    public static final class Result {
        public final String cleanUrl;
        public final List<String> setCookies;
        public final String cookieHeader;
        Result(String cleanUrl, List<String> setCookies, String cookieHeader) {
            this.cleanUrl = cleanUrl; this.setCookies = setCookies; this.cookieHeader = cookieHeader;
        }
    }

    public static final class AuthException extends Exception {
        public AuthException(String message) { super(message); }
    }
}
