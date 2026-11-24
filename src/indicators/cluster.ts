// Cluster Algo (Skoda Version) by ForexResearchLabs — a closed-source TradingView script.
// Rebuilt by reading the plotted values of the original on TradingView and matching them bar by bar
// (BTC/ETH/XRP/SUI 1D, ETH/SOL 4h, LINK/ADA 1h, BTC 15m, BTC 1W — 400 bars each, 0 mismatches):
//   - signal  = linreg(RSI(close, 9), 21)
//   - colour  = green while the signal rises, red while it falls
//   - basis/upper/lower = Bollinger Bands(signal, 34, 2)
//   - green dot: signal turns up   while EMA50(close) >  EMA200(close)
//     red dot:   signal turns down while EMA50(close) <= EMA200(close)
import { ema, rsi, sma, type Series } from './core';

export interface ClusterParams {
  rsiLen: number;    // 9
  sigLen: number;    // 21 ("Signal Line 1 - Length", Linear Regression)
  bbLen: number;     // 34 ("lengtha")
  bbMult: number;    // 2  ("multa")
  trendFast: number; // 50  EMA of close used to filter the dots
  trendSlow: number; // 200
}

/** TradingView ta.linreg(src, len, 0): least-squares line over the window, value at the last bar. */
export function linreg(src: Series, len: number): Series {
  const out: Series = new Array(src.length).fill(null);
  const n = len;
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  for (let i = n - 1; i < src.length; i++) {
    let sy = 0, sxy = 0, ok = true;
    for (let k = 0; k < n; k++) {
      const y = src[i - n + 1 + k];
      if (y === null) { ok = false; break; }
      sy += y;
      sxy += k * y;
    }
    if (!ok) continue;
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    out[i] = (sy - slope * sx) / n + slope * (n - 1);
  }
  return out;
}

/** Population standard deviation (TradingView ta.stdev). */
function stdev(src: Series, len: number, mean: Series): Series {
  return src.map((_, i) => {
    const m = mean[i];
    if (m === null) return null;
    let t = 0;
    for (let j = i - len + 1; j <= i; j++) t += ((src[j] as number) - m) ** 2;
    return Math.sqrt(t / len);
  });
}

export function cluster(close: Series, p: ClusterParams) {
  const signal = linreg(rsi(close, p.rsiLen), p.sigLen);
  const basis = sma(signal, p.bbLen);
  const dev = stdev(signal, p.bbLen, basis);
  const upper = basis.map((b, i) => (b === null ? null : b + p.bbMult * (dev[i] as number)));
  const lower = basis.map((b, i) => (b === null ? null : b - p.bbMult * (dev[i] as number)));

  const rising: (boolean | null)[] = signal.map((s, i) => (s === null || signal[i - 1] == null ? null : s > (signal[i - 1] as number)));
  const fast = ema(close, p.trendFast), slow = ema(close, p.trendSlow);
  const buy: boolean[] = new Array(close.length).fill(false);
  const sell: boolean[] = new Array(close.length).fill(false);
  for (let i = 2; i < signal.length; i++) {
    const s = signal[i], s1 = signal[i - 1], s2 = signal[i - 2], f = fast[i], sl = slow[i];
    if (s === null || s1 === null || s2 === null || f === null || sl === null) continue;
    const bull = f > sl;
    buy[i] = bull && s > s1 && s1 <= s2;    // turn up in an uptrend
    sell[i] = !bull && s < s1 && s1 >= s2;  // turn down in a downtrend
  }
  return { signal, rising, basis, upper, lower, buy, sell };
}
