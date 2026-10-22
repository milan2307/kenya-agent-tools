/**
 * Use cases for the FX routes: look up CBK rates for a date (with weekend/holiday fallback) and
 * convert an amount through KES. Pure over the RateStore; no HTTP, no env.
 */
import { CBK_RATES_PAGE } from "../fx/cbk-source.js";
import { currencyInfo, CURRENCY_CODES, kesPerUnit, quoteText, type CurrencyCode } from "../fx/currencies.js";
import { weekdayName } from "../fx/dates.js";
import type { LiveCheck, RateStore } from "../fx/rate-store.js";
import type { ConvertQuery, RateQuery } from "../schema/fx-input.js";
import { FxError } from "./errors.js";

/** A rate older than this (relative to the requested date) is not served; the call fails unpaid. */
export const MAX_FALLBACK_DAYS = 10;
export const BUY_SELL_LAST_DATE = "2024-01-04";

const SOURCE = {
  publisher: "Central Bank of Kenya (CBK)",
  dataset: "CBK indicative exchange rates against the Kenya shilling, published each business day",
  url: CBK_RATES_PAGE,
  note: `buy and sell are published up to ${BUY_SELL_LAST_DATE}; from 2024-01-05 CBK publishes the mean only (buy/sell are null).`,
  disclaimer: "Not affiliated with or endorsed by CBK. Indicative reference rates, not dealing rates. CBK gives no warranty of accuracy.",
};

export type RateResult = {
  currency: CurrencyCode;
  name: string;
  rate_date: string;
  is_fallback: boolean;
  fallback_reason: string | null;
  quote: string;
  mean: number;
  buy: number | null;
  sell: number | null;
  kes_per_unit: number;
  units_per_kes: number;
};

export async function getKesRates(query: RateQuery, store: RateStore) {
  const date = checkedDate(query.date, store);
  const live = await store.refreshFor(date);
  const codes = query.currency ?? CURRENCY_CODES;
  return {
    base: "KES",
    requested_date: date,
    date_defaulted_to_today: query.date === undefined,
    rates: codes.map((c) => rateFor(c, date, store)),
    freshness: freshness(store, live),
    source: SOURCE,
  };
}

export async function convertAmount(query: ConvertQuery, store: RateStore) {
  const date = checkedDate(query.date, store);
  const live = await store.refreshFor(date);
  const leg = (c: CurrencyCode | "KES") =>
    c === "KES" ? { currency: "KES", kes_per_unit: 1, rate_date: null, is_fallback: false } : pick(rateFor(c, date, store));
  const from = leg(query.from);
  const to = leg(query.to);
  const result = round((query.amount * from.kes_per_unit) / to.kes_per_unit);
  return {
    amount: query.amount,
    from: query.from,
    to: query.to,
    requested_date: date,
    date_defaulted_to_today: query.date === undefined,
    result,
    is_fallback: from.is_fallback || to.is_fallback,
    legs: { from, to },
    method: "amount x (KES per 1 from) / (KES per 1 to), using CBK mean rates; cross rates go through KES",
    freshness: freshness(store, live),
    source: SOURCE,
  };
}

function checkedDate(requested: string | undefined, store: RateStore): string {
  const today = store.today();
  const date = requested ?? today;
  if (date > today) throw new FxError("date_out_of_range", `date is in the future (today in Nairobi is ${today})`);
  if (date < store.firstDate) throw new FxError("date_out_of_range", `coverage starts ${store.firstDate}`);
  return date;
}

function rateFor(code: CurrencyCode, date: string, store: RateStore): RateResult {
  const hit = store.lookup(code, date, MAX_FALLBACK_DAYS);
  if (!hit.found) {
    if (hit.reason === "before_coverage") throw new FxError("rate_not_available", `no CBK rate for ${code} on or before ${date}`);
    throw new FxError("rates_unavailable", `newest ${code} rate is ${hit.newestDate}; CBK could not be reached for newer data. Not charged; retry later.`);
  }
  const { rate } = hit;
  const fallback = rate.date !== date;
  const kpu = kesPerUnit(code, rate.mean);
  return {
    currency: code,
    name: currencyInfo(code).name,
    rate_date: rate.date,
    is_fallback: fallback,
    fallback_reason: fallback ? fallbackReason(date, hit.withheldOnRequestedDate, store) : null,
    quote: quoteText(code),
    mean: rate.mean,
    buy: rate.buy ?? null,
    sell: rate.sell ?? null,
    kes_per_unit: round(kpu),
    units_per_kes: round(1 / kpu),
  };
}

function fallbackReason(date: string, withheld: boolean, store: RateStore): string {
  if (withheld) return "CBK's value for this date failed our plausibility check and is withheld; last good published rate returned";
  const day = weekdayName(date);
  if (day === "Saturday" || day === "Sunday") return `${day}: CBK does not publish on weekends; last published rate returned`;
  if (date === store.today()) return "today's CBK rate is not published yet; last published rate returned";
  return "no CBK rate published for this date (public holiday or no publication); last published rate returned";
}

const pick = (r: RateResult) => ({ currency: r.currency, kes_per_unit: r.kes_per_unit, rate_date: r.rate_date, is_fallback: r.is_fallback });

function freshness(store: RateStore, live: LiveCheck) {
  return { snapshot_last_date: store.snapshotLastDate, live_check: live };
}

const round = (n: number) => Number(n.toPrecision(10));
