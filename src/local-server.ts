/** Local entry point (`npm start`). Not named index/app/server so Vercel never picks it as the entry. */
import { serve } from "@hono/node-server";
import { createApp } from "./http-app.js";
import { loadConfig } from "./config.js";
import { defaultRateStore } from "./fx/default-store.js";
import { createPaymentMiddleware } from "./payments/x402.js";

const config = loadConfig();
const app = createApp(config, await createPaymentMiddleware(config), { rateStore: defaultRateStore });

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`x402 parser on http://localhost:${port} (network ${config.network}, facilitator ${config.facilitator}, payTo ${config.payTo})`);
});
