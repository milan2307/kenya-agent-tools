import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/services/parse-document.js";
import type { EtimsInvoice, MpesaStatement } from "../src/schema/output.js";
import * as fx from "./fixtures/synthetic.js";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");
const statement = (req: Parameters<typeof parseDocument>[1]) => parseDocument("mpesa_statement", req) as Promise<MpesaStatement>;
const invoice = (req: Parameters<typeof parseDocument>[1]) => parseDocument("etims_invoice", req) as Promise<EtimsInvoice>;

describe("M-Pesa statement", () => {
  const rows = fx.syntheticTransactions();
  const expectedPaidIn = Math.round(rows.reduce((s, r) => s + r.paidIn, 0) * 100) / 100;
  const expectedWithdrawn = Math.round(rows.reduce((s, r) => s + r.withdrawn, 0) * 100) / 100;

  it("parses text: header, every row, totals, full reconciliation", async () => {
    const r = await statement({ text: fx.mpesaStatementText(rows) });
    expect(r.customer_name.value).toBe(fx.STATEMENT_HEADER.name);
    expect(r.mobile_number.value).toBe(fx.STATEMENT_HEADER.mobile);
    expect(r.statement_period.value).toEqual(fx.STATEMENT_HEADER.period);
    expect(r.request_date.value).toBe(fx.STATEMENT_HEADER.requestDate);
    expect(r.transactions).toHaveLength(rows.length);
    expect(r.transactions.map((t) => t.receipt_no)).toEqual(rows.map((x) => x.receipt));
    expect(r.totals).toEqual({ paid_in: expectedPaidIn, withdrawn: expectedWithdrawn, transaction_count: rows.length });
    expect(r.checks).toEqual({ balance_reconciled_rows: rows.length - 1, balance_checked_rows: rows.length - 1 });
    expect(r.warnings).toEqual([]);
    expect(r.transactions[0].completed_at).toMatch(/^2026-09-\d\dT\d\d:\d\d:05\+03:00$/);
  });

  it("parses an encrypted 2-page PDF with its password, including wrapped details", async () => {
    const pdf = await fx.mpesaStatementPdf({ password: "TEST1234" });
    const r = await statement({ file_base64: b64(pdf), password: "TEST1234" });
    expect(r.pages).toBe(2);
    expect(r.transactions).toHaveLength(rows.length);
    expect(r.totals.paid_in).toBe(expectedPaidIn);
    expect(r.totals.withdrawn).toBe(expectedWithdrawn);
    expect(r.checks.balance_reconciled_rows).toBe(rows.length - 1);
    const wrapped = r.transactions.find((t) => t.details.startsWith("Pay Bill Online"));
    expect(wrapped?.details).toBe("Pay Bill Online to 000111 - SAMPLE POWER CO Acc. 00000000001");
  });

  it("asks for the password, and rejects a wrong one", async () => {
    const pdf = b64(await fx.mpesaStatementPdf({ password: "TEST1234" }));
    await expect(statement({ file_base64: pdf })).rejects.toMatchObject({ code: "password_required" });
    await expect(statement({ file_base64: pdf, password: "nope" })).rejects.toMatchObject({ code: "wrong_password" });
  });

  it("flags a row whose balance does not reconcile", async () => {
    const tampered = fx.syntheticTransactions().map((r, i) => (i === 10 ? { ...r, balance: r.balance + 1000 } : r));
    const r = await statement({ text: fx.mpesaStatementText(tampered) });
    expect(r.checks.balance_reconciled_rows).toBeLessThan(r.checks.balance_checked_rows);
    expect(r.transactions[10].confidence).toBe(0.6);
    expect(r.warnings.join()).toMatch(/do not reconcile/);
  });

  it("reads the three-column layout (Paid In, Withdrawn, Balance all printed)", async () => {
    const text = [
      "M-PESA STATEMENT",
      "Customer Name: TEST",
      "TK1AAA0002  2026-10-02 10:00:00  Customer Transfer to 0700***002 - TEST TWO  COMPLETED  0.00  250.00  750.00",
      "TK1AAA0001  2026-10-01 09:00:00  Funds received from 0700***001 - TEST ONE  COMPLETED  1,000.00  0.00  1,000.00",
    ].join("\n");
    const r = await statement({ text });
    expect(r.transactions.map((t) => [t.paid_in, t.withdrawn, t.balance])).toEqual([[0, 250, 750], [1000, 0, 1000]]);
    expect(r.checks).toEqual({ balance_reconciled_rows: 1, balance_checked_rows: 1 });
  });
});

