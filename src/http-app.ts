/**
 * HTTP surface. Handlers are thin: validate input -> one service call -> JSON.
 * Payment middleware runs before every paid route; a >= 400 response is never settled.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppConfig } from "./config.js";
import { registerDiscoveryRoutes } from "./discovery/routes.js";
import type { RateStore } from "./fx/rate-store.js";
import { DOCUMENT_PRODUCTS, FX_PRODUCTS, PHONE_PRODUCTS, catalogue } from "./products.js";
import { normalise, normaliseBatch } from "./phone/normalise.js";
import { phoneBatchSchema, phoneSingleSchema } from "./schema/phone-input.js";
import { convertQuerySchema, rateQuerySchema } from "./schema/fx-input.js";
import { MAX_BODY_BYTES, parseRequestSchema } from "./schema/input.js";
import { FxError, ParseError } from "./services/errors.js";
import { convertAmount, getKesRates } from "./services/fx-rates.js";
import { parseDocument } from "./services/parse-document.js";

export type AppDeps = { rateStore: () => RateStore };

export function createApp(config: AppConfig, payment: MiddlewareHandler, deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
  });

  app.get("/", (c) => c.json(catalogue(config)));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/fx/status", (c) => c.json(deps.rateStore().status()));
  registerDiscoveryRoutes(app, config);

  // Cheap size check first, so oversized bodies never reach the facilitator.
  app.use("/v1/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(errorBody("file_too_large", "Request body too large"), 413) }));
  // Hono answers HEAD with the GET handler, which would run a paid lookup unpaid. Paid routes are GET/POST only.
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "HEAD") return c.json(errorBody("method_not_allowed", "Use GET"), 405);
    await next();
  });
  app.use("/v1/*", payment);

  for (const product of DOCUMENT_PRODUCTS) {
    app.post(product.path, async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      const body = parseRequestSchema.safeParse(raw);
      if (!body.success) {
        return c.json(errorBody("invalid_request", body.error.issues.map((i) => i.message).join("; ")), 400);
      }
      return c.json(await parseDocument(product.document, body.data));
    });
  }

  app.get(FX_PRODUCTS.rate.path, async (c) => c.json(await getKesRates(query(c, rateQuerySchema), deps.rateStore())));
  app.get(FX_PRODUCTS.convert.path, async (c) => c.json(await convertAmount(query(c, convertQuerySchema), deps.rateStore())));

  app.get(PHONE_PRODUCTS[0].path, (c) => {
    const q = phoneSingleSchema.safeParse(c.req.query());
    if (!q.success) return c.json(errorBody("invalid_request", q.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ")), 400);
    return c.json(normalise(q.data.number, { defaultCountry: q.data.country, kind: q.data.kind }));
  });
  app.post(PHONE_PRODUCTS[1].path, async (c) => {
    const b = phoneBatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json(errorBody("invalid_request", b.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")), 400);
    return c.json(normaliseBatch(b.data.numbers, { defaultCountry: b.data.country, kind: b.data.kind }));
  });

  app.onError((err, c) => {
    if (err instanceof ParseError || err instanceof FxError) return c.json(errorBody(err.code, err.message), err.status);
    // Never log request bodies or passwords; the error name is enough to debug.
    console.error("unhandled_error", err instanceof Error ? err.name : typeof err);
    return c.json(errorBody("internal_error", "Unexpected error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "No such route"), 404));

  return app;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

function query<S extends z.ZodTypeAny>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new FxError("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "));
  return parsed.data;
}
