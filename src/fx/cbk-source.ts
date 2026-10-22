/**
 * Reads CBK's published indicative exchange rates from the tables behind
 * https://www.centralbank.go.ke/rates/forex-exchange-rates/ (wpDataTables server-side endpoint).
 *
 * The URL is a constant: callers choose only table id, date range and currency label, never the host,
 * so no request input can point this fetch anywhere else.
 */
import { z } from "zod";
import { codeForCbkLabel, type CurrencyCode } from "./currencies.js";
import { cbkToIso, isoToCbk } from "./dates.js";

export const CBK_RATES_PAGE = "https://www.centralbank.go.ke/rates/forex-exchange-rates/";
const CBK_TABLE_ENDPOINT = "https://www.centralbank.go.ke/wp-admin/admin-ajax.php?action=get_wdtable";

/** Table ids as of 2026-10: 32 = 1990s..2024-01-03 with mean/buy/sell, 91 = 2024-01-04, 193 = 2024-01-05..today, mean only. */
export const CBK_TABLES = { legacyMeanBuySell: 32, transitionDay: 91, currentMeanOnly: 193 } as const;

export type CbkRate = { date: string; currency: CurrencyCode; mean: number; buy?: number; sell?: number };

export type CbkQuery = {
  tableId: number;
  /** Inclusive ISO date range (column 0 filter). Only honoured by table 193; table 32 needs `cbkLabel`. */
  from?: string;
  to?: string;
  /** Exact CBK label filter (column 1), e.g. "US DOLLAR". */
  cbkLabel?: string;
  maxRows: number;
  timeoutMs: number;
  /** Hard cap on response bytes so a misbehaving upstream cannot exhaust memory. */
  maxBytes: number;
};

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const responseSchema = z.object({
  recordsFiltered: z.union([z.string(), z.number()]).optional(),
  data: z.array(z.array(z.string())),
});

export class CbkUnavailableError extends Error {}

export async function fetchCbkRates(q: CbkQuery, fetcher: Fetcher = fetch): Promise<{ rates: CbkRate[]; skipped: number; recordsFiltered?: number }> {
  const form = new URLSearchParams({
    draw: "1",
    start: "0",
    length: String(q.maxRows),
    "columns[0][data]": "0",
    "columns[0][searchable]": "true",
    "columns[0][search][value]": q.from && q.to ? `${isoToCbk(q.from)}|${isoToCbk(q.to)}` : "",
    "columns[1][data]": "1",
    "columns[1][searchable]": "true",
    "columns[1][search][value]": q.cbkLabel ?? "",
  });

  let text: string;
  try {
    const res = await fetcher(`${CBK_TABLE_ENDPOINT}&table_id=${q.tableId}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        // CBK sits behind a WAF that rejects library user agents.
        "user-agent": "Mozilla/5.0 (compatible; kes-fx-x402/1.0; +https://mpesa-kra-parser.vercel.app/)",
        "x-requested-with": "XMLHttpRequest",
      },
      body: form.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(q.timeoutMs),
    });
    if (!res.ok) throw new CbkUnavailableError(`CBK returned HTTP ${res.status}`);
    text = await readCapped(res, q.maxBytes);
  } catch (err) {
    if (err instanceof CbkUnavailableError) throw err;
    throw new CbkUnavailableError(err instanceof Error ? err.name : "fetch_failed");
  }

  const parsed = responseSchema.safeParse(safeJson(text));
  if (!parsed.success) throw new CbkUnavailableError("CBK response was not the expected table JSON");

  const rates: CbkRate[] = [];
  let skipped = 0;
  for (const row of parsed.data.data) {
    const rate = parseRow(row);
    if (rate) rates.push(rate);
    else skipped++;
  }
  const rf = parsed.data.recordsFiltered;
  return { rates, skipped, recordsFiltered: rf === undefined ? undefined : Number(rf) };
}

/** ["15/10/2026","US DOLLAR","129.8100"(,"buy","sell")] -> CbkRate, or undefined when anything is off. */
export function parseRow(row: string[]): CbkRate | undefined {
  const [d, label, mean, buy, sell] = row;
  const date = d ? cbkToIso(d) : undefined;
  const currency = label ? codeForCbkLabel(label) : undefined;
  const m = num(mean);
  if (!date || !currency || m === undefined || date < "1990-01-01") return undefined;
  const b = num(buy);
  const s = num(sell);
  return b !== undefined && s !== undefined ? { date, currency, mean: m, buy: b, sell: s } : { date, currency, mean: m };
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CbkUnavailableError("CBK response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
