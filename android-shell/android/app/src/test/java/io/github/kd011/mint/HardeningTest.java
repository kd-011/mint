package io.github.kd011.mint;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

/**
 * Source-level guards for the bank-app settings no JVM test can exercise: the
 * window is secure, nothing is cached or backed up by the OS, traffic is TLS only.
 * (build.sh checks the same on the built APK with aapt.)
 */
public class HardeningTest {
    private static String read(String rel) throws Exception {
        Path p = Paths.get(System.getProperty("user.dir")).resolve(rel);
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    /** The source with block comments, line comments and string literals blanked, so only code is matched. */
    private static String code(String rel) throws Exception {
        return read(rel)
            .replaceAll("(?s)/\\*.*?\\*/", " ")
            .replaceAll("//[^\n]*", " ")
            .replaceAll("\"(\\\\.|[^\"\\\\])*\"", "\"\"");
    }

    private static final String ACTIVITY = "src/main/java/io/github/kd011/mint/MainActivity.java";
    private static final Pattern SECURE_CALL = Pattern.compile(
        "getWindow\\(\\)\\s*\\.setFlags\\(\\s*WindowManager\\.LayoutParams\\.FLAG_SECURE\\s*,\\s*WindowManager\\.LayoutParams\\.FLAG_SECURE\\s*\\)");

    @Test
    public void windowIsSecureBeforeAnyContentIsSet() throws Exception {
        String src = code(ACTIVITY);
        Matcher m = SECURE_CALL.matcher(src);
        assertTrue("MainActivity must call getWindow().setFlags(FLAG_SECURE, FLAG_SECURE) in code", m.find());
        int create = src.indexOf("super.onCreate(");
        assertTrue("super.onCreate must exist", create > 0);
        assertTrue("FLAG_SECURE must be set before super.onCreate builds the WebView", m.start() < create);
    }

    @Test
    public void theGuardsSeeThroughCommentsAndMissingCalls() {
        Pattern call = SECURE_CALL;
        assertFalse(call.matcher("/* FLAG_SECURE blanks screenshots */ super.onCreate(b);").find());
        assertFalse(call.matcher("super.onCreate(b); getWindow().setFlags(0, 0);").find());
        assertTrue(call.matcher("getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);").find());
    }

    @Test
    public void manifestIsTlsOnlyAndNotBackedUp() throws Exception {
        String m = read("src/main/AndroidManifest.xml");
        assertFalse(m.contains("usesCleartextTraffic=\"true\""));
        assertTrue(m.contains("android:allowBackup=\"false\""));
        assertTrue(m.contains("android:usesCleartextTraffic=\"false\""));
        assertTrue(m.contains("android.permission.INTERNET"));
    }

    @Test
    public void passkeysGoThroughCredentialManager() throws Exception {
        String src = code(ACTIVITY);
        assertTrue(src.contains("WebSettingsCompat.setWebAuthenticationSupport("));
        assertTrue(src.contains("WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP"));
    }
}
