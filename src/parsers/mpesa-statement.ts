/**
 * Safaricom M-PESA full statement -> structured JSON.
 * Works on text lines from a text-based PDF or pasted text.
 */
import type { MpesaStatement, MpesaTransaction } from "../schema/output.js";
import { field, labelledValue, parseAmount, parseDate, roughlyEqual, round2 } from "./common.js";

const ROW_START = /^([A-Z0-9]{10})\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/;
const STATUS = /\s(COMPLETED|FAILED|REVERSED|PENDING|CANCELLED)\b/i;
const NOT_DETAILS = /^(page\s+\d|receipt no|disclaimer|detailed statement|summary|transaction type|safaricom|m-?pesa statement)/i;

export function looksLikeMpesaStatement(lines: string[]): boolean {
  const head = lines.slice(0, 40).join(" ").toUpperCase();
  return /M-?PESA/.test(head) && head.includes("STATEMENT") && lines.some((l) => ROW_START.test(l));
}

export function parseMpesaStatement(lines: string[], pages: number): MpesaStatement {
  const warnings: string[] = [];
  const transactions = parseRows(lines, warnings);
  const checks = reconcileBalances(transactions);

  if (transactions.length === 0) warnings.push("No transaction rows found");
  if (checks.balance_checked_rows > 0 && checks.balance_reconciled_rows < checks.balance_checked_rows) {
    warnings.push(
      `${checks.balance_checked_rows - checks.balance_reconciled_rows} row(s) do not reconcile with the running balance`,
    );
  }

  const name = labelledValue(lines, /customer\s+name/);
  const mobile = labelledValue(lines, /mobile\s+number/);
  const period = parsePeriod(labelledValue(lines, /statement\s+period/));
  const requestDate = parseDate(labelledValue(lines, /request\s+date/) ?? "");

  return {
    document_type: "mpesa_statement",
    currency: "KES",
    pages,
    customer_name: field(name, 0.95),
    mobile_number: field(mobile?.replace(/\s+/g, " "), 0.95),
    statement_period: field(period, 0.95),
    request_date: field(requestDate, 0.95),
    transactions,
    totals: {
      paid_in: round2(transactions.reduce((s, t) => s + t.paid_in, 0)),
      withdrawn: round2(transactions.reduce((s, t) => s + t.withdrawn, 0)),
      transaction_count: transactions.length,
    },
    checks,
    warnings,
  };
}

function parseRows(lines: string[], warnings: string[]): MpesaTransaction[] {
  const rows: MpesaTransaction[] = [];
  for (const line of lines) {
    const m = line.match(ROW_START);
    if (!m) {
      appendWrappedDetails(rows.at(-1), line);
      continue;
    }
    const [, receipt, date, time, rest] = m;
    const row = parseRowBody(receipt, `${date}T${time.length === 5 ? `${time}:00` : time}+03:00`, rest);
    if (row) rows.push(row);
    else warnings.push(`Could not read amounts for receipt ${receipt}`);
  }
  return rows;
}

function parseRowBody(receipt: string, completedAt: string, rest: string): MpesaTransaction | null {
  const status = rest.match(STATUS);
  const details = (status ? rest.slice(0, status.index) : rest).trim();
  const after = status ? rest.slice(status.index! + status[0].length) : rest;
  const amounts = after.split(/\s+/).map(parseAmount).filter((n): n is number => n !== null);

  let paidIn = 0, withdrawn = 0, balance: number | null = null;
  if (amounts.length >= 3) {
    [paidIn, withdrawn, balance] = [Math.abs(amounts[0]), Math.abs(amounts[1]), amounts[2]];
  } else if (amounts.length === 2) {
    const [amount, bal] = amounts;
    if (amount < 0) withdrawn = -amount;
    else paidIn = amount;
    balance = bal;
  } else {
    return null;
  }

  return {
    receipt_no: receipt,
    completed_at: completedAt,
    details,
    status: (status?.[1] ?? "UNKNOWN").toUpperCase(),
    paid_in: paidIn,
    withdrawn,
    balance,
    confidence: 0.8,
  };
}

const MAX_DETAILS_CHARS = 300;

/** Long "Details" text wraps onto the next line in the PDF (one or two lines in practice). */
function appendWrappedDetails(row: MpesaTransaction | undefined, line: string) {
  if (!row || row.details.length > MAX_DETAILS_CHARS || line.length > 120) return;
  if (NOT_DETAILS.test(line) || /^[\d\s.,-]+$/.test(line)) return;
  row.details = `${row.details} ${line}`.trim();
}

/**
 * Each row's balance should equal the neighbouring row's balance plus this row's net amount.
 * Statements are usually newest-first; the order is inferred from timestamps.
 */
function reconcileBalances(rows: MpesaTransaction[]) {
  const newestFirst = rows.length > 1 && rows[0].completed_at >= rows.at(-1)!.completed_at;
  let checked = 0, reconciled = 0;
  rows.forEach((row, i) => {
    const prev = newestFirst ? rows[i + 1] : rows[i - 1];
    if (!prev || prev.balance === null || row.balance === null) return;
    checked++;
    const ok = roughlyEqual(prev.balance + row.paid_in - row.withdrawn, row.balance);
    if (ok) reconciled++;
    row.confidence = ok ? 0.99 : 0.6;
  });
  return { balance_reconciled_rows: reconciled, balance_checked_rows: checked };
}

function parsePeriod(raw: string | null): { start: string; end: string } | null {
  if (!raw) return null;
  const parts = raw.split(/\s+(?:-|to|–)\s+/i);
  if (parts.length !== 2) return null;
  const [start, end] = parts.map(parseDate);
  return start && end ? { start, end } : null;
}
