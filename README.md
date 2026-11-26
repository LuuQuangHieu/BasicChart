# BasicChart

A TradingView-style charting web app that runs locally: real-time crypto, Vietnamese and US stocks, and macro
symbols, with custom timeframes, indicators and drawing tools. No API keys needed.

## Run

Requires [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev
```

Then open <http://basicchart.localhost:8386> (or <http://localhost:8386>).

Use `npm run dev` (not a static host): the dev server proxies Yahoo Finance, CoinMarketCap, FRED and Entrade,
which do not allow direct browser requests.

## Features

- **Markets**
  - Crypto: Binance, Bybit, OKX, Gate, Bitget, Bitstamp. Bitstamp BTC/USD history starts in 2011.
  - VN stocks: Entrade and VNDirect.
  - US stocks: Yahoo Finance.
  - Macro (BTC.D, ETH.D, USDT.D, GOLD, SILVER, USOIL, SPX, NDX, DJI, FEDFUNDS, USUR): CoinMarketCap, Yahoo, FRED.
- **Timeframes**: presets 15m to 3M, plus any custom one (e.g. `7m`, `10h`, `6M`). Stock intraday bars start
  at the session open.
- **Indicators**: EMA/SMA, RSI, Stoch RSI, MACD, RSI Tue Trading, Cluster Algo (Skoda Version).
  RSI Tue Trading and Cluster Algo were rebuilt to match the TradingView originals bar by bar.
- **Tools**: Fibonacci retracement, price & time measure (Shift + click).
- **Chart behaviour**: TradingView-style mouse wheel zoom on the chart and the price axis; logarithmic price scale (Log button or Alt + L).
- **Watchlist**: add, remove and drag to reorder (press and hold).
- **Indicator panes**: hover a pane to move it up or down, or remove it.
- **Theme**: light / dark.
- **Saving**: settings, watchlist and drawings are kept in the browser's local storage.
