import type { Candle } from '../exchanges/types';

/**
 * Drawings anchor to real times (ms) so they survive timeframe changes.
 * These map a time to a (fractional) bar index and back, extrapolating
 * with the bar duration outside the loaded range.
 */
export function timeToLogical(bars: Candle[], barMs: number, t: number): number | null {
  const n = bars.length;
  if (!n) return null;
  if (t <= bars[0].t) return (t - bars[0].t) / barMs;
  if (t >= bars[n - 1].t) return n - 1 + (t - bars[n - 1].t) / barMs;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - bars[lo].t) / (bars[hi].t - bars[lo].t);
}

/** Time of the bar at (rounded) logical index `l`. */
export function logicalToTime(bars: Candle[], barMs: number, l: number): number | null {
  const n = bars.length;
  if (!n) return null;
  const i = Math.round(l);
  if (i < 0) return bars[0].t + i * barMs;
  if (i >= n) return bars[n - 1].t + (i - n + 1) * barMs;
  return bars[i].t;
}
