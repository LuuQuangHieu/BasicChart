// Vietnamese stocks & indices (HOSE / HNX / UPCOM). Both sources are public, CORS-open and keyless:
//  - Entrade (DNSE) for 1h and 1D: daily since 2012, hourly ~3 years
//  - VNDirect for 1m–30m (only ~6 months kept) and symbol search
// No WebSocket: polled.
import type { Candle, Exchange, Ticker } from './types';
import { DAY, HOUR, MIN, getJson, poll, stockSpan } from './util';

const REST = 'https://dchart-api.vndirect.com.vn/dchart';
const ENTRADE = '/entrade/chart-api/v2/ohlcs'; // via the Vite proxy (vite.config.ts)
const ENTRADE_RES: Record<string, string> = { '60': '1H', D: '1D' };
const SESSION_MIN = 285; // 09:00–11:30 + 13:00–14:45
const OPEN_UTC = 2 * HOUR; // 09:00 Asia/Ho_Chi_Minh (UTC+7, no DST)

const vnSession = (t: number) => Math.floor(t / DAY) * DAY + OPEN_UTC;

/** Stock prices come in thousands of VND (46.85 = 46,850 ₫); indices are in points. */
export const isVnIndex = (s: string) => /INDEX|^(VN|HNX|VNX)\d+$|^VN(MID|SML|ALL|DIAMOND|FIN)/i.test(s);

interface Raw { t?: number[] | null; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

async function history(symbol: string, res: string, from: number, to: number): Promise<Candle[]> {
  const index = isVnIndex(symbol);
  const range = { symbol, from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) };
  const er = ENTRADE_RES[res];
  const r = er
    ? await getJson<Raw>(`${ENTRADE}/${index ? 'index' : 'stock'}?${new URLSearchParams({ ...range, resolution: er })}`)
    : await getJson<Raw>(`${REST}/history?${new URLSearchParams({ ...range, resolution: res })}`);
  const k = index ? 1 : 1000;
  const daily = res === 'D';
  return (r.t ?? []).map((t, i) => ({
    t: daily ? Math.floor(t / 86400) * DAY : t * 1000, // Entrade stamps daily bars at the 09:00 open
    o: r.o[i] * k, h: r.h[i] * k, l: r.l[i] * k, c: r.c[i] * k, v: r.v[i],
  }));
}

export const vn: Exchange = {
  id: 'vn',
  name: 'VN Stocks',
  intervals: { [MIN]: '1', [5 * MIN]: '5', [15 * MIN]: '15', [30 * MIN]: '30', [HOUR]: '60', [DAY]: 'D' },
  maxCandles: 10_000,
  pageSize: 1000,

  sessionFor: () => vnSession,

  async fetchTickers() {
    return []; // looked up with search()
  },

  async search(q) {
    type R = { symbol: string; description: string; exchange: string; type: string };
    const p = new URLSearchParams({ query: q, limit: '30', type: '', exchange: '' });
    const raw = await getJson<R[]>(`${REST}/search?${p}`);
    return raw.map((r) => ({
      symbol: r.symbol, base: r.symbol, quote: isVnIndex(r.symbol) ? 'Index' : 'VND',
      last: NaN, open: NaN, quoteVolume: 0, name: `${r.exchange} · ${r.description}`,
    }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const end = endTime ?? Date.now();
    let span = stockSpan(intervalMs, limit, SESSION_MIN);
    // a window can fall entirely inside a long holiday (Tết): look a bit further back before giving up
    for (let attempt = 0; attempt < 3; attempt++, span *= 2) {
      const page = (await history(symbol, this.intervals[intervalMs], end - span, end)).filter((c) => c.t <= end);
      if (page.length) return page.slice(-limit);
      if (intervalMs >= DAY) break;
    }
    return [];
  },

  klineStream(symbol, intervalMs, onCandle) {
    return poll(5000, async () => {
      const page = await this.fetchPage(symbol, intervalMs, 3);
      page.forEach(onCandle);
    });
  },

  tickerStream(symbols, onTicker) {
    return poll(10_000, async () => {
      await Promise.all(symbols.map(async (s) => {
        const d = await history(s, 'D', Date.now() - 20 * DAY, Date.now());
        if (!d.length) return;
        const last = d[d.length - 1], prev = d[d.length - 2] ?? last;
        const t: Ticker = {
          symbol: s, base: s, quote: isVnIndex(s) ? 'Index' : 'VND',
          last: last.c, open: prev.c, quoteVolume: isVnIndex(s) ? last.v : last.v * last.c,
        };
        onTicker(t);
      }));
    });
  },
};
