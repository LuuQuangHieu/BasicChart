import './style.css';
import { DEFAULT_WATCHLIST, EXCHANGES, marketKey, nativeIntervals, pairLabel, sessionOf, type Candle, type Closable, type Market, type Ticker } from './exchanges';
import { fetchHistory } from './exchanges/util';
import { CandleStore } from './data/candles';
import { PRESET_TIMEFRAMES, parseTimeframe, type Timeframe } from './data/timeframe';
import { FiboTool, type Fib } from './drawing/fibo';
import { MeasureTool } from './drawing/measure';
import { DEFAULT_SETTINGS, normalizeOrder, type IndicatorSettings, type PaneKey } from './indicators/settings';
import { ChartView, type Theme } from './ui/chartView';
import { formatPrice, pricePrecision } from './ui/format';
import { Watchlist } from './ui/watchlist';

// ---- persisted state ---------------------------------------------------------

interface AppState {
  market: Market;
  watchlist: Market[];
  tf: string;
  customTfs: string[];
  indicators: IndicatorSettings;
  paneOrder: PaneKey[]; // indicator panes, top to bottom
  theme: Theme;
  logScale: boolean; // logarithmic price scale on the candle pane
  wlWidth: number; // watchlist width in px, set by dragging its left edge
}

const STATE_KEY = 'basicchart:state';
const WL_DEFAULT_WIDTH = 320;
const fibKey = (m: Market) => `basicchart:fibo:${marketKey(m)}`;

function loadState(): AppState {
  const fallback: AppState = {
    market: DEFAULT_WATCHLIST[0],
    watchlist: DEFAULT_WATCHLIST,
    tf: '1h',
    customTfs: ['45m', '10h'],
    indicators: DEFAULT_SETTINGS,
    paneOrder: normalizeOrder(null),
    theme: 'light',
    logScale: false,
    wlWidth: WL_DEFAULT_WIDTH,
  };
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
    if (!s) return fallback;
    if (!s.market && s.symbol) s.market = { ex: 'binance', symbol: s.symbol, base: s.symbol.replace(/USDT$/, ''), quote: 'USDT' };
    delete s.symbol;
    const ind = { ...DEFAULT_SETTINGS, ...s.indicators };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof IndicatorSettings)[]) {
      ind[k] = { ...DEFAULT_SETTINGS[k], ...(s.indicators?.[k] ?? {}) } as never;
    }
    return { ...fallback, ...s, indicators: ind, paneOrder: normalizeOrder(s.paneOrder) };
  } catch {
    return fallback;
  }
}

const state = loadState();
// normalise labels saved by older versions (1d -> 1D, 1w -> 1W) and drop customs that are now presets
{
  const norm = (tf: string) => parseTimeframe(tf, [60_000])?.label ?? tf;
  state.tf = norm(state.tf);
  state.customTfs = [...new Set(state.customTfs.map(norm))].filter((t) => !PRESET_TIMEFRAMES.includes(t));
}
const saveState = () => localStorage.setItem(STATE_KEY, JSON.stringify(state));
const loadFibs = (m: Market): Fib[] => JSON.parse(localStorage.getItem(fibKey(m)) ?? '[]');
const exchange = () => EXCHANGES[state.market.ex];
const natives = () => nativeIntervals(state.market);
const session = () => sessionOf(state.market);

// ---- layout ------------------------------------------------------------------

