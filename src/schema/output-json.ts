/**
 * Hand-written JSON Schemas for every paid response, published in the LAX offer and AIAX sections.
 * They mirror the TypeScript types in output.ts (documents) and services/fx-rates.ts (FX).
 * Tests validate real responses against them, so a drift fails the build.
 */
type Schema = Record<string, unknown>;

const num = { type: "number" };
const str = { type: "string" };
const isoDate = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required });
const field = (value: Schema) => obj({ value: nullable(value), confidence: { type: "number", minimum: 0, maximum: 1 } });
const warnings = { type: "array", items: str };

export const MPESA_STATEMENT_OUTPUT: Schema = obj({
  document_type: { const: "mpesa_statement" },
  currency: { const: "KES" },
  pages: { type: "integer", minimum: 0 },
  customer_name: field(str),
  mobile_number: field(str),
  statement_period: field(obj({ start: str, end: str })),
  request_date: field(str),
  transactions: {
    type: "array",
    items: obj({
      receipt_no: str,
      completed_at: { type: "string", description: "ISO 8601 with +03:00 (EAT)" },
      details: str,
      status: str,
      paid_in: num,
      withdrawn: num,
      balance: nullable(num),
      confidence: { type: "number", minimum: 0, maximum: 1 },
    }),
  },
  totals: obj({ paid_in: num, withdrawn: num, transaction_count: { type: "integer", minimum: 0 } }),
  checks: obj({ balance_reconciled_rows: { type: "integer" }, balance_checked_rows: { type: "integer" } }),
  warnings,
});

export const ETIMS_INVOICE_OUTPUT: Schema = obj({
  document_type: { const: "etims_invoice" },
  currency: { const: "KES" },
  pages: { type: "integer", minimum: 0 },
  seller_name: field(str),
  seller_pin: field(str),
  buyer_name: field(str),
  buyer_pin: field(str),
  invoice_number: field(str),
  invoice_date: field(str),
  cu_serial_number: field(str),
  cu_invoice_number: field(str),
  items: {
    type: "array",
    items: obj({ description: str, quantity: nullable(num), unit_price: nullable(num), amount: num, tax_code: nullable(str) }),
  },
  taxable_amount: field(num),
  vat_amount: field(num),
  total_amount: field(num),
  checks: obj({
    vat_is_16_percent: nullable({ type: "boolean" }),
    items_sum_matches: nullable({ type: "boolean" }),
    totals_add_up: nullable({ type: "boolean" }),
  }),
  warnings,
});

const fxFreshness = obj({ snapshot_last_date: isoDate, live_check: { enum: ["not_needed", "fetched", "cached", "failed"] } });
const fxSource = obj({ publisher: str, dataset: str, url: str, note: str, disclaimer: str });

export const FX_RATES_OUTPUT: Schema = obj({
  base: { const: "KES" },
  requested_date: isoDate,
  date_defaulted_to_today: { type: "boolean" },
  rates: {
    type: "array",
    items: obj({
      currency: str,
      name: str,
      rate_date: isoDate,
      is_fallback: { type: "boolean" },
      fallback_reason: nullable(str),
      quote: str,
      mean: num,
      buy: nullable(num),
      sell: nullable(num),
      kes_per_unit: num,
      units_per_kes: num,
    }),
  },
  freshness: fxFreshness,
  source: fxSource,
});

const convertLeg = obj({ currency: str, kes_per_unit: num, rate_date: nullable(isoDate), is_fallback: { type: "boolean" } });

export const FX_CONVERT_OUTPUT: Schema = obj({
  amount: num,
  from: str,
  to: str,
  requested_date: isoDate,
  date_defaulted_to_today: { type: "boolean" },
  result: num,
  is_fallback: { type: "boolean" },
  legs: obj({ from: convertLeg, to: convertLeg }),
  method: str,
  freshness: fxFreshness,
  source: fxSource,
});
