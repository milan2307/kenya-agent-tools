/**
 * Data-quality rules applied to CBK rows before we serve them. CBK's own tables carry a few
 * obvious keying errors (values shifted into the wrong currency for one day, an inverted EAC
 * quote on 2017-03-28). We withhold those points instead of selling them, and say so.
 */
import type { CbkRate } from "./cbk-source.js";

/** Rows dated before this are misaligned across currencies in CBK's table 32. */
export const SERIES_START = "2004-11-02";
/** A point this far from both its past and future neighbourhood is treated as a keying error. */
export const OUTLIER_RATIO = 0.25;
const WINDOW = 5;

/** Multi-day stretches the spike rule cannot see. Each was checked by hand against neighbouring days. */
export const KNOWN_BAD_RANGES = [
  { currency: "AUD", from: "2006-07-13", to: "2006-12-20", reason: "CBK table shows CNY-level values (~9) under AUSTRALIAN $ for this stretch" },
] as const;

export type Withheld = { date: string; currency: string; mean: number; reason: string };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const far = (x: number, ref: number) => Math.abs(x / ref - 1) > OUTLIER_RATIO;

/** Drops reverting spikes per currency. A genuine level shift (CHF 2015, BIF 2023) has a future neighbourhood at the new level and is kept. */
export function withholdOutliers(rates: CbkRate[]): { kept: CbkRate[]; withheld: Withheld[] } {
  const byCurrency = new Map<string, CbkRate[]>();
  const knownBad: Withheld[] = [];
  for (const r of rates) {
    if (r.date < SERIES_START) continue;
    const bad = KNOWN_BAD_RANGES.find((b) => b.currency === r.currency && r.date >= b.from && r.date <= b.to);
    if (bad) {
      knownBad.push({ date: r.date, currency: r.currency, mean: r.mean, reason: bad.reason });
      continue;
    }
    const list = byCurrency.get(r.currency) ?? [];
    list.push(r);
    byCurrency.set(r.currency, list);
  }
  const kept: CbkRate[] = [];
  const withheld: Withheld[] = [...knownBad];
  for (const list of byCurrency.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    list.forEach((r, i) => {
      const before = list.slice(Math.max(0, i - WINDOW), i).map((x) => x.mean);
      const after = list.slice(i + 1, i + 1 + WINDOW).map((x) => x.mean);
      const spike = before.length > 0 && after.length > 0 && far(r.mean, median(before)) && far(r.mean, median(after));
      if (spike) withheld.push({ date: r.date, currency: r.currency, mean: r.mean, reason: "differs >25% from surrounding CBK values (likely keying error)" });
      else kept.push(r);
    });
  }
  return { kept, withheld };
}

/** Runtime check for freshly fetched rows: no history after them yet, so compare with the last trusted value. */
export const plausibleNext = (mean: number, lastTrusted: number | undefined): boolean => lastTrusted === undefined || !far(mean, lastTrusted);
