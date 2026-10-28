/**
 * Optional second payment rail: x402 `exact` scheme on Sui (scheme_exact_sui.md), for the FX routes only.
 *
 * Why a wrapper and not an @x402/core scheme: the official SDK ships no Sui package, and the Base
 * path (CDP facilitator, Bazaar) must stay byte-for-byte unchanged. So this middleware:
 *  - adds a Sui option to the `accepts` list of every 402 the Base middleware returns for an FX route;
 *  - takes over only when the buyer's PAYMENT-SIGNATURE says `accepted.network` is `sui:*`.
 *
 * Non-custodial: the buyer sends a complete transaction they signed that pays `payTo` directly.
 * The facilitator can only simulate it (/verify) or broadcast it unchanged (/settle). We hold no Sui key.
 * Flow: check the buyer agreed to OUR terms -> /verify -> run the handler -> /settle only if status < 400
 * (errors are never charged, same rule as the Base rail) -> PAYMENT-RESPONSE header.
 *
 * This file never reads process.env; config.ts does.
 */
import type { MiddlewareHandler } from "hono";

export const SUI_NETWORKS = { mainnet: "sui:mainnet", testnet: "sui:testnet" } as const;
export type SuiNetwork = (typeof SUI_NETWORKS)[keyof typeof SUI_NETWORKS];

/** Circle USDC coin types (6 decimals). Mainnet: https://developers.circle.com/stablecoins/usdc-contract-addresses */
export const SUI_USDC: Record<SuiNetwork, string> = {
  "sui:mainnet": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "sui:testnet": "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
};
export const SUI_NATIVE = "0x2::sui::SUI";

export type SuiPaymentConfig = {
  network: SuiNetwork;
  /** Seller's public Sui address (receive only). */
  payTo: string;
  facilitatorUrl: string;
  /** Coin type. USDC by default; SUI is allowed on testnet only (for faucet-funded end-to-end tests). */
  asset: string;
  /** Required when asset is not USDC: fixed atomic amount per call (testnet SUI tests). */
  fixedAmount?: string;
};

export type SuiRequirements = {
  scheme: "exact";
  network: SuiNetwork;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

export type SuiVerifyResponse = { isValid: boolean; invalidReason?: string; payer?: string };
export type SuiSettleResponse = { success: boolean; errorReason?: string; payer?: string; transaction: string; network: string; amount?: string };

export interface SuiFacilitator {
  verify(body: unknown): Promise<SuiVerifyResponse>;
  settle(body: unknown): Promise<SuiSettleResponse>;
}

export const SUI_ADDRESS = /^0x[0-9a-f]{64}$/;
const normalizeAddress = (a: string) => a.toLowerCase();
const normalizeCoin = (t: string) => {
  const [addr, ...rest] = t.split("::");
  if (!addr || rest.length !== 2 || !/^0x[0-9a-fA-F]{1,64}$/.test(addr)) return t;
  return `0x${addr.slice(2).toLowerCase().padStart(64, "0")}::${rest.join("::")}`;
};

/** "$0.003" -> "3000" (USDC atomic, 6 decimals). Exact decimal arithmetic, no floats. */
export function usdToUsdcAtomic(price: string): string {
  const m = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!m) throw new Error(`unsupported price format: ${price}`);
  const atomic = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (atomic <= 0n) throw new Error("price must be positive");
  return atomic.toString();
}

export function suiRequirements(cfg: SuiPaymentConfig, price: `$${string}`): SuiRequirements {
  const isUsdc = normalizeCoin(cfg.asset) === normalizeCoin(SUI_USDC[cfg.network]);
  return {
    scheme: "exact",
    network: cfg.network,
    amount: isUsdc ? usdToUsdcAtomic(price) : cfg.fixedAmount!,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 300,
    extra: isUsdc ? { name: "USDC", decimals: 6 } : {},
  };
}

