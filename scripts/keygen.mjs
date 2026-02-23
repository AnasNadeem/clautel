#!/usr/bin/env node

/**
 * One-time Ed25519 keypair generator for the license proxy.
 *
 * Usage: node scripts/keygen.mjs
 *
 * Output:
 *   - Private key hex (64 chars) → set as Cloudflare secret: wrangler secret put ED25519_PRIVATE_KEY_HEX
 *   - Public key hex (64 chars) → embed in src/license.ts as ED25519_PUBLIC_KEY_HEX
 */

import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

// Export as raw bytes
const pubRaw = publicKey.export({ type: "spki", format: "der" });
const privRaw = privateKey.export({ type: "pkcs8", format: "der" });

// Ed25519 SPKI is 44 bytes: 12-byte prefix + 32-byte key
const pubHex = pubRaw.subarray(12).toString("hex");
// Ed25519 PKCS8 is 48 bytes: 16-byte prefix + 32-byte key
const privHex = privRaw.subarray(16).toString("hex");

console.log("=== Ed25519 Keypair ===\n");
console.log(`Private key (for Cloudflare secret):\n  ${privHex}\n`);
console.log(`Public key (for src/license.ts):\n  ${pubHex}\n`);
console.log("--- Next steps ---");
console.log("1. cd proxy && wrangler secret put ED25519_PRIVATE_KEY_HEX");
console.log("   Paste the private key hex when prompted.\n");
console.log("2. Update ED25519_PUBLIC_KEY_HEX in src/license.ts with the public key hex.\n");
