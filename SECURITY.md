# Attack-your-own-app pass - 2026-10-15 (local, pre-deploy)

Scope: this API only (2 paid POST routes, 2 free GETs). No DB, no accounts, no storage, no admin.
Evidence = `npm test` (28 passing) + scratch probes noted below.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Hide API keys | Pass. Only env var *names* in repo (`.env.example`); `.env*` gitignored; `GET /` returns no secrets. | `rg` secret scan; test "GET / lists both products … no secrets" |
| 2 | RLS | N/A - no database. | - |
| 3 | IDOR | N/A - no record IDs; stateless. | - |
| 4 | Git secrets | Pass - tree scan clean; repo is new (no history). | `rg -i "api_key|secret|private_key|0x[0-9a-f]{64}"` |
| 5 | Admin routes | N/A - none exist. | - |
| 6 | User isolation | Pass - no module-level caches; each request parsed and discarded. | code review: no state outside request scope |
| 7 | Rate limits | Paid routes are priced; unpaid requests get a locally built 402 (no facilitator call). **See R1/R2.** | test "oversized bodies are rejected before any facilitator call" |
| 8 | Storage buckets | N/A - nothing written anywhere (no fs, no blob, no logs of content). | `rg "writeFile|fs\." src` → none |
| 9 | Validate inputs | Pass - strict zod body (unknown fields rejected), base64 check, 4.4 MB body cap before payment, 3 MB decoded cap, page caps (60 / 3), magic-byte sniff (PDF or UTF-8 text only). | parser + API tests |
| 10 | Unauthenticated routes | Pass - only `/` and `/health` are free and return no PII; both `/v1/parse/*` routes require x402 payment. | 402 tests |
| 11 | SQL injection | N/A - no SQL. Regexes tested for catastrophic backtracking instead. | test "stays fast on hostile 300k-character text" |
| 12 | Sensitive logs | Pass - only the error *name* is logged; passwords/document text never logged. | test "never logs document content or passwords" |
| 13 | Field tampering | Pass - price/payTo/network come from server config; `price` etc. in body → 400; a payment signed for the $0.05 route is refused on the $0.10 route. | tests |
| 14 | File uploads | Pass with R1 - type sniff, size + page caps, pdf.js 6.1 (no font eval path; CVE-2024-4367 class not applicable), font loading disabled, no storage. | tests |
| 15 | Server-side logic | Pass - all checks server-side. | - |
| 16 | Trim responses | Pass - errors are `{code, message}` only; parsed data is withheld if settlement fails. | test "when settlement fails the parsed data is withheld" |
| 17 | Sessions | N/A - no sessions/cookies. | - |
| 18 | Dependencies | Pass - `npm audit`: 0 vulnerabilities (prod + dev). | `npm audit` |
| 19 | Record access | N/A. | - |
| 20 | Hostile pass | Done as a stranger (no payment, garbage header, cross-route replay, oversized body, bad JSON, wrong doc type, binaries, broken/scanned PDFs, hostile text) and as a paying buyer. Findings below. | - |

## Findings

**Fixed (real):** F1 - a 300k-char statement with thousands of continuation lines took ~3 s to parse
(details-wrap concatenation). Capped wrapped details at 300 chars → 66 ms. Regression test added.

**Open (real, medium, availability only - owner decision):**
- **R1 PDF decompression bomb.** A ~2 MB PDF whose content stream inflates to 2 GB drove the process to
  ~4.4 GB RSS / 11 s before returning `no_text_layer`. pdf.js has no inflate cap. To reach the parser the
  attacker needs a payment that passes facilitator verify (a wallet holding ≥ $0.05 USDC); because a 5xx/4xx
  is never settled, the same authorization can be reused, so a funded attacker can repeatedly crash a function
  instance for free. No data exposure. Mitigations, pick one: (a) Vercel Firewall rate limit on `/v1/*`
  (config only, recommended first), (b) run extraction in a worker thread with a hard timeout (more code),
  (c) settle `upfront` before parsing (closes it but buyers then pay for failed parses).
  `vercel.json` already caps `maxDuration` at 15 s.