/** HTTP client for any facilitator implementing POST /verify and /settle (e.g. sui-x402-facilitator). */
export class HttpSuiFacilitator implements SuiFacilitator {
  /** 6 s per call: Vercel maxDuration is 15 s, and verify + handler + settle must fit. */
  constructor(private readonly url: string, private readonly timeoutMs = 6_000) {}
  verify(body: unknown) { return this.post<SuiVerifyResponse>("/verify", body); }
  settle(body: unknown) { return this.post<SuiSettleResponse>("/settle", body); }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status >= 500) throw new Error(`facilitator ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

const b64encode = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
function b64decode(v: string): any {
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); } catch { return undefined; }
}

export type SuiPricedRoute = { method: string; path: string; price: `$${string}`; description: string };

/**
 * Wraps the Base x402 middleware. Routes not in `routes` pass straight to it.
 */
export function withSuiPayments(
  base: MiddlewareHandler,
  cfg: SuiPaymentConfig,
  routes: SuiPricedRoute[],
  facilitator: SuiFacilitator = new HttpSuiFacilitator(cfg.facilitatorUrl),
): MiddlewareHandler {
  const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));

  return async (c, next) => {
    const route = byKey.get(`${c.req.method} ${c.req.path}`);
    if (!route) return base(c, next);
    const reqs = suiRequirements(cfg, route.price);
    const header = c.req.header("payment-signature") ?? c.req.header("x-payment");
    const payload = header ? b64decode(header) : undefined;
    const isSui = typeof payload?.accepted?.network === "string" && payload.accepted.network.startsWith("sui:");

    if (!isSui) {
      // Base path untouched; we only append the Sui option to its 402 challenge.
      const out = await base(c, next);
      const res = (out as Response | undefined) ?? c.res;
      if (res.status === 402) return addSuiOption(res, reqs, c);
      return out;
    }

    const challenge = (error: string) => {
      const body = { x402Version: 2, error, resource: { url: c.req.url, description: route.description, mimeType: "application/json" }, accepts: [reqs] };
      return c.json(body, 402, { "PAYMENT-REQUIRED": b64encode(body) });
    };

    // The buyer must have agreed to exactly our terms. Never trust the client's amount/payTo.
    const a = payload.accepted;
    const agreed =
      a.scheme === reqs.scheme && a.network === reqs.network && String(a.amount) === reqs.amount &&
      typeof a.asset === "string" && normalizeCoin(a.asset) === normalizeCoin(reqs.asset) &&
      typeof a.payTo === "string" && normalizeAddress(a.payTo) === normalizeAddress(reqs.payTo);
    if (payload.x402Version !== 2 || !agreed) return challenge("payment terms do not match this route");
    const tx = payload.payload?.transaction, sig = payload.payload?.signature;
    if (typeof tx !== "string" || typeof sig !== "string" || !tx || !sig || tx.length > 120_000) return challenge("invalid Sui payment payload");

    const body = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, resource: payload.resource, accepted: reqs, payload: { transaction: tx, signature: sig } },
      paymentRequirements: reqs,
    };

    let verified: SuiVerifyResponse;
    try { verified = await facilitator.verify(body); } catch { return c.json({ error: { code: "facilitator_unavailable", message: "Sui facilitator unreachable" } }, 503); }
    if (!verified?.isValid) return challenge(verified?.invalidReason ?? "payment invalid");

    await next();
    if (c.res.status >= 400) return; // errors are free: never settled

    let settled: SuiSettleResponse;
    try { settled = await facilitator.settle(body); } catch { settled = { success: false, errorReason: "facilitator_unavailable", transaction: "", network: reqs.network }; }
    if (!settled?.success) {
      c.res = undefined as unknown as Response; // drop the paid content
      c.res = challenge(settled?.errorReason ?? "settlement failed");
      return;
    }
    c.res.headers.set("PAYMENT-RESPONSE", b64encode(settled));
  };
}

async function addSuiOption(res: Response, reqs: SuiRequirements, c: { res: Response }): Promise<Response> {
  const header = res.headers.get("payment-required");
  const decoded = header ? b64decode(header) : undefined;
  if (!decoded || !Array.isArray(decoded.accepts)) return res;
  decoded.accepts.push(reqs);
  const headers = new Headers(res.headers);
  headers.set("payment-required", b64encode(decoded));
  let bodyText = await res.text();
  const parsed = (() => { try { return JSON.parse(bodyText); } catch { return undefined; } })();
  if (parsed && Array.isArray(parsed.accepts)) { parsed.accepts.push(reqs); bodyText = JSON.stringify(parsed); }
  const out = new Response(bodyText, { status: 402, headers });
  c.res = out;
  return out;
}
