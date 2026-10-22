/** Query-string contracts for the FX routes. Format only; date-range rules live in the service. */
import { z } from "zod";
import { CURRENCY_CODES, isCurrencyCode, type CurrencyCode } from "../fx/currencies.js";
import { isRealIsoDate } from "../fx/dates.js";

const isoDate = z
  .string()
  .max(10)
  .refine(isRealIsoDate, "date must be a real calendar date as YYYY-MM-DD");

const currencyList = z
  .string()
  .max(120)
  .transform((s) => [...new Set(s.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean))])
  .refine((codes) => codes.length > 0 && codes.every(isCurrencyCode), {
    message: `currency must be one or more of ${CURRENCY_CODES.join(",")} (comma-separated)`,
  })
  .transform((codes) => codes as CurrencyCode[]);

const convertCurrency = z
  .string()
  .max(3)
  .transform((s) => s.trim().toUpperCase())
  .refine((c) => c === "KES" || isCurrencyCode(c), { message: `must be KES or one of ${CURRENCY_CODES.join(",")}` })
  .transform((c) => c as CurrencyCode | "KES");

export const MAX_AMOUNT = 1_000_000_000_000;

export const rateQuerySchema = z.object({ currency: currencyList.optional(), date: isoDate.optional() }).strict();

export const convertQuerySchema = z
  .object({
    amount: z
      .string()
      .regex(/^\d{1,13}(\.\d{1,8})?$/, "amount must be a plain positive decimal like 1500 or 99.95")
      .transform(Number)
      .refine((n) => n > 0 && n <= MAX_AMOUNT, `amount must be > 0 and <= ${MAX_AMOUNT}`),
    from: convertCurrency,
    to: convertCurrency,
    date: isoDate.optional(),
  })
  .strict();

export type RateQuery = z.infer<typeof rateQuerySchema>;
export type ConvertQuery = z.infer<typeof convertQuerySchema>;
