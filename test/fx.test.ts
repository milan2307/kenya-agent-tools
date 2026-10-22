import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { StubFacilitator, TEST_PAY_TO, FX_NOW, buildTestApp, decodeHeader, payingFetch, testRateStore } from "./helpers.js";
import { CbkUnavailableError, fetchCbkRates, parseRow, type CbkRate } from "../src/fx/cbk-source.js";
import { withholdOutliers } from "../src/fx/clean.js";
import { loadSnapshot } from "../src/fx/default-store.js";
import { RateStore } from "../src/fx/rate-store.js";
import { snapshotRates } from "../src/fx/snapshot.js";

const RATE = "http://test.local/v1/fx/kes";
const CONVERT = "http://test.local/v1/fx/convert";

afterEach(() => vi.restoreAllMocks());

async function paid(url: string, store = testRateStore()) {
  const facilitator = new StubFacilitator();
  const { appFetch } = await buildTestApp(facilitator, store);
  const res = await payingFetch(appFetch)(url);
  return { res, body: await res.json(), facilitator };
}

describe("FX 402 challenge", () => {
  it.each([`${RATE}?currency=USD`, `${CONVERT}?amount=100&from=USD&to=KES`, RATE])("%s without payment -> 402 for $0.003 with GET Bazaar metadata", async (url) => {
    const { appFetch, facilitator } = await buildTestApp();
    const res = await appFetch(url);
    expect(res.status).toBe(402);
    const challenge = decodeHeader(res.headers.get("payment-required"));
    expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "3000", payTo: TEST_PAY_TO });
    expect(challenge.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(challenge.resource.description.length).toBeLessThanOrEqual(500);
    expect(challenge.resource.description).toMatch(/Central Bank of Kenya/);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("GET routes advertise a canonical resource URL without the buyer's query when the origin is known", async () => {
    const { paidRoutes } = await import("../src/products.js");
    const { testConfig } = await import("./helpers.js");
    const routes = paidRoutes({ ...testConfig, publicOrigin: "https://example.test" });
    expect(routes["GET /v1/fx/kes"]!.resource).toBe("https://example.test/v1/fx/kes");
    expect(routes["POST /v1/parse/etims-invoice"]!.resource).toBeUndefined();
  });

  it("GET /fx/status is free and never calls CBK", async () => {
    const tail = vi.fn(async () => []);
    const { appFetch } = await buildTestApp(undefined, testRateStore(tail));
    const res = await appFetch("/fx/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ snapshot_last_date: "2026-10-09", last_live_refresh: "none_yet" });
    expect(tail).not.toHaveBeenCalled();
  });

  it("HEAD cannot run a paid lookup unpaid", async () => {
    const tail = vi.fn(async () => []);
    const { appFetch } = await buildTestApp(undefined, testRateStore(tail));
    expect((await appFetch(`${RATE}?currency=USD`, { method: "HEAD" })).status).toBe(405);
    expect(tail).not.toHaveBeenCalled();
  });

  it("POST to an FX path is not a paid route", async () => {
    const { appFetch } = await buildTestApp();
    expect((await appFetch(RATE, { method: "POST" })).status).toBe(404);
  });
});

describe("paid rate lookups", () => {
  it("a Sunday returns Friday's rate with a fallback flag and settles 3000 once", async () => {
    const { res, body, facilitator } = await paid(`${RATE}?currency=usd&date=2026-10-11`);
    expect(res.status).toBe(200);
    expect(body.rates).toHaveLength(1);
    expect(body.rates[0]).toMatchObject({ currency: "USD", rate_date: "2026-10-09", is_fallback: true, mean: 129.79, buy: null, sell: null, quote: "KES per 1 USD" });
    expect(body.rates[0].fallback_reason).toMatch(/Sunday/);
    expect(body.freshness.live_check).toBe("not_needed");
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.settleCalls[0]).toMatchObject({ amount: "3000" });
  });

  it("an exact business day is not a fallback; legacy dates carry buy and sell", async () => {
    const { body } = await paid(`${RATE}?currency=USD&date=2023-12-29`);
    expect(body.rates[0]).toMatchObject({ rate_date: "2023-12-29", is_fallback: false, fallback_reason: null, mean: 156.3, buy: 156.1, sell: 156.5 });
  });

  it("normalises JPY (per 100) and the inverted EAC quotes to KES per unit", async () => {
    const { body } = await paid(`${RATE}?currency=JPY,UGX&date=2026-10-09`);
    const [jpy, ugx] = body.rates;
    expect(jpy).toMatchObject({ quote: "KES per 100 JPY", mean: 81.95, kes_per_unit: 0.8195 });
    expect(ugx).toMatchObject({ quote: "UGX per 1 KES", mean: 31.82 });
    expect(ugx.kes_per_unit).toBeCloseTo(1 / 31.82, 9);
  });

  it("no currency returns all 21", async () => {
    const { body } = await paid(`${RATE}?date=2026-10-09`);
    expect(body.rates).toHaveLength(21);
  });

  it("a withheld CBK value says so in the fallback reason", async () => {
    const { body } = await paid(`${RATE}?currency=USD&date=2026-10-08`);
    expect(body.rates[0]).toMatchObject({ rate_date: "2026-10-07", is_fallback: true, mean: 129.77 });
    expect(body.rates[0].fallback_reason).toMatch(/plausibility/);
  });
});

describe("paid conversions", () => {
  it("USD -> KES uses the mean", async () => {
    const { body } = await paid(`${CONVERT}?amount=100&from=USD&to=KES&date=2026-10-09`);
    expect(body).toMatchObject({ result: 12979, is_fallback: false });
    expect(body.legs.to).toMatchObject({ currency: "KES", kes_per_unit: 1 });
  });

  it("cross rate via KES and a weekend flag", async () => {
    const { body } = await paid(`${CONVERT}?amount=1000&from=UGX&to=JPY&date=2026-10-10`);
    expect(body.is_fallback).toBe(true);
    expect(body.result).toBeCloseTo((1000 * (1 / 31.82)) / 0.8195, 6);
  });
});

describe("bad input is refused and never settled", () => {
  it.each([
    [`${RATE}?currency=XYZ`, 400],
    [`${RATE}?currency=${"USD,".repeat(40)}`, 400],
    [`${RATE}?date=2026-02-30`, 400],
    [`${RATE}?date=12/10/2026`, 400],
    [`${RATE}?curency=USD`, 400],
    [`${RATE}?date=2026-10-13`, 422], // tomorrow in Nairobi
    [`${RATE}?date=2001-01-01`, 422], // before coverage
    [`${CONVERT}?amount=1e5&from=USD&to=KES`, 400],
    [`${CONVERT}?amount=-5&from=USD&to=KES`, 400],
    [`${CONVERT}?amount=0&from=USD&to=KES`, 400],
    [`${CONVERT}?amount=99999999999999&from=USD&to=KES`, 400],
    [`${CONVERT}?amount=10&from=USD`, 400],
    [`${CONVERT}?amount=10&from=BTC&to=KES`, 400],
  ])("%s -> %i", async (url, status) => {
    const { res, body, facilitator } = await paid(url);
    expect(res.status).toBe(status);
    expect(body.error.code).toBeTruthy();
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

describe("live refresh (cache path)", () => {
  const today: CbkRate = { date: "2026-10-12", currency: "USD", mean: 129.9 };

  it("fetches the tail once, then serves it from cache; concurrent callers share one fetch", async () => {
    const tail = vi.fn(async () => [today]);
    const store = testRateStore(tail);
    const [a, b] = await Promise.all([paid(`${RATE}?currency=USD`, store), paid(`${RATE}?currency=USD`, store)]);
    expect(a.body.rates[0]).toMatchObject({ rate_date: "2026-10-12", is_fallback: false, mean: 129.9 });
    expect(b.body.rates[0].mean).toBe(129.9);
    const c = await paid(`${RATE}?currency=USD`, store);
    expect(c.body.freshness.live_check).toBe("cached");
    expect(tail).toHaveBeenCalledTimes(1);
    expect(tail).toHaveBeenCalledWith("2026-10-10", "2026-10-12");
  });

  it("historical dates never touch CBK", async () => {
    const tail = vi.fn(async () => [today]);
    await paid(`${RATE}?currency=USD&date=2026-10-09`, testRateStore(tail));
    expect(tail).not.toHaveBeenCalled();
  });

  it("a failed refresh falls back to the last rate, flags it, and backs off", async () => {
    const tail = vi.fn(async () => {
      throw new CbkUnavailableError("TimeoutError");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = testRateStore(tail);
    const first = await paid(`${RATE}?currency=USD`, store);
    expect(first.res.status).toBe(200);
    expect(first.body.rates[0]).toMatchObject({ rate_date: "2026-10-09", is_fallback: true });
    expect(first.body.rates[0].fallback_reason).toMatch(/not published yet/);
    expect(first.body.freshness.live_check).toBe("failed");
    await paid(`${RATE}?currency=USD`, store);
    expect(tail).toHaveBeenCalledTimes(1);
  });

  it("ignores tail rows that are in the future, overwrite the snapshot, or are implausible", async () => {
    const store = testRateStore(async () => [
      { date: "2026-10-13", currency: "USD", mean: 129.9 },
      { date: "2026-10-09", currency: "USD", mean: 1 },
      { date: "2026-10-12", currency: "EUR", mean: 1000 },
    ]);
    const { body } = await paid(`${RATE}?currency=USD,EUR`, store);
    expect(body.rates[0]).toMatchObject({ rate_date: "2026-10-09", mean: 129.79 });
    expect(body.rates[1]).toMatchObject({ rate_date: "2026-10-09", is_fallback: true });
    expect(body.rates[1].fallback_reason).toMatch(/plausibility/);
  });

  it("too stale and CBK down -> 503, not settled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const later = new Date(FX_NOW.getTime() + 20 * 86_400_000);
    const store = testRateStore(async () => Promise.reject(new Error("down")), { now: () => later });
    const { res, body, facilitator } = await paid(`${RATE}?currency=USD`, store);
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("rates_unavailable");
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

describe("CBK source parsing", () => {
  it("maps labels, rejects junk", () => {
    expect(parseRow(["15/10/2026", "US DOLLAR", "129.8100"])).toEqual({ date: "2026-10-15", currency: "USD", mean: 129.81 });
    expect(parseRow(["02/01/2024", "KES/USHS", "24.1", "24.0", "24.2"])).toMatchObject({ currency: "UGX", buy: 24, sell: 24.2 });
    expect(parseRow(["01/01/1970", "US DOLLAR", "1"])).toBeUndefined();
    expect(parseRow(["31/02/2024", "US DOLLAR", "1"])).toBeUndefined();
    expect(parseRow(["15/10/2026", "BITCOIN", "1"])).toBeUndefined();
    expect(parseRow(["15/10/2026", "US DOLLAR", "-1"])).toBeUndefined();
    expect(parseRow(["15/10/2026", "US DOLLAR", "<script>"])).toBeUndefined();
  });

  it("always calls CBK's fixed endpoint and fails closed on bad responses", async () => {
    const urls: string[] = [];
    const respond = (body: string, status = 200) => async (url: string) => {
      urls.push(url);
      return new Response(body, { status });
    };
    const q = { tableId: 193, from: "2026-10-01", to: "2026-10-12", maxRows: 10, timeoutMs: 1000, maxBytes: 200 };
    await expect(fetchCbkRates(q, respond("nope"))).rejects.toBeInstanceOf(CbkUnavailableError);
    await expect(fetchCbkRates(q, respond("{}", 500))).rejects.toBeInstanceOf(CbkUnavailableError);
    await expect(fetchCbkRates(q, respond("x".repeat(500)))).rejects.toThrow(/too large/);
    const ok = await fetchCbkRates(q, respond(JSON.stringify({ recordsFiltered: "2", data: [["12/10/2026", "EURO", "145.1"], ["bad"]] })));
    expect(ok).toMatchObject({ rates: [{ date: "2026-10-12", currency: "EUR", mean: 145.1 }], skipped: 1, recordsFiltered: 2 });
    expect(new Set(urls.map((u) => new URL(u).origin))).toEqual(new Set(["https://www.centralbank.go.ke"]));
  });
});

describe("data cleaning", () => {
  it("withholds a one-day spike but keeps a real level shift", () => {
    const series = (vals: number[]) => vals.map((mean, i): CbkRate => ({ date: `2015-01-${String(i + 1).padStart(2, "0")}`, currency: "CHF", mean }));
    const spike = withholdOutliers(series([90, 90, 90, 150, 90, 90, 90]));
    expect(spike.withheld.map((w) => w.mean)).toEqual([150]);
    const shift = withholdOutliers(series([90, 90, 90, 115, 116, 115, 116, 115]));
    expect(shift.withheld).toHaveLength(0);
  });
});

describe("bundled snapshot", () => {
  it.runIf(existsSync("data/cbk-kes-rates.json"))("loads, covers 21 currencies from 2004-11-02, and matches CBK's published 15 Oct 2026 USD mean", () => {
    const snap = loadSnapshot();
    expect(snap.currencies).toHaveLength(21);
    expect(snap.first_date).toBe("2004-11-02");
    expect(snap.last_date >= "2026-10-15").toBe(true);
    const store = new RateStore(snap, undefined);
    const hit = store.lookup("USD", "2026-10-15", 10);
    expect(hit.found && hit.rate.mean).toBe(129.81);
    const rates = [...snapshotRates(snap)];
    expect(rates.length).toBeGreaterThan(100_000);
    expect(rates.every((r) => r.mean > 0 && Number.isFinite(r.mean))).toBe(true);
  });
});
