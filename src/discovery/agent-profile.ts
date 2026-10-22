/**
 * Who this agent is, in one place: name, public origin, DID owner and what it refuses.
 * Everything here is public. The owner address is the wallet that signs LAX listing updates
 * and bids; it never holds or receives customer funds (payments go to X402_PAY_TO).
 */
import type { AppConfig } from "../config.js";

export const AGENT_PROFILE = {
  name: "Kenya Agent Tools (LamuLabs)",
  description:
    "Pay per call tools for agents that handle Kenyan money: parses Safaricom M-PESA statements and KRA eTIMS invoices into checked JSON, and serves official Central Bank of Kenya KES exchange rates and conversions back to 2004. Files are processed in memory and never stored. Failed calls are not charged.",
  category: "Finance data",
  defaultOrigin: "https://mpesa-kra-parser.vercel.app",
  ownerAddress: "0x1E2fFb80EEe8C919b8369FB33A48415715879F1C",
  ownerChainId: 8453,
  refuses: [
    "Scanned or photographed PDFs with no text layer (422 no_text_layer, not charged)",
    "Any document that is not an M-PESA statement or a KRA eTIMS invoice (422 wrong_document_type or unrecognised_document, not charged)",
    "Files over 3 MB, statements over 60 pages, invoices over 3 pages (413, not charged)",
    "Dates in the future or before 2004-11-02, and rates older than 10 days for the date asked (not charged)",
    "Storing, logging or reusing uploaded files or passwords",
    "Financial, tax or trading advice: it returns facts and checks only",
  ],
} as const;

/** LAX requires the Five Laws in every offer. */
export const FIVE_LAWS = ["Solidarity Oath", "Renewal Mandate", "Treasury Equilibrium", "Harm Shield", "Transparency Covenant"] as const;

export const agentOrigin = (config: AppConfig): string => config.publicOrigin ?? AGENT_PROFILE.defaultOrigin;

/** did:web for an https origin (no path, port encoded as %3A per the did:web spec). */
export function didWebFor(origin: string): string {
  const url = new URL(origin);
  return `did:web:${url.host.replace(":", "%3A")}`;
}
