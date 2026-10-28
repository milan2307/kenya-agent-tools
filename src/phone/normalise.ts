// Vendored from https://github.com/milan2307/east-africa-phone-normaliser/blob/bb44cf4/src/core/normalise.ts (MIT, LamuLabs). Do not edit here.
/**
 * Normalise and classify one Kenyan, Ugandan or Tanzanian phone number, or a Kenyan M-PESA Paybill / Till.
 * Pure function, no I/O, no registry lookups.
 */
import { COUNTRY_CODES, SECONDARY_SOURCE, SOURCES, lookup, type Country } from "./plans.js";

export type Kind = "auto" | "phone" | "paybill" | "till";
export type ResultType = "mobile" | "landline" | "m2m" | "toll_free" | "premium" | "paybill" | "till" | "paybill_or_till" | "unknown";

export type NormaliseOptions = {
  /** Country for numbers written without a country code. Default KE. */
  defaultCountry?: Country;
  /** What the caller says the input is. "auto" guesses from the shape. */
  kind?: Kind;
};

export type NormaliseResult = {
  input: string;
  valid: boolean;
  country: Country | null;
  type: ResultType;
  /** +2547XXXXXXXX for phone numbers, null otherwise. */
  e164: string | null;
  /** Local dialling form, e.g. 0712345678. */
  national: string | null;
  /** Readable international form, e.g. +254 712 345 678. */
  display: string | null;
  /** Digits only: the Paybill/Till number, or the E.164 digits without "+". */
  clean: string | null;
  /** Brand of the operator the number range is allocated to (Safaricom, Airtel, MTN, Yas...). */
  network: string | null;
  /** Operator legal name as written in the numbering plan. */
  network_operator: string | null;
  range_status: "operational" | "not_operational" | "test_only" | "special_use" | "secondary_source" | null;
  region: string | null;
  /** "numbering_plan" = checked against the regulator's plan; "format_only" = shape check only (Paybill/Till). */
  check: "numbering_plan" | "format_only" | "none";
  reason: string | null;
  notes: string[];
  source: { plan: string; url: string } | null;
};

const PORTING_NOTE = "Network is the operator this number range is allocated to in the official plan. The number may have been ported to another operator; this is not a live registry lookup.";
const MPESA_NOTE = "Format check only: 5 to 7 digits. Safaricom publishes no public registry, so this does not confirm the Paybill/Till exists, is active, or who owns it.";

const empty = (input: string): NormaliseResult => ({
  input, valid: false, country: null, type: "unknown", e164: null, national: null, display: null, clean: null,
  network: null, network_operator: null, range_status: null, region: null, check: "none", reason: null, notes: [], source: null,
});

/** Strip formatting people actually type: spaces, dashes, dots, brackets, slashes, NBSP, a leading "tel:". */
export function stripFormatting(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/^tel:/i, "").replace(/[\s\u00a0\-.()/\\]/g, "");
}

export function normalise(raw: unknown, opts: NormaliseOptions = {}): NormaliseResult {
  const input = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : typeof raw === "string" ? raw : "";
  const out = empty(input);
  if (!input || input.length > 40) return { ...out, reason: input ? "too_long" : "empty" };
  const kind = opts.kind ?? "auto";
  const defaultCountry = opts.defaultCountry ?? "KE";

  let s = stripFormatting(input);
  const hadPlus = s.startsWith("+");
  if (hadPlus) s = s.slice(1);
  if (!/^\d+$/.test(s)) return { ...out, reason: "not_digits" };

  // Paybill / Till: Kenyan M-PESA short numbers, 5-7 digits, never with a country code or trunk 0.
  if (kind === "paybill" || kind === "till" || (kind === "auto" && !hadPlus && s.length >= 5 && s.length <= 7 && !s.startsWith("0"))) {
    const type: ResultType = kind === "auto" ? "paybill_or_till" : kind;
    const base = { ...out, country: "KE" as Country, type, check: "format_only" as const, notes: [MPESA_NOTE] };
    if (hadPlus || s.startsWith("0")) return { ...base, reason: "paybill_till_must_not_have_prefix" };
    if (s.length < 5 || s.length > 7) return { ...base, reason: "paybill_till_length_5_to_7" };
    return {
      ...base, valid: true, clean: s, network: "Safaricom M-PESA", network_operator: "Safaricom PLC",
      notes: kind === "auto" ? [MPESA_NOTE, "A Paybill and a Till look the same; pass kind=paybill or kind=till if you know which."] : [MPESA_NOTE],
    };
  }
  if (kind !== "auto" && kind !== "phone") return { ...out, reason: "invalid_kind" };

  // Work out country + national significant number (NSN).
  let country: Country | null = null;
  let nsn = s;
  if (s.startsWith("00")) s = s.slice(2);
  const cc = (Object.entries(COUNTRY_CODES) as [Country, string][]).find(([, code]) => s.startsWith(code));
  if (cc && (hadPlus || input.trim().startsWith("00") || s.length >= 12)) {
    country = cc[0];
    nsn = s.slice(cc[1].length);
    if (nsn.startsWith("0")) nsn = nsn.slice(1); // "+254 0712..." is a common mistake
  } else if (hadPlus || input.trim().startsWith("00")) {
    return { ...out, reason: "unsupported_country_code" };
  } else {
    country = defaultCountry;
    if (nsn.startsWith("0")) nsn = nsn.slice(1);
  }

  const source = SOURCES[country];
  const base = { ...out, country, check: "numbering_plan" as const, source: { plan: source.plan, url: source.url } };
  const alloc = lookup(country, nsn);
  if (!alloc) return { ...base, reason: nsn.length < 7 ? "too_short" : "prefix_not_allocated" };
  if (nsn.length < alloc.minLength) return { ...base, type: alloc.type, reason: "too_short" };
  if (nsn.length > alloc.maxLength) return { ...base, type: alloc.type, reason: "too_long" };

  const code = COUNTRY_CODES[country];
  const notes = [alloc.type === "mobile" ? PORTING_NOTE : null, alloc.note ?? null].filter((n): n is string => !!n);
  const issued = alloc.status !== "test_only" && alloc.status !== "not_operational";
  return {
    ...base,
    valid: issued,
    type: alloc.type,
    e164: `+${code}${nsn}`,
    national: `0${nsn}`,
    display: `+${code} ${group(nsn)}`,
    clean: `${code}${nsn}`,
    network: alloc.brand ?? alloc.operator,
    network_operator: alloc.operator,
    range_status: alloc.status ?? null,
    region: alloc.region ?? null,
    reason: issued ? null : alloc.status === "test_only" ? "test_range_not_issued" : "range_not_operational",
    ...(alloc.status === "secondary_source" ? { source: SECONDARY_SOURCE } : {}),
    notes,
  };
}

/** 712345678 -> "712 345 678"; landlines keep the area code first. */
function group(nsn: string): string {
  if (nsn.length === 9) return `${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6)}`;
  if (nsn.length === 12) return `${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6, 9)} ${nsn.slice(9)}`;
  return `${nsn.slice(0, 2)} ${nsn.slice(2)}`;
}

export const MAX_BATCH = 100;

export function normaliseBatch(items: unknown[], opts: NormaliseOptions = {}) {
  const results = items.map((n) => normalise(n, opts));
  return {
    count: results.length,
    valid_count: results.filter((r) => r.valid).length,
    results,
  };
}
