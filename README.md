# Kenya Agent Tools (LamuLabs)

A paid agent for other agents that handle Kenyan money. It parses Safaricom M-PESA statements and KRA eTIMS
invoices into checked JSON, and serves official Central Bank of Kenya (CBK) Kenya shilling exchange rates and
conversions back to 2004. Every call is paid per call in USDC on Base over x402. Failed calls are not charged.

- **Live endpoint:** https://mpesa-kra-parser.vercel.app/ (free catalogue at `GET /`)
- **LAX listing id:** pending (added after the listing is paid and accepted)
- **Agent DID:** `did:web:mpesa-kra-parser.vercel.app` (document at `/.well-known/did.json`)
- **LAX offer:** [`lax-offer.json`](lax-offer.json), also served at `/.well-known/lax-offer.json`
- **Source:** https://github.com/milan2307/kenya-agent-tools
- **AIAX manifest:** `/.well-known/aiax.json`, sections at `/aiax/sections/<skill_id>.json`

## Price per call

| Capability (`skill_id`) | Route | Price (USDC on Base) |
|---|---|---|
| `parse-mpesa-statement` | `POST /v1/parse/mpesa-statement` | 0.10 |
| `parse-etims-invoice` | `POST /v1/parse/etims-invoice` | 0.05 |
| `kes-fx-rates` | `GET /v1/fx/kes?currency=USD,EUR&date=YYYY-MM-DD` | 0.003 |
| `kes-fx-convert` | `GET /v1/fx/convert?amount=1500&from=USD&to=KES&date=YYYY-MM-DD` | 0.003 |

An unpaid call gets HTTP 402 with x402 v2 `exact` terms (USDC `0x8335...2913` on Base, `eip155:8453`) in the
`PAYMENT-REQUIRED` header. Pay with any x402 client and repeat the call. Any 4xx or 5xx answer is not settled.

Document body: `{ "file_base64": "...", "password": "optional" }` or `{ "text": "..." }`. Input and output
JSON Schemas for every capability are in `lax-offer.json`.

## Examples

[`examples/`](examples) holds three real requests and the answers this agent gave, one per paid test call:

1. `mpesa-statement.json`: a 5 row synthetic M-PESA statement to transactions, totals and a balance check.
2. `etims-invoice.json`: a synthetic KRA eTIMS invoice to PINs, CU numbers, items and VAT checks.
3. `kes-fx-convert.json`: 250 USD to KES at the CBK mean rate for 9 October 2026.

All names, PINs, phone numbers and receipts in the examples are invented. Regenerate them with
`npm run lax:artifacts`; tests fail if they drift from what the code returns.

## What it refuses

- Scanned or photographed PDFs with no text layer (422 `no_text_layer`, not charged).
- Any document that is not an M-PESA statement or a KRA eTIMS invoice (422, not charged).
- Files over 3 MB, statements over 60 pages, invoices over 3 pages (413, not charged).
- Dates in the future or before 2 November 2004, and rates more than 10 days older than the date asked (not charged).
- Storing, logging or reusing uploaded files or passwords. Files are processed in memory only.
- Financial, tax or trading advice. It returns facts and checks only.

## Run and test

```bash
npm install
npm test                       # tests A1 to A5 for the LAX acceptance items, plus parser, FX and API tests
npm run typecheck
X402_PAY_TO=0x... npm start    # local server on Base Sepolia through the public x402.org facilitator, no keys
```

Tests run offline: synthetic documents, synthetic FX fixtures and the bundled CBK snapshot.
`test/lax.test.ts` names each test after the acceptance item it proves (A1 to A5).

## Configuration

Names only; values live in the host's environment, never in git. See `.env.example`:
`X402_PAY_TO` (public receive address), `X402_FACILITATOR` (`cdp` for Base mainnet), `X402_NETWORK`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`.

## Code map

1. `src/products.ts`: what is sold. Routes, prices, descriptions, input and output schemas.
2. `src/http-app.ts`: thin routes. Body limit, HEAD refused on paid routes, x402 middleware, validate, one service call.
3. `src/discovery/`: DID document, LAX offer, AIAX manifest and the three examples, all built from `products.ts`.
4. `src/services/`: parse a document, CBK rates and conversion.
5. `src/parsers/`: pure M-PESA and eTIMS parsers.
6. `src/fx/`: CBK snapshot store, live tail refresh, data quality rules.
7. `src/payments/x402.ts`: the only file that knows about facilitators.
8. `src/config.ts`: the only file that reads environment variables.

## Data source

CBK indicative exchange rates, https://www.centralbank.go.ke/rates/forex-exchange-rates/ . Not affiliated with or
endorsed by CBK; indicative reference rates, not dealing rates. Every FX answer carries this notice.

## Security

See [SECURITY.md](SECURITY.md) for the attack pass on every route.

## Licence

MIT, copyright 2026 LamuLabs. See [LICENSE](LICENSE).
