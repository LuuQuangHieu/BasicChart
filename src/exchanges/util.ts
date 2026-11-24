import type { Candle, Closable, Exchange } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET JSON, retrying a few times when the exchange rate-limits us (HTTP 429). */
export async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < 4) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export const num = (s: string | number) => +s;

export function candle(t: number | string, o: string, h: string, l: string, c: string, v: string): Candle {
  return { t: +t, o: +o, h: +h, l: +l, c: +c, v: +v };
}

/** Page backwards through history until `count` candles or the listing date. */
export async function fetchHistory(
  ex: Exchange,
  symbol: string,
  intervalMs: number,
  count: number,
  endTime?: number,
): Promise<Candle[]> {
  if (ex.continuous) return fetchParallel(ex, symbol, intervalMs, count, endTime);
  const out: Candle[] = [];
  let end = endTime;
  while (out.length < count) {
    const limit = Math.min(ex.pageSize, count - out.length);
    let page = await ex.fetchPage(symbol, intervalMs, limit, end);
    const first = out[0]?.t ?? Infinity;
    page = page.filter((c) => c.t < first && (end === undefined || c.t <= end));
    if (!page.length) break; // listing date or the exchange's history limit
    out.unshift(...page);
    end = page[0].t - 1;
  }
  return out;
}

const PARALLEL = 4;

/**
 * Markets open 24/7 have one candle per interval, so page k simply ends k·pageSize intervals back:
 * fetch several pages at once instead of one after another. Overlaps (exchange downtime) are de-duplicated;
 * an empty page means the listing date was reached.
 */
async function fetchParallel(ex: Exchange, symbol: string, intervalMs: number, count: number, endTime?: number): Promise<Candle[]> {
  const end = endTime ?? Date.now();
  const span = ex.pageSize * intervalMs;
  const pages = Math.ceil(count / ex.pageSize);
  const byTime = new Map<number, Candle>();
  for (let i = 0; i < pages; i += PARALLEL) {
    const batch = Array.from({ length: Math.min(PARALLEL, pages - i) }, (_, j) => {
      const k = i + j;
      // the newest page keeps endTime undefined when the caller asked for "latest" (some APIs want no end then)
      const pageEnd = k === 0 ? endTime : Math.floor(end / intervalMs) * intervalMs - k * span + intervalMs - 1;
      return ex.fetchPage(symbol, intervalMs, ex.pageSize, pageEnd);
    });
    const results = await Promise.all(batch);
    let done = false;
    for (const page of results) {
      if (!page.length) done = true;
      for (const c of page) if (c.t <= end) byTime.set(c.t, c);
    }
    if (done) break;
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-count);
}

interface SocketOptions {
  onOpen?: (ws: WebSocket) => void;
  onMessage: (msg: any) => void;
  ping?: { everyMs: number; payload: () => string };
}

/** WebSocket with automatic reconnect + keep-alive pings. */
export class Socket {
  private ws?: WebSocket;
  private closed = false;
  private attempt = 0;
  private pingTimer = 0;

  constructor(
    private readonly url: string | (() => string),
    private readonly opts: SocketOptions,
  ) {
    this.connect();
  }

  private connect() {
    const url = typeof this.url === 'function' ? this.url() : this.url;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onOpen?.(ws);
      if (this.opts.ping) {
        const { everyMs, payload } = this.opts.ping;
        this.pingTimer = window.setInterval(() => ws.readyState === 1 && ws.send(payload()), everyMs);
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.attempt++;
      setTimeout(() => !this.closed && this.connect(), Math.min(10_000, 500 * 2 ** this.attempt));
    };
    ws.onerror = () => ws.close();
  }

  get attempts() {
    return this.attempt;
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** "Stream" for REST-only sources: calls `tick` now and then every `everyMs` until closed. */
export function poll(everyMs: number, tick: () => Promise<void>): Closable {
  let closed = false, timer = 0;
  const run = async () => {
    try {
      await tick();
    } catch {
      /* keep polling */
    }
    if (!closed) timer = window.setTimeout(run, everyMs);
  };
  run();
  return { close: () => { closed = true; clearTimeout(timer); } };
}

/**
 * Calendar span (ms) that holds about `limit` bars of a market open `sessionMin` minutes a day, 5 days a week,
 * with room for holidays.
 */
export function stockSpan(intervalMs: number, limit: number, sessionMin: number): number {
  if (intervalMs >= DAY) return (Math.ceil((limit * 7) / 5) + 15) * DAY;
  const perDay = Math.max(1, Math.floor((sessionMin * MIN) / intervalMs));
  return (Math.ceil((Math.ceil(limit / perDay) * 7) / 5) + 12) * DAY;
}
