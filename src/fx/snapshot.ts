/**
 * The bundled CBK history (data/cbk-kes-rates.json), built by `npm run fx:snapshot`.
 * Each day row is aligned to `currencies`: [mean, buy, sell] up to 2024-01-04, a bare mean after
 * (CBK stopped publishing buy/sell), or 0 when CBK published nothing for that currency that day.
 */
import type { CbkRate } from "./cbk-source.js";
import type { Withheld } from "./clean.js";
import { CURRENCY_CODES, type CurrencyCode } from "./currencies.js";

export type SnapshotCell = number | [number, number, number];
export type Snapshot = {
  format: 1;
  source: string;
  generated_at: string;
  first_date: string;
  last_date: string;
  currencies: CurrencyCode[];
  days: [string, SnapshotCell[]][];
  /** CBK values we refuse to serve (see clean.ts), so a lookup can say why a weekday has no rate. */
  withheld: Withheld[];
};

export function buildSnapshot(rates: Iterable<CbkRate>, withheld: Withheld[], source: string, generatedAt: Date): Snapshot {
  const byDate = new Map<string, SnapshotCell[]>();
  for (const r of rates) {
    const row = byDate.get(r.date) ?? CURRENCY_CODES.map(() => 0 as SnapshotCell);
    row[CURRENCY_CODES.indexOf(r.currency)] = r.buy !== undefined && r.sell !== undefined ? [r.mean, r.buy, r.sell] : r.mean;
    byDate.set(r.date, row);
  }
  const days = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    format: 1,
    source,
    generated_at: generatedAt.toISOString(),
    first_date: days[0]?.[0] ?? "",
    last_date: days.at(-1)?.[0] ?? "",
    currencies: [...CURRENCY_CODES],
    days,
    withheld: [...withheld].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export function* snapshotRates(s: Snapshot): Generator<CbkRate> {
  for (const [date, row] of s.days) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      const currency = s.currencies[i];
      if (!currency || cell === 0) continue;
      yield Array.isArray(cell) ? { date, currency, mean: cell[0], buy: cell[1], sell: cell[2] } : { date, currency, mean: cell };
    }
  }
}
