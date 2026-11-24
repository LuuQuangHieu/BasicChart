export function pricePrecision(price: number): number {
  if (!isFinite(price) || price <= 0) return 2;
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  return Math.min(10, Math.ceil(-Math.log10(price)) + 3);
}

export function formatPrice(price: number, precision = pricePrecision(price)): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

export function formatVolume(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

/** Chart times are UTC timestamps shifted so the axis shows the viewer's local time. */
export const TZ_SHIFT_SEC = -new Date().getTimezoneOffset() * 60;
