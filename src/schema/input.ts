/** Request body accepted by both paid parse routes. */
import { z } from "zod";

export const MAX_FILE_BYTES = 3 * 1024 * 1024; // decoded; keeps base64 body under Vercel's 4.5 MB limit
export const MAX_TEXT_CHARS = 300_000;
export const MAX_BODY_BYTES = 4_400_000;

export const parseRequestSchema = z
  .object({
    /** The document (PDF or UTF-8 text) as base64. */
    file_base64: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4).optional(),
    /** Already-extracted text, as an alternative to a file. */
    text: z.string().min(1).max(MAX_TEXT_CHARS).optional(),
    /** Password for an encrypted PDF (M-Pesa statements usually are). Used in memory only. */
    password: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.file_base64) !== Boolean(b.text), {
    message: "Send exactly one of file_base64 or text",
  });

export type ParseRequest = z.infer<typeof parseRequestSchema>;
