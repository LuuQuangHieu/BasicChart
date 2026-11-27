export interface IndicatorSettings {
  ma: { enabled: boolean; type: 'SMA' | 'EMA'; periods: number[] };
  rsi: { enabled: boolean; period: number; upper: number; lower: number };
  stochRsi: { enabled: boolean; rsiLen: number; stochLen: number; k: number; d: number };
  macd: { enabled: boolean; fast: number; slow: number; signal: number };
  rsiTue: { enabled: boolean; rsiLen: number; fastLen: number; slowLen: number; ob: number; os: number };
  cluster: {
    enabled: boolean; rsiLen: number; sigLen: number; bbLen: number; bbMult: number;
    ob: number; os: number; dots: boolean;
  };
}

export const DEFAULT_SETTINGS: IndicatorSettings = {
  ma: { enabled: true, type: 'EMA', periods: [20, 50, 200] },
  rsi: { enabled: false, period: 14, upper: 70, lower: 30 },
  stochRsi: { enabled: false, rsiLen: 14, stochLen: 14, k: 3, d: 3 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
  // defaults of "RSI Tue Trading" on TradingView
  rsiTue: { enabled: true, rsiLen: 14, fastLen: 9, slowLen: 45, ob: 80, os: 20 },
  // defaults of "Cluster Algo (Skoda Version)" on TradingView
  cluster: { enabled: true, rsiLen: 9, sigLen: 21, bbLen: 34, bbMult: 2, ob: 70, os: 30, dots: true },
};

export const MA_COLORS = ['#f5c542', '#4aa3ff', '#e05cff'];

/** Indicators drawn in their own pane below the candles; the user can reorder them. */
export type PaneKey = 'rsi' | 'stochRsi' | 'macd' | 'rsiTue' | 'cluster';
export const PANE_KEYS: PaneKey[] = ['rsi', 'stochRsi', 'macd', 'rsiTue', 'cluster'];
export const PANE_NAMES: Record<PaneKey, string> = {
  rsi: 'RSI', stochRsi: 'Stoch RSI', macd: 'MACD', rsiTue: 'RSI Tue Trading', cluster: 'Cluster Algo',
};

/** Saved order -> valid order: unknown keys dropped, missing ones appended. */
export const normalizeOrder = (order: unknown): PaneKey[] => {
  const known = Array.isArray(order) ? order.filter((k): k is PaneKey => PANE_KEYS.includes(k)) : [];
  return [...new Set([...known, ...PANE_KEYS])];
};
