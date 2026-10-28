import { describe, expect, it } from "vitest";
import { createApp } from "../src/http-app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createPaymentMiddleware } from "../src/payments/x402.js";
import { SUI_NATIVE, SUI_USDC, suiRequirements, usdToUsdcAtomic, withSuiPayments, type SuiFacilitator } from "../src/payments/sui.js";
import { StubFacilitator, TEST_PAY_TO, decodeHeader, payingFetch, testConfig, testRateStore } from "./helpers.js";

const SUI_PAY_TO = "0x" + "c7".repeat(32);
const RATE = "http://test.local/v1/fx/kes?currency=USD&date=2026-10-09";
const CONVERT = "http://test.local/v1/fx/convert?amount=100&from=USD&to=KES&date=2026-10-09";
const INVOICE = "http://test.local/v1/parse/etims-invoice";

class StubSui implements SuiFacilitator {
  verifyBodies: any[] = [];
  settleBodies: any[] = [];
  verifyResult: any = { isValid: true, payer: "0x" + "11".repeat(32) };
  settleResult: any = { success: true, transaction: "SuiDigest111", network: "sui:testnet", payer: "0x" + "11".repeat(32), amount: "3000" };
  throwOnVerify = false;
  async verify(b: unknown) { if (this.throwOnVerify) throw new Error("down"); this.verifyBodies.push(b); return this.verifyResult; }
  async settle(b: unknown) { this.settleBodies.push(b); return this.settleResult; }
}

const suiConfig: AppConfig = {
  ...testConfig,
  sui: { network: "sui:testnet", payTo: SUI_PAY_TO, facilitatorUrl: "https://facilitator.invalid", asset: SUI_USDC["sui:testnet"] },
};

async function build(sui = new StubSui(), base = new StubFacilitator(), cfg = suiConfig) {
  const app = createApp(cfg, await createPaymentMiddleware(cfg, base, sui), { rateStore: () => testRateStore() });
  const appFetch = ((input: any, init?: RequestInit) => app.fetch(input instanceof Request ? input : new Request(new URL(String(input), "http://test.local"), init))) as typeof fetch;
  return { appFetch, sui, base };
}

const suiPayment = (overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = { transaction: "AAAA", signature: "BBBB" }) =>
  Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: RATE },
    accepted: { scheme: "exact", network: "sui:testnet", amount: "3000", asset: SUI_USDC["sui:testnet"], payTo: SUI_PAY_TO, maxTimeoutSeconds: 300, extra: {}, ...overrides },
    payload,
  })).toString("base64");

const withPay = (h: string): RequestInit => ({ headers: { "payment-signature": h } });

describe("Sui pricing helpers", () => {
  it.each([["$0.003", "3000"], ["$0.002", "2000"], ["$0.10", "100000"], ["$1", "1000000"], ["$0.000001", "1"]])("%s -> %s USDC atomic", (p, a) => {
    expect(usdToUsdcAtomic(p)).toBe(a);
  });
  it("rejects bad or zero prices", () => {
    expect(() => usdToUsdcAtomic("0.003")).toThrow();
    expect(() => usdToUsdcAtomic("$0")).toThrow();
    expect(() => usdToUsdcAtomic("$0.0000001")).toThrow();
  });
  it("uses the fixed amount for testnet SUI", () => {
    const r = suiRequirements({ network: "sui:testnet", payTo: SUI_PAY_TO, facilitatorUrl: "x", asset: SUI_NATIVE, fixedAmount: "3000000" }, "$0.003");
    expect(r).toMatchObject({ amount: "3000000", asset: SUI_NATIVE, extra: {} });
  });
});

