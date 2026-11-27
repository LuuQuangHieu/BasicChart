import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../exchanges/types';
import { ema, macd, rsi, sma, stochRsi, type Series } from '../indicators/core';
import { cluster } from '../indicators/cluster';
import { rsiTue } from '../indicators/rsiTue';
import { MA_COLORS, PANE_KEYS, PANE_NAMES, type IndicatorSettings, type PaneKey } from '../indicators/settings';
import { BandFill } from './bandFill';
import { RsiTueDecor } from './rsiTueDecor';
import { TZ_SHIFT_SEC, formatPrice, formatVolume, pricePrecision } from './format';

const UP = '#ffffff';
const DOWN = '#2962ff';

export type Theme = 'dark' | 'light';

/** Chart colours per theme. Candles stay white (up) / blue (down); on white they get a grey outline. */
const THEMES = {
  dark: {
    bg: '#131722', text: '#b2b5be', grid: '#1e222d', border: '#2a2e39', separatorHover: '#3a3f4b',
    upBorder: UP, volUp: UP + '55', volDown: DOWN + '55', rsiLevel: 'rgba(255,255,255,0.6)',
  },
  light: {
    bg: '#ffffff', text: '#131722', grid: '#f0f3fa', border: '#e0e3eb', separatorHover: '#c9ccd6',
    upBorder: '#5d606b', volUp: '#5d606b40', volDown: DOWN + '40', rsiLevel: 'rgba(19,23,34,0.45)',
  },
} as const;

export const toTime = (ms: number) => (Math.floor(ms / 1000) + TZ_SHIFT_SEC) as UTCTimestamp;

interface Plot {
  label: string;
  series: ISeriesApi<SeriesType>;
  compute: (close: Series) => Series;
  color?: (v: number, i: number, values: Series) => string;
  price?: boolean; // value is in price units (format with price precision)
  legend?: boolean; // show in the legend (default true)
  ma?: string; // moving average: its period, shown in the legend
}

export class ChartView {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private plots: Plot[] = [];
  private bars: Candle[] = [];
  private precision = 2;
  private theme: Theme = 'dark';
  private get colors() {
    return THEMES[this.theme];
  }
  /** What each pane shows: 'main' for the candles, then the indicator panes in order. */
  private paneKeys: ('main' | PaneKey)[] = ['main'];
  private paneCtl: HTMLElement;
  /** Called with an indicator pane and -1 (up) / +1 (down) when its arrow is clicked. */
  onMovePane: (key: PaneKey, dir: number) => void = () => {};
  /** Called when an indicator pane's × is clicked. */
  onRemovePane: (key: PaneKey) => void = () => {};

