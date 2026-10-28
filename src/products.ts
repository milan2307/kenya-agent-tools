/**
 * Everything we sell, one entry per paid route. Price, description, catalogue schema and Bazaar
 * discovery metadata live here and nowhere else.
 *  - DOCUMENT_PRODUCTS: POST parsers (M-Pesa statement, KRA eTIMS invoice).
 *  - FX_PRODUCTS: GET CBK Kenya shilling exchange rates and conversion.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { RouteConfig } from "@x402/core/server";
import type { AppConfig } from "./config.js";
import { CURRENCY_CODES } from "./fx/currencies.js";
import { ETIMS_INVOICE_OUTPUT, FX_CONVERT_OUTPUT, FX_RATES_OUTPUT, MPESA_STATEMENT_OUTPUT } from "./schema/output-json.js";
import type { DocumentKind } from "./services/parse-document.js";

export type PaidRoute = {
  /** Stable capability id used in the LAX offer, AIAX sections and examples/. */
  skillId: string;
  /** One short sentence for listings (the full description goes to x402/Bazaar). */
  summary: string;
  method: "GET" | "POST";
  path: string;
  price: `$${string}`;
  description: string; // <= 500 chars (CDP facilitator limit); describes, never instructs
  serviceName: string;
  tags: string[]; // Bazaar keeps the first 5
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  discovery: ReturnType<typeof declareDiscoveryExtension>;
};

export type DocumentProduct = PaidRoute & { method: "POST"; document: DocumentKind };

const requestBodySchema = {
  type: "object",
  properties: {
    file_base64: { type: "string", description: "Base64 of a text-based PDF or UTF-8 text file, max 3 MB decoded" },
    text: { type: "string", description: "Already-extracted document text, max 300,000 characters" },
    password: { type: "string", description: "Password for an encrypted PDF; used in memory only" },
  },
  additionalProperties: false,
};

export const MPESA_EXAMPLE_TEXT = [
  "M-PESA STATEMENT",
  "Customer Name: AMANI TEST USER",
  "Mobile Number: 0700 000 000",
  "Statement Period: 01 Sep 2026 - 30 Sep 2026",
  "Request Date: 01 Oct 2026",
  "Receipt No. Completion Time Details Transaction Status Paid In Withdrawn Balance",
  "TJ2AAA0002 2026-09-02 10:00:00 Pay Bill to 000000 - SAMPLE POWER CO COMPLETED -500.00 1,500.00",
  "TJ1AAA0001 2026-09-01 09:00:00 Funds received from 0700***000 - SAMPLE SENDER COMPLETED 2,000.00 2,000.00",
].join("\n");

export const ETIMS_EXAMPLE_TEXT = [
  "SAMPLE TRADERS LTD",
  "TAX INVOICE",
  "Seller PIN: P000000000A",
  "Buyer Name: EXAMPLE BUYER LTD",
  "Buyer PIN: A000000000B",
  "Invoice No: INV-0001",
  "Date: 14/10/2026",
  "Description Qty Unit Price Amount Tax",
  "Sample item 2 500.00 1,000.00 B",
  "Taxable Amount: 1,000.00",
  "VAT 16%: 160.00",
  "Total: 1,160.00",
  "SCU ID: KRACU0000000001",
  "CU Invoice No: KRACU0000000001/1",
].join("\n");

const PARSER_SERVICE = "M-Pesa & KRA Document Parser";
const PARSER_TAGS = ["kenya", "m-pesa", "kra", "etims", "document-parsing"];
const documentDiscovery = (input: Record<string, unknown>, output: Record<string, unknown>) =>
  declareDiscoveryExtension({ bodyType: "json", input, inputSchema: requestBodySchema, output: { example: output } });

