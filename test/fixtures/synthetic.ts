import { deflateSync } from "node:zlib";
/**
 * SYNTHETIC test documents. Every name, number, PIN and receipt here is invented;
 * phone numbers use the 0700 000 000 placeholder range and PINs are not real KRA PINs.
 */
import PDFDocument from "pdfkit";

export type SyntheticTxn = {
  receipt: string;
  time: string; // "YYYY-MM-DD HH:MM:SS"
  details: string;
  paidIn: number;
  withdrawn: number;
  balance: number;
};

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Deterministic statement: `count` rows, oldest opening balance 60,000, returned newest-first like Safaricom does. */
export function syntheticTransactions(count = 45): SyntheticTxn[] {
  const kinds = [
    { details: "Funds received from 0700***001 - TEST SENDER ONE", inflow: true },
    { details: "Customer Transfer to 0700***002 - TEST RECIPIENT TWO", inflow: false },
    { details: "Pay Bill Online to 000111 - SAMPLE POWER CO Acc. 00000000001", inflow: false },
    { details: "Merchant Payment Online to 000222 - SAMPLE SUPERMARKET", inflow: false },
    { details: "Business Payment from 000333 - SAMPLE EMPLOYER LTD via API", inflow: true },
  ];
  let balance = 60000;
  const rows: SyntheticTxn[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length];
    const amount = 100 + ((i * 137) % 2400) + (i % 3) * 0.5;
    balance = Math.round((balance + (kind.inflow ? amount : -amount)) * 100) / 100;
    const day = String(1 + Math.floor(i / 2)).padStart(2, "0");
    const hh = String(8 + (i % 10)).padStart(2, "0");
    rows.push({
      receipt: `TJ${String(i).padStart(2, "0")}X${"ABCDEFG"[i % 7]}${String(1000 + i).slice(-4)}Q`.slice(0, 10),
      time: `2026-09-${day} ${hh}:${String((i * 7) % 60).padStart(2, "0")}:05`,
      details: kind.details,
      paidIn: kind.inflow ? amount : 0,
      withdrawn: kind.inflow ? 0 : amount,
      balance,
    });
  }
  return rows.reverse();
}

export const STATEMENT_HEADER = {
  name: "WANJIRU TEST CUSTOMER",
  mobile: "0700 000 000",
  period: { start: "2026-09-01", end: "2026-09-30" },
  requestDate: "2026-10-01",
};

/** Text layout matching what `pdftotext -layout` gives for a real statement (withdrawals negative, empty column omitted). */
export function mpesaStatementText(rows = syntheticTransactions()): string {
  return [
    "M-PESA STATEMENT",
    `Customer Name: ${STATEMENT_HEADER.name}`,
    `Mobile Number: ${STATEMENT_HEADER.mobile}`,
    "Email Address: test.customer@example.com",
    "Statement Period: 01 Sep 2026 - 30 Sep 2026",
    "Request Date: 01 Oct 2026",
    "DETAILED STATEMENT",
    "Receipt No.  Completion Time  Details  Transaction Status  Paid In  Withdrawn  Balance",
    ...rows.map(
      (r) =>
        `${r.receipt}  ${r.time}  ${r.details}  COMPLETED  ${r.paidIn ? fmt(r.paidIn) : `-${fmt(r.withdrawn)}`}  ${fmt(r.balance)}`,
    ),
    "Disclaimer: This is a synthetic test statement.",
  ].join("\n");
}

export async function mpesaStatementPdf(opts: { password?: string; rows?: SyntheticTxn[] } = {}): Promise<Buffer> {
  const rows = opts.rows ?? syntheticTransactions();
  return renderPdf({ userPassword: opts.password }, (doc) => {
    doc.fontSize(14).text("M-PESA STATEMENT", 40, 40);
    doc.fontSize(9);
    doc.text(`Customer Name: ${STATEMENT_HEADER.name}`, 40, 70);
    doc.text(`Mobile Number: ${STATEMENT_HEADER.mobile}`, 40, 84);
    doc.text("Statement Period: 01 Sep 2026 - 30 Sep 2026", 40, 98);
    doc.text("Request Date: 01 Oct 2026", 40, 112);
    doc.text("DETAILED STATEMENT", 40, 140);
    const cols = [40, 105, 200, 400, 455, 500, 545];
    const header = (y: number) =>
      ["Receipt No.", "Completion Time", "Details", "Status", "Paid In", "Withdrawn", "Balance"].forEach((h, i) =>
        doc.fontSize(7).text(h, cols[i], y, { lineBreak: false }),
      );
    let y = 160;
    header(y);
    y += 14;
    for (const r of rows) {
      if (y > 760) {
        doc.addPage();
        y = 40;
        header(y);
        y += 14;
      }
      const cells = [
        r.receipt,
        r.time,
        wrapAt(r.details, 44)[0],
        "COMPLETED",
        r.paidIn ? fmt(r.paidIn) : "",
        r.withdrawn ? `-${fmt(r.withdrawn)}` : "",
        fmt(r.balance),
      ];
      cells.forEach((cell, i) => cell && doc.fontSize(6.5).text(cell, cols[i], y, { lineBreak: false }));
      // Long details wrap onto a second visual line, as in real statements.
      const [, rest] = wrapAt(r.details, 44);
      if (rest) doc.fontSize(6.5).text(rest, cols[2], y + 8, { lineBreak: false });
      y += rest ? 18 : 11;
    }
  });
}

