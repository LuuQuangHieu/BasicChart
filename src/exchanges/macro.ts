// Macro & cross-market symbols, named like TradingView:
//   BTC.D / ETH.D / USDT.D  crypto dominance (% of total market cap) — CoinMarketCap public data API
//   GOLD / SILVER / USOIL   COMEX/NYMEX front-month futures GC=F, SI=F, CL=F — Yahoo Finance
//   SPX / NDX / DJI         S&P 500, Nasdaq 100, Dow Jones indices — Yahoo Finance
//   FEDFUNDS / USUR         Fed funds rate, US unemployment rate (monthly) — FRED (St. Louis Fed)
// CoinMarketCap, Yahoo and FRED send no CORS headers: requests go through the Vite proxy (vite.config.ts).
import type { Candle, Closable, Exchange, Ticker } from './types';
import { us } from './us';
import { DAY, HOUR, getJson, poll } from './util';

type Source =
  | { src: 'dom'; coin: 'btc' | 'eth' | 'usdt' }
  | { src: 'yahoo'; id: string }
  | { src: 'fred'; id: string };

interface Entry { symbol: string; name: string; aliases?: string; source: Source }

export const MACRO: Entry[] = [
  { symbol: 'BTC.D', name: 'Bitcoin Dominance %', aliases: 'BTCD', source: { src: 'dom', coin: 'btc' } },
  { symbol: 'ETH.D', name: 'Ethereum Dominance %', aliases: 'ETHD', source: { src: 'dom', coin: 'eth' } },
  { symbol: 'USDT.D', name: 'Tether Dominance %', aliases: 'USDTD', source: { src: 'dom', coin: 'usdt' } },
  { symbol: 'GOLD', name: 'Gold futures (GC=F)', aliases: 'XAU VANG', source: { src: 'yahoo', id: 'GC=F' } },
  { symbol: 'SILVER', name: 'Silver futures (SI=F)', aliases: 'XAG BAC', source: { src: 'yahoo', id: 'SI=F' } },
  { symbol: 'USOIL', name: 'WTI crude oil futures (CL=F)', aliases: 'WTI OIL DAU', source: { src: 'yahoo', id: 'CL=F' } },
  { symbol: 'SPX', name: 'S&P 500', aliases: 'SP500 GSPC', source: { src: 'yahoo', id: '^GSPC' } },
  { symbol: 'NDX', name: 'Nasdaq 100', aliases: 'NASDAQ', source: { src: 'yahoo', id: '^NDX' } },
  { symbol: 'DJI', name: 'Dow Jones Industrial Average', aliases: 'DOW', source: { src: 'yahoo', id: '^DJI' } },
  { symbol: 'FEDFUNDS', name: 'Effective Fed funds rate % (monthly)', aliases: 'FED RATE LAI SUAT', source: { src: 'fred', id: 'FEDFUNDS' } },
  { symbol: 'USUR', name: 'US unemployment rate % (monthly)', aliases: 'UNRATE UNEMPLOYMENT THAT NGHIEP', source: { src: 'fred', id: 'UNRATE' } },
];
const BY_SYMBOL = new Map(MACRO.map((e) => [e.symbol, e]));
const entry = (symbol: string) => {
  const e = BY_SYMBOL.get(symbol);
  if (!e) throw new Error(`Unknown symbol ${symbol}`);
  return e;
};
const blankTicker = (e: Entry): Ticker => ({ symbol: e.symbol, base: e.symbol, quote: '', last: NaN, open: NaN, quoteVolume: 0, name: e.name });

// ---- snapshot series -> candles ---------------------------------------------------
// Dominance and economic data are point readings, not trades: each bar opens at the previous reading.

interface Point { t: number; v: number }

function toCandles(points: Point[]): Candle[] {
  return points.map((p, i) => {
    const o = i ? points[i - 1].v : p.v;
    return { t: p.t, o, h: Math.max(o, p.v), l: Math.min(o, p.v), c: p.v, v: 0 };
  });
}