export const DOCUMENT_PRODUCTS: DocumentProduct[] = [
  {
    document: "mpesa_statement",
    skillId: "parse-mpesa-statement",
    summary: "M-PESA full statement (PDF or text) to JSON: every transaction, totals and a running balance check.",
    method: "POST",
    path: "/v1/parse/mpesa-statement",
    price: "$0.10",
    description:
      "Parses a Safaricom M-PESA full statement (text-based PDF, password supported, up to 60 pages) into JSON: customer, period, every transaction with receipt number, EAT timestamp, details, paid in, withdrawn and balance, plus totals and a running-balance reconciliation check. Per-field confidence. Files are processed in memory and never stored. Not charged when the document cannot be parsed.",
    serviceName: PARSER_SERVICE,
    tags: PARSER_TAGS,
    inputSchema: requestBodySchema,
    outputSchema: MPESA_STATEMENT_OUTPUT,
    discovery: documentDiscovery({ text: MPESA_EXAMPLE_TEXT }, {
      document_type: "mpesa_statement",
      currency: "KES",
      customer_name: { value: "AMANI TEST USER", confidence: 0.95 },
      transactions: [
        { receipt_no: "TJ2AAA0002", completed_at: "2026-09-02T10:00:00+03:00", paid_in: 0, withdrawn: 500, balance: 1500, confidence: 0.99 },
      ],
      totals: { paid_in: 2000, withdrawn: 500, transaction_count: 2 },
      checks: { balance_reconciled_rows: 1, balance_checked_rows: 1 },
    }),
  },
  {
    document: "etims_invoice",
    skillId: "parse-etims-invoice",
    summary: "KRA eTIMS tax invoice (PDF or text) to JSON: PINs, CU numbers, line items, VAT and total checks.",
    method: "POST",
    path: "/v1/parse/etims-invoice",
    price: "$0.05",
    description:
      "Parses a Kenya KRA eTIMS tax invoice or receipt (text-based PDF up to 3 pages, or text) into JSON: seller and buyer KRA PINs and names, invoice number and date, CU serial and CU invoice numbers, line items, taxable amount, VAT and total, with checks that VAT is 16% and totals add up. Per-field confidence. Files are processed in memory and never stored. Not charged when the document cannot be parsed.",
    serviceName: PARSER_SERVICE,
    tags: PARSER_TAGS,
    inputSchema: requestBodySchema,
    outputSchema: ETIMS_INVOICE_OUTPUT,
    discovery: documentDiscovery({ text: ETIMS_EXAMPLE_TEXT }, {
      document_type: "etims_invoice",
      currency: "KES",
      seller_pin: { value: "P000000000A", confidence: 0.97 },
      total_amount: { value: 1160, confidence: 0.97 },
      checks: { vat_is_16_percent: true, items_sum_matches: true, totals_add_up: true },
    }),
  },
];

const FX_SERVICE = "CBK Kenya Shilling Exchange Rates";
const FX_TAGS = ["kenya", "kes", "exchange-rate", "cbk", "m-pesa"];
const currencyEnum = CURRENCY_CODES.join(", ");
const dateParam = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD (Nairobi). Omit for the latest. Weekends/holidays return the last published rate with is_fallback=true" };

const rateQuerySchema = {
  type: "object",
  properties: {
    currency: { type: "string", description: `One or more ISO codes, comma-separated: ${currencyEnum}. Omit for all 21` },
    date: dateParam,
  },
  additionalProperties: false,
};

const convertQuerySchema = {
  type: "object",
  properties: {
    amount: { type: "string", description: "Positive decimal, e.g. 1500 or 99.95" },
    from: { type: "string", description: `KES or ${currencyEnum}` },
    to: { type: "string", description: `KES or ${currencyEnum}` },
    date: dateParam,
  },
  required: ["amount", "from", "to"],
  additionalProperties: false,
};

const RATE_EXAMPLE = {
  base: "KES",
  requested_date: "2026-10-11",
  rates: [
    {
      currency: "USD",
      rate_date: "2026-10-09",
      is_fallback: true,
      fallback_reason: "Sunday: CBK does not publish on weekends; last published rate returned",
      quote: "KES per 1 USD",
      mean: 129.91,
      buy: null,
      sell: null,
      kes_per_unit: 129.91,
      units_per_kes: 0.007697636825,
    },
  ],
  source: { publisher: "Central Bank of Kenya (CBK)" },
};

const CONVERT_EXAMPLE = {
  amount: 100,
  from: "USD",
  to: "KES",
  requested_date: "2026-10-15",
  result: 12981,
  is_fallback: false,
  legs: { from: { currency: "USD", kes_per_unit: 129.81, rate_date: "2026-10-15", is_fallback: false }, to: { currency: "KES", kes_per_unit: 1 } },
};

