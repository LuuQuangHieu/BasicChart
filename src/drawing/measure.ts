import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { Candle } from '../exchanges/types';
import { formatPrice, formatVolume } from '../ui/format';
import { logicalToTime, timeToLogical } from './coords';

interface Anchor {
  t: number;
  price: number;
}

type State = 'idle' | 'armed' | 'drawing' | 'done';

const UP = { fill: 'rgba(41, 98, 255, 0.18)', line: '#2962ff', label: '#2962ff' };
const DOWN = { fill: 'rgba(242, 54, 69, 0.18)', line: '#f23645', label: '#f23645' };

/**
 * Price & time range measure (like TradingView's ruler).
 * Activate with the toolbar button or Shift+click, click the start, click the end.
 * The result stays until the next click on the chart or Esc.
 */
export class MeasureTool implements ISeriesPrimitive<Time> {
  private chart!: IChartApi;
  private series!: ISeriesApi<SeriesType>;
  private requestUpdate = () => {};
  private bars: Candle[] = [];
  private barMs = 60_000;
  private precision = 2;
  private state: State = 'idle';
  private a: Anchor | null = null;
  private b: Anchor | null = null;
  /** When true (another tool is active) this tool ignores the mouse. */
  blocked = () => false;

  constructor(
    private readonly container: HTMLElement,
    private readonly onModeChange: (active: boolean) => void,
  ) {
    container.addEventListener('mousedown', this.onDown, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.state !== 'idle') this.cancel();
    });
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }

  setBars(bars: Candle[], barMs: number, precision: number) {
    this.bars = bars;
    this.barMs = barMs;
    this.precision = precision;
    this.requestUpdate();
  }

  get active() {
    return this.state === 'armed' || this.state === 'drawing';
  }

  toggle() {
    if (this.active) this.cancel();
    else this.arm();
  }

  cancel() {
    window.removeEventListener('mousemove', this.onMove);
    this.a = this.b = null;
    this.setState('idle');
  }

  private arm() {
    this.a = this.b = null;
    this.setState('armed');
  }

  private setState(s: State) {
    const wasActive = this.active;
    this.state = s;
    const active = this.active;
    if (active !== wasActive) {
      this.chart.applyOptions({ handleScroll: !active, handleScale: !active });
      this.container.style.cursor = active ? 'crosshair' : '';
      this.onModeChange(active);
    }
    this.requestUpdate();
  }

  // ---- mouse -----------------------------------------------------------------

  private anchorAt(e: MouseEvent): Anchor | null {
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (y > this.chart.panes()[0].getHeight()) return null;
    const l = this.chart.timeScale().coordinateToLogical(x);
    const t = l === null ? null : logicalToTime(this.bars, this.barMs, l);
    const price = this.series.coordinateToPrice(y);
    if (t === null || price === null) return null;
    return { t, price };
  }

  private onDown = (e: MouseEvent) => {
    if (e.button !== 0 || this.blocked()) return;
    if (this.state === 'done') {
      // any click clears the last measurement (and still pans the chart as usual)
      this.cancel();
      if (!e.shiftKey) return;
    }
    if (this.state === 'idle') {
      if (!e.shiftKey) return;
      this.arm();
    }
    const p = this.anchorAt(e);
    if (!p) return;
    e.stopPropagation();
    e.preventDefault();
    if (this.state === 'armed') {
      this.a = this.b = p;
      this.setState('drawing');
      window.addEventListener('mousemove', this.onMove);
    } else if (this.state === 'drawing') {
      this.b = p;
      window.removeEventListener('mousemove', this.onMove);
      this.setState('done');
    }
  };

  private onMove = (e: MouseEvent) => {
    const p = this.anchorAt(e);
    if (p && this.state === 'drawing') {
      this.b = p;
      this.requestUpdate();
    }
  };

  // ---- rendering -------------------------------------------------------------

  updateAllViews() {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ renderer: () => this.renderer, zOrder: () => 'top' }];
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        if (!this.a || !this.b || (this.state !== 'drawing' && this.state !== 'done')) return;
        this.draw(ctx, this.a, this.b, mediaSize.width, mediaSize.height);
      });
    },
  };

  private draw(ctx: CanvasRenderingContext2D, a: Anchor, b: Anchor, width: number, height: number) {
    const la = timeToLogical(this.bars, this.barMs, a.t);
    const lb = timeToLogical(this.bars, this.barMs, b.t);
    if (la === null || lb === null) return;
    const ts = this.chart.timeScale();
    const xa = ts.logicalToCoordinate(la as Logical), xb = ts.logicalToCoordinate(lb as Logical);
    const ya = this.series.priceToCoordinate(a.price), yb = this.series.priceToCoordinate(b.price);
    if (xa === null || xb === null || ya === null || yb === null) return;

    const up = b.price >= a.price;
    const c = up ? UP : DOWN;
    const left = Math.min(xa, xb), right = Math.max(xa, xb);
    const top = Math.min(ya, yb), bottom = Math.max(ya, yb);

    ctx.fillStyle = c.fill;
    ctx.fillRect(left, top, right - left, bottom - top);

    // arrows through the middle: time (horizontal) and price (vertical)
    const midX = (xa + xb) / 2, midY = (ya + yb) / 2;
    ctx.strokeStyle = c.line;
    ctx.fillStyle = c.line;
    ctx.lineWidth = 1;
    this.arrow(ctx, xa, midY, xb, midY);
    this.arrow(ctx, midX, ya, midX, yb);

    // stats
    const diff = b.price - a.price;
    const pct = (diff / a.price) * 100;
    const nBars = Math.round(lb - la);
    const [t0, t1] = a.t <= b.t ? [a.t, b.t] : [b.t, a.t];
    let vol = 0;
    for (const bar of this.bars) if (bar.t >= t0 && bar.t <= t1) vol += bar.v;
    const sign = diff >= 0 ? '+' : '−';
    const lines = [
      `${sign}${formatPrice(Math.abs(diff), this.precision)} (${sign}${Math.abs(pct).toFixed(2)}%)`,
      `${Math.abs(nBars)} bars, ${formatDuration(Math.abs(b.t - a.t))}`,
      `Vol ${formatVolume(vol)}`,
    ];

    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    const padX = 10, lineH = 17;
    const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
    const boxH = lines.length * lineH + 8;
    let bx = midX - boxW / 2;
    let by = up ? top - boxH - 8 : bottom + 8;
    bx = Math.max(4, Math.min(width - boxW - 4, bx));
    by = Math.max(4, Math.min(height - boxH - 4, by));

    ctx.fillStyle = c.label;
    roundRect(ctx, bx, by, boxW, boxH, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, bx + boxW / 2, by + 4 + lineH * i + lineH / 2));
  }

  private arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (len < 8) return;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 7 * Math.cos(ang - 0.45), y2 - 7 * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - 7 * Math.cos(ang + 0.45), y2 - 7 * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 93784000 -> "1d 2h 3m" (two largest units). */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  const parts: [number, string][] = [
    [Math.floor(min / 1440), 'd'],
    [Math.floor((min % 1440) / 60), 'h'],
    [min % 60, 'm'],
  ];
  const first = parts.findIndex(([v]) => v > 0);
  if (first < 0) return '0m';
  return parts
    .slice(first, first + 2)
    .filter(([v]) => v > 0)
    .map(([v, u]) => `${v}${u}`)
    .join(' ');
}
