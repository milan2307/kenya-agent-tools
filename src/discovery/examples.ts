/** The three LAX examples (one per Kognai paid test call). Requests only; responses come from the agent. */
import { ETIMS_EXAMPLE_TEXT } from "../products.js";
import type { DocumentKind } from "../services/parse-document.js";

/** Synthetic statement: invented names, receipts and placeholder numbers; newest row first, as Safaricom prints it. */
const MPESA_STATEMENT_TEXT = [
  "M-PESA STATEMENT",
  "Customer Name: AMANI TEST USER",
  "Mobile Number: 0700 000 000",
  "Statement Period: 01 Sep 2026 - 30 Sep 2026",
  "Request Date: 01 Oct 2026",
  "Receipt No. Completion Time Details Transaction Status Paid In Withdrawn Balance",
  "TJ5AAA0005 2026-09-06 18:45:00 Customer Transfer to 0700***001 - TEST RECIPIENT COMPLETED -1,200.00 4,949.50",
  "TJ4AAA0004 2026-09-05 08:30:00 Business Payment from 000222 - SAMPLE EMPLOYER LTD COMPLETED 5,000.00 6,149.50",
  "TJ3AAA0003 2026-09-03 13:15:00 Merchant Payment to 000111 - SAMPLE SUPERMARKET COMPLETED -350.50 1,149.50",
  "TJ2AAA0002 2026-09-02 10:00:00 Pay Bill to 000000 - SAMPLE POWER CO COMPLETED -500.00 1,500.00",
  "TJ1AAA0001 2026-09-01 09:00:00 Funds received from 0700***000 - SAMPLE SENDER COMPLETED 2,000.00 2,000.00",
].join("\n");

export type LaxExample = {
  name: string;
  capability: string;
  document?: DocumentKind;
  request: { method: "GET" | "POST"; path: string; body?: Record<string, string>; query?: Record<string, string> };
};

export const LAX_EXAMPLES: LaxExample[] = [
  {
    name: "mpesa-statement",
    capability: "parse-mpesa-statement",
    document: "mpesa_statement",
    request: { method: "POST", path: "/v1/parse/mpesa-statement", body: { text: MPESA_STATEMENT_TEXT } },
  },
  {
    name: "etims-invoice",
    capability: "parse-etims-invoice",
    document: "etims_invoice",
    request: { method: "POST", path: "/v1/parse/etims-invoice", body: { text: ETIMS_EXAMPLE_TEXT } },
  },
  {
    name: "kes-fx-convert",
    capability: "kes-fx-convert",
    request: { method: "GET", path: "/v1/fx/convert", query: { amount: "250", from: "USD", to: "KES", date: "2026-10-09" } },
  },
];
