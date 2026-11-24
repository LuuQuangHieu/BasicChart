// US stocks, ETFs and indices from Yahoo Finance. Yahoo sends no CORS headers, so requests go through
// the Vite dev-server proxy at /yahoo (see vite.config.ts). Quotes are delayed ~15 min for some venues.
// Intraday depth: 1m ≈ 30 days, 5m–30m ≈ 60 days, 60m ≈ 2 years; daily since listing.
import type { Candle, Exchange, Ticker } from './types';
import { DAY, HOUR, MIN, getJson, poll, stockSpan } from './util';

const REST = '/yahoo';
const SESSION_MIN = 390; // 09:30–16:00 New York
const DEPTH: Record<number, number> = { [MIN]: 29 * DAY, [5 * MIN]: 59 * DAY, [15 * MIN]: 59 * DAY, [30 * MIN]: 59 * DAY, [HOUR]: 729 * DAY };
const MAX_SPAN: Record<number, number> = { [MIN]: 7 * DAY };

// bars are 13:30–21:00 UTC, so the UTC date is the New York date
export const nySession = (t: number) => Math.floor(t / DAY) * DAY + 9.5 * HOUR - nyOffset(t);
/** Futures (GC=F, CL=F…) trade almost round the clock: no 09:30–16:00 session. */
const isFuture = (s: string) => s.endsWith('=F');

/** UTC offset of New York at time t, in ms (−5h in winter, −4h in summer). */
const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
const offsetCache = new Map<number, number>();
function nyOffset(t: number): number {
  const day = Math.floor(t / DAY);
  let o = offsetCache.get(day);
  if (o === undefined) {
    const name = nyFmt.formatToParts(new Date(day * DAY + 12 * HOUR)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
    const m = name.match(/GMT([+-]\d+)/);
    o = (m ? +m[1] : -5) * HOUR;
    offsetCache.set(day, o);
  }
  return o;
}

interface Chart {
  chart: {
    result: {
      meta: { regularMarketPrice: number; chartPreviousClose: number; regularMarketVolume?: number };
      timestamp?: number[];
      indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
    }[] | null;
    error: { description: string } | null;
  };
}

async function chart(symbol: string, params: Record<string, string>) {
  const q = new URLSearchParams({ ...params, includePrePost: 'false' });
  const r = await getJson<Chart>(`${REST}/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`);
  if (!r.chart.result) throw new Error(r.chart.error?.description ?? 'Yahoo: no data');
  return r.chart.result[0];
}

export const us: Exchange = {
  id: 'us',
  name: 'US Stocks',
  intervals: { [MIN]: '1m', [5 * MIN]: '5m', [15 * MIN]: '15m', [30 * MIN]: '30m', [HOUR]: '60m', [DAY]: '1d' },
  maxCandles: 10_000,
  pageSize: 2000,

  sessionFor: (symbol) => (isFuture(symbol) ? undefined : nySession),

  async fetchTickers() {
    return []; // looked up with search()
  },

  async search(q) {
    type R = { symbol: string; quoteType: string; exchDisp?: string; shortname?: string; longname?: string };
    const p = new URLSearchParams({ q, quotesCount: '20', newsCount: '0', enableFuzzyQuery: 'false' });
    const raw = await getJson<{ quotes: R[] }>(`${REST}/v1/finance/search?${p}`);
    return raw.quotes
      // US listings only: foreign ones carry a suffix (NVD.DE, NVDA.TO)
      .filter((r) => ['EQUITY', 'ETF', 'INDEX'].includes(r.quoteType) && !r.symbol.includes('.'))
      .map((r) => ({
        symbol: r.symbol, base: r.symbol, quote: r.quoteType === 'INDEX' ? 'Index' : 'USD',
        last: NaN, open: NaN, quoteVolume: 0, name: `${r.exchDisp ?? ''} · ${r.shortname ?? r.longname ?? ''}`,
      }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const now = Date.now();
    const end = endTime ?? now;
    const earliest = intervalMs >= DAY ? 0 : now - DEPTH[intervalMs];
    let span = Math.min(stockSpan(intervalMs, limit, SESSION_MIN), MAX_SPAN[intervalMs] ?? Infinity);
    for (let attempt = 0; attempt < 3; attempt++, span = Math.min(span * 2, MAX_SPAN[intervalMs] ?? Infinity)) {
      const from = Math.max(earliest, end - span);
      if (from >= end) return [];
      let r: Awaited<ReturnType<typeof chart>>;
      try {
        r = await chart(symbol, {
          interval: this.intervals[intervalMs],
          period1: String(Math.floor(from / 1000)),
          period2: String(Math.floor(end / 1000) + 1),
        });
      } catch (e) {
        // asking for dates before the listing: Yahoo answers 400 "Data doesn't exist" instead of an empty list
        if (/doesn't exist|No data found/i.test((e as Error).message)) return [];
        throw e;
      }
      const q = r.indicators.quote[0];
      const out: Candle[] = [];
      (r.timestamp ?? []).forEach((ts, i) => {
        const c = q.close[i];
        if (c == null || q.open[i] == null) return;
        let t = ts * 1000;
        if (intervalMs >= DAY) t = Math.floor(t / DAY) * DAY; // daily bars open at 09:30 NY: key them by date
        else if (!isFuture(symbol) && t >= nySession(t) + SESSION_MIN * MIN) return; // Yahoo appends a 16:00 closing tick
        if (t > end) return;
        out.push({ t, o: q.open[i]!, h: q.high[i]!, l: q.low[i]!, c, v: q.volume[i] ?? 0 });
      });
      if (out.length) return out.slice(-limit);
      if (intervalMs >= DAY || from <= earliest) break;
    }
    return [];
  },

  klineStream(symbol, intervalMs, onCandle) {
    return poll(10_000, async () => {
      const page = await this.fetchPage(symbol, intervalMs, 3);
      page.forEach(onCandle);
    });
  },

  tickerStream(symbols, onTicker) {
    return poll(15_000, async () => {
      await Promise.all(symbols.map(async (s) => {
        const r = await chart(s, { range: '1d', interval: '1d' });
        const m = r.meta;
        const t: Ticker = {
          symbol: s, base: s, quote: 'USD',
          last: m.regularMarketPrice, open: m.chartPreviousClose,
          quoteVolume: (m.regularMarketVolume ?? 0) * m.regularMarketPrice,
        };
        onTicker(t);
      }));
    });
  },
};
