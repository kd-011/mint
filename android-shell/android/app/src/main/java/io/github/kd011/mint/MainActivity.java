package io.github.kd011.mint;

import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Mint's shell: a WebView over the live site, nothing native but the glue.
 *
 * - Secure window. FLAG_SECURE blanks screenshots, screen recording and the
 *   recents thumbnail; this is a bank app. It is set before the WebView exists.
 * - Sign-in. If the site sits behind a login gateway (Authelia is one example),
 *   its host is allowed in capacitor.config.js so the login stays inside the
 *   app. The cookie is flushed whenever the app leaves the screen so a sign-in
 *   made seconds before a swipe-away survives, and on Authelia's page the
 *   Remember me box is ticked (see ShellPolicy.REMEMBER_ME_JS).
 * - Fingerprint. Mint's lock is a WebAuthn passkey. The WebView only does
 *   navigator.credentials through Android's Credential Manager when asked, so
 *   the app asks (FOR_APP). See README.md, "The fingerprint lock".
 * - Insets. targetSdk 36 forces edge-to-edge; the content view is padded here
 *   (SystemBars insetsHandling "disable") so nothing sits under a bar.
 * - Back. Capacitor 8 has no hardware back handling without @capacitor/app, so
 *   back walks the WebView history (Mint's sheets push history entries) and
 *   only then leaves the app.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);

        View content = findViewById(android.R.id.content);
        content.setBackgroundColor(0xFF0B0D0C);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) getWindow().setNavigationBarContrastEnforced(false);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        Bridge bridge = getBridge();
        WebView web = bridge.getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(
                web.getSettings(), WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                if (ShellPolicy.isSignInPage(url)) view.evaluateJavascript(ShellPolicy.REMEMBER_ME_JS, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (ShellPolicy.isSignInPage(url)) view.evaluateJavascript(ShellPolicy.REMEMBER_ME_JS, null);
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView w = getBridge().getWebView();
                if (w.canGoBack()) w.goBack();
                else finish();
            }
        });
    }

    // Cookies reach disk on a timer; flush on the way out so a sign-in made
    // seconds before the app is swiped away is still there next launch.
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