  constructor(
    container: HTMLElement,
    private readonly legend: HTMLElement,
  ) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#b2b5be',
        fontSize: 12,
        panes: { separatorColor: '#2a2e39', separatorHoverColor: '#3a3f4b' },
      },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 8 },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.chart.subscribeCrosshairMove((p) => this.renderLegend(p));
    container.addEventListener('wheel', (e) => this.onWheel(e, container), { capture: true, passive: false });
    this.freeDrag(container);

    // TradingView-style pane buttons: hover an indicator pane to get its name and ▲ ▼ to reorder it
    this.paneCtl = document.createElement('div');
    this.paneCtl.className = 'pane-ctl';
    this.paneCtl.hidden = true;
    container.parentElement!.appendChild(this.paneCtl);
    container.addEventListener('mousemove', (e) => this.showPaneCtl(e.clientY - container.getBoundingClientRect().top));
    container.addEventListener('mouseleave', (e) => {
      if (!this.paneCtl.contains(e.relatedTarget as Node)) this.paneCtl.hidden = true;
    });
    this.paneCtl.addEventListener('mouseleave', (e) => {
      if (!container.contains(e.relatedTarget as Node)) this.paneCtl.hidden = true;
    });
    this.paneCtl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      const key = this.paneCtl.dataset.key as PaneKey | undefined;
      if (!btn || btn.disabled || !key) return;
      this.paneCtl.hidden = true;
      if (btn.dataset.act === 'remove') this.onRemovePane(key);
      else this.onMovePane(key, +btn.dataset.dir!);
    });
  }

  /**
   * TradingView-style drag: with auto-scale on, the library only pans in time. When a drag in a pane
   * starts going up or down, switch that pane's auto-scale off so it pans in price as well.
   * The first few pixels of the move are held back from the library until the direction is known.
   * Auto-scale comes back on a new symbol / timeframe, or by double-clicking the price axis.
   */
  private freeDrag(container: HTMLElement) {
    const THRESHOLD = 6;
    let start: { x: number; y: number; pane: number } | null = null;
    const scrollOn = () => {
      const h = this.chart.options().handleScroll as unknown;
      return typeof h === 'boolean' ? h : (h as { pressedMouseMove?: boolean }).pressedMouseMove !== false;
    };
    const down = (x: number, y: number) => {
      const rect = container.getBoundingClientRect();
      const lx = x - rect.left, ly = y - rect.top;
      const hit = lx < this.chart.timeScale().width() ? this.paneAt(ly) : null;
      start = hit && scrollOn() ? { x, y, pane: hit.index } : null;
    };
    const move = (e: Event, x: number, y: number) => {
      if (!start) return;
      const dx = Math.abs(x - start.x), dy = Math.abs(y - start.y);
      if (Math.max(dx, dy) < THRESHOLD) {
        e.stopPropagation(); // keep it from the library until we know the direction
        return;
      }
      if (dy > dx * 0.5) this.chart.panes()[start.pane]?.getSeries()[0]?.priceScale().setAutoScale(false);
      start = null;
    };
    container.addEventListener('mousedown', (e) => e.button === 0 && down(e.clientX, e.clientY), true);
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY);
      else start = null; // pinch: leave it to the library
    }, { capture: true, passive: true });
    window.addEventListener('mousemove', (e) => move(e, e.clientX, e.clientY), true);
    window.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) start = null;
      else move(e, e.touches[0].clientX, e.touches[0].clientY);
    }, { capture: true, passive: true });
    const end = () => (start = null);
    window.addEventListener('mouseup', end, true);
    window.addEventListener('touchend', end, true);
    window.addEventListener('touchcancel', end, true);
  }

  /** Pane index and its top (px) under a y coordinate of the chart container. */
  private paneAt(y: number): { index: number; top: number } | null {
    let top = 0;
    const panes = this.chart.panes();
    for (let i = 0; i < panes.length; i++) {
      const h = panes[i].getHeight();
      if (y >= top && y < top + h) return { index: i, top };
      top += h + 1; // 1px separator
    }
    return null;
  }

  private showPaneCtl(y: number) {
    const hit = this.paneAt(y);
    const key = hit ? this.paneKeys[hit.index] : undefined;
    if (!hit || !key || key === 'main') {
      this.paneCtl.hidden = true;
      return;
    }
    if (this.paneCtl.hidden || this.paneCtl.dataset.key !== key) {
      const n = this.paneKeys.length;
      this.paneCtl.dataset.key = key;
      this.paneCtl.innerHTML = `<b>${PANE_NAMES[key]}</b>
        <button data-dir="-1" title="Move pane up" ${hit.index <= 1 ? 'disabled' : ''}>▲</button>
        <button data-dir="1" title="Move pane down" ${hit.index >= n - 1 ? 'disabled' : ''}>▼</button>
        <button data-act="remove" class="rm" title="Remove indicator">×</button>`;
    }
    this.paneCtl.style.top = `${hit.top + 4}px`;
    this.paneCtl.style.right = `${this.chart.priceScale('right').width() + 8}px`;
    this.paneCtl.hidden = false;
  }

  /**
   * TradingView-style wheel:
   *  - over a price axis: stretch/shrink that pane's price scale;
   *  - over the chart: zoom the time axis keeping the right edge (latest bars) fixed;
   *  - horizontal wheel / trackpad swipe: left to the library, which scrolls in time.
   */
  private onWheel(e: WheelEvent, container: HTMLElement) {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const ts = this.chart.timeScale();

    if (x < ts.width()) {
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      e.preventDefault();
      e.stopPropagation();
      const spacing = ts.width() / (range.to - range.from);
      // changing barSpacing keeps rightOffset, so the zoom is anchored at the right edge
      ts.applyOptions({ barSpacing: Math.min(50, Math.max(0.5, spacing * Math.exp(-delta * 0.002))) });
      return;
    }

    const hit = this.paneAt(y);
    const series = hit ? this.chart.panes()[hit.index].getSeries()[0] : undefined;
    if (!series) return;
    e.preventDefault();
    e.stopPropagation();

    const scale = series.priceScale();
    const range = scale.getVisibleRange();
    if (!range) return;
    const factor = Math.exp(delta * 0.002); // scroll down = compress candles, up = stretch
    if (scale.options().mode === PriceScaleMode.Logarithmic) {
      // In log mode getVisibleRange() returns prices but setVisibleRange() takes the library's internal
      // log units: log10(price + 10^-k) + k, where k depends on the price range. Find k by setting a probe
      // range and reading it back, then zoom around the middle in those units (even on screen).
      if (range.from <= 0 || range.to <= 0) return;
      const probe = 20;
      scale.setVisibleRange({ from: probe + Math.log10(range.from), to: probe + Math.log10(range.to) });
      const back = scale.getVisibleRange();
      if (!back || back.to <= 0) return;
      const k = probe - Math.round(Math.log10(back.to / range.to));
      const toInternal = (p: number) => Math.log10(p + 10 ** -k) + k;
      const lo = toInternal(range.from), hi = toInternal(range.to);
      const mid = (lo + hi) / 2, half = ((hi - lo) / 2) * factor;
      scale.setVisibleRange({ from: mid - half, to: mid + half });
      return;
    }
    const mid = (range.from + range.to) / 2;
    const half = ((range.to - range.from) / 2) * factor;
    scale.setVisibleRange({ from: mid - half, to: mid + half });
  }

  /** Logarithmic price scale for the candle pane (indicator panes stay linear). */
  setLogScale(on: boolean) {
    const scale = this.candles.priceScale();
    scale.applyOptions({ mode: on ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    scale.setAutoScale(true);
  }

  /** Switch chart colours; call applyIndicators afterwards so level lines follow. */
  setTheme(theme: Theme) {
    this.theme = theme;
    const c = this.colors;
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text, panes: { separatorColor: c.border, separatorHoverColor: c.separatorHover } },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    this.candles.applyOptions({ borderVisible: theme === 'light', borderUpColor: c.upBorder, borderDownColor: DOWN, wickUpColor: c.upBorder });
    this.volume.setData(this.bars.map((b) => ({ time: toTime(b.t), value: b.v, color: b.c >= b.o ? c.volUp : c.volDown })));
  }

  get data() {
    return this.bars;
  }

  setBars(bars: Candle[], keepView = false) {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const added = bars.length - this.bars.length;
    this.bars = bars.slice();
    const last = bars[bars.length - 1];
    if (last) {
      this.precision = pricePrecision(last.c);
      this.applyPricePrecision();
    }
    this.candles.setData(bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    this.volume.setData(bars.map((b) => ({ time: toTime(b.t), value: b.v, color: b.c >= b.o ? this.colors.volUp : this.colors.volDown })));
    this.refreshPlots(false);
    if (!keepView) this.candles.priceScale().setAutoScale(true);
    if (keepView && range) {
      this.chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    }
    this.renderLegend();
  }

  /** Live update of the last bar (or a newly opened bar). */
  updateLast(bar: Candle) {
    const n = this.bars.length;
    if (n && this.bars[n - 1].t === bar.t) this.bars[n - 1] = bar;
    else this.bars.push(bar);
    const time = toTime(bar.t);
    this.candles.update({ time, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
    this.volume.update({ time, value: bar.v, color: bar.c >= bar.o ? this.colors.volUp : this.colors.volDown });
    this.refreshPlots(true);
    this.renderLegend();
  }

  onVisibleRangeChange(fn: (r: LogicalRange | null) => void) {
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(fn);
  }

  applyIndicators(s: IndicatorSettings, order: PaneKey[] = PANE_KEYS) {
    for (const p of this.plots) if (this.chart.panes()[0].getSeries().includes(p.series)) this.chart.removeSeries(p.series);
    for (let i = this.chart.panes().length - 1; i >= 1; i--) this.chart.removePane(i);
    this.plots = [];

    const lineOpts = (color: string, width = 1) => ({
      color,
      lineWidth: width as 1 | 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });

    if (s.ma.enabled) {
      const f = s.ma.type === 'EMA' ? ema : sma;
      s.ma.periods.forEach((period, i) => {
        const color = MA_COLORS[i % MA_COLORS.length];
        this.plots.push({
          label: `${s.ma.type} ${period}`,
          series: this.chart.addSeries(LineSeries, { ...lineOpts(color, 2), lastValueVisible: false }, 0),
          compute: (c) => f(c, period),
          price: true,
          ma: String(period),
        });
      });
    }

    // indicator panes, top to bottom in the user's order (pane 0 = candles)
    let pane = 1;
    const build: Record<PaneKey, () => void> = {
      rsi: () => {
        const series = this.chart.addSeries(LineSeries, lineOpts('#b388ff', 2), pane);
        this.levels(series, [s.rsi.upper, s.rsi.lower]);
        this.plots.push({ label: `RSI ${s.rsi.period}`, series, compute: (c) => rsi(c, s.rsi.period) });
      },
      stochRsi: () => {
        const p = s.stochRsi;
        const k = this.chart.addSeries(LineSeries, lineOpts('#2962ff'), pane);
        const d = this.chart.addSeries(LineSeries, lineOpts('#ff6d00'), pane);
        this.levels(k, [80, 20]);
        let cache: { k: Series; d: Series } | null = null;
        const calc = (c: Series, part: 'k' | 'd') => {
          if (part === 'k') cache = stochRsi(c, p.rsiLen, p.stochLen, p.k, p.d);
          return cache![part];
        };
        this.plots.push({ label: `StochRSI K`, series: k, compute: (c) => calc(c, 'k') });
        this.plots.push({ label: `D`, series: d, compute: (c) => calc(c, 'd') });
      },
      macd: () => {
        const p = s.macd;
        const hist = this.chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        const line = this.chart.addSeries(LineSeries, lineOpts('#2962ff'), pane);
        const signal = this.chart.addSeries(LineSeries, lineOpts('#ff6d00'), pane);
        let cache: ReturnType<typeof macd> | null = null;
        this.plots.push({
          label: `MACD ${p.fast} ${p.slow} ${p.signal}`,
          series: line,
          compute: (c) => (cache = macd(c, p.fast, p.slow, p.signal)).line,
          price: true,
        });
        this.plots.push({ label: 'Signal', series: signal, compute: () => cache!.signal, price: true });
        this.plots.push({
          label: 'Hist',
          series: hist,
          compute: () => cache!.hist,
          price: true,
          color: (v, i, vals) => {
            const prev = vals[i - 1] ?? 0;
            if (v >= 0) return v >= prev ? '#26a69a' : '#b2dfdb';
            return v <= prev ? '#ef5350' : '#ffcdd2';
          },
        });
      },
      rsiTue: () => {
        const p = s.rsiTue;
        let cache: ReturnType<typeof rsiTue> | null = null;
        const main = this.chart.addSeries(LineSeries, { ...lineOpts('#ba68c8', 2), autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, pane);
        const fast = this.chart.addSeries(LineSeries, lineOpts('#66bb6a'), pane);
        const slow = this.chart.addSeries(LineSeries, lineOpts('#5b9cf6'), pane);
        for (const price of [70, 30]) main.createPriceLine({ price, color: this.colors.rsiLevel, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
        main.attachPrimitive(
          new RsiTueDecor(() => (cache ? { times: this.bars.map((b) => toTime(b.t)), rsi: cache.rsi, ob: p.ob, os: p.os } : null)),
        );
        this.plots.push({ label: `RSI Tue ${p.rsiLen}`, series: main, compute: (c) => (cache = rsiTue(c, p)).rsi });
        this.plots.push({ label: `Fast ${p.fastLen}`, series: fast, compute: () => cache!.fast });
        this.plots.push({ label: `Slow ${p.slowLen}`, series: slow, compute: () => cache!.slow });
      },
      cluster: () => {
        const p = s.cluster;
        let cache: ReturnType<typeof cluster> | null = null;
        const lower = this.chart.addSeries(LineSeries, { ...lineOpts('#2962ff'), lastValueVisible: false }, pane);
        const upper = this.chart.addSeries(LineSeries, { ...lineOpts('#2962ff'), lastValueVisible: false }, pane);
        const basis = this.chart.addSeries(LineSeries, { ...lineOpts('#f23645'), lastValueVisible: false }, pane);
        const signal = this.chart.addSeries(LineSeries, lineOpts('#22c55e', 2), pane);
        const dots = this.chart.addSeries(
          LineSeries,
          { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          pane,
        );
        for (const price of [p.ob, p.os]) {
          signal.createPriceLine({ price, color: '#2962ff', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });
        }
        basis.attachPrimitive(
          new BandFill(
            () => (cache ? { times: this.bars.map((b) => toTime(b.t)), upper: cache.upper, lower: cache.lower } : null),
            'rgba(41, 98, 255, 0.08)',
          ),
        );
        this.plots.push({
          label: `Cluster ${p.rsiLen} ${p.sigLen}`,
          series: signal,
          compute: (c) => (cache = cluster(c, { rsiLen: p.rsiLen, sigLen: p.sigLen, bbLen: p.bbLen, bbMult: p.bbMult, trendFast: 50, trendSlow: 200 })).signal,
          color: (_v, i) => (cache!.rising[i] === false ? '#f23645' : '#22c55e'),
        });
        this.plots.push({ label: 'Basis', series: basis, compute: () => cache!.basis });
        this.plots.push({ label: 'Upper', series: upper, compute: () => cache!.upper });
        this.plots.push({ label: 'Lower', series: lower, compute: () => cache!.lower });
        if (p.dots) {
          this.plots.push({
            label: 'Dots',
            series: dots,
            legend: false,
            compute: () => cache!.buy.map((b, i) => (b || cache!.sell[i] ? 2 : null)),
            color: (_v, i) => (cache!.buy[i] ? '#22c55e' : '#f23645'),
          });
        }
      },
    };
    this.paneKeys = ['main'];
    for (const key of order) {
      if (!s[key].enabled) continue;
      build[key]();
      this.paneKeys.push(key);
      pane++;
    }

    this.applyPricePrecision();
    const panes = this.chart.panes();
    panes[0].setStretchFactor(3);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    this.refreshPlots(false);
    this.renderLegend();
  }

  /** Candles and price-unit indicators (MA, MACD) share the coin's price precision. */
  private applyPricePrecision() {
    const priceFormat = { type: 'price' as const, precision: this.precision, minMove: 10 ** -this.precision };
    this.candles.applyOptions({ priceFormat });
    for (const p of this.plots) if (p.price) p.series.applyOptions({ priceFormat });
  }

  private levels(series: ISeriesApi<SeriesType>, prices: number[]) {
    for (const price of prices) {
      series.createPriceLine({ price, color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    }
  }

  private values = new Map<Plot, Series>();

  private refreshPlots(lastOnly: boolean) {
    const close: Series = this.bars.map((b) => b.c);
    for (const p of this.plots) {
      const vals = p.compute(close);
      this.values.set(p, vals);
      const point = (i: number) => {
        const v = vals[i];
        const time = toTime(this.bars[i].t);
        if (v === null) return { time };
        return p.color ? { time, value: v, color: p.color(v, i, vals) } : { time, value: v };
      };
      if (lastOnly && this.bars.length) p.series.update(point(this.bars.length - 1));
      else p.series.setData(this.bars.map((_, i) => point(i)));
    }
  }

  /** Top-left legend: OHLC + volume, then the moving averages ("EMA 20/50/200  72,893  76,576  69,520" in their colours). */
  private renderLegend(param?: MouseEventParams<Time>) {
    let idx = this.bars.length - 1;
    if (param?.logical !== undefined && param.time !== undefined) {
      idx = Math.max(0, Math.min(this.bars.length - 1, Math.round(param.logical)));
    }
    const b = this.bars[idx];
    if (!b) {
      this.legend.innerHTML = '';
      return;
    }
    const cls = b.c >= b.o ? 'up' : 'down';
    const f = (v: number) => formatPrice(v, this.precision);
    const change = ((b.c - b.o) / b.o) * 100;
    let html = `<div class="ohlc ${cls}">O <b>${f(b.o)}</b> H <b>${f(b.h)}</b> L <b>${f(b.l)}</b> C <b>${f(b.c)}</b>
      <span>${change >= 0 ? '+' : ''}${change.toFixed(2)}%</span> Vol <b>${formatVolume(b.v)}</b></div>`;
    const mas = this.plots.filter((p) => p.ma);
    if (mas.length) {
      const type = mas[0].label.split(' ')[0];
      const values = mas.map((p) => {
        const v = this.values.get(p)?.[idx];
        const color = (p.series.options() as { color?: string }).color;
        return `<b style="color:${color}">${v == null ? '—' : f(v)}</b>`;
      });
      html += `<div class="ma">${type} ${mas.map((p) => p.ma).join('/')} ${values.join(' ')}</div>`;
    }
    this.legend.innerHTML = html;
  }

}
