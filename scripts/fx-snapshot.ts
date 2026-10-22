/**
 * Rebuilds data/cbk-kes-rates.json from CBK's own tables. Run from a trusted machine, review the diff, redeploy.
 *   npm run fx:snapshot
 * Fails loudly if any CBK query returns fewer rows than CBK says it filtered (no silent gaps).
 */
import { writeFileSync } from "node:fs";
import { CBK_RATES_PAGE, CBK_TABLES, fetchCbkRates, type CbkQuery, type CbkRate } from "../src/fx/cbk-source.js";
import { withholdOutliers } from "../src/fx/clean.js";
import { CURRENCIES } from "../src/fx/currencies.js";
import { todayInNairobi } from "../src/fx/dates.js";
import { buildSnapshot } from "../src/fx/snapshot.js";

const OUT = new URL("../data/cbk-kes-rates.json", import.meta.url);
const base = { maxRows: 6000, timeoutMs: 120_000, maxBytes: 20_000_000 } satisfies Partial<CbkQuery>;

async function complete(q: CbkQuery): Promise<CbkRate[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { rates, skipped, recordsFiltered } = await fetchCbkRates(q);
      if (recordsFiltered !== undefined && rates.length + skipped !== recordsFiltered) {
        throw new Error(`table ${q.tableId} ${q.cbkLabel ?? ""}: got ${rates.length + skipped} of ${recordsFiltered} rows`);
      }
      if (recordsFiltered !== undefined && recordsFiltered >= q.maxRows) throw new Error(`table ${q.tableId} ${q.cbkLabel}: hit maxRows`);
      console.log(`table ${q.tableId} ${q.cbkLabel ?? "(all)"}: ${rates.length} rows, ${skipped} skipped`);
      return rates;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`retry ${attempt}: ${(err as Error).message}`);
    }
  }
}

const today = todayInNairobi(new Date());
const merged = new Map<string, CbkRate>();
let conflicts = 0;
const add = (rates: CbkRate[], override: boolean) => {
  for (const r of rates) {
    if (r.date >= today) continue; // today's rate is served live, so a same-day CBK revision is never frozen in
    const key = `${r.date}|${r.currency}`;
    const prev = merged.get(key);
    if (prev && prev.mean !== r.mean) conflicts++;
    if (!prev || override) merged.set(key, r);
  }
};

for (const c of CURRENCIES) {
  for (const label of c.cbkLabels) add(await complete({ ...base, tableId: CBK_TABLES.legacyMeanBuySell, cbkLabel: label }), false);
}
add(await complete({ ...base, tableId: CBK_TABLES.transitionDay }), true);
for (const c of CURRENCIES) add(await complete({ ...base, tableId: CBK_TABLES.currentMeanOnly, cbkLabel: c.cbkLabels[0] }), true);

const { kept, withheld } = withholdOutliers([...merged.values()]);
for (const w of withheld) console.log(`withheld ${w.date} ${w.currency} ${w.mean}`);
const snapshot = buildSnapshot(kept, withheld, CBK_RATES_PAGE, new Date());
writeFileSync(OUT, JSON.stringify(snapshot));
console.log(`wrote ${snapshot.days.length} days, ${kept.length} rates kept, ${withheld.length} withheld, ${snapshot.first_date}..${snapshot.last_date}, ${conflicts} same-day conflicts (later table wins, else first seen)`);
