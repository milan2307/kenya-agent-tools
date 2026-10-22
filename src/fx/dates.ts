/** Calendar-date helpers. Dates are plain "YYYY-MM-DD" strings in Kenya time (EAT, UTC+3, no DST). */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

export function isRealIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s;
}

export const todayInNairobi = (now: Date): string => new Date(now.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

export const weekdayName = (iso: string): string =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** CBK uses dd/mm/yyyy. */
export function cbkToIso(cbk: string): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cbk.trim());
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isRealIsoDate(iso) ? iso : undefined;
}

export const isoToCbk = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
