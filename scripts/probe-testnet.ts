/**
 * Live check against a running server (default http://localhost:8402) on Base Sepolia:
 *  1. unpaid POST -> expect 402 + PAYMENT-REQUIRED challenge
 *  2. POST paid by a throwaway, UNFUNDED key generated in memory -> expect the facilitator
 *     to reject it (insufficient funds). Proves the real verify path works without moving money.
 * The key is never printed or saved.
 */
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const base = process.argv[2] ?? "http://localhost:8402";
const url = `${base}/v1/parse/etims-invoice`;
const body = JSON.stringify({ text: "TAX INVOICE\nSeller PIN: P000000000A\nCU Invoice No: X\nTotal: 1.00" });
const init = { method: "POST", headers: { "content-type": "application/json" }, body };

const unpaid = await fetch(url, init);
const challenge = JSON.parse(Buffer.from(unpaid.headers.get("payment-required") ?? "", "base64").toString() || "{}");
console.log("1) unpaid:", unpaid.status, JSON.stringify(challenge.accepts?.[0]));

const client = new x402Client();
const account = privateKeyToAccount(generatePrivateKey());
registerExactEvmScheme(client, { signer: account });
const paid = await wrapFetchWithPayment(fetch, client)(url, init);
const verdict = paid.headers.get("payment-required");
const detail = verdict ? JSON.parse(Buffer.from(verdict, "base64").toString()).error : await paid.text();
console.log(`2) paid by unfunded throwaway ${account.address}:`, paid.status, detail);