export const FX_PRODUCTS = {
  rate: {
    skillId: "kes-fx-rates",
    summary: "Official CBK Kenya shilling rates for up to 21 currencies, latest or any date since 2004-11-02.",
    method: "GET",
    path: "/v1/fx/kes",
    price: "$0.003",
    description:
      "Official Central Bank of Kenya (CBK) daily indicative exchange rates for the Kenya shilling (KES): mean, plus buy/sell up to 2024-01-04, for 21 currencies incl. USD, EUR, GBP, UGX, TZS, RWF, ZAR, CNY, INR. Latest or historical by date from 2004-11-02. Weekends and holidays return the last published rate with a fallback flag. For M-Pesa, KRA and Kenya accounting conversions. Not charged on errors.",
    serviceName: FX_SERVICE,
    tags: FX_TAGS,
    inputSchema: rateQuerySchema,
    outputSchema: FX_RATES_OUTPUT,
    discovery: declareDiscoveryExtension({ input: { currency: "USD", date: "2026-10-11" }, inputSchema: rateQuerySchema, output: { example: RATE_EXAMPLE } }),
  },
  convert: {
    skillId: "kes-fx-convert",
    summary: "Convert an amount between KES and 21 currencies at the CBK mean rate for a date.",
    method: "GET",
    path: "/v1/fx/convert",
    price: "$0.003",
    description:
      "Converts an amount between the Kenya shilling (KES) and 21 currencies, or across two of them via KES, at the official Central Bank of Kenya (CBK) mean rate for a date (latest or historical from 2004-11-02). Returns the result, the rate dates used and a fallback flag for weekends and holidays. Useful for M-Pesa, KRA tax and Kenya invoice reconciliation. Not charged on errors.",
    serviceName: FX_SERVICE,
    tags: FX_TAGS,
    inputSchema: convertQuerySchema,
    outputSchema: FX_CONVERT_OUTPUT,
    discovery: declareDiscoveryExtension({ input: { amount: "100", from: "USD", to: "KES" }, inputSchema: convertQuerySchema, output: { example: CONVERT_EXAMPLE } }),
  },
} satisfies Record<string, PaidRoute & { method: "GET" }>;

export const ALL_PAID: PaidRoute[] = [...DOCUMENT_PRODUCTS, FX_PRODUCTS.rate, FX_PRODUCTS.convert];

/** x402 route table, shared by the CDP and the generic resource server. */
export function paidRoutes(config: AppConfig): Record<string, RouteConfig> {
  return Object.fromEntries(
    ALL_PAID.map((p) => [
      `${p.method} ${p.path}`,
      {
        accepts: { scheme: "exact", price: p.price, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 300 },
        // GET routes carry the buyer's query in the URL; pin one canonical resource so Bazaar lists one entry per route.
        ...(p.method === "GET" && config.publicOrigin ? { resource: `${config.publicOrigin}${p.path}` } : {}),
        description: p.description,
        mimeType: "application/json",
        serviceName: p.serviceName,
        tags: p.tags,
        extensions: p.discovery,
      } satisfies RouteConfig,
    ]),
  );
}

/** Free, human- and agent-readable catalogue served at GET /. */
export function catalogue(config: AppConfig) {
  return {
    name: "Kenya agent tools: M-Pesa & KRA document parser, CBK KES exchange rates",
    payment: { protocol: "x402", scheme: "exact", asset: "USDC", network: config.network },
    ...(config.sui
      ? {
          payment_alternatives: [{
            protocol: "x402", scheme: "exact", network: config.sui.network, asset: config.sui.asset, pay_to: config.sui.payTo,
            routes: [FX_PRODUCTS.rate.path, FX_PRODUCTS.convert.path],
            note: "Sui option for the FX routes: send a PAYMENT-SIGNATURE whose accepted.network is the Sui network. Non-custodial: you sign a transaction that pays pay_to directly; the facilitator only relays it.",
            facilitator: config.sui.facilitatorUrl,
          }],
        }
      : {}),
    privacy: "Uploaded files are processed in memory and never stored or logged.",
    routes: ALL_PAID.map((p) => ({ method: p.method, path: p.path, price: p.price, description: p.description, input_schema: p.inputSchema })),
    errors: {
      400: "invalid_request: body or query does not match the input schema",
      402: "payment required or payment invalid (x402 PAYMENT-REQUIRED header)",
      404: "rate_not_available: no CBK rate for that currency on or before the date",
      413: "file_too_large, too_many_pages or pdf_stream_too_large",
      422: "password_required, wrong_password, no_text_layer, unreadable_pdf, unsupported_file_type, wrong_document_type, unrecognised_document, date_out_of_range",
      503: "rates_unavailable: CBK unreachable and no recent enough rate held",
    },
    free_routes: ["GET /", "GET /health", "GET /fx/status (FX coverage and freshness)", "GET /.well-known/did.json", "GET /.well-known/lax-offer.json", "GET /.well-known/aiax.json"],
    billing_note: "Error responses (4xx/5xx) are not settled, so failed calls are free.",
    fx_source: "Central Bank of Kenya indicative rates, https://www.centralbank.go.ke/rates/forex-exchange-rates/ (not affiliated with CBK).",
  };
}
