/** The did:web document served at /.well-known/did.json. */
import { AGENT_PROFILE, didWebFor } from "./agent-profile.js";

export function didDocument(origin: string) {
  const id = didWebFor(origin);
  const owner = `${id}#lax-owner`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/secp256k1recovery-2020/v2"],
    id,
    verificationMethod: [
      {
        id: owner,
        type: "EcdsaSecp256k1RecoveryMethod2020",
        controller: id,
        blockchainAccountId: `eip155:${AGENT_PROFILE.ownerChainId}:${AGENT_PROFILE.ownerAddress}`,
      },
    ],
    authentication: [owner],
    assertionMethod: [owner],
    service: [
      { id: `${id}#api`, type: "X402PaidApi", serviceEndpoint: `${origin}/` },
      { id: `${id}#lax-offer`, type: "LaxOffer", serviceEndpoint: `${origin}/.well-known/lax-offer.json` },
      { id: `${id}#aiax`, type: "AiaxManifest", serviceEndpoint: `${origin}/.well-known/aiax.json` },
    ],
  };
}