describe("402 challenge advertises both rails on FX routes", () => {
  it.each([RATE, CONVERT])("%s lists Base USDC then Sui USDC", async (url) => {
    const { appFetch } = await build();
    const res = await appFetch(url);
    expect(res.status).toBe(402);
    const ch = decodeHeader(res.headers.get("payment-required"));
    expect(ch.accepts).toHaveLength(2);
    expect(ch.accepts[0]).toMatchObject({ network: "eip155:84532", payTo: TEST_PAY_TO, amount: "3000" });
    expect(ch.accepts[1]).toEqual({ scheme: "exact", network: "sui:testnet", amount: "3000", asset: SUI_USDC["sui:testnet"], payTo: SUI_PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", decimals: 6 } });
    expect(ch.extensions?.bazaar).toBeTruthy(); // Bazaar metadata untouched
  });

  it("document routes stay Base-only", async () => {
    const { appFetch } = await build();
    const res = await appFetch(INVOICE, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(decodeHeader(res.headers.get("payment-required")).accepts).toHaveLength(1);
  });

  it("with Sui off, nothing changes", async () => {
    const { appFetch } = await build(new StubSui(), new StubFacilitator(), testConfig);
    expect(decodeHeader((await appFetch(RATE)).headers.get("payment-required")).accepts).toHaveLength(1);
  });

  it("catalogue lists the Sui alternative only when enabled", async () => {
    const on = await (await (await build()).appFetch("/")).json();
    expect(on.payment_alternatives[0]).toMatchObject({ network: "sui:testnet", pay_to: SUI_PAY_TO });
    const off = await (await (await build(new StubSui(), new StubFacilitator(), testConfig)).appFetch("/")).json();
    expect(off.payment_alternatives).toBeUndefined();
  });
});

describe("paid Sui calls", () => {
  it("verify -> serve -> settle once, with PAYMENT-RESPONSE, enforcing OUR terms", async () => {
    const { appFetch, sui, base } = await build();
    const res = await appFetch(RATE, withPay(suiPayment()));
    expect(res.status).toBe(200);
    expect((await res.json()).rates[0].currency).toBe("USD");
    expect(sui.verifyBodies).toHaveLength(1);
    expect(sui.settleBodies).toHaveLength(1);
    const sent = sui.settleBodies[0];
    expect(sent.paymentRequirements).toMatchObject({ payTo: SUI_PAY_TO, amount: "3000", network: "sui:testnet" });
    expect(sent.paymentPayload.accepted).toEqual(sent.paymentRequirements);
    expect(sent.paymentPayload.payload).toEqual({ transaction: "AAAA", signature: "BBBB" });
    expect(decodeHeader(res.headers.get("payment-response"))).toMatchObject({ success: true, transaction: "SuiDigest111" });
    expect(base.verifyCalls).toHaveLength(0); // Base facilitator never consulted
  });

  it("accepts an uppercase payTo / short-form coin type that normalise to ours", async () => {
    const { appFetch } = await build();
    const asset = SUI_USDC["sui:testnet"].replace("0x", "0x").toUpperCase().replace("0X", "0x").replace("::USDC::USDC", "::usdc::USDC");
    expect((await appFetch(RATE, withPay(suiPayment({ payTo: SUI_PAY_TO.toUpperCase().replace("0X", "0x"), asset })))).status).toBe(200);
  });

  it.each([
    ["wrong payTo", { payTo: "0x" + "ee".repeat(32) }],
    ["underpaid amount", { amount: "2999" }],
    ["wrong asset", { asset: SUI_NATIVE }],
    ["wrong network", { network: "sui:mainnet" }],
    ["wrong scheme", { scheme: "upto" }],
  ])("%s -> 402, facilitator never called", async (_n, o) => {
    const { appFetch, sui } = await build();
    const res = await appFetch(RATE, withPay(suiPayment(o)));
    expect(res.status).toBe(402);
    expect(decodeHeader(res.headers.get("payment-required")).accepts[0].payTo).toBe(SUI_PAY_TO);
    expect(sui.verifyBodies).toHaveLength(0);
  });

  it("missing or oversized transaction -> 402", async () => {
    const { appFetch, sui } = await build();
    expect((await appFetch(RATE, withPay(suiPayment({}, { signature: "x" })))).status).toBe(402);
    expect((await appFetch(RATE, withPay(suiPayment({}, { transaction: "A".repeat(120_001), signature: "x" })))).status).toBe(402);
    expect(sui.verifyBodies).toHaveLength(0);
  });

  it("verify rejected -> 402 with reason, no data, no settle", async () => {
    const sui = new StubSui();
    sui.verifyResult = { isValid: false, invalidReason: "invalid_transaction_state" };
    const { appFetch } = await build(sui);
    const res = await appFetch(RATE, withPay(suiPayment()));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("invalid_transaction_state");
    expect(sui.settleBodies).toHaveLength(0);
  });

  it("handler error (bad currency) is never settled", async () => {
    const { appFetch, sui } = await build();
    const res = await appFetch("http://test.local/v1/fx/kes?currency=XXX", withPay(suiPayment()));
    expect(res.status).toBe(400);
    expect(sui.verifyBodies).toHaveLength(1);
    expect(sui.settleBodies).toHaveLength(0);
  });

  it("settle failure withholds the data and returns 402", async () => {
    const sui = new StubSui();
    sui.settleResult = { success: false, errorReason: "insufficient_funds", transaction: "", network: "sui:testnet" };
    const { appFetch } = await build(sui);
    const res = await appFetch(RATE, withPay(suiPayment()));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.rates).toBeUndefined();
    expect(body.error).toBe("insufficient_funds");
  });

  it("facilitator down -> 503, nothing served", async () => {
    const sui = new StubSui();
    sui.throwOnVerify = true;
    const { appFetch } = await build(sui);
    const res = await appFetch(RATE, withPay(suiPayment()));
    expect(res.status).toBe(503);
  });

  it("Base payments still work on FX routes with Sui on", async () => {
    const { appFetch, sui, base } = await build();
    const res = await payingFetch(appFetch)(RATE);
    expect(res.status).toBe(200);
    expect(base.settleCalls).toHaveLength(1);
    expect(sui.verifyBodies).toHaveLength(0);
  });

  it("an unrecognised network in the header falls through to the Base rail", async () => {
    const { appFetch, sui } = await build();
    const res = await appFetch(RATE, withPay(suiPayment({ network: "solana:x" })));
    expect(res.status).toBe(402);
    expect(sui.verifyBodies).toHaveLength(0);
  });
});

describe("Sui config", () => {
  const base = { X402_PAY_TO: "0x000000000000000000000000000000000000dEaD" };
  const prod = { ...base, VERCEL_ENV: "production", X402_FACILITATOR: "cdp", X402_NETWORK: "eip155:8453", CDP_API_KEY_ID: "i", CDP_API_KEY_SECRET: "s" };
  it("off by default", () => expect(loadConfig(base).sui).toBeUndefined());
  it("defaults to testnet USDC and lower-cases the address", () => {
    expect(loadConfig({ ...base, SUI_X402_PAY_TO: SUI_PAY_TO.toUpperCase().replace("0X", "0x") }).sui).toEqual({
      network: "sui:testnet", payTo: SUI_PAY_TO, facilitatorUrl: "https://sui-facilitator.onrender.com", asset: SUI_USDC["sui:testnet"],
    });
  });
  it("rejects an EVM-length or malformed Sui address", () => {
    expect(() => loadConfig({ ...base, SUI_X402_PAY_TO: "0x000000000000000000000000000000000000dEaD" })).toThrow(/SUI_X402_PAY_TO/);
  });
  it("SUI coin only on testnet and only with a fixed amount", () => {
    expect(() => loadConfig({ ...base, SUI_X402_PAY_TO: SUI_PAY_TO, SUI_X402_ASSET: SUI_NATIVE })).toThrow(/FIXED_AMOUNT/);
    expect(() => loadConfig({ ...base, SUI_X402_PAY_TO: SUI_PAY_TO, SUI_X402_ASSET: SUI_NATIVE, SUI_X402_NETWORK: "sui:mainnet", SUI_X402_FIXED_AMOUNT: "1" })).toThrow(/testnet only/);
    expect(() => loadConfig({ ...base, SUI_X402_PAY_TO: SUI_PAY_TO, SUI_X402_ASSET: "0xbad::x::Y" })).toThrow(/USDC/);
  });
  it("production refuses Sui testnet and accepts Sui mainnet USDC", () => {
    expect(() => loadConfig({ ...prod, SUI_X402_PAY_TO: SUI_PAY_TO })).toThrow(/sui:mainnet/);
    expect(loadConfig({ ...prod, SUI_X402_PAY_TO: SUI_PAY_TO, SUI_X402_NETWORK: "sui:mainnet" }).sui?.asset).toBe(SUI_USDC["sui:mainnet"]);
  });
  it("facilitator URL must be https", () => {
    expect(() => loadConfig({ ...base, SUI_X402_PAY_TO: SUI_PAY_TO, SUI_X402_FACILITATOR_URL: "http://x.example" })).toThrow();
  });
});

describe("withSuiPayments unit", () => {
  it("non-priced routes go straight to the base middleware", async () => {
    let called = 0;
    const mw = withSuiPayments(async (_c, next) => { called++; await next(); }, suiConfig.sui!, []);
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", mw);
    app.get("/x", (c) => c.text("ok"));
    expect((await app.request("/x")).status).toBe(200);
    expect(called).toBe(1);
  });
});
