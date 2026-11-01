package io.github.kd011.mint;

import java.net.URI;

/**
 * Which pages the shell treats as Mint's own. Mirrors allowNavigation in
 * capacitor.config.js (the app host, plus the login gateway host if there is
 * one); anything else Capacitor already hands to the system browser. Both hosts
 * are set at build time from MINT_APP_ORIGIN and MINT_AUTH_HOST via BuildConfig.
 */
final class ShellPolicy {
    static final String APP_HOST = BuildConfig.APP_HOST;
    /** Empty when the server has no login gateway. */
    static final String AUTH_HOST = BuildConfig.AUTH_HOST;

    private ShellPolicy() {}

    private static String hostOf(String url) {
        if (url == null) return null;
        try {
            URI u = new URI(url);
            if (!"https".equals(u.getScheme()) || u.getRawUserInfo() != null) return null;
            return u.getHost();
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isTrusted(String url) {
        String h = hostOf(url);
        return APP_HOST.equals(h) || (!AUTH_HOST.isEmpty() && AUTH_HOST.equals(h));
    }

    static boolean isSignInPage(String url) {
        return !AUTH_HOST.isEmpty() && AUTH_HOST.equals(hostOf(url));
    }

    /**
     * Targets Authelia's sign-in page; harmless on any other gateway, since it
     * only looks for one element id and does nothing if it is absent. Authelia
     * keeps a session for 12 hours, or 90 days when "Remember me" is ticked, and
     * an unticked session cookie does not survive the app process being killed.
     * This ticks the box on the sign-in page (once, for at most 15 seconds while
     * the page draws) so a sign-in lasts. It touches nothing else: no field
     * values, no network.
     */
    static final String REMEMBER_ME_JS =
        "(function(){if(window.__mintRemember)return;window.__mintRemember=1;"
        + "var done=false;"
        + "function tick(){var el=document.getElementById('remember-checkbox');if(!el)return false;"
        + "var box=el.matches&&el.matches('input')?el:el.querySelector('input[type=checkbox]');"
        + "if(!box)return false;if(!box.checked)box.click();return true;}"
        + "var mo=new MutationObserver(function(){if(!done&&tick()){done=true;mo.disconnect();}});"
        + "mo.observe(document.documentElement,{childList:true,subtree:true});"
        + "if(tick()){done=true;mo.disconnect();}"
        + "setTimeout(function(){mo.disconnect();},15000);})();";
}
