/**
 * Client-facing failures. Any response >= 400 from a paid route is NOT settled,
 * so the caller is never charged for these.
 */
export type ParseErrorCode =
  | "invalid_request"
  | "unsupported_file_type"
  | "file_too_large"
  | "too_many_pages"
  | "pdf_stream_too_large"
  | "password_required"
  | "wrong_password"
  | "no_text_layer"
  | "unreadable_pdf"
  | "wrong_document_type"
  | "unrecognised_document";

const STATUS: Record<ParseErrorCode, 400 | 413 | 422> = {
  invalid_request: 400,
  unsupported_file_type: 422,
  file_too_large: 413,
  too_many_pages: 413,
  pdf_stream_too_large: 413,
  password_required: 422,
  wrong_password: 422,
  no_text_layer: 422,
  unreadable_pdf: 422,
  wrong_document_type: 422,
  unrecognised_document: 422,
};

export class ParseError extends Error {
  readonly status: 400 | 413 | 422;
  constructor(readonly code: ParseErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

/** FX route failures. Same rule: never settled, never charged. */
export type FxErrorCode = "invalid_request" | "date_out_of_range" | "rate_not_available" | "rates_unavailable";

const FX_STATUS: Record<FxErrorCode, 400 | 404 | 422 | 503> = {
  invalid_request: 400,
  date_out_of_range: 422,
  rate_not_available: 404,
  rates_unavailable: 503,
};

export class FxError extends Error {
  readonly status: 400 | 404 | 422 | 503;
  constructor(readonly code: FxErrorCode, message: string) {
    super(message);
    this.status = FX_STATUS[code];
  }
}
