/**
 * Free, read-only discovery routes: DID document, LAX offer, AIAX manifest and sections.
 * Static JSON built from code; no input reaches anything but a skill-id lookup in a fixed list.
 */
import type { Context, Hono } from "hono";
import type { AppConfig } from "../config.js";
import { agentOrigin } from "./agent-profile.js";
import { aiaxManifest, aiaxSection } from "./aiax.js";
import { didDocument } from "./did.js";
import { laxOffer } from "./lax-offer.js";

const publicJson = (c: Context, body: unknown) => {
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(body);
};

export function registerDiscoveryRoutes(app: Hono, config: AppConfig): void {
  const origin = agentOrigin(config);
  app.get("/.well-known/did.json", (c) => publicJson(c, didDocument(origin)));
  app.get("/.well-known/lax-offer.json", (c) => publicJson(c, laxOffer(origin)));
  app.get("/.well-known/aiax.json", (c) => publicJson(c, aiaxManifest()));
  app.get("/aiax/sections/:file", (c) => {
    const file = c.req.param("file");
    const section = file.endsWith(".json") ? aiaxSection(file.slice(0, -5), origin) : undefined;
    return section ? publicJson(c, section) : c.json({ error: { code: "not_found", message: "No such section" } }, 404);
  });
}
