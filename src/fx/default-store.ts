/**
 * Production wiring for the rate store: bundled snapshot from data/ + live CBK tail (table 193).
 * Loaded lazily on the first FX request so the parser routes never pay for it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CBK_TABLES, fetchCbkRates } from "./cbk-source.js";
import { RateStore, type TailSource } from "./rate-store.js";
import type { Snapshot } from "./snapshot.js";

const SNAPSHOT_FILE = "data/cbk-kes-rates.json";

export const cbkTail: TailSource = async (from, to) =>
  (await fetchCbkRates({ tableId: CBK_TABLES.currentMeanOnly, from, to, maxRows: 2000, timeoutMs: 6000, maxBytes: 1_000_000 })).rates;

export function loadSnapshot(): Snapshot {
  // Vercel ships data/ via vercel.json includeFiles; the function runs with cwd at the project root.
  const candidates = [join(process.cwd(), SNAPSHOT_FILE), new URL(`../../${SNAPSHOT_FILE}`, import.meta.url)];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    } catch {
      // try the next location
    }
  }
  throw new Error("CBK snapshot file not found");
}

let store: RateStore | undefined;
export const defaultRateStore = (): RateStore => (store ??= new RateStore(loadSnapshot(), cbkTail));
