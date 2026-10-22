import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const PAY_TO = "0x000000000000000000000000000000000000dEaD";

describe("config", () => {
  it("refuses to run Vercel production on the testnet defaults", () => {
    expect(() => loadConfig({ X402_PAY_TO: PAY_TO, VERCEL_ENV: "production" })).toThrow(/Base mainnet/);
  });

  it("accepts Vercel production on CDP + Base mainnet", () => {
    const cfg = loadConfig({
      X402_PAY_TO: PAY_TO,
      VERCEL_ENV: "production",
      X402_FACILITATOR: "cdp",
      X402_NETWORK: "eip155:8453",
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "secret",
    });
    expect(cfg).toMatchObject({ facilitator: "cdp", network: "eip155:8453", payTo: PAY_TO });
  });

  it("rejects a malformed payTo", () => {
    expect(() => loadConfig({ X402_PAY_TO: "0xabc" })).toThrow(/X402_PAY_TO/);
  });
});
