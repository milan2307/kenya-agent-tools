/**
 * postinstall: caps every decoded PDF stream at 32 MiB inside the pdf.js copy bundled by unpdf.
 *
 * Why: pdf.js has no inflate limit, so a ~2 MB PDF whose content stream inflates to 2 GB drove one
 * function instance to 4.4 GB RSS (SECURITY.md R1). pdf.js decodes streams on two paths, and both
 * get the same guard:
 *   1. DecodeStream.ensureBuffer: the sync path every filter (Flate, LZW, RunLength, ...) grows through.
 *   2. asyncGetBytesFromDecompressionStream: the native DecompressionStream fast path for Flate/Brotli.
 *      pdf.js swallows errors there and falls back to path 1, which then throws.
 * The thrown error (message starts with `DecodedStreamTooLarge`) is mapped to a 413 in src/services/document-text.ts (never settled).
 *
 * Fails the install (and so the deploy) if the pdf.js code it targets has changed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_DECODED_STREAM_BYTES = 32 * 1024 * 1024;
const MARKER = "DecodedStreamTooLarge";
// pdf.js re-wraps errors crossing its worker boundary (name becomes UnknownErrorException), so the marker rides in the message.
const tooLarge = `{throw Error(\`${MARKER}: decoded PDF stream exceeds 32 MiB\`)}`;

const PATCHES = [
  {
    name: "DecodeStream.ensureBuffer",
    target: "ensureBuffer(e){let t=this.buffer;if(e<=t.byteLength)return t;",
    guarded: `ensureBuffer(e){if(e>${MAX_DECODED_STREAM_BYTES})${tooLarge}let t=this.buffer;if(e<=t.byteLength)return t;`,
  },
  {
    name: "asyncGetBytesFromDecompressionStream",
    target: "let a=[],o=0;for await(let e of n)a.push(e),o+=e.byteLength;",
    guarded: `let a=[],o=0;for await(let e of n){if(o+=e.byteLength,o>${MAX_DECODED_STREAM_BYTES})${tooLarge}a.push(e)}`,
  },
];

const file = fileURLToPath(new URL("../node_modules/unpdf/dist/pdfjs.mjs", import.meta.url));
let source = readFileSync(file, "utf8");

if (source.includes(MARKER)) {
  console.log("pdf.js decoded-stream cap already applied");
  process.exit(0);
}
for (const { name, target, guarded } of PATCHES) {
  const hits = source.split(target).length - 1;
  if (hits !== 1) {
    console.error(`cap-pdf-decoded-streams: expected 1 match for ${name} in ${file}, found ${hits}. Re-check SECURITY.md R1 before upgrading unpdf.`);
    process.exit(1);
  }
  source = source.replace(target, guarded);
}
writeFileSync(file, source);
console.log(`pdf.js decoded-stream cap applied (32 MiB, ${PATCHES.length} paths)`);
