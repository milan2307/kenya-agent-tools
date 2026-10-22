/** Test wiring: an in-process app, a recording stub facilitator, and an x402 paying client. */
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/http-app.js";
import type { CbkRate } from "../src/fx/cbk-source.js";
import { CURRENCY_CODES } from "../src/fx/currencies.js";
import { RateStore, type StoreOptions, type TailSource } from "../src/fx/rate-store.js";
import { buildSnapshot } from "../src/fx/snapshot.js";
import { NETWORKS, type AppConfig } from "../src/config.js";
import { createPaymentMiddleware } from "../src/payments/x402.js";

// Placeholder receive address for tests only (no funds ever move in tests).
export const TEST_PAY_TO = "0x000000000000000000000000000000000000dEaD" as const;

export const testConfig: AppConfig = {
  facilitator: "public-testnet",
  network: NETWORKS.baseSepolia,
  payTo: TEST_PAY_TO,
  port: 0,
};

export class StubFacilitator implements FacilitatorClient {
  verifyCalls: PaymentRequirements[] = [];
  settleCalls: PaymentRequirements[] = [];
  settleSucceeds = true;

  async verify(payload: PaymentPayload, req: PaymentRequirements) {
    this.verifyCalls.push(req);
    return { isValid: true, payer: (payload.payload as { authorization?: { from?: string } }).authorization?.from };
  }
  async settle(_payload: PaymentPayload, req: PaymentRequirements) {
    this.settleCalls.push(req);
    return this.settleSucceeds
      ? { success: true, transaction: "0x" + "ab".repeat(32), network: req.network }
      : { success: false, errorReason: "insufficient_funds", transaction: "", network: req.network };
  }
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORKS.baseSepolia }],
      extensions: ["bazaar"],
      signers: {},
    };
  }
}

/** Synthetic CBK history: Wed 7 - Fri 9 Oct 2026 (mean only; USD on the 8th withheld), plus one legacy day with buy/sell. */
export const FX_FIXTURE_RATES: CbkRate[] = ([
  { date: "2023-12-29", currency: "USD", mean: 156.3, buy: 156.1, sell: 156.5 },
  ...(["2026-10-07", "2026-10-08", "2026-10-09"] as const).flatMap((date, i) =>
    CURRENCY_CODES.map((currency, j): CbkRate => ({ date, currency, mean: currency === "USD" ? [129.77, 129.78, 129.79][i]! : currency === "JPY" ? 81.95 : currency === "UGX" ? 31.82 : 10 + j })),
  ),
] as CbkRate[]).filter((r) => !(r.date === "2026-10-08" && r.currency === "USD")); // withheld below

/** Monday 2026-10-12 09:00 EAT. */
export const FX_NOW = new Date("2026-10-12T06:00:00Z");

export function testRateStore(tail?: TailSource, opts: Partial<StoreOptions> = {}) {
  const snapshot = buildSnapshot(FX_FIXTURE_RATES, [{ date: "2026-10-08", currency: "USD", mean: 1.29, reason: "test" }], "test", FX_NOW);
  return new RateStore(snapshot, tail, { okTtlMs: 60_000, failTtlMs: 30_000, maxTailDays: 60, now: () => FX_NOW, ...opts });
}

export async function buildTestApp(facilitator = new StubFacilitator(), rateStore = testRateStore()) {
  const app = createApp(testConfig, await createPaymentMiddleware(testConfig, facilitator), { rateStore: () => rateStore });
  const appFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(input instanceof Request ? input : new Request(new URL(String(input), "http://test.local"), init));
  return { app, facilitator, appFetch: appFetch as typeof fetch };
}

/** A buyer with a throwaway, never-funded key generated per test run (not a real wallet). */
export function payingFetch(appFetch: typeof fetch) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  return wrapFetchWithPayment(appFetch, client);
}

export const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

export function decodeHeader<T = any>(value: string | null): T {
  if (!value) throw new Error("missing header");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
