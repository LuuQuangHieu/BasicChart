import type { IChartApi, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';

// Region fills of the original (between band levels), bottom layer.
const REGIONS: [number, number, string][] = [
  [80, 90, 'rgba(200, 230, 201, 0.12)'], // overbought
  [60, 80, 'rgba(126, 87, 194, 0.10)'],  // bullish
  [40, 60, 'rgba(126, 87, 194, 0.05)'],  // neutral
  [20, 40, 'rgba(126, 87, 194, 0.10)'],  // bearish
  [10, 20, 'rgba(255, 224, 178, 0.12)'], // oversold
];

export interface RsiTueBg {
  times: Time[];
  rsi: (number | null)[];
  ob: number;
  os: number;
}

/** Draws the band regions and the per-bar overbought/oversold background of RSI Tue Trading. */
export class RsiTueDecor implements ISeriesPrimitive<Time> {
  private chart!: IChartApi;
  private series!: ISeriesApi<SeriesType>;

  constructor(private readonly data: () => RsiTueBg | null) {}

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart;
    this.series = p.series;
  }

  updateAllViews() {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [
      {
        zOrder: () => 'bottom',
        renderer: () => ({
          draw: (target) =>
            target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
              for (const [lo, hi, color] of REGIONS) {
                const y1 = this.series.priceToCoordinate(hi), y2 = this.series.priceToCoordinate(lo);
                if (y1 === null || y2 === null) continue;
                ctx.fillStyle = color;
                ctx.fillRect(0, y1, mediaSize.width, y2 - y1);
              }
              const d = this.data();
              if (!d) return;
              const ts = this.chart.timeScale();
              const range = ts.getVisibleLogicalRange();
              const from = Math.max(0, Math.floor(range?.from ?? 0));
              const to = Math.min(d.times.length - 1, Math.ceil(range?.to ?? d.times.length));
              const spacing = ts.options().barSpacing;
              for (let i = from; i <= to; i++) {
                const v = d.rsi[i];
                if (v === null || (v <= d.ob && v >= d.os)) continue;
                const x = ts.timeToCoordinate(d.times[i]);
                if (x === null) continue;
                ctx.fillStyle = v > d.ob ? 'rgba(76, 175, 80, 0.35)' : 'rgba(255, 152, 0, 0.35)';
                ctx.fillRect(x - spacing / 2, 0, spacing, mediaSize.height);
              }
            }),
        }),
      },
    ];
  }
}
