// https://www.gate.io/docs/developers/apiv4/#market-candlesticks
import type { Exchange } from './types';
import { DAY, HOUR, MIN, Socket, candle, getJson } from './util';

const REST = 'https://api.gateio.ws/api/v4';
const WS = 'wss://api.gateio.ws/ws/v4/';
const MAX_POINTS_BACK = 10_000; // Gate refuses candles older than 10000 intervals
const now = () => Math.floor(Date.now() / 1000);
const msg = (channel: string, payload: string[]) => JSON.stringify({ time: now(), channel, event: 'subscribe', payload });
const ping = { everyMs: 20_000, payload: () => JSON.stringify({ time: now(), channel: 'spot.ping' }) };

export const gate: Exchange = {
  id: 'gate',
  name: 'Gate',
  intervals: {
    [MIN]: '1m', [5 * MIN]: '5m', [15 * MIN]: '15m', [30 * MIN]: '30m',
    [HOUR]: '1h', [4 * HOUR]: '4h', [8 * HOUR]: '8h', [DAY]: '1d',
  },
  maxCandles: 8000,
  pageSize: 1000,
  continuous: true,

  async fetchTickers() {
    type Raw = { currency_pair: string; last: string; change_percentage: string; quote_volume: string };
    const raw = await getJson<Raw[]>(`${REST}/spot/tickers`);
    return raw
      .filter((t) => t.currency_pair.endsWith('_USDT') && +t.quote_volume > 0)
      .map((t) => ({
        symbol: t.currency_pair, base: t.currency_pair.split('_')[0], quote: 'USDT',
        last: +t.last, open: +t.last / (1 + +t.change_percentage / 100), quoteVolume: +t.quote_volume,
      }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const step = intervalMs / 1000;
    const to = Math.floor((endTime ?? Date.now()) / 1000);
    const earliest = now() - (MAX_POINTS_BACK - 1) * step;
    limit = Math.min(limit, Math.floor((to - earliest) / step));
    if (limit <= 0) return [];
    const q = new URLSearchParams({ currency_pair: symbol, interval: this.intervals[intervalMs], limit: String(limit), to: String(to) });
    // columns: t(sec), quote volume, close, high, low, open, base volume, closed
    const raw = await getJson<string[][]>(`${REST}/spot/candlesticks?${q}`);
    return raw.map((k) => candle(+k[0] * 1000, k[5], k[3], k[4], k[2], k[6]));
  },

  klineStream(symbol, intervalMs, onCandle) {
    const name = `${this.intervals[intervalMs]}_${symbol}`;
    return new Socket(WS, {
      onOpen: (ws) => ws.send(msg('spot.candlesticks', [this.intervals[intervalMs], symbol])),
      onMessage: (m) => {
        const k = m.result;
        if (m.channel !== 'spot.candlesticks' || m.event !== 'update' || k?.n !== name) return;
        onCandle(candle(+k.t * 1000, k.o, k.h, k.l, k.c, k.a));
      },
      ping,
    });
  },

  tickerStream(symbols, onTicker) {
    return new Socket(WS, {
      onOpen: (ws) => ws.send(msg('spot.tickers', symbols)),
      onMessage: (m) => {
        const d = m.result;
        if (m.channel !== 'spot.tickers' || m.event !== 'update' || !d?.currency_pair) return;
        onTicker({
          symbol: d.currency_pair, base: d.currency_pair.split('_')[0], quote: 'USDT',
          last: +d.last, open: +d.last / (1 + +d.change_percentage / 100), quoteVolume: +d.quote_volume,
        });
      },
      ping,
    });
  },
};