// ---- dominance (CoinMarketCap) ----------------------------------------------------

const CMC = '/cmc/data-api';
const DOM_INTERVALS = { [HOUR]: '1h', [DAY]: '1d' };
const USDT_PAGE = 400; // CMC returns at most 400 coin quotes per request
const sec = (ms: number) => String(Math.floor(ms / 1000));

interface GlobalQuote { timestamp: string; btcDominance: number; ethDominance: number; quote: { totalMarketCap: number }[] }

async function globalSeries(intervalMs: number, from: number, to: number) {
  const q = new URLSearchParams({ format: 'chart', interval: DOM_INTERVALS[intervalMs], timeStart: sec(from), timeEnd: sec(to) });
  const r = await getJson<{ data?: { quotes: GlobalQuote[] } }>(`${CMC}/v3/global-metrics/quotes/historical?${q}`);
  // readings are taken a few minutes into the hour/day (07:35 for daily): key them by their bar
  return (r.data?.quotes ?? []).map((x) => ({
    t: Math.floor(Date.parse(x.timestamp) / intervalMs) * intervalMs,
    btc: x.btcDominance, eth: x.ethDominance, total: x.quote[0].totalMarketCap,
  }));
}

async function usdtCaps(intervalMs: number, from: number, to: number) {
  const q = new URLSearchParams({ id: '825', convertId: '2781', interval: DOM_INTERVALS[intervalMs], timeStart: sec(from), timeEnd: sec(to) });
  type Q = { timeOpen: string; quote: { marketCap: number } };
  const r = await getJson<{ data?: { quotes: Q[] } }>(`${CMC}/v3.1/cryptocurrency/historical?${q}`);
  return new Map((r.data?.quotes ?? []).map((x) => [Math.floor(Date.parse(x.timeOpen) / intervalMs) * intervalMs, x.quote.marketCap]));
}

async function dominance(coin: 'btc' | 'eth' | 'usdt', intervalMs: number, from: number, to: number): Promise<Point[]> {
  const g = await globalSeries(intervalMs, from, to);
  if (coin !== 'usdt') return g.map((x) => ({ t: x.t, v: x[coin] }));
  const caps = await usdtCaps(intervalMs, from, to);
  return g.flatMap((x) => (caps.has(x.t) ? [{ t: x.t, v: (caps.get(x.t)! / x.total) * 100 }] : []));
}

/** Latest reading (hourly) and the one 24h before it — the daily bar and the watchlist use it. */
async function domNow(coin: 'btc' | 'eth' | 'usdt') {
  const now = Date.now();
  const pts = await dominance(coin, HOUR, now - 27 * HOUR, now);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  const dayAgo = pts.find((p) => p.t >= last.t - DAY) ?? pts[0];
  return { last, dayAgo };
}

// ---- FRED ---------------------------------------------------------------------------

