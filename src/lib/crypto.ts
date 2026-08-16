// ============================================================================
// Secret encryption — AES-256-GCM envelope for credentials at rest
//
// Envelope format:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
//   • AES-256-GCM, random 12-byte IV per value, 16-byte auth tag
//   • Encrypt always uses the primary key (SECRETS_ENCRYPTION_KEY)
//   • Decrypt tries the primary key, then the optional previous key
//     (SECRETS_ENCRYPTION_KEY_PREVIOUS) — the GCM tag authenticates which
//     key is correct, enabling zero-downtime key rotation.
//
// Values that do NOT carry the `enc:v1:` prefix are treated as legacy
// plaintext and returned unchanged (lazy migration): reads keep working
// before the backfill runs, and the next write re-encrypts them.
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createLogger } from "./logger";

const logger = createLogger("crypto.secrets");

const ENVELOPE_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKeys: { primary: Buffer; previous: Buffer | null } | null = null;
let warnedPlaintext = false;

/** Parse a base64 32-byte key from an env var, or throw a descriptive error. */
function parseKey(raw: string | undefined, name: string): Buffer {
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `${name} is missing. Generate one with \`openssl rand -base64 32\` and set it in the environment.`,
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), "base64");
  } catch {
    throw new Error(`${name} is not valid base64.`);
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${name} must decode to ${KEY_BYTES} bytes (got ${buf.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return buf;
}

function getKeys(): { primary: Buffer; previous: Buffer | null } {
  if (cachedKeys) return cachedKeys;
  const primary = parseKey(process.env.SECRETS_ENCRYPTION_KEY, "SECRETS_ENCRYPTION_KEY");
  const previousRaw = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
  const previous =
    previousRaw && previousRaw.trim().length > 0
      ? parseKey(previousRaw, "SECRETS_ENCRYPTION_KEY_PREVIOUS")
      : null;
  cachedKeys = { primary, previous };
  return cachedKeys;
}

/** Throw if the encryption key is missing or malformed. Call at startup / in scripts. */
export function assertEncryptionConfigured(): void {
  getKeys();
}

/** True if the value carries the encryption envelope prefix. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/** Encrypt a plaintext string into the `enc:v1:` envelope. */
export function encryptSecret(plain: string): string {
  const { primary } = getKeys();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, primary, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString(
    "base64",
  )}`;
}

function decryptWithKey(iv: Buffer, tag: Buffer, ciphertext: Buffer, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Decrypt an `enc:v1:` value. Values without the envelope prefix are legacy
 * plaintext and returned unchanged (warn-once) so reads work before backfill.
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    if (!warnedPlaintext) {
      warnedPlaintext = true;
      logger.warn("Reading a plaintext secret — run scripts/encrypt-org-secrets.ts to backfill.");
    }
    return value;
  }

  const parts = value.slice(ENVELOPE_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret: expected enc:v1:<iv>:<tag>:<ciphertext>.");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  const { primary, previous } = getKeys();
  try {
    return decryptWithKey(iv, tag, ciphertext, primary);
  } catch (primaryErr) {
    if (previous) {
      try {
        return decryptWithKey(iv, tag, ciphertext, previous);
      } catch {
        // fall through to the primary error below
      }
    }
    throw new Error(
      `Failed to decrypt secret (auth tag mismatch). The value may have been encrypted with a different SECRETS_ENCRYPTION_KEY. Original: ${
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
      }`,
    );
  }
}

/** Encrypt a value only if it is not already enveloped (idempotent). */
export function ensureEncrypted(value: string): string {
  return isEncrypted(value) ? value : encryptSecret(value);
}

/** Test-only: reset the cached key material so env changes take effect. */
export function __resetKeyCacheForTests(): void {
  cachedKeys = null;
  warnedPlaintext = false;
}
