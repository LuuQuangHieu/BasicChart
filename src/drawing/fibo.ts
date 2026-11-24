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
import { formatPrice } from '../ui/format';
import { logicalToTime, timeToLogical } from './coords';

/** A point anchored to a real time (ms UTC) so it survives timeframe changes. */
export interface Anchor {
  t: number;
  price: number;
}

export interface Fib {
  id: string;
  a: Anchor; // start point: level 1
  b: Anchor; // end point: level 0
}

const LEVELS: [number, string][] = [
  [0, '#787b86'],
  [0.236, '#f23645'],
  [0.382, '#ff9800'],
  [0.5, '#4caf50'],
  [0.618, '#089981'],
  [0.786, '#2196f3'],
  [1, '#787b86'],
  [1.618, '#9c27b0'],
];

const HIT_PX = 6;

/**
 * Fibonacci retracement tool, drawn as a series primitive on the candle series.
 * Click-move-click to draw; drag the end handles or a level line to edit; Delete removes the selected one.
 */
export class FiboTool implements ISeriesPrimitive<Time> {
  fibs: Fib[] = [];
  private chart!: IChartApi;
  private series!: ISeriesApi<SeriesType>;
  private requestUpdate = () => {};
  private bars: Candle[] = [];
  private barMs = 60_000;
  private selected: string | null = null;
  private drawing = false;
  private draft: Fib | null = null;
  private drag: { fib: Fib; part: 'a' | 'b' | 'body'; start: Anchor; orig: Fib } | null = null;
  private precision = 2;
  /** When true (another tool is active) this tool ignores the mouse. */
  blocked = () => false;

