package com.webdcc.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure Java: extract launch URLs without ever including credentials in error text. */
public final class LaunchLink {
    private static final Pattern URL = Pattern.compile("https?://[^\\s<>\"'`，。；（）()]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern ANSI = Pattern.compile("\u001B\\[[0-?]*[ -/]*[@-~]");
    private final URI uri;

    private LaunchLink(URI uri) { this.uri = uri; }

    public static LaunchLink fromText(String text) throws LinkException {
        if (text == null || text.trim().isEmpty()) throw new LinkException("请粘贴服务启动时打印的完整 token 链接。");
        Matcher matcher = URL.matcher(ANSI.matcher(text).replaceAll(""));
        List<LaunchLink> found = new ArrayList<>();
        LinkException last = null;
        while (matcher.find()) {
            try {
                LaunchLink candidate = new LaunchLink(validUri(matcher.group()));
                candidate.checkToken();
                boolean duplicate = false;
                for (LaunchLink link : found) if (link.launchUrl().equals(candidate.launchUrl())) duplicate = true;
                if (!duplicate) found.add(candidate);
            } catch (LinkException e) { last = e; }
        }
        if (found.size() > 1) throw new LinkException("检测到多个带 token 的链接，请只粘贴需要绑定的那一条。");
        if (found.size() == 1) return found.get(0);
        if (last != null) throw last;
        throw new LinkException("没有找到完整的 http:// 或 https:// 链接。请复制终端中的整条地址。");
    }

    public static LaunchLink saved(String text) throws LinkException {
        LaunchLink link = new LaunchLink(validUri(text));
        if (!link.launchUrl().equals(link.cleanUrl())) throw new LinkException("保存的地址无效，请重新绑定。");
        return link;
    }

    private static URI validUri(String text) throws LinkException {
        try {
            URI uri = new URI(text);
            String scheme = uri.getScheme();
            if (!("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
                    || uri.getHost() == null || uri.getHost().isEmpty() || uri.getRawUserInfo() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535 || text.indexOf('\\') >= 0) {
                throw new LinkException("链接地址无效。请使用带 token 的 HTTP 或 HTTPS 服务地址。");
            }
            return uri;
        } catch (URISyntaxException | NullPointerException e) {
            throw new LinkException("链接格式不完整，请重新复制终端中的整条地址。");
        }
    }

    private void checkToken() throws LinkException {
        int count = 0;
        String query = uri.getRawQuery();
        if (query != null) {
            for (String part : query.split("&", -1)) {
                int equals = part.indexOf('=');
                String name = decode(equals < 0 ? part : part.substring(0, equals));
                if (!"token".equals(name)) continue;
                count++;
                String token = equals < 0 ? "" : decode(part.substring(equals + 1));
                if (token.trim().isEmpty()) throw new LinkException("链接里的 token 为空，请复制完整链接。");
                for (int i = 0; i < token.length(); i++) {
                    if (Character.isISOControl(token.charAt(i))) throw new LinkException("token 格式无效，请重新复制完整链接。");
                }
            }
        }
        if (count == 0) throw new LinkException("链接缺少 token。请复制启动时打印的完整链接，包括 ?token= 后面的全部内容。");
        if (count != 1) throw new LinkException("链接里有重复的 token 参数，请重新复制启动链接。");
    }

    private static String decode(String value) throws LinkException {
        try { return URLDecoder.decode(value, "UTF-8"); }
        catch (Exception e) { throw new LinkException("链接编码无效，请重新复制完整链接。"); }
    }

    public String launchUrl() { return uri.toASCIIString(); }

    /** Drop credentials and fragments before storing or displaying an address. */
    public String cleanUrl() throws LinkException { return withoutToken(uri); }

    private static String withoutToken(URI uri) throws LinkException {
        List<String> parts = new ArrayList<>();
        if (uri.getRawQuery() != null) {
            for (String part : uri.getRawQuery().split("&", -1)) {
                int equals = part.indexOf('=');
                String name = decode(equals < 0 ? part : part.substring(0, equals));
                if (!"token".equals(name) && !part.isEmpty()) parts.add(part);
            }
        }
        String path = uri.getRawPath();
        return uri.getScheme().toLowerCase(Locale.ROOT) + "://" + uri.getRawAuthority()
                + (path == null || path.isEmpty() ? "/" : path)
                + (parts.isEmpty() ? "" : "?" + join(parts));
    }

    private static String join(List<String> parts) {
        StringBuilder out = new StringBuilder();
        for (String part : parts) { if (out.length() > 0) out.append('&'); out.append(part); }
        return out.toString();
    }

    public String origin() { return uri.getScheme().toLowerCase(Locale.ROOT) + "://" + uri.getRawAuthority(); }
    public String displayAddress() { return uri.getScheme().toLowerCase(Locale.ROOT) + "://" + uri.getRawAuthority(); }

    public boolean isLocalAddress() {
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return host.equals("localhost") || host.endsWith(".localhost") || host.startsWith("127.")
                || host.equals("0.0.0.0") || host.equals("[::]") || host.equals("[::1]")
                || host.equals("::") || host.equals("::1");
    }

    public LaunchLink withServerAddress(String address) throws LinkException {
        if (address == null || address.trim().isEmpty()) throw new LinkException("请填写运行 WebDCC 的电脑局域网 IP 或服务器地址。");
        String value = address.trim();
        boolean hasScheme = value.contains("://");
        URI replacement = validUri(hasScheme ? value : uri.getScheme() + "://" + value);
        if (replacement.getRawQuery() != null || replacement.getRawFragment() != null
                || (replacement.getRawPath() != null && !replacement.getRawPath().isEmpty() && !replacement.getRawPath().equals("/"))) {
            throw new LinkException("这里只填写电脑 IP、域名或服务地址，不要填写路径和 token。");
        }
        int port = replacement.getPort();
        if (port < 0 && !hasScheme) port = uri.getPort();
        String authority = replacement.getHost() + (port < 0 ? "" : ":" + port);
        String path = uri.getRawPath();
        URI updated = validUri(replacement.getScheme() + "://" + authority
                + (path == null || path.isEmpty() ? "/" : path)
                + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()));
        return new LaunchLink(updated);
    }

    public boolean sameOrigin(String other) {
        try {
            URI candidate = validUri(other);
            return uri.getScheme().equalsIgnoreCase(candidate.getScheme())
                    && uri.getHost().equalsIgnoreCase(candidate.getHost())
                    && effectivePort(uri) == effectivePort(candidate);
        } catch (LinkException e) { return false; }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    public String resolveCleanRedirect(String location) throws LinkException {
        try {
            URI redirected = uri.resolve(new URI(location));
            if (!sameOrigin(redirected.toString())) throw new LinkException("服务跳转到了另一个地址。请使用最终服务地址对应的完整 token 链接。");
            return withoutToken(redirected);
        } catch (URISyntaxException | IllegalArgumentException e) {
            throw new LinkException("服务器返回的跳转地址无效。");
        }
    }

    public static final class LinkException extends Exception {
        public LinkException(String message) { super(message); }
    }
}
