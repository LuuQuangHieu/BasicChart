import type { Candle, Market } from '../exchanges/types';
import type { Timeframe } from './timeframe';

/** Keeps raw base candles and the aggregated bars for one timeframe. */
export class CandleStore {
  base: Candle[] = [];
  bars: Candle[] = [];

  constructor(
    readonly tf: Timeframe,
    readonly market: Market,
  ) {}

  setBase(candles: Candle[]) {
    this.base = candles;
    this.bars = aggregate(candles, this.tf);
  }

  prependBase(older: Candle[]) {
    const first = this.base[0]?.t ?? Infinity;
    this.setBase([...older.filter((c) => c.t < first), ...this.base]);
  }

  /** Apply a live base candle. Returns the updated last bar. */
  upsert(c: Candle): Candle {
    const last = this.base[this.base.length - 1];
    if (last && last.t === c.t) this.base[this.base.length - 1] = c;
    else if (!last || c.t > last.t) this.base.push(c);
    else return this.bars[this.bars.length - 1];

    const start = this.tf.bucket(c.t);
    const parts: Candle[] = [];
    for (let i = this.base.length - 1; i >= 0 && this.tf.bucket(this.base[i].t) === start; i--) parts.unshift(this.base[i]);
    const bar = merge(start, parts);
    const lastBar = this.bars[this.bars.length - 1];
    if (lastBar && lastBar.t === start) this.bars[this.bars.length - 1] = bar;
    else this.bars.push(bar);
    return bar;
  }
}

function merge(t: number, parts: Candle[]): Candle {
  let h = -Infinity, l = Infinity, v = 0;
  for (const p of parts) {
    if (p.h > h) h = p.h;
    if (p.l < l) l = p.l;
    v += p.v;
  }
  return { t, o: parts[0].o, h, l, c: parts[parts.length - 1].c, v };
}

export function aggregate(candles: Candle[], tf: Timeframe): Candle[] {
  if (tf.factor === 1) return candles.slice();
  const out: Candle[] = [];
  let group: Candle[] = [];
  let start = NaN;
  for (const c of candles) {
    const b = tf.bucket(c.t);
    if (b !== start && group.length) {
      out.push(merge(start, group));
      group = [];
    }
    start = b;
    group.push(c);
  }
  if (group.length) out.push(merge(start, group));
  return out;
}
