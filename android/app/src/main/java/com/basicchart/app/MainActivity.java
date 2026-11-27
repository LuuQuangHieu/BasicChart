package com.basicchart.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The whole app: one WebView showing the BasicChart web app, which is packed into the APK (assets/).
 *
 * Pages are served from https://appassets.androidplatform.net/ so the web app gets a normal https origin
 * (localStorage, fetch). Data sources that refuse browser requests are fetched here instead, the way the
 * Vite dev server proxies them on a computer:
 *   /yahoo/…    → query1.finance.yahoo.com     /cmc/…      → api.coinmarketcap.com
 *   /fred/…     → fred.stlouisfed.org          /entrade/…  → services.entrade.com.vn
 * Everything else (crypto exchanges, websockets) goes straight to the network from the page.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final String[][] PROXIES = {
            {"/yahoo/", "https://query1.finance.yahoo.com/"},
            {"/cmc/", "https://api.coinmarketcap.com/"},
            {"/fred/", "https://fred.stlouisfed.org/"},
            {"/entrade/", "https://services.entrade.com.vn/"},
    };
    private static final String USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        fitInsideSystemBars(root);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // watchlist, settings and drawings are kept in localStorage
        s.setSupportZoom(false);                // pinch and drag belong to the chart
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);                     // the layout is sized in px; ignore the system font scale
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null; // straight to the network
                String path = url.getEncodedPath() == null ? "" : url.getEncodedPath();
                for (String[] p : PROXIES) {
                    if (path.startsWith(p[0])) {
                        String query = url.getEncodedQuery();
                        String target = p[1] + path.substring(p[0].length()) + (query == null ? "" : "?" + query);
                        return proxy(target, request.getRequestHeaders());
                    }
                }
                return assets.shouldInterceptRequest(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost()); // stay on the app's own page
            }
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
    }

    /** Fetch a data-source URL on behalf of the page (no Origin / Referer, a browser User-Agent). */
    private static WebResourceResponse proxy(String target, Map<String, String> requestHeaders) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("User-Agent", USER_AGENT);
            String accept = requestHeaders.get("Accept");
            if (accept != null) c.setRequestProperty("Accept", accept);

            int code = c.getResponseCode();
            InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);

            String mime = "application/octet-stream";
            String charset = null;
            String type = c.getContentType();
            if (type != null) {
                String[] parts = type.split(";");
                mime = parts[0].trim();
                for (String part : parts) {
                    String t = part.trim();
                    if (t.toLowerCase().startsWith("charset=")) charset = t.substring(8);
                }
            }
            Map<String, String> headers = new HashMap<>();
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                String k = h.getKey();
                if (k == null || h.getValue().isEmpty()) continue;
                String lk = k.toLowerCase();
                // the body is already decoded and re-chunked by WebView; drop transport headers
                if (lk.equals("content-encoding") || lk.equals("content-length") || lk.equals("transfer-encoding")
                        || lk.equals("set-cookie") || lk.startsWith("access-control-")) continue;
                headers.put(k, h.getValue().get(0));
            }
            headers.put("Cache-Control", "no-store");
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = code < 400 ? "OK" : "Error";
            // WebResourceResponse refuses 3xx codes (redirects were already followed)
            if (code >= 300 && code < 400) code = 502;
            return new WebResourceResponse(mime, charset, code, reason, headers, body);
        } catch (IOException e) {
            if (c != null) c.disconnect();
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", new HashMap<>(),
                    new ByteArrayInputStream(("Proxy error: " + e.getMessage()).getBytes()));
        }
    }

    /** Android 15+ draws apps under the status / navigation bars; keep the page (and the keyboard) clear of them. */
    private void fitInsideSystemBars(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return; // older versions lay out inside the bars already
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime()
                    | WindowInsets.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