  constructor(
    private readonly container: HTMLElement,
    private readonly onChange: (fibs: Fib[]) => void,
    private readonly onModeChange: (drawing: boolean) => void,
  ) {
    container.addEventListener('mousedown', this.onDown, true);
    container.addEventListener('mousemove', this.onHover, true);
    window.addEventListener('keydown', this.onKey);
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

  setFibs(fibs: Fib[]) {
    this.fibs = fibs;
    this.selected = null;
    this.requestUpdate();
  }

  setDrawing(on: boolean) {
    this.drawing = on;
    this.draft = null;
    this.chart.applyOptions({ handleScroll: !on, handleScale: !on });
    this.container.style.cursor = on ? 'crosshair' : '';
    this.onModeChange(on);
    this.requestUpdate();
  }

  get isDrawing() {
    return this.drawing;
  }

  clear() {
    this.fibs = [];
    this.selected = null;
    this.commit();
  }

  // ---- coordinate conversion -------------------------------------------------

  private timeToX(t: number): number | null {
    const l = timeToLogical(this.bars, this.barMs, t);
    if (l === null) return null;
    // logicalToCoordinate is linear in the logical index, so fractional values work.
    return this.chart.timeScale().logicalToCoordinate(l as Logical);
  }

  private xToTime(x: number): number | null {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return l === null ? null : logicalToTime(this.bars, this.barMs, l);
  }

  private anchorAt(e: MouseEvent): Anchor | null {
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (y > this.chart.panes()[0].getHeight()) return null;
    const t = this.xToTime(x);
    const price = this.series.coordinateToPrice(y);
    if (t === null || price === null) return null;
    return { t, price };
  }

  // ---- geometry & hit testing ------------------------------------------------

  private geometry(f: Fib) {
    const xa = this.timeToX(f.a.t), xb = this.timeToX(f.b.t);
    const ya = this.series.priceToCoordinate(f.a.price), yb = this.series.priceToCoordinate(f.b.price);
    if (xa === null || xb === null || ya === null || yb === null) return null;
    const levels = LEVELS.map(([lvl, color]) => {
      const price = f.b.price + (f.a.price - f.b.price) * lvl;
      return { lvl, color, price, y: this.series.priceToCoordinate(price) };
    });
    return { xa, xb, ya, yb, levels };
  }

  private hit(x: number, y: number): { fib: Fib; part: 'a' | 'b' | 'body' } | null {
    for (let i = this.fibs.length - 1; i >= 0; i--) {
      const f = this.fibs[i];
      const g = this.geometry(f);
      if (!g) continue;
      if (Math.hypot(x - g.xa, y - g.ya) <= HIT_PX + 2) return { fib: f, part: 'a' };
      if (Math.hypot(x - g.xb, y - g.yb) <= HIT_PX + 2) return { fib: f, part: 'b' };
      const left = Math.min(g.xa, g.xb), right = Math.max(g.xa, g.xb);
      if (x >= left - HIT_PX && x <= right + HIT_PX && g.levels.some((l) => l.y !== null && Math.abs(y - l.y) <= HIT_PX)) {
        return { fib: f, part: 'body' };
      }
    }
    return null;
  }

  // ---- mouse / keyboard ------------------------------------------------------

  private onDown = (e: MouseEvent) => {
    if (e.button !== 0 || this.blocked()) return;
    const p = this.anchorAt(e);
    if (!p) return;

    if (this.drawing) {
      e.stopPropagation();
      e.preventDefault();
      if (!this.draft) {
        this.draft = { id: crypto.randomUUID(), a: p, b: p };
        window.addEventListener('mousemove', this.onDraftMove);
      } else {
        this.draft.b = p;
        this.fibs.push(this.draft);
        this.selected = this.draft.id;
        this.draft = null;
        window.removeEventListener('mousemove', this.onDraftMove);
        this.setDrawing(false);
        this.commit();
      }
      this.requestUpdate();
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const h = this.hit(e.clientX - rect.left, e.clientY - rect.top);
    if (!h) {
      if (this.selected) {
        this.selected = null;
        this.requestUpdate();
      }
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    this.selected = h.fib.id;
    this.drag = { ...h, start: p, orig: { ...h.fib, a: { ...h.fib.a }, b: { ...h.fib.b } } };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd, { once: true });
    this.requestUpdate();
  };

  private onDraftMove = (e: MouseEvent) => {
    const p = this.anchorAt(e);
    if (p && this.draft) {
      this.draft.b = p;
      this.requestUpdate();
    }
  };

  private onDragMove = (e: MouseEvent) => {
    const d = this.drag;
    const p = this.anchorAt(e);
    if (!d || !p) return;
    if (d.part === 'a') d.fib.a = p;
    else if (d.part === 'b') d.fib.b = p;
    else {
      const dt = p.t - d.start.t, dp = p.price - d.start.price;
      d.fib.a = { t: d.orig.a.t + dt, price: d.orig.a.price + dp };
      d.fib.b = { t: d.orig.b.t + dt, price: d.orig.b.price + dp };
    }
    this.requestUpdate();
  };

  private onDragEnd = () => {
    window.removeEventListener('mousemove', this.onDragMove);
    this.drag = null;
    this.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.commit();
  };

  private onHover = (e: MouseEvent) => {
    if (this.drawing || this.drag || this.blocked()) return;
    const rect = this.container.getBoundingClientRect();
    const h = this.hit(e.clientX - rect.left, e.clientY - rect.top);
    this.container.style.cursor = h ? (h.part === 'body' ? 'move' : 'pointer') : '';
  };

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
    if (e.key === 'Escape' && this.drawing) {
      window.removeEventListener('mousemove', this.onDraftMove);
      this.setDrawing(false);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this.fibs = this.fibs.filter((f) => f.id !== this.selected);
      this.selected = null;
      this.commit();
    }
  };

  private commit() {
    this.onChange(this.fibs);
    this.requestUpdate();
  }

  // ---- rendering -------------------------------------------------------------

  updateAllViews() {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ renderer: () => this.renderer, zOrder: () => 'top' }];
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      target.useMediaCoordinateSpace(({ context: ctx }) => {
        const all = this.draft ? [...this.fibs, this.draft] : this.fibs;
        for (const f of all) this.drawFib(ctx, f, f.id === this.selected || f === this.draft);
      });
    },
  };

  private drawFib(ctx: CanvasRenderingContext2D, f: Fib, active: boolean) {
    const g = this.geometry(f);
    if (!g) return;
    const left = Math.min(g.xa, g.xb), right = Math.max(g.xa, g.xb);
    const levels = g.levels.filter((l) => l.y !== null) as { lvl: number; color: string; price: number; y: number }[];

    // shaded bands between consecutive levels
    for (let i = 0; i < levels.length - 1; i++) {
      ctx.fillStyle = levels[i + 1].color + '1f';
      const y1 = levels[i].y, y2 = levels[i + 1].y;
      ctx.fillRect(left, Math.min(y1, y2), right - left, Math.abs(y2 - y1));
    }

    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const l of levels) {
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(l.y) + 0.5);
      ctx.lineTo(right, Math.round(l.y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = l.color;
      ctx.fillText(`${l.lvl} (${formatPrice(l.price, this.precision)})`, left - 4, l.y);
    }

    // trend line from A to B
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9598a1';
    ctx.beginPath();
    ctx.moveTo(g.xa, g.ya);
    ctx.lineTo(g.xb, g.yb);
    ctx.stroke();
    ctx.setLineDash([]);

    if (active) {
      for (const [x, y] of [[g.xa, g.ya], [g.xb, g.yb]]) {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#131722';
        ctx.fill();
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
}
