// https://developers.binance.com/docs/binance-spot-api-docs
import type { Exchange, Ticker } from './types';
import { DAY, HOUR, MIN, Socket, WEEK, candle, getJson } from './util';

const REST = ['https://api.binance.com', 'https://data-api.binance.vision'];
const WS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];
let restIdx = 0;

async function get<T>(path: string): Promise<T> {
  let err: unknown;
  for (let i = 0; i < REST.length; i++) {
    const idx = (restIdx + i) % REST.length;
    try {
      const r = await getJson<T>(REST[idx] + path);
      restIdx = idx;
      return r;
    } catch (e) {
      err = e;
    }
  }
  throw err;
}


export const binance: Exchange = {
  id: 'binance',
  name: 'Binance',
  intervals: {
    [MIN]: '1m', [3 * MIN]: '3m', [5 * MIN]: '5m', [15 * MIN]: '15m', [30 * MIN]: '30m',
    [HOUR]: '1h', [2 * HOUR]: '2h', [4 * HOUR]: '4h', [6 * HOUR]: '6h', [8 * HOUR]: '8h', [12 * HOUR]: '12h',
    [DAY]: '1d', [3 * DAY]: '3d', [WEEK]: '1w',
  },
  maxCandles: 8000,
  pageSize: 1000,
  continuous: true,

  async fetchTickers() {
    type Raw = { symbol: string; lastPrice: string; openPrice: string; quoteVolume: string; count: number };
    const raw = await get<Raw[]>('/api/v3/ticker/24hr');
    return raw
      .filter((r) => r.symbol.endsWith('USDT') && r.count > 0)
      .map((r) => ({
        symbol: r.symbol, base: r.symbol.slice(0, -4), quote: 'USDT',
        last: +r.lastPrice, open: +r.openPrice, quoteVolume: +r.quoteVolume,
      }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const q = new URLSearchParams({ symbol, interval: this.intervals[intervalMs], limit: String(limit) });
    if (endTime !== undefined) q.set('endTime', String(endTime));
    const raw = await get<string[][]>(`/api/v3/klines?${q}`);
    return raw.map((k) => candle(k[0], k[1], k[2], k[3], k[4], k[5]));
  },

  klineStream(symbol, intervalMs, onCandle) {
    let s: Socket | undefined;
    const path = `/ws/${symbol.toLowerCase()}@kline_${this.intervals[intervalMs]}`;
    // alternate hosts on reconnect in case one is blocked
    s = new Socket(() => WS[(s?.attempts ?? 0) % WS.length] + path, {
      onMessage: (m) => m.k && onCandle(candle(m.k.t, m.k.o, m.k.h, m.k.l, m.k.c, m.k.v)),
    });
    return s;
  },

  tickerStream(symbols, onTicker) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/');
    let s: Socket | undefined;
    s = new Socket(() => WS[(s?.attempts ?? 0) % WS.length] + `/stream?streams=${streams}`, {
      onMessage: (m) => {
        const d = m.data;
        if (!d?.s) return;
        const t: Ticker = { symbol: d.s, base: d.s.slice(0, -4), quote: 'USDT', last: +d.c, open: +d.o, quoteVolume: +d.q };
        onTicker(t);
      },
    });
    return s;
  },
};
