import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/http-app.js";
import { NETWORKS, type AppConfig } from "../src/config.js";
import { createPaymentMiddleware } from "../src/payments/x402.js";
import { phoneBatchPrice as batchPrice } from "../src/products.js";
import { testRateStore } from "./helpers.js";

const PAY_TO = "0x000000000000000000000000000000000000dEaD" as const;
const config: AppConfig = { facilitator: "public-testnet", network: NETWORKS.baseSepolia, payTo: PAY_TO, port: 0 };

class StubFacilitator implements FacilitatorClient {
  verifyCalls: PaymentRequirements[] = [];
  settleCalls: PaymentRequirements[] = [];
  async verify(payload: PaymentPayload, req: PaymentRequirements) {
    this.verifyCalls.push(req);
    return { isValid: true, payer: (payload.payload as any).authorization?.from };
  }
  async settle(_p: PaymentPayload, req: PaymentRequirements) {
    this.settleCalls.push(req);
    return { success: true, transaction: "0x" + "ab".repeat(32), network: req.network };
  }
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORKS.baseSepolia }], extensions: ["bazaar"], signers: {} };
  }
}

async function build() {
  const facilitator = new StubFacilitator();
  const app = createApp(config, await createPaymentMiddleware(config, facilitator), { rateStore: () => testRateStore() });
  const appFetch = ((input: any, init?: RequestInit) => app.fetch(input instanceof Request ? input : new Request(new URL(String(input), "http://t.local"), init))) as typeof fetch;
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) }); // throwaway, never funded
  return { facilitator, appFetch, pay: wrapFetchWithPayment(appFetch, client) };
}
const dec = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString());
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const SINGLE = "http://t.local/v1/phone/normalise?number=0712%20345%20678";
const BATCH = "http://t.local/v1/phone/normalise/batch";

describe("pricing", () => {
  it.each([[1, "$0.002000"], [2, "$0.004000"], [37, "$0.074000"], [100, "$0.200000"], [101, "$0.200000"], [0, "$0.002000"], [-3, "$0.002000"], [1.5, "$0.002000"]])("%s numbers -> %s", (count, price) => {
    expect(batchPrice(count)).toBe(price);
  });
});

describe("catalogue", () => {
  it("lists the phone routes, plan sources and caveats", async () => {
    const { appFetch } = await build();
    const body = await (await appFetch("/")).json();
    expect(body.phone_sources.map((s: any) => s.url).join(" ")).toMatch(/ca\.go\.ke.*itu\.int.*tcra\.go\.tz/);
    expect(body.phone_caveats.join(" ")).toMatch(/not a live registry/);
  });
});

describe("402 challenges", () => {
  it("single: $0.002 = 2000 atomic USDC to payTo, with Bazaar metadata", async () => {
    const { appFetch, facilitator } = await build();
    const res = await appFetch(SINGLE);
    expect(res.status).toBe(402);
    const ch = dec(res.headers.get("payment-required"));
    expect(ch.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "2000", payTo: PAY_TO });
    expect(ch.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(ch.resource.description.length).toBeLessThanOrEqual(500);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });
  it.each([[["0712345678"], "2000"], [["0712345678", "247247", "+256772123456"], "6000"], [Array(100).fill("0712345678"), "200000"]])("batch of %# priced per number", async (numbers, amount) => {
    const { appFetch } = await build();
    const res = await appFetch(BATCH, post({ numbers }));
    expect(res.status).toBe(402);
    expect(dec(res.headers.get("payment-required")).accepts[0].amount).toBe(amount);
  });
  it("batch with an unreadable body is priced as one number (and later refused 400)", async () => {
    const { appFetch } = await build();
    expect(dec((await appFetch(BATCH, post("not json"))).headers.get("payment-required")).accepts[0].amount).toBe("2000");
  });
  it("HEAD on a paid route is refused, not served free", async () => {
    const { appFetch } = await build();
    expect((await appFetch(SINGLE, { method: "HEAD" })).status).toBe(405);
  });
});

describe("paid calls", () => {
  it("single: pays, answers, settles once", async () => {
    const { pay, facilitator } = await build();
    const res = await pay(SINGLE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, e164: "+254712345678", network: "Safaricom", type: "mobile" });
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.settleCalls[0]).toMatchObject({ amount: "2000", payTo: PAY_TO });
    expect(dec(res.headers.get("payment-response"))).toMatchObject({ success: true });
  });
  it("single with country and kind", async () => {
    const { pay } = await build();
    expect(await (await pay("http://t.local/v1/phone/normalise?number=0754123456&country=tz")).json()).toMatchObject({ country: "TZ", network: "Vodacom" });
    expect(await (await pay("http://t.local/v1/phone/normalise?number=522522&kind=paybill")).json()).toMatchObject({ type: "paybill", check: "format_only" });
  });
  it("an invalid number is a successful (charged) answer", async () => {
    const { pay, facilitator } = await build();
    const res = await pay("http://t.local/v1/phone/normalise?number=0767123456");
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(false);
    expect(facilitator.settleCalls).toHaveLength(1);
  });
  it.each([
    ["missing number", "http://t.local/v1/phone/normalise"],
    ["bad country", "http://t.local/v1/phone/normalise?number=0712345678&country=RW"],
    ["bad kind", "http://t.local/v1/phone/normalise?number=0712345678&kind=bank"],
    ["unknown param", "http://t.local/v1/phone/normalise?number=0712345678&x=1"],
  ])("%s -> 400 and not settled", async (_n, url) => {
    const { pay, facilitator } = await build();
    expect((await pay(url)).status).toBe(400);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
  it("batch: pays the exact per-number price and returns results in order", async () => {
    const { pay, facilitator } = await build();
    const res = await pay(BATCH, post({ numbers: ["0712345678", "+256 772 123456", "255754123456", "247247", "rubbish"], country: "KE" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ count: 5, valid_count: 4 });
    expect(body.results.map((r: any) => r.network)).toEqual(["Safaricom", "MTN", "Vodacom", "Safaricom M-PESA", null]);
    expect(facilitator.settleCalls[0]!.amount).toBe("10000");
  });
  it.each([
    ["empty list", { numbers: [] }],
    ["101 numbers", { numbers: Array(101).fill("0712345678") }],
    ["not an array", { numbers: "0712345678" }],
    ["extra field", { numbers: ["0712345678"], foo: 1 }],
    ["number too long", { numbers: ["1".repeat(41)] }],
  ])("batch %s -> 400, not settled", async (_n, body) => {
    const { pay, facilitator } = await build();
    expect((await pay(BATCH, post(body))).status).toBe(400);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
  it("batch numbers over 40 chars are refused 400 and not settled", async () => {
    const { pay, facilitator } = await build();
    expect((await pay(BATCH, post({ numbers: ["x".repeat(20_000)] }))).status).toBe(400);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
  it("garbage payment header is refused without settling", async () => {
    const { appFetch, facilitator } = await build();
    const res = await appFetch(SINGLE, { headers: { "payment-signature": "bm9wZQ==" } });
    expect(res.status).toBe(402);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

