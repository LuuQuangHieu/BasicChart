import type { IChartApi, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';

export interface BandData {
  times: Time[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/** Shades the area between two lines of the series it is attached to (like Pine's fill()). */
export class BandFill implements ISeriesPrimitive<Time> {
  private chart!: IChartApi;
  private series!: ISeriesApi<SeriesType>;

  constructor(
    private readonly data: () => BandData | null,
    private readonly color: string,
  ) {}

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
            target.useMediaCoordinateSpace(({ context: ctx }) => {
              const d = this.data();
              if (!d) return;
              const ts = this.chart.timeScale();
              const range = ts.getVisibleLogicalRange();
              const from = Math.max(0, Math.floor(range?.from ?? 0) - 1);
              const to = Math.min(d.times.length - 1, Math.ceil(range?.to ?? d.times.length) + 1);
              const top: [number, number][] = [], bottom: [number, number][] = [];
              const flush = () => {
                if (top.length > 1) {
                  ctx.beginPath();
                  top.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
                  for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1]);
                  ctx.closePath();
                  ctx.fill();
                }
                top.length = bottom.length = 0;
              };
              ctx.fillStyle = this.color;
              for (let i = from; i <= to; i++) {
                const u = d.upper[i], l = d.lower[i];
                const x = ts.timeToCoordinate(d.times[i]);
                const yu = u === null ? null : this.series.priceToCoordinate(u);
                const yl = l === null ? null : this.series.priceToCoordinate(l);
                if (x === null || yu === null || yl === null) {
                  flush();
                  continue;
                }
                top.push([x, yu]);
                bottom.push([x, yl]);
              }
              flush();
            }),
        }),
      },
    ];
  }
}
