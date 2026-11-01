package io.github.kd011.mint;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Which pages the shell treats as Mint's own, and the sign-in nudge for the Authelia page. */
public class ShellPolicyTest {
    private static final String APP = ShellPolicy.APP_HOST;
    private static final String AUTH = ShellPolicy.AUTH_HOST;
    private static final boolean HAS_AUTH = !AUTH.isEmpty();

    @Test
    public void mintAndTheSignInPortalAreTrusted() {
        assertTrue(ShellPolicy.isTrusted("https://" + APP + "/"));
        assertTrue(ShellPolicy.isTrusted("https://" + APP + "/api/lock/status?x=1"));
        if (HAS_AUTH) {
            assertTrue(ShellPolicy.isTrusted("https://" + AUTH + "/?rd=https%3A%2F%2F" + APP + "%2F"));
        }
    }

    @Test
    public void everythingElseIsNot() {
        assertFalse(ShellPolicy.isTrusted(null));
        assertFalse(ShellPolicy.isTrusted(""));
        assertFalse(ShellPolicy.isTrusted("http://" + APP + "/"));
        assertFalse(ShellPolicy.isTrusted("https://other.example/"));
        assertFalse(ShellPolicy.isTrusted("https://" + APP + ".evil.example/"));
        assertFalse(ShellPolicy.isTrusted("https://evil.example/https://" + APP + "/"));
        assertFalse(ShellPolicy.isTrusted("https://user@evil.example/@" + APP + "/"));
        assertFalse(ShellPolicy.isTrusted("file:///android_asset/public/offline.html"));
        if (HAS_AUTH) {
            assertFalse(ShellPolicy.isTrusted("http://" + AUTH + "/"));
        } else {
            // No login gateway configured: an empty host must never match anything.
            assertFalse(ShellPolicy.isTrusted("https:///"));
        }
    }

    @Test
    public void onlyTheSignInPortalGetsTheRememberMeNudge() {
        assertFalse(ShellPolicy.isSignInPage("https://" + APP + "/"));
        assertFalse(ShellPolicy.isSignInPage("https://evil.example/"));
        assertFalse(ShellPolicy.isSignInPage(null));
        if (HAS_AUTH) {
            assertTrue(ShellPolicy.isSignInPage("https://" + AUTH + "/"));
            assertTrue(ShellPolicy.isSignInPage("https://" + AUTH + "/?rd=https%3A%2F%2F" + APP + "%2F"));
            assertFalse(ShellPolicy.isSignInPage("https://" + AUTH + ".evil.example/"));
            assertFalse(ShellPolicy.isSignInPage("http://" + AUTH + "/"));
        }
    }

    @Test
    public void rememberMeScriptTicksTheBoxOnceAndGivesUp() {
        String js = ShellPolicy.REMEMBER_ME_JS;
        assertTrue(js.contains("remember-checkbox"));
        assertTrue(js.contains("checked"));
        // Bounded: a page without the box must not leave a watcher running forever.
        assertTrue(js.contains("disconnect"));
        assertTrue(js.contains("setTimeout"));
        // Never touches the credentials the person types.
        assertFalse(js.toLowerCase().contains("password"));
        assertFalse(js.toLowerCase().contains("username"));
        assertFalse(js.contains("fetch("));
        assertFalse(js.contains("XMLHttpRequest"));
    }
}
