import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createCipheriv } from "crypto";
import { encryptApiData } from "./crypto";

const ANKER_PUBLIC_KEY_HEX =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

// Cross-validated against the actual Python reference implementation
// (anker_solix_api/session.py) using a fixed private key scalar (12345) on
// both sides - public key, derived shared secret, and encrypted password
// ciphertext all came back byte-for-byte identical. That confirms this is a
// faithful port, not a fresh (and therefore unverifiable) reimplementation.
// This test locks in the same fixed-key derivation using this module's
// exported pieces to catch any future regression in the ECDH/AES-256-CBC
// parameters (curve, IV source, padding).
function deriveWithFixedKey(scalar: bigint) {
  const privKeyBuf = Buffer.alloc(32);
  privKeyBuf.writeBigUInt64BE(scalar, 24);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privKeyBuf);
  const publicKeyHex = ecdh.getPublicKey("hex", "uncompressed");
  const sharedSecret = ecdh.computeSecret(Buffer.from(ANKER_PUBLIC_KEY_HEX, "hex"));
  return { publicKeyHex, sharedSecret };
}

test("ECDH + AES-256-CBC matches the Python reference implementation", () => {
  const { publicKeyHex, sharedSecret } = deriveWithFixedKey(12345n);

  assert.equal(
    publicKeyHex,
    "0426efcebd0ee9e34a669187e18b3a9122b2f733945b649cc9f9f921e9f9dad81290238bde9cc7bb330d150c67704dd25ae7055205744b6f31bf4070745872d0e6",
  );
  assert.equal(
    sharedSecret.toString("hex"),
    "aab0cfbd0587018bfabca74b01a3c0ede6844e6d8e6b6adfe218e0d52e4c1580",
  );

  const encrypted = encryptApiData("TestPassword123!", sharedSecret);
  assert.equal(encrypted, "IvpZ4MzThQTMkczENCoy4oL4ijerMrUYEX0GKHGvhwE=");
});

test("encryptApiData is deterministic for a given shared secret", () => {
  // Sanity check independent of the fixed-key fixture above: same inputs,
  // same IV-from-shared-secret scheme, should always produce the same output.
  const iv = Buffer.alloc(16, 7);
  const key = Buffer.concat([iv, Buffer.alloc(16, 9)]);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const expected = Buffer.concat([cipher.update("hello", "utf-8"), cipher.final()]).toString(
    "base64",
  );
  assert.equal(encryptApiData("hello", key), expected);
});
