/**
 * KRA eTIMS tax invoice / receipt -> structured JSON.
 * Field labels vary between invoicing systems, so each field accepts several labels.
 */
import type { EtimsInvoice, EtimsLineItem } from "../schema/output.js";
import { KRA_PIN, field, labelledValue, lastAmount, parseAmount, parseDate, roughlyEqual, round2 } from "./common.js";

const ITEMS_HEADER = /\b(qty|quantity)\b/i;
const TOTALS_START = /^(sub\s*-?total|total|taxable|vat|tax\b)/i;
const ITEM_ROW = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})(?:\s+([A-E]))?$/;
const BUYER_LABEL = /\b(buyer|customer|bill\s+to|client)\b/i;
const SELLER_LABEL = /\b(seller|supplier|vendor|company)\b/i;

export function looksLikeEtimsInvoice(lines: string[]): boolean {
  const text = lines.join(" ").toUpperCase();
  const hasKraMarker = /ETIMS|CU INVOICE|CU SERIAL|SCU ID|CONTROL UNIT|KRA/.test(text);
  return hasKraMarker && KRA_PIN.test(text) && /INVOICE|RECEIPT/.test(text);
}

export function parseEtimsInvoice(lines: string[], pages: number): EtimsInvoice {
  const warnings: string[] = [];
  const { sellerPin, buyerPin } = findPins(lines);
  const items = parseItems(lines);

  const taxable = totalOn(lines, /^(total\s+)?taxable(\s+amount)?|^total\s+(before|excl(uding)?)\s+(tax|vat)|^sub\s*-?total/i);
  const vat = totalOn(lines, /^(total\s+)?vat(\s+amount)?\b|^tax\s+amount|^total\s+tax/i);
  const total = totalOn(lines, /^(grand\s+)?total(?!\s+(taxable|before|excl|vat|tax))/i);

  const totalsAddUp = taxable !== null && vat !== null && total !== null ? roughlyEqual(taxable + vat, total, 1) : null;
  const vatIs16 = taxable !== null && vat !== null && taxable > 0 ? roughlyEqual(vat, taxable * 0.16, 1) : null;
  const itemSum = round2(items.reduce((s, i) => s + i.amount, 0));
  const itemsMatch =
    items.length === 0 ? null : [taxable, total].some((t) => t !== null && roughlyEqual(itemSum, t, 1));
  const amountConfidence = totalsAddUp ? 0.97 : 0.7;

  if (!sellerPin) warnings.push("Seller KRA PIN not found");
  if (totalsAddUp === false) warnings.push("Taxable amount + VAT does not equal the total");
  if (itemsMatch === false) warnings.push("Line items do not sum to the taxable amount or total");

  return {
    document_type: "etims_invoice",
    currency: "KES",
    pages,
    seller_name: nameField(lines, SELLER_LABEL, true),
    seller_pin: field(sellerPin, 0.97),
    buyer_name: nameField(lines, BUYER_LABEL, false),
    buyer_pin: field(buyerPin, 0.95),
    invoice_number: field(labelledValue(lines, /(tax\s+)?invoice\s+(no|number|#)\.?|receipt\s+(no|number)\.?/)?.split(/\s{2,}/)[0], 0.9),
    invoice_date: field(parseDate(labelledValue(lines, /(invoice\s+)?date/) ?? ""), 0.9),
    cu_serial_number: field(firstToken(labelledValue(lines, /cu\s+serial\s+(no|number)\.?|scu\s+id|cu\s+id/)), 0.95),
    cu_invoice_number: field(firstToken(labelledValue(lines, /cu\s+invoice\s+(no|number)\.?/)), 0.95),
    items,
    taxable_amount: field(taxable, amountConfidence),
    vat_amount: field(vat, amountConfidence),
    total_amount: field(total, amountConfidence),
    checks: { vat_is_16_percent: vatIs16, items_sum_matches: itemsMatch, totals_add_up: totalsAddUp },
    warnings,
  };
}

/** A PIN on a buyer/customer line is the buyer's; the first other PIN is the seller's. */
function findPins(lines: string[]) {
  let sellerPin: string | null = null;
  let buyerPin: string | null = null;
  for (const line of lines) {
    const pin = line.match(KRA_PIN)?.[0];
    if (!pin) continue;
    if (BUYER_LABEL.test(line)) buyerPin ??= pin;
    else sellerPin ??= pin;
  }
  return { sellerPin, buyerPin };
}

function nameField(lines: string[], label: RegExp, isSeller: boolean) {
  const nameLabel = new RegExp(`${label.source}(\\s+name)?(?!\\s+pin)`, "i");
  const labelled = labelledValue(lines, nameLabel);
  if (labelled && !KRA_PIN.test(labelled)) return field(labelled, 0.9);
  if (!isSeller) return field<string>(null, 0);
  // Fallback: invoices usually open with the seller's name above the title.
  const first = lines.find((l) => !/tax invoice|invoice|receipt|etims/i.test(l) && /[A-Za-z]{3}/.test(l));
  return field(first ?? null, 0.5);
}

function parseItems(lines: string[]): EtimsLineItem[] {
  const start = lines.findIndex((l) => ITEMS_HEADER.test(l));
  if (start < 0) return [];
  const items: EtimsLineItem[] = [];
  for (const line of lines.slice(start + 1)) {
    if (TOTALS_START.test(line)) break;
    const m = line.match(ITEM_ROW);
    if (!m) continue;
    items.push({
      description: m[1].trim(),
      quantity: Number(m[2]),
      unit_price: parseAmount(m[3]),
      amount: parseAmount(m[4]) ?? 0,
      tax_code: m[5] ?? null,
    });
  }
  return items;
}

function totalOn(lines: string[], label: RegExp): number | null {
  const line = lines.find((l) => label.test(l));
  return line ? lastAmount(line) : null;
}

function firstToken(value: string | null): string | null {
  return value?.split(/\s+/)[0] ?? null;
}
