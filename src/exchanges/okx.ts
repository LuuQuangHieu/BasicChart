// https://www.okx.com/docs-v5/en/#public-data-rest-api-get-candlesticks-history
import type { Exchange } from './types';
import { DAY, HOUR, MIN, Socket, WEEK, candle, getJson } from './util';

const REST = 'https://www.okx.com';
const WS_PUBLIC = 'wss://ws.okx.com:443/ws/v5/public';
const WS_BUSINESS = 'wss://ws.okx.com:443/ws/v5/business'; // candles live here
const ping = { everyMs: 25_000, payload: () => 'ping' };

export const okx: Exchange = {
  id: 'okx',
  name: 'OKX',
  // UTC-aligned variants for >= 6h (plain 1D etc. open at UTC+8)
  intervals: {
    [MIN]: '1m', [3 * MIN]: '3m', [5 * MIN]: '5m', [15 * MIN]: '15m', [30 * MIN]: '30m',
    [HOUR]: '1H', [2 * HOUR]: '2H', [4 * HOUR]: '4H', [6 * HOUR]: '6Hutc', [12 * HOUR]: '12Hutc',
    [DAY]: '1Dutc', [WEEK]: '1Wutc',
  },
  maxCandles: 2000, // history endpoint returns 100 per request
  pageSize: 100,
  continuous: true,

  async fetchTickers() {
    type Raw = { instId: string; last: string; open24h: string; volCcy24h: string };
    const r = await getJson<{ data: Raw[] }>(`${REST}/api/v5/market/tickers?instType=SPOT`);
    return r.data
      .filter((t) => t.instId.endsWith('-USDT') && +t.volCcy24h > 0)
      .map((t) => ({
        symbol: t.instId, base: t.instId.split('-')[0], quote: 'USDT',
        last: +t.last, open: +t.open24h, quoteVolume: +t.volCcy24h,
      }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const q = new URLSearchParams({ instId: symbol, bar: this.intervals[intervalMs], limit: String(limit) });
    if (endTime !== undefined) q.set('after', String(endTime + 1)); // `after` is exclusive
    const r = await getJson<{ data: string[][] }>(`${REST}/api/v5/market/history-candles?${q}`);
    return r.data.map((k) => candle(k[0], k[1], k[2], k[3], k[4], k[5])).reverse();
  },

  klineStream(symbol, intervalMs, onCandle) {
    const channel = 'candle' + this.intervals[intervalMs];
    return new Socket(WS_BUSINESS, {
      onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel, instId: symbol }] })),
      onMessage: (m) => {
        if (m.arg?.channel !== channel || !m.data) return;
        for (const k of m.data) onCandle(candle(k[0], k[1], k[2], k[3], k[4], k[5]));
      },
      ping,
    });
  },

  tickerStream(symbols, onTicker) {
    return new Socket(WS_PUBLIC, {
      onOpen: (ws) =>
        ws.send(JSON.stringify({ op: 'subscribe', args: symbols.map((instId) => ({ channel: 'tickers', instId })) })),
      onMessage: (m) => {
        if (m.arg?.channel !== 'tickers' || !m.data) return;
        for (const d of m.data) {
          onTicker({
            symbol: d.instId, base: d.instId.split('-')[0], quote: 'USDT',
            last: +d.last, open: +d.open24h, quoteVolume: +d.volCcy24h,
          });
        }
      },
      ping,
    });
  },
};
