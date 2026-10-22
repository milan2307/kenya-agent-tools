/** AIAX v0.1 Tier 0 manifest (/.well-known/aiax.json) and Tier 1 sections (/aiax/sections/<skill>.json). */
import { ALL_PAID } from "../products.js";
import { AGENT_PROFILE } from "./agent-profile.js";
import { laxCapability } from "./lax-offer.js";

export const AIAX_UPDATED_AT = "2026-10-22T00:00:00Z";

export function aiaxManifest() {
  return {
    aiax_version: "0.1",
    product: { name: AGENT_PROFILE.name, one_line_purpose: "Kenyan finance data for agents: M-PESA and KRA eTIMS parsing, CBK KES rates.", domain: "finance-data" },
    entry_points: ALL_PAID.map((p) => ({ id: p.skillId, url: `/aiax/sections/${p.skillId}.json`, purpose: p.summary, est_tokens: 400 })),
    pricing_summary: `Per call in USDC on Base over x402: ${ALL_PAID.map((p) => `${p.skillId} ${p.price.slice(1)}`).join(", ")}. Failed calls are free.`,
    trust_signals: { pact_endpoint: null },
    mcp_endpoint: null,
    updated_at: AIAX_UPDATED_AT,
    extensions: { "x-lax-offer": "/.well-known/lax-offer.json", "x-did": "/.well-known/did.json" },
  };
}

export function aiaxSection(skillId: string, origin: string) {
  const p = ALL_PAID.find((r) => r.skillId === skillId);
  if (!p) return undefined;
  const cap = laxCapability(p);
  return {
    aiax_version: "0.1",
    section_id: p.skillId,
    purpose: p.description,
    inputs: p.inputSchema,
    outputs: p.outputSchema,
    pricing: cap.pricing,
    examples: [{ description: `See ${origin}/ for the catalogue; unpaid calls answer 402 with x402 terms.`, request: { method: p.method, url: `${origin}${p.path}` }, response: { status: 402 } }],
    pact_mandate_template: null,
  };
}
