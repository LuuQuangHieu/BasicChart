import { EXCHANGES, EXCHANGE_ORDER, marketKey, type Closable, type ExchangeId, type Market, type Ticker } from '../exchanges';
import { formatPrice, formatVolume } from './format';

interface Row {
  el: HTMLElement;
  price: HTMLElement;
  change: HTMLElement;
  vol: HTMLElement;
  last?: number;
}

interface Options {
  list: Market[];
  onSelect: (m: Market) => void;
  onChange: (list: Market[]) => void;
  onTick: (m: Market, t: Ticker) => void;
}

const SHORT: Record<ExchangeId, string> = { binance: 'BN', bybit: 'BY', okx: 'OKX', gate: 'GT', bitget: 'BG', bitstamp: 'BS', vn: 'VN', us: 'US', macro: 'MC' };
const badge = (ex: ExchangeId) => `<em class="ex ex-${ex}" title="${EXCHANGES[ex].name}">${SHORT[ex]}</em>`;

export class Watchlist {
  private list: Market[];
  private rows = new Map<string, Row>();
  private streams: Closable[] = [];
  private active = '';
  private listEl: HTMLElement;
  private dialog: HTMLElement;
  private results: HTMLElement;
  private search: HTMLInputElement;
  private filterEx: ExchangeId | 'all' = 'all';
  private tickerCache = new Map<ExchangeId, Promise<Ticker[]>>();
  private searchCache = new Map<string, Promise<Ticker[]>>();
  private searchTimer = 0;
  private suppressClick = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: Options,
  ) {
    this.list = opts.list;
    root.innerHTML = `
      <div class="wl-head">
        <span>Watchlist</span>
        <button class="wl-add" title="Add a coin or stock">+ Add symbol</button>
      </div>
      <div class="wl-cols"><span>Symbol</span><span>Last</span><span>24h</span><span>Vol</span></div>
      <div class="wl-list"></div>
      <div class="wl-dialog" hidden>
        <div class="wl-dialog-head">
          <input class="wl-search" placeholder="Search symbol… (BTC, FPT, VNINDEX, AAPL)" spellcheck="false" />
          <button class="wl-close" title="Close (Esc)">×</button>
        </div>
        <div class="wl-ex">
          ${['all', ...EXCHANGE_ORDER].map((e) => `<button data-ex="${e}" class="${e === 'all' ? 'active' : ''}">${e === 'all' ? 'All' : EXCHANGES[e as ExchangeId].name}</button>`).join('')}
        </div>
        <div class="wl-results"></div>
      </div>`;
    this.listEl = root.querySelector('.wl-list')!;
    this.dialog = root.querySelector('.wl-dialog')!;
    this.results = root.querySelector('.wl-results')!;
    this.search = root.querySelector('.wl-search')!;

    root.querySelector('.wl-add')!.addEventListener('click', () => this.openDialog());
    root.querySelector('.wl-close')!.addEventListener('click', () => this.closeDialog());
    this.search.addEventListener('input', () => {
      // stock lookups hit the network per query: wait for the user to pause typing
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.renderResults(), 250);
    });
    this.search.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeDialog());
    root.querySelector('.wl-ex')!.addEventListener('click', (e) => {
      const ex = (e.target as HTMLElement).dataset.ex as ExchangeId | 'all' | undefined;
      if (!ex) return;
      this.filterEx = ex;
      root.querySelectorAll('.wl-ex button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.ex === ex));
      this.renderResults();
    });
    this.results.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-market]');
      if (!el) return;
      const m = JSON.parse(el.dataset.market!) as Market;
      if (!this.rows.has(marketKey(m))) this.add(m);
      this.opts.onSelect(m);
      this.renderResults();
    });
    this.listEl.addEventListener('pointerdown', (e) => this.onPress(e));
    this.listEl.addEventListener('click', (e) => {
      if (this.suppressClick) {
        // the click that ends a drag must not open the coin
        this.suppressClick = false;
        return;
      }
      const target = e.target as HTMLElement;
      const rowEl = target.closest<HTMLElement>('[data-key]');
      if (!rowEl) return;
      const m = this.list.find((x) => marketKey(x) === rowEl.dataset.key)!;
      const mv = target.closest<HTMLElement>('.mv');
      if (mv) this.move(m, +mv.dataset.dir!);
      else if (target.closest('.rm')) this.remove(m);
      else this.opts.onSelect(m);
    });

    this.renderList();
  }

  // ---- list --------------------------------------------------------------------

  private renderList() {
    this.listEl.innerHTML = '';
    this.rows.clear();
    if (!this.list.length) {
      this.listEl.innerHTML = '<div class="wl-empty">Your watchlist is empty. Click “+ Add symbol”.</div>';
    }
    for (const m of this.list) {
      const el = document.createElement('div');
      el.className = 'wl-row';
      el.dataset.key = marketKey(m);
      el.innerHTML = `<span class="sym">${m.base}${m.quote ? `<small>/${m.quote}</small>` : ''}${badge(m.ex)}</span>
        <span class="price">—</span><span class="chg"></span><span class="vol"></span>
        <span class="wl-act"><button class="mv" data-dir="-1" title="Move up">▲</button><button class="mv" data-dir="1" title="Move down">▼</button><button class="rm" title="Remove from watchlist">×</button></span>`;
      this.rows.set(marketKey(m), {
        el,
        price: el.querySelector('.price')!,
        change: el.querySelector('.chg')!,
        vol: el.querySelector('.vol')!,
      });
      this.listEl.appendChild(el);
    }
    this.rows.get(this.active)?.el.classList.add('active');
    this.fitColumns();
    this.subscribe();
  }

  /** Size the symbol and price columns to their widest entry so they never get cut off. */
  private fitPending = false;
  private fitColumns() {
    if (this.fitPending) return;
    this.fitPending = true;
    requestAnimationFrame(() => {
      this.fitPending = false;
      const widest = (sel: string) =>
        Math.max(0, ...[...this.root.querySelectorAll<HTMLElement>(sel)].map((e) => e.scrollWidth));
      const sym = widest('.wl-cols span:nth-child(1), .wl-row .sym');
      const last = widest('.wl-cols span:nth-child(2), .wl-row .price');
      this.root.style.setProperty('--wl-sym', `${Math.ceil(sym) + 1}px`);
      this.root.style.setProperty('--wl-last', `${Math.ceil(last) + 1}px`);
    });
  }

  private subscribe() {
    this.streams.forEach((s) => s.close());
    this.streams = [];
    const byEx = new Map<ExchangeId, Market[]>();
    for (const m of this.list) byEx.set(m.ex, [...(byEx.get(m.ex) ?? []), m]);
    for (const [ex, markets] of byEx) {
      const exchange = EXCHANGES[ex];
      const onTicker = (t: Ticker) => this.update(ex, t);
      this.streams.push(exchange.tickerStream(markets.map((m) => m.symbol), onTicker));
      // initial snapshot so prices show before the first push
      this.tickers(ex)
        .then((all) => {
          const wanted = new Set(markets.map((m) => m.symbol));
          all.filter((t) => wanted.has(t.symbol)).forEach(onTicker);
        })
        .catch(() => {});
    }
  }

  private update(ex: ExchangeId, t: Ticker) {
    const key = `${ex}:${t.symbol}`;
    const row = this.rows.get(key);
    if (!row || !isFinite(t.last)) return;
    const dir = row.last === undefined ? 0 : Math.sign(t.last - row.last);
    row.last = t.last;
    const pct = ((t.last - t.open) / t.open) * 100;
    const text = formatPrice(t.last);
    if (text.length !== row.price.textContent?.length) this.fitColumns(); // price got wider or narrower
    row.price.textContent = text;
    row.change.textContent = isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
    row.change.className = 'chg ' + (pct >= 0 ? 'up' : 'down');
    row.vol.textContent = formatVolume(t.quoteVolume);
    if (dir !== 0) {
      row.price.classList.remove('flash-up', 'flash-down');
      void row.price.offsetWidth; // restart animation
      row.price.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
    }
    if (key === this.active) this.opts.onTick(this.list.find((m) => marketKey(m) === key)!, t);
  }

  private add(m: Market) {
    this.list = [...this.list, m];
    this.opts.onChange(this.list);
    this.renderList();
  }

  // ---- press & hold, then drag to reorder ---------------------------------------------

  private onPress(e: PointerEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.wl-row');
    if (!row || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const startX = e.clientX, startY = e.clientY;
    let lastY = startY;
    let dragging = false;
    let scrollTimer = 0;

    const hold = window.setTimeout(() => {
      dragging = true;
      row.classList.add('dragging');
      this.listEl.classList.add('reordering');
      navigator.vibrate?.(15);
    }, 300);

    // drop the row where the pointer is: before the first row whose middle is below it
    const place = () => {
      const others = [...this.listEl.querySelectorAll<HTMLElement>('.wl-row:not(.dragging)')];
      const before = others.find((r) => {
        const b = r.getBoundingClientRect();
        return lastY < b.top + b.height / 2;
      });
      if (before) {
        if (row.nextElementSibling !== before) this.listEl.insertBefore(row, before);
      } else if (this.listEl.lastElementChild !== row) this.listEl.appendChild(row);
    };

    // keep scrolling while held near the top/bottom edge of the list
    const autoScroll = () => {
      const b = this.listEl.getBoundingClientRect();
      const edge = 28;
      const v = lastY < b.top + edge ? -(b.top + edge - lastY) : lastY > b.bottom - edge ? lastY - (b.bottom - edge) : 0;
      if (v) {
        this.listEl.scrollTop += Math.max(-20, Math.min(20, v / 2));
        place();
      }
      scrollTimer = requestAnimationFrame(autoScroll);
    };

    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (!dragging) {
        // moved before the hold fired: it's a scroll or a plain click, not a drag
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) end();
        return;
      }
      ev.preventDefault();
      if (!scrollTimer) scrollTimer = requestAnimationFrame(autoScroll);
      place();
    };

    const end = () => {
      clearTimeout(hold);
      cancelAnimationFrame(scrollTimer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('touchmove', touchMove);
      if (!dragging) return;
      row.classList.remove('dragging');
      this.listEl.classList.remove('reordering');
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0); // no click follows on some devices
      const order = [...this.listEl.querySelectorAll<HTMLElement>('.wl-row')].map((r) => r.dataset.key);
      const byKey = new Map(this.list.map((m) => [marketKey(m), m]));
      const list = order.map((k) => byKey.get(k!)!).filter(Boolean);
      if (list.some((m, i) => m !== this.list[i])) {
        this.list = list;
        this.opts.onChange(this.list);
      }
    };

    // on touch screens, stop the list from scrolling once the hold has picked the row up
    const touchMove = (ev: TouchEvent) => dragging && ev.preventDefault();
    window.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Swap with the neighbour above (-1) or below (+1); moves the row element so live prices and streams stay. */
  private move(m: Market, dir: number) {
    const i = this.list.findIndex((x) => marketKey(x) === marketKey(m));
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.list.length) return;
    const list = this.list.slice();
    [list[i], list[j]] = [list[j], list[i]];
    this.list = list;
    const a = this.rows.get(marketKey(m))!.el, b = this.rows.get(marketKey(list[i]))!.el;
    if (dir < 0) this.listEl.insertBefore(a, b);
    else this.listEl.insertBefore(b, a);
    this.opts.onChange(this.list);
  }

  private remove(m: Market) {
    this.list = this.list.filter((x) => marketKey(x) !== marketKey(m));
    this.opts.onChange(this.list);
    this.renderList();
  }

  setActive(m: Market) {
    this.rows.get(this.active)?.el.classList.remove('active');
    this.active = marketKey(m);
    this.rows.get(this.active)?.el.classList.add('active');
  }

  // ---- add-coin dialog -----------------------------------------------------------

  private tickers(ex: ExchangeId): Promise<Ticker[]> {
    let p = this.tickerCache.get(ex);
    if (!p) {
      p = EXCHANGES[ex].fetchTickers();
      p.catch(() => this.tickerCache.delete(ex)); // retry next time
      this.tickerCache.set(ex, p);
    }
    return p;
  }

  /** Matches on one source: stock sources search remotely, crypto exchanges filter their ticker list. */
  private async find(ex: ExchangeId, q: string): Promise<Ticker[]> {
    const exchange = EXCHANGES[ex];
    if (!exchange.search) return (await this.tickers(ex)).filter((t) => t.base.includes(q));
    const key = `${ex}:${q}`;
    let p = this.searchCache.get(key);
    if (!p) {
      p = exchange.search(q);
      p.catch(() => this.searchCache.delete(key));
      this.searchCache.set(key, p);
    }
    return p;
  }

  private openDialog() {
    this.dialog.hidden = false;
    this.search.value = '';
    this.search.focus();
    EXCHANGE_ORDER.filter((ex) => !EXCHANGES[ex].search).forEach((ex) => this.tickers(ex).then(() => this.renderResults(), () => this.renderResults()));
    this.renderResults();
  }

  private closeDialog() {
    this.dialog.hidden = true;
  }

  private async renderResults() {
    const q = this.search.value.trim().toUpperCase().replace(/[/_-]?USDT?$/, '');
    const exs = this.filterEx === 'all' ? EXCHANGE_ORDER : [this.filterEx];
    if (!q && (this.filterEx === 'all' || this.filterEx === 'macro')) {
      this.renderFound((await this.find('macro', '')).map((t) => ({ ex: 'macro' as ExchangeId, t })), [], 'Macro — click to add:');
      return;
    }
    if (!q) {
      this.results.innerHTML = '<div class="wl-empty">Type a symbol to search coins (Binance, Bybit, OKX, Gate, Bitget, Bitstamp) and Vietnamese / US stocks.</div>';
      return;
    }
    const settled = await Promise.allSettled(exs.map((ex) => this.find(ex, q)));
    if (q !== this.search.value.trim().toUpperCase().replace(/[/_-]?USDT?$/, '')) return; // stale

    const found: { ex: ExchangeId; t: Ticker }[] = [];
    const notes: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'rejected') notes.push(`${EXCHANGES[exs[i]].name}: failed to load`);
      else for (const t of r.value) found.push({ ex: exs[i], t });
    });
    this.renderFound(found, notes, '', q);
  }

  private renderFound(found: { ex: ExchangeId; t: Ticker }[], notes: string[], title: string, q = '') {
    const rank = (b: string) => (b === q ? 0 : b.startsWith(q) ? 1 : 2);
    found.sort((a, b) => rank(a.t.base) - rank(b.t.base) || +(b.ex === 'macro') - +(a.ex === 'macro') || (b.t.quoteVolume || 0) - (a.t.quoteVolume || 0));

    const html = found.slice(0, 60).map(({ ex, t }) => {
      const m: Market = { ex, symbol: t.symbol, base: t.base, quote: t.quote };
      const added = this.rows.has(marketKey(m));
      return `<div class="wl-res ${added ? 'added' : ''}" data-market='${JSON.stringify(m)}'>
        <span class="sym">${t.base}${t.quote ? `<small>/${t.quote}</small>` : ''}${badge(ex)}</span>
        ${isFinite(t.last)
          ? `<span class="price">${formatPrice(t.last)}</span><span class="vol">${formatVolume(t.quoteVolume)}</span>`
          : `<span class="nm" title="${esc(t.name ?? '')}">${esc(t.name ?? '')}</span>`}
        <span class="act">${added ? '✓' : '+'}</span>
      </div>`;
    });
    this.results.innerHTML =
      (title ? `<div class="wl-empty">${title}</div>` : '') +
      (html.join('') || '<div class="wl-empty">No results.</div>') +
      (notes.length ? `<div class="wl-empty">${notes.join(' · ')}</div>` : '');
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