document.querySelector('#app')!.innerHTML = `
  <aside class="watchlist"></aside>
  <div class="wl-resizer" title="Drag to resize the watchlist · double-click to reset"></div>
  <main>
    <header class="toolbar">
      <div class="symbol"><b id="sym"></b><em id="exname"></em><span id="last"></span><span id="chg"></span></div>
      <div class="tb-row">
        <div class="tfs" id="tfs"></div>
        <form class="tf-custom" id="tf-form">
          <input id="tf-input" placeholder="e.g. 7m, 45m, 10h, 6M" spellcheck="false" />
          <button>Apply</button>
        </form>
        <div class="spacer"></div>
        <button id="btn-ind">Indicators</button>
        <button id="btn-measure" title="Price & time range: click the start, then the end (or Shift + click)">Measure</button>
        <button id="btn-fib" title="Fibonacci retracement: click the start, then the end">Fibo</button>
        <button id="btn-clear" title="Remove all Fibonacci drawings on this symbol">Clear drawings</button>
        <button id="btn-log" title="Logarithmic price scale (Alt + L)">Log</button>
        <button id="btn-theme"></button>
      </div>
    </header>
    <div class="chart-wrap">
      <div id="chart"></div>
      <div class="legend" id="legend"></div>
      <div class="status" id="status"></div>
      <div class="panel" id="ind-panel" hidden></div>
    </div>
  </main>
  <button class="wl-fab" title="Show the watchlist">☰ Watchlist</button>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chartEl = $('chart');
const statusEl = $('status');
const chartView = new ChartView(chartEl, $('legend'));
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  chartView.setTheme(state.theme);
  chartView.applyIndicators(state.indicators, state.paneOrder);
  const btn = $('btn-theme');
  btn.textContent = state.theme === 'dark' ? '☀' : '☾';
  btn.title = state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}
applyTheme();
$('btn-theme').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  saveState();
  applyTheme();
};
function applyLogScale() {
  chartView.setLogScale(state.logScale);
  $('btn-log').classList.toggle('active', state.logScale);
}
applyLogScale();
const toggleLogScale = () => {
  state.logScale = !state.logScale;
  saveState();
  applyLogScale();
};
$('btn-log').onclick = toggleLogScale;
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyL' && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    toggleLogScale();
  }
});
chartView.onRemovePane = (key) => {
  // just switches it off: settings and position are kept, turn it back on from Indicators
  state.indicators = { ...state.indicators, [key]: { ...state.indicators[key], enabled: false } };
  saveState();
  chartView.applyIndicators(state.indicators, state.paneOrder);
  if (!$('ind-panel').hidden) renderPanel();
};
chartView.onMovePane = (key, dir) => {
  // step over hidden indicators so one click always moves the pane one place on screen
  const shown = state.paneOrder.filter((k) => state.indicators[k].enabled);
  const j = shown.indexOf(key) + dir;
  if (j < 0 || j >= shown.length) return;
  const order = state.paneOrder.filter((k) => k !== key);
  const at = order.indexOf(shown[j]);
  order.splice(dir < 0 ? at : at + 1, 0, key);
  state.paneOrder = order;
  saveState();
  chartView.applyIndicators(state.indicators, state.paneOrder);
};

const fibo = new FiboTool(
  chartEl,
  (fibs) => localStorage.setItem(fibKey(state.market), JSON.stringify(fibs)),
  (on) => $('btn-fib').classList.toggle('active', on),
);
chartView.candles.attachPrimitive(fibo);

const measure = new MeasureTool(chartEl, (on) => $('btn-measure').classList.toggle('active', on));
chartView.candles.attachPrimitive(measure);
fibo.blocked = () => measure.active;
measure.blocked = () => fibo.isDrawing;

$('btn-measure').onclick = () => {
  if (fibo.isDrawing) fibo.setDrawing(false);
  measure.cancel();
  measure.toggle();
};
$('btn-fib').onclick = () => {
  if (measure.active) measure.cancel();
  fibo.setDrawing(!fibo.isDrawing);
};
$('btn-clear').onclick = () => {
  if (fibo.fibs.length && confirm(`Remove all Fibonacci drawings on ${pairLabel(state.market)}?`)) fibo.clear();
};

// ---- header / watchlist --------------------------------------------------------

function showPrice(price: number) {
  $('last').textContent = formatPrice(price);
  document.title = `${formatPrice(price)} ${pairLabel(state.market)} · BasicChart`;
}

function showTicker(m: Market, t: Ticker) {
  if (marketKey(m) !== marketKey(state.market)) return;
  const pct = ((t.last - t.open) / t.open) * 100;
  showPrice(t.last);
  const chg = $('chg');
  chg.textContent = isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
  chg.className = pct >= 0 ? 'up' : 'down';
}

// ---- watchlist width: drag the border between the chart and the watchlist -----------

const WL_MIN = 200;
const wlEl = document.querySelector<HTMLElement>('.watchlist')!;
const clampWl = (w: number) => Math.round(Math.max(WL_MIN, Math.min(w, window.innerWidth - 320)));
const setWlWidth = (w: number) => {
  wlEl.style.width = `${clampWl(w)}px`;
};
setWlWidth(state.wlWidth);
window.addEventListener('resize', () => setWlWidth(state.wlWidth));
{
  const handle = document.querySelector<HTMLElement>('.wl-resizer')!;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = wlEl.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    handle.classList.add('dragging');
    const move = (ev: PointerEvent) => setWlWidth(startW + startX - ev.clientX); // watchlist is on the right
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      handle.classList.remove('dragging');
      state.wlWidth = clampWl(wlEl.getBoundingClientRect().width);
      saveState();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    state.wlWidth = WL_DEFAULT_WIDTH;
    setWlWidth(state.wlWidth);
    saveState();
  });
}

// ---- phone layout: the watchlist is a sheet over the bottom of the chart -------------
// Tapping a symbol or swiping the sheet down hides it behind a button; the button brings it back.

const phone = window.matchMedia('(max-width: 768px)');
const setSheet = (open: boolean) => document.body.classList.toggle('wl-hidden', !open);
document.querySelector<HTMLElement>('.wl-fab')!.onclick = () => setSheet(true);

const watchlist = new Watchlist(document.querySelector('.watchlist')!, {
  list: state.watchlist,
  onSelect: (m) => {
    selectMarket(m);
    if (phone.matches) setSheet(false); // uncover the chart
  },
  onChange: (list) => {
    state.watchlist = list;
    saveState();
  },
  onTick: showTicker,
});
{
  const grab = document.createElement('div');
  grab.className = 'wl-grab';
  grab.title = 'Swipe down to hide';
  wlEl.prepend(grab);
  // swipe the sheet down by its grab bar or header to hide it; a tap on the grab bar hides it too
  const swipeStart = (e: PointerEvent) => {
    if (!phone.matches || (e.target as HTMLElement).closest('button')) return;
    const y0 = e.clientY;
    let dy = 0;
    wlEl.classList.add('swiping');
    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - y0);
      wlEl.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      wlEl.classList.remove('swiping');
      wlEl.style.transform = '';
      if (dy > 60 || (e.target === grab && dy < 5)) setSheet(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  grab.addEventListener('pointerdown', swipeStart);
  wlEl.querySelector<HTMLElement>('.wl-head')!.addEventListener('pointerdown', swipeStart);
}

function selectMarket(m: Market) {
  if (marketKey(m) === marketKey(state.market)) return;
  state.market = m;
  saveState();
  $('chg').textContent = '';
  load();
}

// ---- timeframes --------------------------------------------------------------

function renderTfs() {
  const all = [...PRESET_TIMEFRAMES, ...state.customTfs.filter((t) => !PRESET_TIMEFRAMES.includes(t))];
  $('tfs').innerHTML = all
    .map((tf) => {
      const custom = !PRESET_TIMEFRAMES.includes(tf);
      return `<button data-tf="${tf}" class="${tf === state.tf ? 'active' : ''} ${custom ? 'custom' : ''}">${tf}${
        custom ? `<i data-del="${tf}" title="Remove this timeframe">×</i>` : ''
      }</button>`;
    })
    .join('');
}

$('tfs').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const del = target.dataset.del;
  if (del) {
    state.customTfs = state.customTfs.filter((t) => t !== del);
    saveState();
    renderTfs();
    return;
  }
  const tf = target.closest<HTMLElement>('[data-tf]')?.dataset.tf;
  if (tf) setTimeframe(tf);
});

$('tf-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('tf-input');
  const tf = parseTimeframe(input.value, natives(), session());
  if (!tf) {
    input.classList.add('invalid');
    input.title = 'Format: number + m (minutes), h (hours), D (days), W (weeks), M (months). E.g. 7m, 45m, 10h, 2D, 6M';
    return;
  }
  input.classList.remove('invalid');
  input.value = '';
  if (!PRESET_TIMEFRAMES.includes(tf.label) && !state.customTfs.includes(tf.label)) state.customTfs.push(tf.label);
  setTimeframe(tf.label);
});
$('tf-input').addEventListener('input', (e) => (e.target as HTMLElement).classList.remove('invalid'));

function setTimeframe(tf: string) {
  if (tf === state.tf) return;
  state.tf = tf;
  saveState();
  renderTfs();
  load();
}

// ---- indicator settings panel ----------------------------------------------------

function renderPanel() {
  const s = state.indicators;
  const num = (path: string, value: number, label: string) =>
    `<label>${label}<input type="number" min="1" max="500" data-path="${path}" value="${value}" /></label>`;
  $('ind-panel').innerHTML = `
    <section>
      <label class="title"><input type="checkbox" data-path="ma.enabled" ${s.ma.enabled ? 'checked' : ''}/> Moving Average</label>
      <label>Type<select data-path="ma.type">
        <option ${s.ma.type === 'EMA' ? 'selected' : ''}>EMA</option><option ${s.ma.type === 'SMA' ? 'selected' : ''}>SMA</option>
      </select></label>
      <label>Periods<input data-path="ma.periods" value="${s.ma.periods.join(', ')}" placeholder="20, 50, 200" /></label>
    </section>
    <section>
      <label class="title"><input type="checkbox" data-path="rsi.enabled" ${s.rsi.enabled ? 'checked' : ''}/> RSI</label>
      ${num('rsi.period', s.rsi.period, 'Length')}${num('rsi.upper', s.rsi.upper, 'Overbought')}${num('rsi.lower', s.rsi.lower, 'Oversold')}
    </section>
    <section>
      <label class="title"><input type="checkbox" data-path="stochRsi.enabled" ${s.stochRsi.enabled ? 'checked' : ''}/> Stoch RSI</label>
      ${num('stochRsi.rsiLen', s.stochRsi.rsiLen, 'RSI')}${num('stochRsi.stochLen', s.stochRsi.stochLen, 'Stoch')}
      ${num('stochRsi.k', s.stochRsi.k, 'K')}${num('stochRsi.d', s.stochRsi.d, 'D')}
    </section>
    <section>
      <label class="title"><input type="checkbox" data-path="macd.enabled" ${s.macd.enabled ? 'checked' : ''}/> MACD</label>
      ${num('macd.fast', s.macd.fast, 'Fast')}${num('macd.slow', s.macd.slow, 'Slow')}${num('macd.signal', s.macd.signal, 'Signal')}
    </section>
    <section>
      <label class="title"><input type="checkbox" data-path="cluster.enabled" ${s.cluster.enabled ? 'checked' : ''}/> Cluster Algo</label>
      ${num('cluster.rsiLen', s.cluster.rsiLen, 'RSI')}${num('cluster.sigLen', s.cluster.sigLen, 'Signal (LinReg)')}
      ${num('cluster.bbLen', s.cluster.bbLen, 'BB length')}${num('cluster.bbMult', s.cluster.bbMult, 'BB mult')}
      ${num('cluster.ob', s.cluster.ob, 'Overbought')}${num('cluster.os', s.cluster.os, 'Oversold')}
      <label class="check"><input type="checkbox" data-path="cluster.dots" ${s.cluster.dots ? 'checked' : ''}/> Buy/sell dots (filtered by EMA50/EMA200)</label>
    </section>
    <section>
      <label class="title"><input type="checkbox" data-path="rsiTue.enabled" ${s.rsiTue.enabled ? 'checked' : ''}/> RSI Tue Trading</label>
      ${num('rsiTue.rsiLen', s.rsiTue.rsiLen, 'RSI')}${num('rsiTue.fastLen', s.rsiTue.fastLen, 'Fast (EMA)')}
      ${num('rsiTue.slowLen', s.rsiTue.slowLen, 'Slow (WMA)')}${num('rsiTue.ob', s.rsiTue.ob, 'Over Buy')}
      ${num('rsiTue.os', s.rsiTue.os, 'Over Sell')}
    </section>`;
}

$('btn-ind').onclick = () => {
  const panel = $('ind-panel');
  panel.hidden = !panel.hidden;
  $('btn-ind').classList.toggle('active', !panel.hidden);
  if (!panel.hidden) renderPanel();
};

let applyTimer = 0;
$('ind-panel').addEventListener('change', onPanelInput);
$('ind-panel').addEventListener('input', onPanelInput);

function onPanelInput(e: Event) {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const path = el.dataset.path;
  if (!path) return;
  const [group, key] = path.split('.') as [keyof IndicatorSettings, string];
  const target = state.indicators[group] as unknown as Record<string, unknown>;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') target[key] = el.checked;
  else if (key === 'periods') {
    const periods = el.value.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 1000);
    if (!periods.length) return;
    target[key] = periods.slice(0, 3);
  } else if (key === 'type') target[key] = el.value;
  else {
    const n = Number(el.value);
    if (!Number.isFinite(n) || n < 1) return;
    target[key] = n;
  }
  state.indicators = { ...state.indicators };
  saveState();
  clearTimeout(applyTimer);
  applyTimer = window.setTimeout(() => chartView.applyIndicators(state.indicators, state.paneOrder), 150);
}

// ---- data loading ------------------------------------------------------------

// default zoom when a chart opens: about this many px per candle (more bars on wide screens)
const BAR_PX = 25 / 12; // ~2.1px
const RIGHT_PAD = 50; // empty bars to the right of the last candle
const visibleBars = () => {
  const w = chartView.chart.timeScale().width() || chartEl.clientWidth - 60;
  return Math.round(Math.min(960, Math.max(96, w / BAR_PX)));
};
let token = 0;
let stream: Closable | null = null;
let store: CandleStore | null = null;
let loadingOlder = false;
let exhausted = false;

// Base candles already downloaded, per market and native interval. Timeframes built from the same base
// (1D -> 3D, 1W, 2W, 1M…) and going back to a timeframe seen before then open instantly; only the newest
// candles are re-fetched. Kept for this tab only.
interface Cached { candles: Candle[]; exhausted: boolean }
const baseCache = new Map<string, Cached>();
const cacheKey = (m: Market, baseMs: number) => `${marketKey(m)}@${baseMs}`;

/** History for `m`, at least `want` base candles (or all there is), from cache when possible. */
async function history(m: Market, baseMs: number, want: number): Promise<Cached> {
  const ex = EXCHANGES[m.ex];
  const key = cacheKey(m, baseMs);
  let hit = baseCache.get(key);
  if (!hit) {
    const candles = await fetchHistory(ex, m.symbol, baseMs, want);
    hit = { candles, exhausted: candles.length < want };
  } else {
    // catch up on the bars that closed while we were away
    const last = hit.candles[hit.candles.length - 1];
    const missing = last ? Math.ceil((Date.now() - last.t) / baseMs) + 1 : want;
    let candles = hit.candles;
    if (missing > ex.pageSize) {
      candles = await fetchHistory(ex, m.symbol, baseMs, want); // too stale: start over
    } else {
      const fresh = await ex.fetchPage(m.symbol, baseMs, Math.max(2, missing));
      const from = fresh[0]?.t ?? Infinity;
      candles = [...candles.filter((c) => c.t < from), ...fresh];
    }
    if (!hit.exhausted && candles.length < want) {
      const older = await fetchHistory(ex, m.symbol, baseMs, want - candles.length, candles[0].t - 1);
      hit = { candles: [...older, ...candles], exhausted: older.length < want - candles.length };
    } else hit = { candles, exhausted: hit.exhausted };
  }
  baseCache.set(key, hit);
  return hit;
}

/** Keep what the chart has now (live updates, older pages loaded by scrolling) for next time. */
function rememberStore() {
  if (store?.base.length) baseCache.set(cacheKey(store.market, store.tf.baseMs), { candles: store.base.slice(), exhausted });
}

/** Daily history powers every timeframe from 1D up: fetch it quietly so switching there is instant. */
let prefetchTimer = 0;
function prefetchDaily(m: Market) {
  clearTimeout(prefetchTimer);
  prefetchTimer = window.setTimeout(() => {
    if (marketKey(m) !== marketKey(state.market) || !nativeIntervals(m).includes(DAY_MS)) return;
    if (baseCache.has(cacheKey(m, DAY_MS))) return;
    history(m, DAY_MS, EXCHANGES[m.ex].maxCandles).catch(() => {});
  }, 1500);
}
const DAY_MS = 86_400_000;

function syncFibo(tf: Timeframe) {
  const last = chartView.data[chartView.data.length - 1];
  const precision = last ? pricePrecision(last.c) : 2;
  fibo.setBars(chartView.data, tf.ms, precision);
  measure.setBars(chartView.data, tf.ms, precision);
}

async function load() {
  const my = ++token;
  rememberStore();
  stream?.close();
  stream = null;
  if (fibo.isDrawing) fibo.setDrawing(false);
  const m = state.market;
  const ex = exchange();
  // a timeframe finer than the data (e.g. 1h on monthly FEDFUNDS) falls back to 1D
  const tf = parseTimeframe(state.tf, natives(), session()) ?? parseTimeframe('1h', natives(), session()) ?? parseTimeframe('1D', natives(), session())!;
  $('sym').textContent = `${pairLabel(m)}`;
  $('exname').textContent = ex.name;
  watchlist.setActive(m);
  statusEl.textContent = `Loading ${pairLabel(m)} (${ex.name}) ${tf.label}…`;
  statusEl.hidden = false;

  try {
    const want = Math.min(1000 * tf.factor, ex.maxCandles);
    // seen before with enough history: draw it right away, then catch up on the newest bars below
    const cached = baseCache.get(cacheKey(m, tf.baseMs));
    const instant = cached && (cached.exhausted || cached.candles.length >= want);
    const { candles, exhausted: noMore } = instant ? cached : await history(m, tf.baseMs, want);
    if (my !== token) return;
    store = new CandleStore(tf, m);
    store.setBase(candles);
    exhausted = noMore;
    chartView.setBars(store.bars);
    const n = store.bars.length;
    // leave RIGHT_PAD empty bars after the last candle; with few bars (e.g. 3M on a young coin)
    // spread them out instead of leaving empty space on the left
    const span = visibleBars();
    const pad = n > span ? RIGHT_PAD : Math.min(8, Math.max(2, n / 10));
    chartView.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n + pad - span), to: n + pad });
    syncFibo(tf);
    fibo.setFibs(loadFibs(m));
    statusEl.hidden = n > 0;
    if (!n) statusEl.textContent = 'No candle data for this symbol.';
    if (n) showPrice(store.bars[n - 1].c);

    if (instant) {
      const fresh = await history(m, tf.baseMs, want);
      if (my !== token || !store) return;
      store.setBase(fresh.candles);
      exhausted = fresh.exhausted;
      chartView.setBars(store.bars, true);
      syncFibo(tf);
      if (store.bars.length) showPrice(store.bars[store.bars.length - 1].c);
    }

    prefetchDaily(m);
    stream = ex.klineStream(m.symbol, tf.baseMs, (c) => {
      if (my !== token || !store) return;
      const bar = store.upsert(c);
      chartView.updateLast(bar);
      showPrice(bar.c);
    });
  } catch (e) {
    if (my === token) statusEl.textContent = `Failed to load data: ${(e as Error).message}`;
  }
}

chartView.onVisibleRangeChange(async (range) => {
  if (!range || range.from > 30 || loadingOlder || exhausted || !store) return;
  loadingOlder = true;
  const my = token;
  const tf = store.tf;
  const ex = exchange();
  try {
    const want = Math.min(1000 * tf.factor, ex.maxCandles);
    const older = await fetchHistory(ex, state.market.symbol, tf.baseMs, want, store.base[0].t - 1);
    if (my !== token) return;
    if (older.length < want) exhausted = true;
    if (older.length) {
      store.prependBase(older);
      chartView.setBars(store.bars, true);
      syncFibo(tf);
    }
  } catch {
    exhausted = true; // e.g. exchange limits how far back history goes
  } finally {
    loadingOlder = false;
  }
});

renderTfs();
load();