- **R2 Verify-then-settle replay.** x402's default flow verifies, runs the handler, then settles. Several
  concurrent requests carrying the same signed authorization can each get parsed before one settles; the
  rest receive 402 and no data (tested: settlement failure withholds the body). Cost to us: wasted CPU only.
  Same mitigations as R1.

**Hypothetical (not coded):** facilitator compromise returning `isValid` for unpaid requests (would require
CDP/x402.org to turn hostile); KRA PIN / M-Pesa layout variants we have not seen (accuracy risk, not security -
needs real-but-redacted samples, which we do not have).

---
# Pre-ship gate re-run - 2026-10-16 (Base mainnet production)

Live: https://mpesa-kra-parser.vercel.app (Vercel project `mpesa-kra-parser`, CDP facilitator, Base mainnet).
Evidence: `npm test` 32/32, `npm audit` 0, CDP `/x402/validate` valid=true for both routes, live hostile pass below.

**R1 PDF decompression bomb - FIXED.** `scripts/cap-pdf-decoded-streams.mjs` (postinstall) caps every decoded pdf.js
stream at 32 MiB on both decode paths (sync `DecodeStream.ensureBuffer` and the native `DecompressionStream` fast path);
it fails the install if the targeted pdf.js code changes, and `unpdf` is pinned to 1.8.1. The error maps to
413 `pdf_stream_too_large` (not settled).
- Before (unpatched): 500 MB bomb 3.3 s / 1.19 GB RSS; 2 GB bomb 13.3 s / 4.39 GB RSS, returned `no_text_layer`.
- After: 50 MB / 500 MB / 2 GB bombs 0.24-0.39 s, RSS ≤ 230 MB, `pdf_stream_too_large`.
- Regression test "refuses a PDF decompression bomb fast" fails on unpatched pdf.js (8.6 s, wrong code) and passes patched.
- Vercel build log confirms `pdf.js decoded-stream cap applied (32 MiB, 2 paths)`.

**Config guard - ADDED.** `loadConfig` refuses `VERCEL_ENV=production` unless `X402_FACILITATOR=cdp` and
`X402_NETWORK=eip155:8453`, so production can never silently fall back to testnet defaults (tests in `test/config.test.ts`).

**R2 verify-then-settle replay - reduced, still open (low).** With R1 fixed a replayed authorization costs at most one
bounded parse (< 0.5 s) and returns no data. A Vercel WAF rule "Rate limit paid parse routes" (`/v1/` prefix, 60 req /
60 s per IP, fixed window) is saved and active in the project firewall config, but a 90-request burst from one IP was
not throttled in testing, so treat it as unproven (may need the Rate Limiting pricing dialog accepted in the dashboard).

