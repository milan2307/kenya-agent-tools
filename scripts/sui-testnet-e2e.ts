/**
 * Live end-to-end test of the Sui rail on Sui TESTNET only (no real money).
 *
 *   SUI_TESTNET_PAYER_KEY_FILE=/path/to/testnet-only.key SUI_X402_PAY_TO=0x... npx tsx scripts/sui-testnet-e2e.ts
 *
 * The payer key must be a throwaway testnet key funded from the public faucet. It is read from a file and
 * never printed. The script refuses to run against anything but sui:testnet.
 * Asset: native testnet SUI (Circle's testnet USDC faucet needs a browser captcha); the code path for USDC
 * differs only in coin selection, and the facilitator is asset-agnostic.
 */
import fs from "node:fs";
import { serve } from "@hono/node-server";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { createApp } from "../src/http-app.js";
import { loadConfig } from "../src/config.js";
import { defaultRateStore } from "../src/fx/default-store.js";
import { createPaymentMiddleware } from "../src/payments/x402.js";

const RPC = "https://fullnode.testnet.sui.io:443";
const AMOUNT = 3_000_000n; // 0.003 testnet SUI per call
const payTo = (process.env.SUI_X402_PAY_TO ?? "").toLowerCase();
const keyFile = process.env.SUI_TESTNET_PAYER_KEY_FILE ?? "";
if (!/^0x[0-9a-f]{64}$/.test(payTo) || !keyFile) throw new Error("set SUI_X402_PAY_TO and SUI_TESTNET_PAYER_KEY_FILE");

const config = loadConfig({
  X402_PAY_TO: "0x000000000000000000000000000000000000dEaD", // Base side unused here (Sepolia defaults)
  SUI_X402_PAY_TO: payTo,
  SUI_X402_NETWORK: "sui:testnet",
  SUI_X402_ASSET: "0x2::sui::SUI",
  SUI_X402_FIXED_AMOUNT: AMOUNT.toString(),
  SUI_X402_FACILITATOR_URL: process.env.SUI_X402_FACILITATOR_URL ?? "https://sui-facilitator.onrender.com",
});
if (config.sui?.network !== "sui:testnet") throw new Error("testnet only");

const app = createApp(config, await createPaymentMiddleware(config), { rateStore: defaultRateStore });
const server = serve({ fetch: app.fetch, port: 0 });
await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const client = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });
const payer = Ed25519Keypair.fromSecretKey(fs.readFileSync(keyFile, "utf8").trim());
const payerAddr = payer.toSuiAddress();
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const dec = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : undefined);
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => { results.push({ check: name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

async function signPayment(to: string, amount: bigint) {
  const tx = new Transaction();
  tx.setSender(payerAddr);
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], to);
  const bytes = await tx.build({ client });
  const { signature } = await payer.signTransaction(bytes);
  return { transaction: Buffer.from(bytes).toString("base64"), signature };
}

const balance = async (owner: string) => BigInt((await client.core.getBalance({ owner, coinType: "0x2::sui::SUI" })).balance.balance);

try {
  console.log(`payer ${payerAddr}\npayTo ${payTo}\nfacilitator ${config.sui!.facilitatorUrl}`);
  // A date inside the bundled snapshot, so the test does not depend on the CBK website being fast.
  const url = `${base}/v1/fx/kes?currency=USD&date=2026-10-09`;

  // 1. unpaid -> 402 listing Base and Sui
  const r402 = await fetch(url);
  const ch = dec(r402.headers.get("payment-required"));
  const sui = ch?.accepts?.find((a: any) => a.network === "sui:testnet");
  check("402 lists Base + Sui options", r402.status === 402 && ch.accepts.length === 2 && !!sui, JSON.stringify(sui));

  const payToBefore = await balance(payTo);
  const payerBefore = await balance(payerAddr);

  // 2. paid call
  const signed = await signPayment(sui.payTo, BigInt(sui.amount));
  const header = enc({ x402Version: 2, resource: ch.resource, accepted: sui, payload: signed });
  const paid = await fetch(url, { headers: { "payment-signature": header } });
  const settle = dec(paid.headers.get("payment-response"));
  const body = await paid.json();
  check("paid call -> 200 with data", paid.status === 200 && body?.rates?.[0]?.currency === "USD", `status ${paid.status}, USD mean ${body?.rates?.[0]?.mean} (${body?.rates?.[0]?.rate_date})`);
  check("PAYMENT-RESPONSE carries a settled digest", settle?.success === true && typeof settle.transaction === "string", settle?.transaction ?? "");

  // 3. independent on-chain recompute (do not trust the facilitator)
  const txr: any = await client.core.waitForTransaction({ digest: settle.transaction, include: { balanceChanges: true, effects: true } });
  const t = txr.Transaction ?? txr.transaction ?? txr;
  const changes: any[] = t.balanceChanges ?? [];
  const toPayTo = changes.filter((b) => b.address.toLowerCase() === payTo && b.coinType.endsWith("::sui::SUI")).reduce((s, b) => s + BigInt(b.amount), 0n);
  check("on-chain: payTo credited exactly the price", toPayTo === AMOUNT, `+${toPayTo} MIST`);
  const payToAfter = await balance(payTo);
  check("payTo balance rose by the price", payToAfter - payToBefore === AMOUNT, `${payToBefore} -> ${payToAfter}`);
  const payerAfter = await balance(payerAddr);
  const gas = payerBefore - payerAfter - AMOUNT;
  check("payer paid price + own gas only", gas > 0n && gas < 10_000_000n, `gas ${gas} MIST (${Number(gas) / 1e9} SUI)`);

  // 4. replay the same payment
  const replay = await fetch(url, { headers: { "payment-signature": header } });
  check("replay of a spent payment -> 402", replay.status === 402, (await replay.json()).error);

  // 5. claims our terms but pays 1 MIST less
  const under = enc({ x402Version: 2, resource: ch.resource, accepted: sui, payload: await signPayment(sui.payTo, BigInt(sui.amount) - 1n) });
  const ru = await fetch(url, { headers: { "payment-signature": under } });
  check("underpayment -> 402", ru.status === 402, (await ru.json()).error);

  // 6. claims our terms but pays someone else
  const other = enc({ x402Version: 2, resource: ch.resource, accepted: sui, payload: await signPayment(payerAddr, BigInt(sui.amount)) });
  const ro = await fetch(url, { headers: { "payment-signature": other } });
  check("payment to another address -> 402", ro.status === 402, (await ro.json()).error);

  // 7. valid payment on a bad request: served 400, never broadcast
  const p7 = await signPayment(sui.payTo, BigInt(sui.amount));
  const bad = await fetch(`${base}/v1/fx/kes?currency=XXX`, { headers: { "payment-signature": enc({ x402Version: 2, resource: ch.resource, accepted: sui, payload: p7 }) } });
  const b7 = await balance(payTo);
  check("bad request -> 400 and the payment is not settled", bad.status === 400 && b7 === payToAfter, `payTo still ${b7}`);

  fs.writeFileSync("scripts/sui-testnet-e2e.last.json", JSON.stringify({ ranAt: new Date().toISOString(), network: "sui:testnet", payer: payerAddr, payTo, digest: settle?.transaction, gasMist: gas.toString(), results }, null, 2));
} finally {
  server.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
