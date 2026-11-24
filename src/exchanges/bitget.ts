// https://www.bitget.com/api-doc/spot/market/Get-History-Candle-Data
import type { Exchange } from './types';
import { DAY, HOUR, MIN, Socket, WEEK, candle, getJson } from './util';

const REST = 'https://api.bitget.com/api/v2/spot';
const WS = 'wss://ws.bitget.com/v2/ws/public';
const ping = { everyMs: 30_000, payload: () => 'ping' };

// REST granularity and WS channel suffix differ slightly; UTC-aligned for >= 6h.
const WS_SUFFIX: Record<string, string> = {
  '1min': '1m', '3min': '3m', '5min': '5m', '15min': '15m', '30min': '30m', '1h': '1H', '4h': '4H',
  '6Hutc': '6Hutc', '12Hutc': '12Hutc', '1Dutc': '1Dutc', '3Dutc': '3Dutc', '1Wutc': '1Wutc',
};

export const bitget: Exchange = {
  id: 'bitget',
  name: 'Bitget',
  intervals: {
    [MIN]: '1min', [3 * MIN]: '3min', [5 * MIN]: '5min', [15 * MIN]: '15min', [30 * MIN]: '30min',
    [HOUR]: '1h', [4 * HOUR]: '4h', [6 * HOUR]: '6Hutc', [12 * HOUR]: '12Hutc',
    [DAY]: '1Dutc', [3 * DAY]: '3Dutc', [WEEK]: '1Wutc',
  },
  maxCandles: 6000,
  pageSize: 1000,
  continuous: true,

  async fetchTickers() {
    type Raw = { symbol: string; lastPr: string; open: string; quoteVolume: string };
    const r = await getJson<{ data: Raw[] }>(`${REST}/market/tickers`);
    return r.data
      .filter((t) => t.symbol.endsWith('USDT') && +t.quoteVolume > 0)
      .map((t) => ({
        symbol: t.symbol, base: t.symbol.slice(0, -4), quote: 'USDT',
        last: +t.lastPr, open: +t.open, quoteVolume: +t.quoteVolume,
      }));
  },

  async fetchPage(symbol, intervalMs, limit, endTime) {
    const granularity = this.intervals[intervalMs];
    const end = endTime ?? Date.now();
    const parse = (rows: string[][]) => rows.map((k) => candle(k[0], k[1], k[2], k[3], k[4], k[5])).sort((a, b) => a.t - b.t);
    // /candles is up to date but only covers recent history (~1 month at 1m) ...
    const q = new URLSearchParams({ symbol, granularity, limit: String(limit), endTime: String(end) });
    const recent = parse((await getJson<{ data: string[][] }>(`${REST}/market/candles?${q}`)).data);
    if (recent.length) return recent;
    // ... older data comes from /history-candles (200 per call, endTime matches the candle *close* time)
    q.set('limit', String(Math.min(limit, 200)));
    q.set('endTime', String(end + intervalMs));
    return parse((await getJson<{ data: string[][] }>(`${REST}/market/history-candles?${q}`)).data).filter((c) => c.t <= end);
  },

  klineStream(symbol, intervalMs, onCandle) {
    const channel = 'candle' + WS_SUFFIX[this.intervals[intervalMs]];
    return new Socket(WS, {
      onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ instType: 'SPOT', channel, instId: symbol }] })),
      onMessage: (m) => {
        if (m.arg?.channel !== channel || !m.data) return;
        const rows = (m.data as string[][]).slice().sort((a, b) => +a[0] - +b[0]);
        for (const k of rows) onCandle(candle(k[0], k[1], k[2], k[3], k[4], k[5]));
      },
      ping,
    });
  },

  tickerStream(symbols, onTicker) {
    return new Socket(WS, {
      onOpen: (ws) =>
        ws.send(JSON.stringify({ op: 'subscribe', args: symbols.map((instId) => ({ instType: 'SPOT', channel: 'ticker', instId })) })),
      onMessage: (m) => {
        if (m.arg?.channel !== 'ticker' || !m.data) return;
        for (const d of m.data) {
          onTicker({
            symbol: d.instId, base: d.instId.slice(0, -4), quote: 'USDT',
            last: +d.lastPr, open: +d.open24h, quoteVolume: +d.quoteVolume,
          });
        }
      },
      ping,
    });
  },
};
