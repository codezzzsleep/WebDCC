package com.webdcc.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Credentials belong to the native HTTP client, encrypted with a device Keystore key. */
final class ConnectionVault {
    private final SharedPreferences preferences;
    private static final String ALIAS = "webdcc.native.session.v2";
    ConnectionVault(Context context) { preferences = context.getSharedPreferences("native_connection", Context.MODE_PRIVATE); }
    String address() { return preferences.getString("server", ""); }
    String cookie() {
        try {
            if (preferences.getLong("expires", 0) <= System.currentTimeMillis()) return null;
            byte[] iv = Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(preferences.getString("cookie", ""), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(address().getBytes("UTF-8"));
            return new String(cipher.doFinal(encrypted), "UTF-8");
        } catch (Exception e) { return null; }
    }
    void save(SessionAuth.Result result) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(result.cleanUrl.getBytes("UTF-8"));
        byte[] encrypted = cipher.doFinal(result.cookieHeader.getBytes("UTF-8"));
        long age = 30L * 24 * 60 * 60;
        for (String header : result.setCookies) for (java.net.HttpCookie cookie : java.net.HttpCookie.parse(header)) if (cookie.getMaxAge() >= 0) age = Math.min(age, cookie.getMaxAge());
        boolean saved = preferences.edit().putString("server", result.cleanUrl)
                .putString("cookie", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putLong("expires", System.currentTimeMillis() + age * 1000).commit();
        if (!saved) throw new java.io.IOException("Unable to persist native session");
    }
    void clear() { preferences.edit().clear().apply(); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
}
