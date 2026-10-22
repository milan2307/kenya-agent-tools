/**
 * The LAX registry offer (https://lax.kognai.ai/aiax/sections/lax_offer.json), built from products.ts
 * so prices and schemas can never drift from what the paywall charges.
 */
import { ALL_PAID, type PaidRoute } from "../products.js";
import { AGENT_PROFILE, FIVE_LAWS, didWebFor } from "./agent-profile.js";

/** "$0.10" -> "0.10" (LAX wants a bare decimal string in USDC). */
export const usdcAmount = (price: PaidRoute["price"]): string => price.slice(1);

export function laxCapability(p: PaidRoute) {
  return {
    skill_id: p.skillId,
    description: `${p.method} ${p.path}: ${p.summary}`,
    pricing: { model: "per_call", amount: usdcAmount(p.price), currency: "USDC", rail: "x402" },
    input_schema: p.inputSchema,
    output_schema: p.outputSchema,
  };
}

export function laxOffer(origin: string) {
  return {
    lax_version: "1.0",
    name: AGENT_PROFILE.name,
    description: AGENT_PROFILE.description,
    category: AGENT_PROFILE.category,
    agent_did: didWebFor(origin),
    endpoint: `${origin}/`,
    capabilities: ALL_PAID.map(laxCapability),
    constitutional_constraints: [...FIVE_LAWS],
    payment_rails: ["x402", "usdc-base"],
  };
}
