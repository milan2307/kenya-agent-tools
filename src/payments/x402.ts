/**
 * Builds the x402 payment middleware. The only place that knows about facilitators.
 *
 * - "cdp": Coinbase CDP facilitator (needs CDP_API_KEY_ID/SECRET). Required for Bazaar listing.
 * - "public-testnet": x402.org facilitator, Base Sepolia only, no credentials.
 * - tests inject their own FacilitatorClient.
 */
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, paymentMiddlewareFromHTTPServer, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import { NETWORKS, PUBLIC_TESTNET_FACILITATOR_URL, type AppConfig } from "../config.js";
import { paidRoutes } from "../products.js";

export async function createPaymentMiddleware(
  config: AppConfig,
  injectedFacilitator?: FacilitatorClient,
): Promise<MiddlewareHandler> {
  const routes = paidRoutes(config);

  if (!injectedFacilitator && config.facilitator === "cdp") {
    // Credentials come from CDP_API_KEY_ID / CDP_API_KEY_SECRET; payTo is the given public address.
    const server = await createX402Server({
      environment: config.network === NETWORKS.baseMainnet ? "production" : "development",
      payToConfig: { type: "address", evm: config.payTo },
      routes,
    });
    return paymentMiddlewareFromHTTPServer(server);
  }

  const facilitator = injectedFacilitator ?? new HTTPFacilitatorClient({ url: PUBLIC_TESTNET_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(config.network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  return paymentMiddleware(routes, resourceServer);
}
