/**
 * Use case: one paid call -> one parsed document.
 * Route handlers stay thin; all parsing decisions live here.
 */
import type { ParseRequest } from "../schema/input.js";
import type { ParsedDocument } from "../schema/output.js";
import { looksLikeEtimsInvoice, parseEtimsInvoice } from "../parsers/etims-invoice.js";
import { looksLikeMpesaStatement, parseMpesaStatement } from "../parsers/mpesa-statement.js";
import { readDocumentText } from "./document-text.js";
import { ParseError } from "./errors.js";

export type DocumentKind = "mpesa_statement" | "etims_invoice";

const PARSERS: Record<
  DocumentKind,
  { maxPages: number; detect: (lines: string[]) => boolean; parse: (lines: string[], pages: number) => ParsedDocument }
> = {
  mpesa_statement: { maxPages: 60, detect: looksLikeMpesaStatement, parse: parseMpesaStatement },
  etims_invoice: { maxPages: 3, detect: looksLikeEtimsInvoice, parse: parseEtimsInvoice },
};

export const maxPagesFor = (kind: DocumentKind) => PARSERS[kind].maxPages;

export async function parseDocument(kind: DocumentKind, req: ParseRequest): Promise<ParsedDocument> {
  const parser = PARSERS[kind];
  const { lines, pages } = await readDocumentText(req, parser.maxPages);

  if (!parser.detect(lines)) {
    const actual = (Object.keys(PARSERS) as DocumentKind[]).find((k) => k !== kind && PARSERS[k].detect(lines));
    throw actual
      ? new ParseError("wrong_document_type", `This looks like a ${actual}; use the ${actual} route`)
      : new ParseError("unrecognised_document", `Not recognised as a ${kind}`);
  }
  return parser.parse(lines, pages);
}
