// "RSI Tue Trading" — a closed-source TradingView script.
// Rebuilt by reading the original's plotted values and matching them bar by bar
// (BTC 1D, ETH 4h, SOL 1h, XRP 1W, ADA 15m — 400 bars each, every closed bar identical):
//   - RSI          = RSI(close, 14)
//   - RSI Fast MA  = EMA(RSI, 9)
//   - RSI Slow MA  = WMA(RSI, 45)
//   - background   = green while RSI > Over Buy (80), orange while RSI < Over Sell (20)
//   - bands 90/80/70/60/50/40/30/20/10 with shaded regions; 70 and 30 drawn as solid lines
import { ema, rsi, wma, type Series } from './core';

export interface RsiTueParams {
  rsiLen: number;  // 14
  fastLen: number; // 9  (EMA)
  slowLen: number; // 45 (WMA)
}

export function rsiTue(close: Series, p: RsiTueParams) {
  const r = rsi(close, p.rsiLen);
  return { rsi: r, fast: ema(r, p.fastLen), slow: wma(r, p.slowLen) };
}
