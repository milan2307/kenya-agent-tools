/**
 * Writes the LAX job artifacts at the repo root from the code itself:
 *   lax-offer.json      the offer listed on LAX (production origin)
 *   examples/<n>.json   {capability, request, response}: real answers from this agent's own code
 * Inputs are synthetic (invented names, PINs and receipts). FX uses a past date inside the bundled
 * CBK snapshot, so no network call is made. Tests (A1, A3) fail if these files drift from the code.
 *   npm run lax:artifacts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { AGENT_PROFILE } from "../src/discovery/agent-profile.js";
import { laxOffer } from "../src/discovery/lax-offer.js";
import { LAX_EXAMPLES } from "../src/discovery/examples.js";
import { defaultRateStore } from "../src/fx/default-store.js";
import { convertAmount } from "../src/services/fx-rates.js";
import { parseDocument } from "../src/services/parse-document.js";
import { convertQuerySchema } from "../src/schema/fx-input.js";

const write = (path: string, body: unknown) => writeFileSync(path, JSON.stringify(body, null, 2) + "\n");

write("lax-offer.json", laxOffer(AGENT_PROFILE.defaultOrigin));
mkdirSync("examples", { recursive: true });

for (const ex of LAX_EXAMPLES) {
  const response =
    ex.request.method === "POST"
      ? await parseDocument(ex.document!, ex.request.body as { text: string })
      : await convertAmount(convertQuerySchema.parse(ex.request.query), defaultRateStore());
  write(`examples/${ex.name}.json`, { capability: ex.capability, request: { ...ex.request, url: `${AGENT_PROFILE.defaultOrigin}${ex.request.path}` }, response });
}
console.log(`wrote lax-offer.json and ${LAX_EXAMPLES.length} examples`);
