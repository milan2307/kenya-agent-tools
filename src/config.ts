/**
 * Runtime configuration, read once from environment variables.
 * This is the only file that touches process.env.
 */
import { z } from "zod";
import { SUI_ADDRESS, SUI_NATIVE, SUI_NETWORKS, SUI_USDC, type SuiPaymentConfig } from "./payments/sui.js";

export const NETWORKS = {
  baseMainnet: "eip155:8453",
  baseSepolia: "eip155:84532",
} as const;

/** Public x402.org facilitator: Base Sepolia only, no API key. Used for local/testnet runs. */
export const PUBLIC_TESTNET_FACILITATOR_URL = "https://x402.org/facilitator";

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex EVM address");

const envSchema = z.object({
  /** "cdp" = CDP facilitator (needed for Bazaar listing). "public-testnet" = x402.org, Base Sepolia only. */
  X402_FACILITATOR: z.enum(["cdp", "public-testnet"]).default("public-testnet"),
  X402_NETWORK: z.enum([NETWORKS.baseMainnet, NETWORKS.baseSepolia]).default(NETWORKS.baseSepolia),
  /** Public receive address only. Never a private key. */
  X402_PAY_TO: evmAddress,
  CDP_API_KEY_ID: z.string().min(1).optional(),
  CDP_API_KEY_SECRET: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(8402),
  /** Set by Vercel. Production must never fall back to the testnet defaults. */
  VERCEL_ENV: z.string().optional(),
  /** Set by Vercel, e.g. "mpesa-kra-parser.vercel.app". Gives GET routes a canonical, query-free resource URL. */
  VERCEL_PROJECT_PRODUCTION_URL: z.string().regex(/^[a-z0-9.-]+$/).optional(),
  /** Optional Sui rail for the FX routes. Unset = Sui off. Public receive address only, never a key. */
  SUI_X402_PAY_TO: z.string().trim().toLowerCase().regex(SUI_ADDRESS, "must be a 0x-prefixed 64-hex Sui address").optional(),
  SUI_X402_NETWORK: z.enum([SUI_NETWORKS.mainnet, SUI_NETWORKS.testnet]).default(SUI_NETWORKS.testnet),
  SUI_X402_FACILITATOR_URL: z.string().url().startsWith("https://").default("https://sui-facilitator.onrender.com"),
  /** Coin type; defaults to Circle USDC on the chosen network. 0x2::sui::SUI is testnet-only. */
  SUI_X402_ASSET: z.string().optional(),
  /** Atomic amount per call, required only for a non-USDC (testnet SUI) asset. */
  SUI_X402_FIXED_AMOUNT: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
});

export type AppConfig = {
  facilitator: "cdp" | "public-testnet";
  network: (typeof NETWORKS)[keyof typeof NETWORKS];
  payTo: `0x${string}`;
  port: number;
  /** https origin used as the canonical resource URL, when known. */
  publicOrigin?: string;
  /** Present only when SUI_X402_PAY_TO is set. */
  sui?: SuiPaymentConfig;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;

  if (e.X402_FACILITATOR === "public-testnet" && e.X402_NETWORK !== NETWORKS.baseSepolia) {
    throw new Error("The public x402.org facilitator only settles on Base Sepolia; use X402_FACILITATOR=cdp for Base mainnet.");
  }
  if (e.VERCEL_ENV === "production" && (e.X402_FACILITATOR !== "cdp" || e.X402_NETWORK !== NETWORKS.baseMainnet)) {
    throw new Error("Vercel production must run X402_FACILITATOR=cdp on X402_NETWORK=eip155:8453 (Base mainnet).");
  }
  if (e.X402_FACILITATOR === "cdp" && !(e.CDP_API_KEY_ID && e.CDP_API_KEY_SECRET)) {
    throw new Error("X402_FACILITATOR=cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET.");
  }

  let sui: SuiPaymentConfig | undefined;
  if (e.SUI_X402_PAY_TO) {
    const asset = e.SUI_X402_ASSET ?? SUI_USDC[e.SUI_X402_NETWORK];
    const isUsdc = asset === SUI_USDC[e.SUI_X402_NETWORK];
    if (!isUsdc && !(asset === SUI_NATIVE && e.SUI_X402_NETWORK === SUI_NETWORKS.testnet)) {
      throw new Error("SUI_X402_ASSET must be Circle USDC for the network (0x2::sui::SUI is allowed on sui:testnet only).");
    }
    if (!isUsdc && !e.SUI_X402_FIXED_AMOUNT) throw new Error("SUI_X402_FIXED_AMOUNT is required when SUI_X402_ASSET is not USDC.");
    if (e.VERCEL_ENV === "production" && (e.SUI_X402_NETWORK !== SUI_NETWORKS.mainnet || !isUsdc)) {
      throw new Error("Vercel production may only offer Sui as USDC on sui:mainnet.");
    }
    sui = { network: e.SUI_X402_NETWORK, payTo: e.SUI_X402_PAY_TO, facilitatorUrl: e.SUI_X402_FACILITATOR_URL, asset, ...(isUsdc ? {} : { fixedAmount: e.SUI_X402_FIXED_AMOUNT }) };
  }

  return {
    sui,
    facilitator: e.X402_FACILITATOR,
    network: e.X402_NETWORK,
    payTo: e.X402_PAY_TO as `0x${string}`,
    port: e.PORT,
    publicOrigin: e.VERCEL_PROJECT_PRODUCTION_URL ? `https://${e.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
  };
}
