// Indicator math. Every function returns an array aligned with its input;
// null where the value is not defined yet (warm-up period).

export type Series = (number | null)[];

export function sma(src: Series, period: number): Series {
  const out: Series = new Array(src.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v === null) { sum = 0; count = 0; continue; }
    sum += v; count++;
    if (count > period) { sum -= src[i - period] as number; count = period; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (TradingView ta.ema behaviour). */
export function ema(src: Series, period: number): Series {
  return smoothed(src, period, 2 / (period + 1));
}

/** Wilder's moving average (TradingView ta.rma). */
export function rma(src: Series, period: number): Series {
  return smoothed(src, period, 1 / period);
}

function smoothed(src: Series, period: number, alpha: number): Series {
  const out: Series = new Array(src.length).fill(null);
  let prev: number | null = null, seed = 0, n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v === null) continue;
    if (prev === null) {
      seed += v; n++;
      if (n === period) { prev = seed / period; out[i] = prev; }
    } else {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(src: Series, period: number): Series {
  const gains: Series = [null], losses: Series = [null];
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    if (a === null || b === null) { gains.push(null); losses.push(null); continue; }
    gains.push(Math.max(b - a, 0));
    losses.push(Math.max(a - b, 0));
  }
  const ag = rma(gains, period), al = rma(losses, period);
  return ag.map((g, i) => {
    const l = al[i];
    if (g === null || l === null) return null;
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

function rolling(src: Series, period: number, pick: (a: number, b: number) => number): Series {
  return src.map((_, i) => {
    if (i < period - 1) return null;
    let r: number | null = null;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (v === null) return null;
      r = r === null ? v : pick(r, v);
    }
    return r;
  });
}

export function stochRsi(src: Series, rsiLen: number, stochLen: number, kLen: number, dLen: number) {
  const r = rsi(src, rsiLen);
  const lo = rolling(r, stochLen, Math.min), hi = rolling(r, stochLen, Math.max);
  const stoch: Series = r.map((v, i) => {
    const l = lo[i], h = hi[i];
    if (v === null || l === null || h === null) return null;
    return h === l ? 0 : ((v - l) / (h - l)) * 100;
  });
  const k = sma(stoch, kLen);
  const d = sma(k, dLen);
  return { k, d };
}

export function macd(src: Series, fast: number, slow: number, signalLen: number) {
  const f = ema(src, fast), s = ema(src, slow);
  const line: Series = f.map((v, i) => (v === null || s[i] === null ? null : v - (s[i] as number)));
  const signal = ema(line, signalLen);
  const hist: Series = line.map((v, i) => (v === null || signal[i] === null ? null : v - (signal[i] as number)));
  return { line, signal, hist };
}

/** Weighted moving average (TradingView ta.wma). */
export function wma(src: Series, period: number): Series {
  const out: Series = new Array(src.length).fill(null);
  const w = (period * (period + 1)) / 2;
  for (let i = period - 1; i < src.length; i++) {
    let t = 0;
    let ok = true;
    for (let k = 0; k < period; k++) {
      const v = src[i - period + 1 + k];
      if (v === null) { ok = false; break; }
      t += v * (k + 1);
    }
    if (ok) out[i] = t / w;
  }
  return out;
}
