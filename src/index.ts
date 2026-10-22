/** Vercel entry point (Hono zero-config): the default export is the app. Vercel detects the entry by its "hono" import. */
import type { Hono } from "hono";
import { createApp } from "./http-app.js";
import { loadConfig } from "./config.js";
import { defaultRateStore } from "./fx/default-store.js";
import { createPaymentMiddleware } from "./payments/x402.js";

const config = loadConfig();
const app: Hono = createApp(config, await createPaymentMiddleware(config), { rateStore: defaultRateStore });
export default app;