**Live hostile pass (unpaid, 2026-10-16):** garbage `PAYMENT-SIGNATURE` / `X-PAYMENT` → 402; bad JSON → 402 (payment checked
first); 5 MB body → 413 at the Vercel edge; `price` field in body → 402 (server price only); GET on paid route, `/v1/parse`,
`/admin` → 404 JSON; `GET /` has no secrets; HSTS, nosniff, `Cache-Control: no-store` present. Deployment protection is off
on purpose (agents must reach it); only `/` and `/health` are free and carry no PII. Secrets live only as Vercel
sensitive env vars (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`); repo scan clean.

---
# A5 gate - CBK KES FX routes (2026-10-16)

Scope: `GET /v1/fx/kes`, `GET /v1/fx/convert`, the bundled snapshot and the live CBK refresh path.

**Real, fixed**
- **F1 HEAD bypassed the paywall.** Hono answers HEAD with the GET handler, and the x402 route table is keyed `GET …`,
  so `HEAD /v1/fx/kes` ran the lookup unpaid (200, and could trigger a CBK fetch). Now `/v1/*` refuses HEAD with 405
  before the payment middleware. Test: "HEAD cannot run a paid lookup unpaid". Before: 200 + 1 CBK call; after: 405 + 0.
- **F2 CBK's paging is unstable.** Paging table 32 without a stable sort lost ~700 of 97,606 rows and duplicated others.
  The snapshot builder now queries per exact currency label and fails unless rows received == CBK's `recordsFiltered`.
- **F3 Selling CBK keying errors.** 119 obviously wrong points (shifted currencies, inverted EAC quotes on 2017-03-28,
  AUD mid-2006) are withheld (`src/fx/clean.ts`), listed in the snapshot, and flagged in `fallback_reason`.
- **F4 Freezing a same-day rate.** The snapshot now stops the day before the build so today's rate always comes live.

**Controls checked (tests in `test/fx.test.ts`)**
- Input: zod `.strict()` on the query (unknown params 400), ISO calendar dates only, ≤120-char currency list, amount
  `^\d{1,13}(\.\d{1,8})?$` and ≤ 1e12 (no `1e5`, negatives, Infinity). Future dates and pre-coverage dates 422. All 4xx/5xx unsettled.
- SSRF: the CBK URL is a constant; requests choose only table id/date range/label. `redirect: "error"`, 6 s timeout, 1 MB cap.
- Refresh abuse: only paid (verified) requests for dates newer than the snapshot can trigger a fetch; single-flight,
  ≤ 1 per 30 min per instance (5 min after failure). Unpaid traffic gets the 402 before any handler runs.
- Cache poisoning: live rows are accepted only if newer than the snapshot, not in the future (Nairobi date), and within
  25 % of the last trusted value; they can never overwrite snapshot rows. Memory bounded (≤ 60 days × 21).
- Failure: CBK down → last trusted rate with `live_check: "failed"` and `is_fallback`; > 10 days stale → 503 unpaid.
- Logs: only `fx_refresh_failed` + a 120-char error message; no query, payer or header data.

**Hypothetical (not coded):** a compromised or spoofed CBK response inside the 25 % band (needs CBK or TLS compromise);
a genuine > 25 % one-day move on a live day (would be withheld until the next snapshot; the response says so);
R2 verify-then-settle replay applies here too but costs only a cached lookup; no per-IP rate limit (calls are paid).

---
# A9 gate: LAX discovery routes (2026-10-22)

Scope: `GET /.well-known/did.json`, `/.well-known/lax-offer.json`, `/.well-known/aiax.json`, `/aiax/sections/:file`.
All free, read-only, static JSON built from `products.ts` and `src/discovery/agent-profile.ts`.

Checklist (attack-your-own-app), with evidence from a local hostile pass and `test/lax.test.ts`:
1, 4. Secrets: responses grepped for secret/api_key/private/CDP/PEM/64-hex patterns: no hits. The only address published is
   the public LAX owner (signing) address; its key lives outside the repo. `git grep` for key patterns: clean.
2, 3, 6, 19. RLS, IDOR, user isolation, record access: N/A, no users, no records, no storage.
5. Admin routes: none.
7. Rate limits: static responses, `Cache-Control: public, max-age=300` (CDN absorbs load). No per-IP limit (accepted).
8. Buckets: none.
9. Inputs: the only input is `:file`; looked up in the fixed `ALL_PAID` list. `../`, `%2e%2e%2f`, `__proto__`,
   `constructor`, missing `.json`: all 404 (tested). Query strings ignored.
10. Unauthenticated: intended; nothing mutates, no PII.
11. Injection: no DB, no shell, no templates.
12. Logs: these routes log nothing.
13. Field tampering: prices and payTo come from server code; nothing client supplied reaches them.
14. Uploads: none on these routes. POST/PUT (including a 5 MB body) to discovery paths: 404 without reading the body.
15, 16. Server logic and trimmed responses: offer/DID/AIAX contain only public listing data.
17. Sessions: none.
18. Dependencies: `npm audit`: 0 vulnerabilities (ajv@8 added as a dev dependency for schema tests).
20. Hostile pass: HEAD 200 (free route, harmless), OPTIONS 404, CORS `*` only on discovery routes (paid routes unchanged),
   paid routes still 402 unpaid.

Real findings: none. Hypothetical: none worth coding.