export const INVOICE = {
  sellerName: "NYOTA TEST HARDWARE LTD",
  sellerPin: "P000111222Z",
  buyerName: "MFANO TEST BUILDERS LTD",
  buyerPin: "P000333444Y",
  invoiceNo: "INV-2026-00123",
  date: "2026-10-14",
  cuSerial: "KRACU0300000001",
  cuInvoice: "KRACU0300000001/152",
  items: [
    { description: "Cement 50kg bag", qty: 10, unit: 850, amount: 8500 },
    { description: "Steel bar Y12 6m", qty: 4, unit: 1250, amount: 5000 },
    { description: "Delivery within Nairobi", qty: 1, unit: 1500, amount: 1500 },
  ],
  taxable: 15000,
  vat: 2400,
  total: 17400,
};

export function etimsInvoiceLines(): string[] {
  const i = INVOICE;
  return [
    i.sellerName,
    "TAX INVOICE",
    `Seller PIN: ${i.sellerPin}`,
    `Buyer Name: ${i.buyerName}`,
    `Buyer PIN: ${i.buyerPin}`,
    `Invoice No: ${i.invoiceNo}`,
    "Date: 14/10/2026",
    "Description  Qty  Unit Price  Amount  Tax",
    ...i.items.map((it) => `${it.description}  ${it.qty}  ${fmt(it.unit)}  ${fmt(it.amount)}  B`),
    `Taxable Amount B (16%):  ${fmt(i.taxable)}`,
    `VAT 16%:  ${fmt(i.vat)}`,
    `TOTAL:  KES ${fmt(i.total)}`,
    "SCU INFORMATION",
    `SCU ID: ${i.cuSerial}`,
    `CU Invoice No: ${i.cuInvoice}`,
    "Internal Data: TESTTESTTESTTESTTESTTESTTE",
    "Receipt Signature: TESTSIGNATURE0001",
  ];
}

export async function etimsInvoicePdf(): Promise<Buffer> {
  return renderPdf({}, (doc) => {
    let y = 40;
    for (const line of etimsInvoiceLines()) {
      doc.fontSize(9).text(line, 40, y, { lineBreak: false });
      y += 14;
    }
  });
}

/** Image-only PDF (no text layer), like a phone scan. */
export async function scannedPdf(): Promise<Buffer> {
  return renderPdf({}, (doc) => {
    doc.rect(40, 40, 300, 200).fill("#cccccc");
  });
}

export async function manyPagePdf(pages: number): Promise<Buffer> {
  return renderPdf({}, (doc) => {
    for (let p = 0; p < pages; p++) {
      if (p) doc.addPage();
      doc.text(`TAX INVOICE page ${p + 1} KRA P000111222Z CU Invoice No: X`, 40, 40);
    }
  });
}

/** Split at the last space before `width`, as a PDF table cell would wrap. */
function wrapAt(text: string, width: number): [string, string] {
  if (text.length <= width) return [text, ""];
  const cut = text.lastIndexOf(" ", width);
  return [text.slice(0, cut), text.slice(cut + 1)];
}

function renderPdf(options: { userPassword?: string }, draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      pdfVersion: options.userPassword ? "1.7" : "1.4",
      userPassword: options.userPassword,
      info: { Title: "Synthetic test document", Producer: "x402-parser tests" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });
}

/** Tiny PDF whose single content stream inflates to `inflatedMb` MB of spaces (decompression bomb). */
export function decompressionBombPdf(inflatedMb: number): Buffer {
  const content = deflateSync(Buffer.alloc(inflatedMb * 1024 * 1024, 0x20), { level: 9 });
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
  ];
  let head = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(head));
    head += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  offsets.push(Buffer.byteLength(head));
  head += `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`;
  let tail = "\nendstream\nendobj\n";
  const xrefAt = Buffer.byteLength(head) + content.length + tail.length;
  tail +=
    `xref\n0 5\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(head), content, Buffer.from(tail)]);
}
