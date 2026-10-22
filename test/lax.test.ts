/**
 * Kognai LAX "Best paid agent" acceptance items, one describe per item (A1 to A5).
 * Runs offline: discovery routes in-process, FX examples from the bundled CBK snapshot.
 */
import { readFileSync, readdirSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { AGENT_PROFILE, FIVE_LAWS } from "../src/discovery/agent-profile.js";
import { laxOffer } from "../src/discovery/lax-offer.js";
import { defaultRateStore } from "../src/fx/default-store.js";
import { ALL_PAID } from "../src/products.js";
import { StubFacilitator, TEST_PAY_TO, buildTestApp, decodeHeader, payingFetch } from "./helpers.js";

const ORIGIN = AGENT_PROFILE.defaultOrigin;
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const offerFile = readJson("lax-offer.json");
const laxSection = readJson("test/fixtures/lax-offer.section.json").schema;
const exampleFiles = readdirSync("examples").filter((f) => f.endsWith(".json")).sort();
const examples = exampleFiles.map((f) => ({ file: f, ...readJson(`examples/${f}`) }));
const ajv = new Ajv({ strict: false, allErrors: true });

/** Builds the in-process request for an example (query for GET, JSON body for POST). */
function requestFor(ex: any): [string, RequestInit] {
  const url = new URL(`http://test.local${ex.request.path}`);
  if (ex.request.query) for (const [k, v] of Object.entries(ex.request.query)) url.searchParams.set(k, String(v));
  const init: RequestInit = ex.request.body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ex.request.body) }
    : { method: "GET" };
  return [url.toString(), init];
}

const capability = (skillId: string) => offerFile.capabilities.find((c: any) => c.skill_id === skillId);
const atomicUsdc = (amount: string) => String(Math.round(Number(amount) * 1_000_000));

describe("A1 the offer passes LAX validation on our own domain, with the Five Laws", () => {
  it("A1 lax-offer.json is generated from the code (no drift)", () => {
    expect(offerFile).toEqual(laxOffer(ORIGIN));
  });

  it("A1 lax-offer.json validates against the LAX lax_offer section schema", () => {
    const valid = ajv.validate(laxSection, offerFile);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("A1 declares all Five Laws, an https endpoint not on kognai.ai, and a did:web for that host", () => {
    expect(offerFile.constitutional_constraints).toEqual(expect.arrayContaining([...FIVE_LAWS]));
    const endpoint = new URL(offerFile.endpoint);
    expect(endpoint.protocol).toBe("https:");
    expect(endpoint.hostname.endsWith("kognai.ai")).toBe(false);
    expect(offerFile.agent_did).toBe(`did:web:${endpoint.host}`);
  });

  it("A1 the same offer, DID document and AIAX manifest are served free on the agent's domain", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    const served = await appFetch("/.well-known/lax-offer.json");
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual(offerFile);

    const did = await (await appFetch("/.well-known/did.json")).json();
    expect(did.id).toBe(offerFile.agent_did);
    expect(did.verificationMethod[0].blockchainAccountId).toBe(`eip155:8453:${AGENT_PROFILE.ownerAddress}`);

    const aiax = await (await appFetch("/.well-known/aiax.json")).json();
    for (const entry of aiax.entry_points) {
      const section = await appFetch(entry.url);
      expect(section.status).toBe(200);
      expect((await section.json()).section_id).toBe(entry.id);
    }
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("A1 unknown or traversal section paths are 404", async () => {
    const { appFetch } = await buildTestApp();
    for (const path of ["/aiax/sections/nope.json", "/aiax/sections/..%2F..%2Fpackage.json", "/aiax/sections/kes-fx-rates", "/aiax/sections/__proto__.json"]) {
      expect((await appFetch(path)).status).toBe(404);
    }
  });

  it("A1 text people see uses Latin digits and no long dashes", () => {
    const text = JSON.stringify([offerFile, examples]);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text.replace(/[0-9]/g, "")).not.toMatch(/\p{Nd}/u);
  });
});

describe("A2 every capability has an input schema, an output schema and a price per call", () => {
  it("A2 one capability per paid route, unique skill ids", () => {
    expect(offerFile.capabilities.map((c: any) => c.skill_id)).toEqual(ALL_PAID.map((p) => p.skillId));
    expect(new Set(ALL_PAID.map((p) => p.skillId)).size).toBe(ALL_PAID.length);
  });

  it.each(ALL_PAID.map((p) => [p.skillId, p] as const))("A2 %s: schemas compile and the price matches the paywall", (skillId, route) => {
    const cap = capability(skillId);
    expect(() => ajv.compile(cap.input_schema)).not.toThrow();
    expect(() => ajv.compile(cap.output_schema)).not.toThrow();
    expect(cap.pricing).toEqual({ model: "per_call", amount: route.price.slice(1), currency: "USDC", rail: "x402" });
  });
});

describe("A3 three examples whose requests and responses match the schemas", () => {
  it("A3 at least three examples, each for a listed capability", () => {
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const ex of examples) expect(capability(ex.capability), ex.file).toBeDefined();
    expect(new Set(examples.map((e) => e.capability)).size).toBe(examples.length);
  });

  it.each(examples.map((e) => [e.file, e] as const))("A3 %s: request and response validate", (_f, ex) => {
    const cap = capability(ex.capability);
    const input = ex.request.body ?? ex.request.query;
    expect(ajv.validate(cap.input_schema, input), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(cap.output_schema, ex.response), JSON.stringify(ajv.errors)).toBe(true);
    expect(ex.request.url).toBe(`${ORIGIN}${ex.request.path}`);
  });
});

describe("A4 the endpoint answers 402 with x402 USDC terms when unpaid", () => {
  it.each(examples.map((e) => [e.file, e] as const))("A4 %s unpaid -> 402 at the listed price", async (_f, ex) => {
    const { appFetch, facilitator } = await buildTestApp(new StubFacilitator(), defaultRateStore());
    const res = await appFetch(...requestFor(ex));
    expect(res.status).toBe(402);
    const terms = decodeHeader(res.headers.get("payment-required")).accepts[0];
    expect(terms).toMatchObject({ scheme: "exact", amount: atomicUsdc(capability(ex.capability).pricing.amount), payTo: TEST_PAY_TO });
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it.todo("A4 README carries the LAX listing id (added once the operator approves and pays the 0.01 USDC listing)");
});

describe("A5 paid calls, one per example, are answered with the example's result", () => {
  it.each(examples.map((e) => [e.file, e] as const))("A5 %s paid -> 200, same answer, settled once", async (_f, ex) => {
    const { appFetch, facilitator } = await buildTestApp(new StubFacilitator(), defaultRateStore());
    const res = await payingFetch(appFetch)(...requestFor(ex));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ex.response);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.settleCalls[0]!.amount).toBe(atomicUsdc(capability(ex.capability).pricing.amount));
  });

  it.todo("A5 Kognai's three live paid test calls on Base mainnet (happen after selection)");
});
