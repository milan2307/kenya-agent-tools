/**
 * Turns the request body into plain text lines, entirely in memory.
 * Nothing is written to disk, cached, or logged.
 */
import { extractTextItems, getDocumentProxy, type StructuredTextItem } from "unpdf";
import { MAX_FILE_BYTES, type ParseRequest } from "../schema/input.js";
import { ParseError } from "./errors.js";

export type DocumentText = { lines: string[]; pages: number };

const PDF_MAGIC = "%PDF-";
/** Message marker of the error thrown by the pdf.js decode cap that scripts/cap-pdf-decoded-streams.mjs installs. */
const DECODED_STREAM_TOO_LARGE = "DecodedStreamTooLarge";

export async function readDocumentText(req: ParseRequest, maxPages: number): Promise<DocumentText> {
  if (req.text !== undefined) {
    return { lines: splitLines(req.text), pages: 1 };
  }
  const bytes = decodeBase64(req.file_base64!);
  if (startsWith(bytes, PDF_MAGIC)) {
    return readPdf(bytes, req.password, maxPages);
  }
  return { lines: splitLines(decodeUtf8Text(bytes)), pages: 1 };
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new ParseError("invalid_request", "file_base64 is not valid base64");
  }
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length === 0) throw new ParseError("invalid_request", "file_base64 decodes to an empty file");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ParseError("file_too_large", `File exceeds ${MAX_FILE_BYTES / (1024 * 1024)} MB`);
  }
  return new Uint8Array(bytes);
}

function decodeUtf8Text(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError("unsupported_file_type", "Only text-based PDFs and UTF-8 text are supported");
  }
  // Binary formats (images, zip, office files) contain control bytes.
  if (/[\u0000-\u0008\u000E-\u001F]/.test(text)) {
    throw new ParseError("unsupported_file_type", "Only text-based PDFs and UTF-8 text are supported");
  }
  return text;
}

async function readPdf(bytes: Uint8Array, password: string | undefined, maxPages: number): Promise<DocumentText> {
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, {
      password,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: true,
      verbosity: 0, // silence font warnings; text extraction does not need font files
    });
  } catch (err) {
    throw pdfOpenError(err, password);
  }

  try {
    if (pdf.numPages > maxPages) {
      throw new ParseError("too_many_pages", `This route accepts at most ${maxPages} pages`);
    }
    const { items } = await extractTextItems(pdf).catch((err: unknown) => {
      throw String((err as { message?: unknown })?.message).startsWith(DECODED_STREAM_TOO_LARGE)
        ? new ParseError("pdf_stream_too_large", "A PDF stream inflates beyond 32 MiB; send a normal statement or invoice")
        : err;
    });
    const lines = items.flatMap(itemsToLines);
    if (lines.join("").replace(/\s/g, "").length < 20) {
      throw new ParseError("no_text_layer", "PDF has no text layer (scanned image?); OCR is not supported yet");
    }
    return { lines, pages: pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy(); // release worker memory; bytes are never persisted
  }
}

function pdfOpenError(err: unknown, password: string | undefined): ParseError {
  const name = (err as { name?: string })?.name;
  if (name === "PasswordException") {
    return password
      ? new ParseError("wrong_password", "The PDF password is incorrect")
      : new ParseError("password_required", "This PDF is encrypted; send its password in `password`");
  }
  return new ParseError("unreadable_pdf", "The PDF could not be read");
}

/** Group positioned text items into visual lines (top to bottom, left to right). */
function itemsToLines(items: StructuredTextItem[]): string[] {
  const rows = new Map<number, StructuredTextItem[]>();
  for (const item of items) {
    if (!item.str.trim()) continue;
    const key = Math.round(item.y / 2) * 2; // 2pt tolerance for baseline jitter
    const row = rows.get(key) ?? [];
    row.push(item);
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str.trim())
        .join("  "),
    );
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  return [...ascii].every((ch, i) => bytes[i] === ch.charCodeAt(0));
}
