import { afterEach, describe, expect, it, vi } from "vitest";
import { StubFacilitator, TEST_PAY_TO, buildTestApp, decodeHeader, jsonPost, payingFetch } from "./helpers.js";
import * as fx from "./fixtures/synthetic.js";

const STATEMENT = "http://test.local/v1/parse/mpesa-statement";
const INVOICE = "http://test.local/v1/parse/etims-invoice";
const invoiceBody = { text: fx.etimsInvoiceLines().join("\n") };

afterEach(() => vi.restoreAllMocks());

describe("free routes", () => {
  it("GET / lists every paid route with prices and no secrets", async () => {
    const { appFetch } = await buildTestApp();
    const res = await appFetch("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routes.map((r: any) => [r.method, r.path, r.price])).toEqual([
      ["POST", "/v1/parse/mpesa-statement", "$0.10"],
      ["POST", "/v1/parse/etims-invoice", "$0.05"],
      ["GET", "/v1/fx/kes", "$0.003"],
      ["GET", "/v1/fx/convert", "$0.003"],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/secret|api_key|private/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("unknown routes are 404 and are not paywalled", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    expect((await appFetch("/v1/other", jsonPost({}))).status).toBe(404);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });
});

describe("402 payment challenge", () => {
  it.each([
    [STATEMENT, "100000"],
    [INVOICE, "50000"],
  ])("%s without payment -> 402 with exact USDC requirements and Bazaar metadata", async (path, amount) => {
    const { appFetch } = await buildTestApp();
    const res = await appFetch(path, jsonPost(invoiceBody));
    expect(res.status).toBe(402);
    const challenge = decodeHeader(res.headers.get("payment-required"));
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount, payTo: TEST_PAY_TO });
    expect(challenge.accepts[0].asset.toLowerCase()).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e"); // USDC on Base Sepolia
    expect(challenge.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(challenge.resource.description.length).toBeLessThanOrEqual(500);
  });

  it("an empty body still gets the 402 (Bazaar discovery probes send one)", async () => {
    const { appFetch } = await buildTestApp();
    const res = await appFetch(STATEMENT, { method: "POST" });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
  });

  it("a garbage payment header is refused without reaching the parser", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    const res = await appFetch(INVOICE, { ...jsonPost(invoiceBody), headers: { "content-type": "application/json", "payment-signature": "bm90LWEtcGF5bWVudA==" } });
    expect(res.status).toBe(402);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});

describe("paid calls", () => {
  it("pays, parses and settles exactly once", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    const res = await payingFetch(appFetch)(INVOICE, jsonPost(invoiceBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document_type).toBe("etims_invoice");
    expect(body.total_amount.value).toBe(17400);
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.settleCalls[0]).toMatchObject({ amount: "50000", payTo: TEST_PAY_TO });
    expect(decodeHeader(res.headers.get("payment-response"))).toMatchObject({ success: true });
    expect(res.headers.get("cache-control")).toMatch(/private|no-store/);
  });

  it("an encrypted statement PDF works end to end", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    const pdf = await fx.mpesaStatementPdf({ password: "TEST1234" });
    const res = await payingFetch(appFetch)(STATEMENT, jsonPost({ file_base64: pdf.toString("base64"), password: "TEST1234" }));
    expect(res.status).toBe(200);
    expect((await res.json()).transactions).toHaveLength(45);
    expect(facilitator.settleCalls[0].amount).toBe("100000");
  });

  it.each([
    ["unparseable document", { text: "not a statement" }, 422],
    ["schema violation", { text: "x", file_base64: "eA==" }, 400],
    ["unknown field", { text: "x", price: "0" }, 400],
    ["invalid JSON", "{not json", 400],
  ])("%s -> client error and NO settlement (buyer not charged)", async (_n, body, status) => {
    const { appFetch, facilitator } = await buildTestApp();
    const res = await payingFetch(appFetch)(STATEMENT, jsonPost(body));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBeTruthy();
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("when settlement fails the parsed data is withheld", async () => {
    const facilitator = new StubFacilitator();
    facilitator.settleSucceeds = false;
    const { appFetch } = await buildTestApp(facilitator);
    const res = await payingFetch(appFetch)(INVOICE, jsonPost(invoiceBody));
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("P000111222Z");
  });

  it("a payment signed for the $0.05 route is not accepted on the $0.10 route", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    let cheapHeader = "";
    const recorder = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(String(input), "http://test.local"), init);
      cheapHeader ||= req.headers.get("payment-signature") ?? "";
      return appFetch(req);
    }) as typeof fetch;
    await payingFetch(recorder)(INVOICE, jsonPost(invoiceBody));
    expect(cheapHeader).toBeTruthy();
    facilitator.verifyCalls.length = 0;
    facilitator.settleCalls.length = 0;

    const res = await appFetch(STATEMENT, { ...jsonPost(invoiceBody), headers: { "content-type": "application/json", "payment-signature": cheapHeader } });
    expect(res.status).toBe(402);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("oversized bodies are rejected before any facilitator call", async () => {
    const { appFetch, facilitator } = await buildTestApp();
    const huge = "A".repeat(4_500_000);
    const res = await appFetch(STATEMENT, { ...jsonPost({ file_base64: huge }), headers: { "content-type": "application/json", "content-length": String(huge.length + 20) } });
    expect(res.status).toBe(413);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("never logs document content or passwords", async () => {
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
    const { appFetch } = await buildTestApp();
    const pay = payingFetch(appFetch);
    const pdf = await fx.mpesaStatementPdf({ password: "SECRETPW99" });
    await pay(STATEMENT, jsonPost({ file_base64: pdf.toString("base64"), password: "SECRETPW99" }));
    await pay(STATEMENT, jsonPost({ file_base64: pdf.toString("base64"), password: "WRONGPW77" }));
    await pay(INVOICE, jsonPost(invoiceBody));
    const all = logs.join("\n");
    expect(all).not.toMatch(/SECRETPW99|WRONGPW77|WANJIRU|P000111222Z|NYOTA/);
  });
});
