import { binance } from './binance';
import { bitget } from './bitget';
import { bitstamp } from './bitstamp';
import { bybit } from './bybit';
import { gate } from './gate';
import { macro } from './macro';
import { okx } from './okx';
import { us } from './us';
import { vn } from './vn';
import type { Exchange, ExchangeId, Market } from './types';

export const EXCHANGES: Record<ExchangeId, Exchange> = { binance, bybit, okx, gate, bitget, bitstamp, vn, us, macro };
export const EXCHANGE_ORDER: ExchangeId[] = ['binance', 'bybit', 'okx', 'gate', 'bitget', 'bitstamp', 'vn', 'us', 'macro'];

/** Native candle intervals (ms) available for this market. */
export const nativeIntervals = (m: Market) =>
  Object.keys(EXCHANGES[m.ex].intervalsFor?.(m.symbol) ?? EXCHANGES[m.ex].intervals).map(Number);
export const sessionOf = (m: Market) => EXCHANGES[m.ex].sessionFor?.(m.symbol);

/** "BTC/USDT", "FPT/VND", or just "BTC.D" for symbols without a quote currency. */
export const pairLabel = (m: { base: string; quote: string }) => (m.quote ? `${m.base}/${m.quote}` : m.base);

export const marketKey = (m: Market) => `${m.ex}:${m.symbol}`;

const m = (ex: ExchangeId, base: string): Market => ({
  ex,
  base,
  quote: 'USDT',
  symbol: ex === 'okx' ? `${base}-USDT` : ex === 'gate' ? `${base}_USDT` : `${base}USDT`,
});

// The default watchlist (also the starting list on a new browser or machine).
// BTC from Bitstamp for its longer history (2011+); MX and KAS are not listed on Binance spot.
const stock = (ex: ExchangeId, symbol: string, quote: string): Market => ({ ex, symbol, base: symbol, quote });
const macroSym = (symbol: string): Market => ({ ex: 'macro', symbol, base: symbol, quote: '' });

export const DEFAULT_WATCHLIST: Market[] = [
  { ex: 'bitstamp', symbol: 'btcusd', base: 'BTC', quote: 'USD' },
  m('binance', 'ETH'), m('binance', 'SOL'), m('binance', 'LINK'), m('binance', 'ADA'),
  m('bybit', 'MX'), m('binance', 'SUI'), m('binance', 'APT'), m('bybit', 'KAS'), m('binance', 'ARB'),
  m('binance', 'OP'), m('binance', 'STRK'), m('binance', 'NEAR'),
  ...['BTC.D', 'ETH.D', 'USDT.D', 'GOLD', 'SILVER', 'USOIL', 'FEDFUNDS', 'SPX', 'NDX', 'USUR', 'DJI'].map(macroSym),
  stock('us', 'NVDA', 'USD'),
  stock('vn', 'FPT', 'VND'),
];

export * from './types';
