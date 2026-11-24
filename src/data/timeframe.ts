// Timeframes: an exchange's native interval is used directly; anything else is
// built by aggregating the largest native interval that divides it.
// Units: m = minute, h = hour, D = day, W = week, M = month (d/w/H also accepted).
import { DAY, HOUR, MIN, WEEK } from '../exchanges/util';

const UNIT_MS: Record<string, number> = { m: MIN, h: HOUR, D: DAY, W: WEEK };
// 1970-01-05 was a Monday; weekly candles open Monday 00:00 UTC.
const MONDAY_OFFSET = 4 * DAY;

export interface Timeframe {
  label: string;   // e.g. "45m", "1D", "2W", "3M"
  ms: number;      // bar duration (months approximated as 30 days)
  baseMs: number;  // native interval to fetch
  factor: number;  // base candles per bar (approximate for months)
  bucket(t: number): number; // open time of the bar containing t
}

/**
 * `natives`: the exchange's native interval durations (ms).
 * `session`: for stocks, the session open for a time; intraday bars then restart at the open (09:30 NY, 09:00 VN).
 */
export function parseTimeframe(input: string, natives: number[], session?: (t: number) => number): Timeframe | null {
  const m = input.trim().match(/^(\d+)\s*([mhHdDwWM])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const UNIT: Record<string, string> = { m: 'm', h: 'h', H: 'h', d: 'D', D: 'D', w: 'W', W: 'W', M: 'M' };
  const unit = UNIT[m[2]];
  if (n <= 0) return null;
  const label = `${n}${unit}`;

  if (unit === 'M') {
    // calendar months (UTC), built from daily candles; 3M lines up with quarters
    if (n > 12) return null;
    return {
      label, ms: n * 30 * DAY, baseMs: DAY, factor: n * 30,
      bucket: (t) => {
        const d = new Date(t);
        const idx = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / n) * n;
        return Date.UTC(Math.floor(idx / 12), idx % 12, 1);
      },
    };
  }

  const ms = n * UNIT_MS[unit];
  if (ms > 52 * WEEK) return null;
  // weekly multiples must come from weekly/daily candles so they stay Monday-aligned
  const candidates = natives.filter((b) => ms % b === 0 && (unit !== 'W' || (b % DAY === 0 && WEEK % b === 0) || b === WEEK));
  const baseMs = Math.max(...candidates);
  if (!isFinite(baseMs)) return null;
  const factor = ms / baseMs;

  let bucket: (t: number) => number;
  if (factor === 1) bucket = (t) => t;
  else if (ms < DAY && session) {
    bucket = (t) => {
      const open = session(t);
      return t >= open ? open + Math.floor((t - open) / ms) * ms : t;
    };
  } else if (ms < DAY) {
    // intraday: restart buckets at 00:00 UTC each day (like TradingView)
    bucket = (t) => {
      const day = Math.floor(t / DAY) * DAY;
      return day + Math.floor((t - day) / ms) * ms;
    };
  } else if (unit === 'W') bucket = (t) => Math.floor((t - MONDAY_OFFSET) / ms) * ms + MONDAY_OFFSET;
  else bucket = (t) => Math.floor(t / ms) * ms;

  return { label, ms, baseMs, factor, bucket };
}

export const PRESET_TIMEFRAMES = ['15m', '30m', '1h', '2h', '4h', '8h', '12h', '1D', '3D', '5D', '1W', '2W', '3W', '1M', '2M', '3M'];
