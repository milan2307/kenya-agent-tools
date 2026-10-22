/** Small, pure helpers shared by the document parsers. */
import type { Field } from "../schema/output.js";

export const KRA_PIN = /\b[AP]\d{9}[A-Z]\b/;
const AMOUNT = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export const field = <T>(value: T | null | undefined, confidence: number): Field<T> =>
  value === null || value === undefined ? { value: null, confidence: 0 } : { value, confidence };

export function isAmount(token: string): boolean {
  return AMOUNT.test(token);
}

/** "1,234.50" -> 1234.5, "-500.00" -> -500. Returns null when not a plain amount. */
export function parseAmount(token: string): number | null {
  const t = token.replace(/^KES\s*|^Ksh\.?\s*/i, "").trim();
  if (!isAmount(t)) return null;
  return Number(t.replace(/,/g, ""));
}

/** Last amount on a line, e.g. "TOTAL  KES 9,860.00" -> 9860. */
export function lastAmount(line: string): number | null {
  const tokens = line.replace(/KES|Ksh\.?/gi, " ").split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const n = parseAmount(tokens[i]);
    if (n !== null) return n;
  }
  return null;
}

/** Accepts 2026-08-31, 31/08/2026, 31-08-2026, 31 Aug 2026, 31st Aug 2026. Returns YYYY-MM-DD. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return validDate(m[3], m[2].padStart(2, "0"), m[1].padStart(2, "0"));
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[A-Za-z]*,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return validDate(m[3], MONTHS[m[2].toLowerCase()], m[1].padStart(2, "0"));
  return null;
}

function validDate(y: string, mo: string, d: string): string | null {
  const iso = `${y}-${mo}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().startsWith(iso) ? iso : null;
}

/** Value after "Label:" on the first matching line. */
export function labelledValue(lines: string[], label: RegExp): string | null {
  for (const line of lines) {
    const value = line.match(new RegExp(`^\\s*(?:${label.source})\\s*[:.]?\\s*(?<value>.+)$`, "i"))?.groups?.value.trim();
    if (value) return value;
  }
  return null;
}

export const roughlyEqual = (a: number, b: number, tolerance = 0.05) => Math.abs(a - b) <= tolerance;
export const round2 = (n: number) => Math.round(n * 100) / 100;
