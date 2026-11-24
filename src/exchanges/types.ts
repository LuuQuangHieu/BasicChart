export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'gate' | 'bitget' | 'bitstamp' | 'vn' | 'us' | 'macro';

export interface Candle {
  t: number; // open time (ms, UTC)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Ticker {
  symbol: string; // exchange-native id, e.g. BTCUSDT, BTC-USDT, BTC_USDT
  base: string;
  quote: string;
  last: number;
  open: number; // price 24h ago
  quoteVolume: number;
  name?: string; // company / instrument name (stock search results)
}

/** A coin on a given exchange — what the watchlist and chart work with. */
export interface Market {
  ex: ExchangeId;
  symbol: string;
  base: string;
  quote: string;
}

export interface Closable {
  close(): void;
}

export interface Exchange {
  id: ExchangeId;
  name: string;
  /** Native candle intervals: duration in ms -> exchange interval code. */
  intervals: Record<number, string>;
  /** Max base candles fetched per load (keeps paging cost reasonable). */
  maxCandles: number;
  /** All spot USDT pairs with 24h stats. */
  fetchTickers(): Promise<Ticker[]>;
  /** Up to `limit` candles with open time <= endTime (or latest), oldest first. Empty = no more history. */
  fetchPage(symbol: string, intervalMs: number, limit: number, endTime?: number): Promise<Candle[]>;
  pageSize: number;
  /** Trades round the clock (crypto): history pages can be computed from time alone and fetched in parallel. */
  continuous?: boolean;
  klineStream(symbol: string, intervalMs: number, onCandle: (c: Candle) => void): Closable;
  tickerStream(symbols: string[], onTicker: (t: Ticker) => void): Closable;
  /** Stock sources: look symbols up by text instead of listing every ticker. */
  search?(q: string): Promise<Ticker[]>;
  /**
   * Stock sources: open time of the trading session containing t, for this symbol (intraday bars restart there).
   * Undefined = round-the-clock market, bars restart at 00:00 UTC.
   */
  sessionFor?(symbol: string): ((t: number) => number) | undefined;
  /** Sources whose symbols differ in available intervals (e.g. monthly economic data). */
  intervalsFor?(symbol: string): Record<number, string>;
}