describe("KRA eTIMS invoice", () => {
  const expectInvoice = (r: EtimsInvoice) => {
    const i = fx.INVOICE;
    expect(r.seller_name.value).toBe(i.sellerName);
    expect(r.seller_pin.value).toBe(i.sellerPin);
    expect(r.buyer_name.value).toBe(i.buyerName);
    expect(r.buyer_pin.value).toBe(i.buyerPin);
    expect(r.invoice_number.value).toBe(i.invoiceNo);
    expect(r.invoice_date.value).toBe(i.date);
    expect(r.cu_serial_number.value).toBe(i.cuSerial);
    expect(r.cu_invoice_number.value).toBe(i.cuInvoice);
    expect(r.items.map((x) => [x.description, x.quantity, x.unit_price, x.amount])).toEqual(
      i.items.map((x) => [x.description, x.qty, x.unit, x.amount]),
    );
    expect([r.taxable_amount.value, r.vat_amount.value, r.total_amount.value]).toEqual([i.taxable, i.vat, i.total]);
    expect(r.checks).toEqual({ vat_is_16_percent: true, items_sum_matches: true, totals_add_up: true });
    expect(r.warnings).toEqual([]);
  };

  it("parses text", async () => expectInvoice(await invoice({ text: fx.etimsInvoiceLines().join("\n") })));
  it("parses a PDF", async () => expectInvoice(await invoice({ file_base64: b64(await fx.etimsInvoicePdf()) })));

  it("warns when totals do not add up", async () => {
    const lines = fx.etimsInvoiceLines().map((l) => (l.startsWith("TOTAL") ? "TOTAL:  KES 18,000.00" : l));
    const r = await invoice({ text: lines.join("\n") });
    expect(r.checks.totals_add_up).toBe(false);
    expect(r.total_amount.confidence).toBeLessThan(0.9);
    expect(r.warnings.join()).toMatch(/does not equal/);
  });
});

describe("input handling", () => {
  it("routes a document to the right parser or explains the mismatch", async () => {
    await expect(statement({ text: fx.etimsInvoiceLines().join("\n") })).rejects.toMatchObject({ code: "wrong_document_type" });
    await expect(invoice({ text: fx.mpesaStatementText() })).rejects.toMatchObject({ code: "wrong_document_type" });
    await expect(invoice({ text: "hello world, just a note" })).rejects.toMatchObject({ code: "unrecognised_document" });
  });

  it("rejects scans, binaries, bad base64, broken PDFs and page overruns", async () => {
    await expect(invoice({ file_base64: b64(await fx.scannedPdf()) })).rejects.toMatchObject({ code: "no_text_layer" });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await expect(invoice({ file_base64: b64(png) })).rejects.toMatchObject({ code: "unsupported_file_type" });
    await expect(invoice({ file_base64: "%%%not-base64%%%" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(invoice({ file_base64: b64("%PDF-1.4 garbage") })).rejects.toMatchObject({ code: "unreadable_pdf" });
    await expect(invoice({ file_base64: b64(await fx.manyPagePdf(4)) })).rejects.toMatchObject({ code: "too_many_pages" });
  });

  it("rejects files over 3 MB after decoding", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 1, 0x41);
    await expect(invoice({ file_base64: b64(big) })).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("refuses a PDF decompression bomb fast instead of inflating it (SECURITY.md R1)", async () => {
    const bomb = fx.decompressionBombPdf(1000); // ~1 MB file -> 1 GB content stream
    const t = performance.now();
    await expect(invoice({ file_base64: b64(bomb) })).rejects.toMatchObject({ code: "pdf_stream_too_large" });
    expect(performance.now() - t).toBeLessThan(3000);
    expect(process.memoryUsage().rss).toBeLessThan(1024 * 1024 * 1024);
  });

  it("stays fast on hostile 300k-character text (regex / wrap-join DoS)", async () => {
    const hostile = [
      "M-PESA STATEMENT\nTJ1AAA0001  2026-09-01 09:00:00 x COMPLETED 1.00 2.00\n" + "word\n".repeat(59_000),
      "TAX INVOICE KRA P000111222Z\nQty\nx " + "1 1.00 ".repeat(42_000),
    ];
    const t = performance.now();
    await statement({ text: hostile[0] });
    await invoice({ text: hostile[1] }).catch(() => undefined);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
