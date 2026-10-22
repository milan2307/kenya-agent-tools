/**
 * Response shapes. Every extracted header field carries its own confidence (0-1).
 * JSON Schemas for /schema and Bazaar metadata are written by hand in products.ts
 * so they stay readable for agents.
 */
export type Field<T> = { value: T | null; confidence: number };

export type MpesaTransaction = {
  receipt_no: string;
  completed_at: string; // ISO 8601, +03:00 (EAT)
  details: string;
  status: string;
  paid_in: number;
  withdrawn: number;
  balance: number | null;
  /** 0.99 when the running balance reconciles with the previous row, lower otherwise. */
  confidence: number;
};

export type MpesaStatement = {
  document_type: "mpesa_statement";
  currency: "KES";
  pages: number;
  customer_name: Field<string>;
  mobile_number: Field<string>;
  statement_period: Field<{ start: string; end: string }>;
  request_date: Field<string>;
  transactions: MpesaTransaction[];
  totals: { paid_in: number; withdrawn: number; transaction_count: number };
  checks: { balance_reconciled_rows: number; balance_checked_rows: number };
  warnings: string[];
};

export type EtimsLineItem = {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  tax_code: string | null;
};

export type EtimsInvoice = {
  document_type: "etims_invoice";
  currency: "KES";
  pages: number;
  seller_name: Field<string>;
  seller_pin: Field<string>;
  buyer_name: Field<string>;
  buyer_pin: Field<string>;
  invoice_number: Field<string>;
  invoice_date: Field<string>;
  cu_serial_number: Field<string>;
  cu_invoice_number: Field<string>;
  items: EtimsLineItem[];
  taxable_amount: Field<number>;
  vat_amount: Field<number>;
  total_amount: Field<number>;
  checks: { vat_is_16_percent: boolean | null; items_sum_matches: boolean | null; totals_add_up: boolean | null };
  warnings: string[];
};

export type ParsedDocument = MpesaStatement | EtimsInvoice;
