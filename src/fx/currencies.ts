/**
 * The 21 currencies CBK publishes against the Kenya shilling, and how CBK quotes each one.
 * Pure data: the only place that knows CBK's labels and quote conventions.
 */

/** How the CBK number reads. Most are "KES per 1 unit"; JPY is per 100; the EAC pairs are inverted. */
export type QuoteStyle = "kes_per_unit" | "kes_per_100_units" | "units_per_kes";

export type CurrencyInfo = { code: string; name: string; style: QuoteStyle; cbkLabels: readonly string[] };

export const CURRENCIES = [
  { code: "USD", name: "US dollar", style: "kes_per_unit", cbkLabels: ["US DOLLAR"] },
  { code: "GBP", name: "Pound sterling", style: "kes_per_unit", cbkLabels: ["STG POUND"] },
  { code: "EUR", name: "Euro", style: "kes_per_unit", cbkLabels: ["EURO"] },
  { code: "ZAR", name: "South African rand", style: "kes_per_unit", cbkLabels: ["SA RAND"] },
  { code: "UGX", name: "Ugandan shilling", style: "units_per_kes", cbkLabels: ["KES / USHS", "KES/USHS"] },
  { code: "TZS", name: "Tanzanian shilling", style: "units_per_kes", cbkLabels: ["KES / TSHS", "KES/TSHS"] },
  { code: "RWF", name: "Rwandan franc", style: "units_per_kes", cbkLabels: ["KES / RWF", "KES/RWF"] },
  { code: "BIF", name: "Burundian franc", style: "units_per_kes", cbkLabels: ["KES / BIF", "KES/BIF"] },
  { code: "AED", name: "UAE dirham", style: "kes_per_unit", cbkLabels: ["AE DIRHAM"] },
  { code: "CAD", name: "Canadian dollar", style: "kes_per_unit", cbkLabels: ["CAN $"] },
  { code: "CHF", name: "Swiss franc", style: "kes_per_unit", cbkLabels: ["S FRANC"] },
  { code: "JPY", name: "Japanese yen", style: "kes_per_100_units", cbkLabels: ["JPY (100)", "JPY(100)"] },
  { code: "SEK", name: "Swedish krona", style: "kes_per_unit", cbkLabels: ["SW KRONER"] },
  { code: "NOK", name: "Norwegian krone", style: "kes_per_unit", cbkLabels: ["NOR KRONER"] },
  { code: "DKK", name: "Danish krone", style: "kes_per_unit", cbkLabels: ["DAN KRONER"] },
  { code: "INR", name: "Indian rupee", style: "kes_per_unit", cbkLabels: ["IND RUPEE"] },
  { code: "HKD", name: "Hong Kong dollar", style: "kes_per_unit", cbkLabels: ["HONGKONG DOLLAR", "HONGKONG $"] },
  { code: "SGD", name: "Singapore dollar", style: "kes_per_unit", cbkLabels: ["SINGAPORE DOLLAR", "SINGAPORE $"] },
  { code: "SAR", name: "Saudi riyal", style: "kes_per_unit", cbkLabels: ["SAUDI RIYAL"] },
  { code: "CNY", name: "Chinese yuan", style: "kes_per_unit", cbkLabels: ["CHINESE YUAN"] },
  { code: "AUD", name: "Australian dollar", style: "kes_per_unit", cbkLabels: ["AUSTRALIAN $"] },
] as const satisfies readonly CurrencyInfo[];

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as CurrencyCode[];

const BY_CODE = new Map<string, CurrencyInfo>(CURRENCIES.map((c) => [c.code, c]));
const BY_LABEL = new Map<string, CurrencyCode>(CURRENCIES.flatMap((c) => c.cbkLabels.map((l) => [l, c.code] as const)));

export const currencyInfo = (code: CurrencyCode): CurrencyInfo => BY_CODE.get(code)!;
export const isCurrencyCode = (s: string): s is CurrencyCode => BY_CODE.has(s);
/** CBK label -> ISO code, or undefined for labels we do not recognise (they are skipped, never guessed). */
export const codeForCbkLabel = (label: string): CurrencyCode | undefined => BY_LABEL.get(label.trim());

/** Human-readable reading of the CBK number. */
export function quoteText(code: CurrencyCode): string {
  const { style } = currencyInfo(code);
  if (style === "kes_per_100_units") return `KES per 100 ${code}`;
  if (style === "units_per_kes") return `${code} per 1 KES`;
  return `KES per 1 ${code}`;
}

/** Converts a CBK-published number into KES for one unit of the currency. */
export function kesPerUnit(code: CurrencyCode, published: number): number {
  const { style } = currencyInfo(code);
  if (style === "kes_per_100_units") return published / 100;
  if (style === "units_per_kes") return 1 / published;
  return published;
}
