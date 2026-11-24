import { defineConfig, type ProxyOptions } from 'vite';

// Data sources that block browser requests (no CORS headers, or only the plain "localhost" origin)
// go through the dev server instead:
//   /yahoo    Yahoo Finance   — US stocks, gold, oil, indices
//   /cmc      CoinMarketCap   — crypto dominance
//   /fred     FRED            — Fed funds rate, unemployment
//   /entrade  Entrade (DNSE)  — VN stocks 1h / 1D
const proxy = (target: string, prefix: string, headers: Record<string, string> = {}): ProxyOptions => ({
  target,
  changeOrigin: true,
  rewrite: (p) => p.replace(new RegExp(`^${prefix}`), ''),
  headers,
  configure: (server) => {
    // drop the browser's Origin/Referer: some sources reject unknown origins (an empty header makes Entrade hang up)
    server.on('proxyReq', (req) => {
      req.removeHeader('origin');
      req.removeHeader('referer');
    });
  },
});
const proxies = {
  '/yahoo': proxy('https://query1.finance.yahoo.com', '/yahoo', { 'User-Agent': 'Mozilla/5.0' }),
  '/cmc': proxy('https://api.coinmarketcap.com', '/cmc'),
  '/fred': proxy('https://fred.stlouisfed.org', '/fred'),
  '/entrade': proxy('https://services.entrade.com.vn', '/entrade'),
};

// Open at http://basicchart.localhost:8386 (any *.localhost name points to this machine).
const PORT = 8386;

export default defineConfig({
  server: { port: PORT, strictPort: true, proxy: proxies },
  preview: { port: PORT, strictPort: true, proxy: proxies },
});
