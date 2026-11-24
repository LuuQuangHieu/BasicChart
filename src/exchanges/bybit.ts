// https://bybit-exchange.github.io/docs/v5/market/kline
import type { Exchange } from './types';
import { DAY, HOUR, MIN, Socket, WEEK, candle, chunk, getJson } from './util';

const REST = 'https://api.bybit.com';
const WS = 'wss://stream.bybit.com/v5/public/spot';

function subscribe(ws: WebSocket, topics: string[]) {
  // spot allows at most 10 topics per subscribe request
  for (const args of chunk(topics, 10)) ws.send(JSON.stringify({ op: 'subscribe', args }));
}
const ping = { everyMs: 20_000, payload: () => JSON.stringify({ op: 'ping' }) };

export const bybit: Exchange = {
  id: 'bybit',
  name: 'Bybit',
  intervals: {
    [MIN]: '1', [3 * MIN]: '3', [5 * MIN]: '5', [15 * MIN]: '15', [30 * MIN]: '30',
    [HOUR]: '60', [2 * HOUR]: '120', [4 * HOUR]: '240', [6 * HOUR]: '360', [12 * HOUR]: '720',
    [DAY]: 'D', [WEEK]: 'W',
  },
  maxCandles: 8000,
  pageSize: 1000,
  continuous: true,

  async fetchTickers() {
    type Raw = { symbol: string; lastPrice: string; prevPrice24h: string; turnover24h: string };
    const r = await getJson<{ result: { list: Raw[] } }>(`${REST}/v5/market/tickers?category=spot`);
    return r.result.list
      .filter((t) => t.symbol.endsWith('USDT') && +t.turnover24h > 0)
      .map((t) => ({
        symbol: t.symbol, base: t.symbol.slice(0, -4), quote: 'USDT',
        last: +t.lastPrice, open: +t.prevPrice24h, quoteVolume: +t.turnover24h,
      }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const q = new URLSearchParams({ category: 'spot', symbol, interval: this.intervals[intervalMs], limit: String(limit) });
    if (endTime !== undefined) q.set('end', String(endTime));
    const r = await getJson<{ result: { list: string[][] } }>(`${REST}/v5/market/kline?${q}`);
    return r.result.list.map((k) => candle(k[0], k[1], k[2], k[3], k[4], k[5])).reverse();
  },

  klineStream(symbol, intervalMs, onCandle) {
    const topic = `kline.${this.intervals[intervalMs]}.${symbol}`;
    return new Socket(WS, {
      onOpen: (ws) => subscribe(ws, [topic]),
      onMessage: (m) => {
        if (m.topic !== topic) return;
        for (const k of m.data) onCandle(candle(k.start, k.open, k.high, k.low, k.close, k.volume));
      },
      ping,
    });
  },

  tickerStream(symbols, onTicker) {
    return new Socket(WS, {
      onOpen: (ws) => subscribe(ws, symbols.map((s) => `tickers.${s}`)),
      onMessage: (m) => {
        const d = m.data;
        if (!m.topic?.startsWith('tickers.') || !d?.lastPrice) return;
        onTicker({
          symbol: d.symbol, base: d.symbol.slice(0, -4), quote: 'USDT',
          last: +d.lastPrice, open: +d.prevPrice24h, quoteVolume: +d.turnover24h,
        });
      },
      ping,
    });
  },
};
