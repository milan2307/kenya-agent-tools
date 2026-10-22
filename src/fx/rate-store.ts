/**
 * In-memory CBK rate store: the bundled snapshot plus a live "tail" of days published since the
 * snapshot was built. The tail is fetched from CBK only when a request needs a date newer than the
 * snapshot, at most once per TTL per instance, single-flight, with a hard timeout. A failed refresh
 * never throws: callers fall back to the newest trusted rate and the response says so.
 */
import type { CbkRate } from "./cbk-source.js";
import { plausibleNext, type Withheld } from "./clean.js";
import type { CurrencyCode } from "./currencies.js";
import { addDays, daysBetween, todayInNairobi } from "./dates.js";
import { snapshotRates, type Snapshot } from "./snapshot.js";

export type StoredRate = CbkRate & { origin: "snapshot" | "cbk_live" };
export type LiveCheck = "not_needed" | "fetched" | "cached" | "failed";
/** Fetches CBK rows for an inclusive ISO date range. */
export type TailSource = (from: string, to: string) => Promise<CbkRate[]>;

export type StoreOptions = {
  okTtlMs: number;
  failTtlMs: number;
  /** Never ask CBK for more than this many days in one refresh. */
  maxTailDays: number;
  now: () => Date;
};

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  okTtlMs: 30 * 60_000,
  failTtlMs: 5 * 60_000,
  maxTailDays: 60,
  now: () => new Date(),
};

export type Lookup =
  | { found: true; rate: StoredRate; gapDays: number; withheldOnRequestedDate: boolean }
  | { found: false; reason: "before_coverage" | "too_stale"; newestDate?: string };

export class RateStore {
  private readonly series = new Map<CurrencyCode, StoredRate[]>();
  private readonly withheld = new Set<string>();
  private nextRefreshAt = 0;
  private lastStatus: "ok" | "failed" | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly snapshot: Snapshot,
    private readonly tail: TailSource | undefined,
    private readonly opts: StoreOptions = DEFAULT_STORE_OPTIONS,
  ) {
    for (const r of snapshotRates(snapshot)) this.listFor(r.currency).push({ ...r, origin: "snapshot" });
    for (const list of this.series.values()) list.sort(byDate);
    for (const w of snapshot.withheld) this.withheld.add(`${w.date}|${w.currency}`);
  }

  get snapshotLastDate(): string {
    return this.snapshot.last_date;
  }
  get firstDate(): string {
    return this.snapshot.first_date;
  }
  /** Free status view: what we hold and how the last live refresh went. Never triggers a fetch. */
  status() {
    return {
      currencies: this.snapshot.currencies,
      first_date: this.snapshot.first_date,
      snapshot_last_date: this.snapshot.last_date,
      snapshot_built_at: this.snapshot.generated_at,
      withheld_points: this.withheld.size,
      last_live_refresh: this.lastStatus ?? "none_yet",
    };
  }
  today(): string {
    return todayInNairobi(this.opts.now());
  }

  /** Ensures the tail is as fresh as policy allows for `date`. Never throws. */
  async refreshFor(date: string): Promise<LiveCheck> {
    if (!this.tail || date <= this.snapshot.last_date) return "not_needed";
    if (this.opts.now().getTime() < this.nextRefreshAt) return this.lastStatus === "ok" ? "cached" : "failed";
    this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
    await this.inflight;
    return this.lastStatus === "ok" ? "fetched" : "failed";
  }

  lookup(currency: CurrencyCode, date: string, maxFallbackDays: number): Lookup {
    const list = this.series.get(currency) ?? [];
    const idx = lastIndexOnOrBefore(list, date);
    if (idx < 0) return { found: false, reason: "before_coverage" };
    const rate = list[idx]!;
    const gapDays = daysBetween(rate.date, date);
    if (gapDays > maxFallbackDays) return { found: false, reason: "too_stale", newestDate: rate.date };
    return { found: true, rate, gapDays, withheldOnRequestedDate: this.withheld.has(`${date}|${currency}`) };
  }

  private async refresh(): Promise<void> {
    const today = this.today();
    const earliest = addDays(today, -(this.opts.maxTailDays - 1));
    const from = addDays(this.snapshot.last_date, 1) > earliest ? addDays(this.snapshot.last_date, 1) : earliest;
    try {
      const rows = await this.tail!(from, today);
      for (const r of rows) this.acceptLive(r, today);
      this.lastStatus = "ok";
      this.nextRefreshAt = this.opts.now().getTime() + this.opts.okTtlMs;
    } catch (err) {
      console.error("fx_refresh_failed", err instanceof Error ? err.message.slice(0, 120) : "unknown");
      this.lastStatus = "failed";
      this.nextRefreshAt = this.opts.now().getTime() + this.opts.failTtlMs;
    }
  }

  /** Only rows newer than the snapshot, not in the future, and plausible against the last trusted value. */
  private acceptLive(r: CbkRate, today: string): void {
    if (r.date <= this.snapshot.last_date || r.date > today) return;
    const list = this.listFor(r.currency);
    const prevIdx = lastIndexOnOrBefore(list, addDays(r.date, -1));
    if (!plausibleNext(r.mean, list[prevIdx]?.mean)) {
      this.withheld.add(`${r.date}|${r.currency}`);
      return;
    }
    const at = list.findIndex((x) => x.date === r.date);
    const row: StoredRate = { date: r.date, currency: r.currency, mean: r.mean, origin: "cbk_live" };
    if (at >= 0) list[at] = row;
    else {
      list.push(row);
      list.sort(byDate);
    }
  }

  private listFor(code: CurrencyCode): StoredRate[] {
    let list = this.series.get(code);
    if (!list) this.series.set(code, (list = []));
    return list;
  }
}

const byDate = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function lastIndexOnOrBefore(list: { date: string }[], date: string): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export type { Withheld };
