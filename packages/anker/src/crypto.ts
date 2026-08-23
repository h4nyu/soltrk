import { createECDH, createCipheriv, createHash } from "crypto";

// Hardcoded Anker Solix cloud public key (NIST P-256 / secp256r1, uncompressed
// point). Used for a semi-static ECDH key exchange: we generate a fresh
// ephemeral keypair per session, derive a shared secret against this fixed
// server key, and use it to AES-encrypt the login password - reverse
// engineered from anker_solix_api/session.py, not something we invented.
const ANKER_PUBLIC_KEY_HEX =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

export type AnkerKeyExchange = {
  /** Our ephemeral public key, uncompressed point hex (0x04 + 32B x + 32B y). */
  publicKeyHex: string;
  /** Raw ECDH shared secret (32 bytes for P-256) - also used as the AES-256 key. */
  sharedSecret: Buffer;
};

export function performKeyExchange(): AnkerKeyExchange {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(Buffer.from(ANKER_PUBLIC_KEY_HEX, "hex"));
  return {
    publicKeyHex: ecdh.getPublicKey("hex", "uncompressed"),
    sharedSecret,
  };
}

/**
 * AES-256-CBC encrypt `raw` (PKCS7 padded) using `sharedSecret` as both key
 * and IV source (IV = first 16 bytes of the 32-byte shared secret - this is
 * Anker's scheme, not a general-purpose crypto pattern to reuse elsewhere).
 */
export function encryptApiData(raw: string, sharedSecret: Buffer): string {
  const iv = sharedSecret.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", sharedSecret, iv);
  return Buffer.concat([cipher.update(raw, "utf-8"), cipher.final()]).toString("base64");
}

export function gtokenFromUserId(userId: string): string {
  return createHash("md5").update(userId).digest("hex");
}
