// https://www.bitstamp.net/api/ — the oldest major BTC exchange still running: BTC/USD daily candles go back
// to 2011-08-18 (Binance starts 2017-08). REST and WebSocket are public and CORS-open.
// Bitstamp's socket has no candle channel: the live bar is built from trades on top of the REST bar.
import type { Candle, Exchange, Ticker } from './types';
import { DAY, HOUR, MIN, Socket, getJson, poll } from './util';

const REST = 'https://www.bitstamp.net/api/v2';
const WS = 'wss://ws.bitstamp.net';
const QUOTES = ['USD', 'USDT', 'USDC', 'EUR'];

interface RawTicker { pair: string; last: string; open_24: string; volume: string; market_type?: string }

function toTicker(r: RawTicker): Ticker | null {
  const [base, quote] = r.pair.split('/');
  if (!QUOTES.includes(quote) || (r.market_type && r.market_type !== 'SPOT')) return null;
  return { symbol: (base + quote).toLowerCase(), base, quote, last: +r.last, open: +r.open_24, quoteVolume: +r.volume * +r.last };
}

export const bitstamp: Exchange = {
  id: 'bitstamp',
  name: 'Bitstamp',
  intervals: {
    [MIN]: '60', [3 * MIN]: '180', [5 * MIN]: '300', [15 * MIN]: '900', [30 * MIN]: '1800',
    [HOUR]: '3600', [2 * HOUR]: '7200', [4 * HOUR]: '14400', [6 * HOUR]: '21600', [12 * HOUR]: '43200',
    [DAY]: '86400',
  },
  maxCandles: 8000,
  pageSize: 1000,
  continuous: true,

  async fetchTickers() {
    const raw = await getJson<RawTicker[]>(`${REST}/ticker/`);
    return raw.map(toTicker).filter((t): t is Ticker => !!t && t.quoteVolume > 0);
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const q = new URLSearchParams({ step: this.intervals[intervalMs], limit: String(Math.min(limit, 1000)) });
    if (endTime !== undefined) q.set('end', String(Math.floor(endTime / 1000)));
    type K = { timestamp: string; open: string; high: string; low: string; close: string; volume: string };
    const r = await getJson<{ data: { ohlc: K[] } }>(`${REST}/ohlc/${symbol}/?${q}`);
    return r.data.ohlc
      .map((k) => ({ t: +k.timestamp * 1000, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }))
      .filter((c) => endTime === undefined || c.t <= endTime);
  },

  klineStream(symbol, intervalMs, onCandle) {
    let cur: Candle | null = null;
    const emit = () => cur && onCandle({ ...cur });
    // REST keeps the bar exact (and recovers after a disconnect); trades make it move in real time
    const rest = poll(30_000, async () => {
      const [last] = (await this.fetchPage(symbol, intervalMs, 1)).slice(-1);
      if (last && (!cur || last.t >= cur.t)) {
        cur = last.t === cur?.t ? { ...last, h: Math.max(last.h, cur.h), l: Math.min(last.l, cur.l), c: cur.c } : last;
        emit();
      }
    });
    const ws = new Socket(WS, {
      onOpen: (s) => s.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `live_trades_${symbol}` } })),
      onMessage: (m) => {
        if (m.event !== 'trade' || !cur) return;
        const price = +m.data.price, t = Math.floor((+m.data.timestamp * 1000) / intervalMs) * intervalMs;
        if (t < cur.t) return;
        if (t > cur.t) cur = { t, o: price, h: price, l: price, c: price, v: 0 };
        cur.h = Math.max(cur.h, price);
        cur.l = Math.min(cur.l, price);
        cur.c = price;
        cur.v += +m.data.amount;
        emit();
      },
      ping: { everyMs: 20_000, payload: () => JSON.stringify({ event: 'bts:heartbeat' }) },
    });
    return { close: () => { rest.close(); ws.close(); } };
  },

  tickerStream(symbols, onTicker) {
    const wanted = new Set(symbols);
    return poll(5000, async () => {
      const all = await this.fetchTickers();
      all.filter((t) => wanted.has(t.symbol)).forEach(onTicker);
    });
  },
};