const fredCache = new Map<string, Promise<Point[]>>();
function fred(id: string): Promise<Point[]> {
  let p = fredCache.get(id);
  if (!p) {
    p = fetch(`/fred/graph/fredgraph.csv?id=${id}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`FRED ${r.status}`))))
      .then((csv) =>
        csv.trim().split('\n').slice(1)
          .map((line) => line.split(','))
          .filter(([, v]) => v !== '.' && v !== '' && isFinite(+v))
          .map(([d, v]) => ({ t: Date.parse(d + 'T00:00:00Z'), v: +v })),
      );
    p.catch(() => fredCache.delete(id));
    fredCache.set(id, p);
    setTimeout(() => fredCache.delete(id), 3600_000); // monthly data: refresh hourly is plenty
  }
  return p;
}

// ---- exchange -----------------------------------------------------------------------

export const macro: Exchange = {
  id: 'macro',
  name: 'Macro',
  intervals: us.intervals,
  maxCandles: 10_000,
  pageSize: USDT_PAGE,

  intervalsFor(symbol) {
    const s = entry(symbol).source;
    return s.src === 'yahoo' ? us.intervals : s.src === 'dom' ? DOM_INTERVALS : { [DAY]: '1d' };
  },

  sessionFor(symbol) {
    const s = entry(symbol).source;
    return s.src === 'yahoo' ? us.sessionFor!(s.id) : undefined;
  },

  async fetchTickers() {
    return MACRO.map(blankTicker);
  },

  async search(q) {
    const Q = q.toUpperCase();
    const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'D').toUpperCase();
    return MACRO.filter((e) => !Q || e.symbol.includes(Q) || plain(`${e.name} ${e.aliases ?? ''}`).includes(plain(Q))).map(blankTicker);
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const s = entry(symbol).source;
    if (s.src === 'yahoo') return us.fetchPage(s.id, intervalMs, limit, endTime);
    const end = endTime ?? Date.now();
    if (s.src === 'fred') {
      const pts = await fred(s.id);
      return toCandles(pts).filter((c) => c.t <= end).slice(-limit);
    }
    // one extra reading so the first bar has an open
    const pts = await dominance(s.coin, intervalMs, end - limit * intervalMs, end);
    let bars = toCandles(pts).slice(1).filter((c) => c.t <= end);
    if (endTime === undefined && intervalMs === DAY && bars.length) {
      // the daily reading is taken once a day: let today's bar follow the latest hourly reading
      const now = await domNow(s.coin);
      const today = Math.floor(Date.now() / DAY) * DAY;
      if (now) {
        const prev = bars.filter((b) => b.t < today).pop();
        const cur = bars.find((b) => b.t === today);
        const o = cur?.o ?? prev?.c ?? now.last.v;
        const bar = { t: today, o, h: Math.max(o, now.last.v, cur?.h ?? -Infinity), l: Math.min(o, now.last.v, cur?.l ?? Infinity), c: now.last.v, v: 0 };
        bars = [...bars.filter((b) => b.t < today), bar];
      }
    }
    return bars.slice(-limit);
  },

  klineStream(symbol, intervalMs, onCandle) {
    const s = entry(symbol).source;
    if (s.src === 'yahoo') return us.klineStream(s.id, intervalMs, onCandle);
    return poll(s.src === 'fred' ? 3600_000 : 60_000, async () => {
      (await this.fetchPage(symbol, intervalMs, 3)).forEach(onCandle);
    });
  },

  tickerStream(symbols, onTicker) {
    const streams: Closable[] = [];
    const yahoo = new Map<string, string>(); // Yahoo id -> our symbol
    const other: Entry[] = [];
    for (const sym of symbols) {
      const e = BY_SYMBOL.get(sym);
      if (!e) continue;
      if (e.source.src === 'yahoo') yahoo.set(e.source.id, sym);
      else other.push(e);
    }
    if (yahoo.size) {
      streams.push(us.tickerStream([...yahoo.keys()], (t) => {
        const sym = yahoo.get(t.symbol)!;
        onTicker({ ...t, symbol: sym, base: sym, quote: '', quoteVolume: sym.startsWith('^') ? 0 : t.quoteVolume });
      }));
    }
    if (other.length) {
      streams.push(poll(60_000, async () => {
        await Promise.all(other.map(async (e) => {
          const s = e.source;
          let last: number, open: number;
          if (s.src === 'dom') {
            const n = await domNow(s.coin);
            if (!n) return;
            [last, open] = [n.last.v, n.dayAgo.v];
          } else if (s.src === 'fred') {
            const pts = await fred(s.id);
            if (!pts.length) return;
            [last, open] = [pts[pts.length - 1].v, (pts[pts.length - 2] ?? pts[pts.length - 1]).v]; // vs previous release
          } else return;
          onTicker({ symbol: e.symbol, base: e.symbol, quote: '', last, open, quoteVolume: 0 });
        }));
      }));
    }
    return { close: () => streams.forEach((s) => s.close()) };
  },
};
