import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetKeyCacheForTests,
  assertEncryptionConfigured,
  decryptSecret,
  encryptSecret,
  ensureEncrypted,
  isEncrypted,
} from "../../../src/lib/crypto";

// A second valid 32-byte base64 key, distinct from the one in .env.test.
const KEY_B = Buffer.alloc(32, 7).toString("base64");

describe("crypto — secret encryption envelope", () => {
  const originalPrimary = process.env.SECRETS_ENCRYPTION_KEY;
  const originalPrevious = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;

  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = originalPrimary;
    delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    __resetKeyCacheForTests();
  });

  afterEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = originalPrimary;
    if (originalPrevious === undefined) delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    else process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = originalPrevious;
    __resetKeyCacheForTests();
  });

  it("round-trips a value through encrypt/decrypt", () => {
    const secret = "AIzaSy-super-secret-key-1234";
    const enc = encryptSecret(secret);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("passes through legacy plaintext values unchanged", () => {
    expect(isEncrypted("re_plaintextkey")).toBe(false);
    expect(decryptSecret("re_plaintextkey")).toBe("re_plaintextkey");
  });

  it("ensureEncrypted is idempotent", () => {
    const enc = encryptSecret("x");
    expect(ensureEncrypted(enc)).toBe(enc);
    const fromPlain = ensureEncrypted("y");
    expect(isEncrypted(fromPlain)).toBe(true);
    expect(decryptSecret(fromPlain)).toBe("y");
  });

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const enc = encryptSecret("tamper-me");
    // Corrupt the last base64 char of the ciphertext segment.
    const flipped = enc.slice(0, -1) + (enc.at(-1) === "A" ? "B" : "A");
    expect(() => decryptSecret(flipped)).toThrow(/decrypt/i);
  });

  it("throws on a malformed envelope", () => {
    expect(() => decryptSecret("enc:v1:onlyonepart")).toThrow(/Malformed/i);
  });

  it("decrypts with the previous key after rotation", () => {
    const secret = "rotate-me";
    const encWithOld = encryptSecret(secret); // encrypted with the .env.test key

    // Rotate: new key becomes primary, old key moves to PREVIOUS.
    process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = originalPrimary;
    process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
    __resetKeyCacheForTests();

    // Old ciphertext still decrypts via the previous key.
    expect(decryptSecret(encWithOld)).toBe(secret);
    // New writes use the new primary and still round-trip.
    const encWithNew = encryptSecret(secret);
    expect(decryptSecret(encWithNew)).toBe(secret);
  });

  it("throws a descriptive error when the key is missing", () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    expect(() => assertEncryptionConfigured()).toThrow(/SECRETS_ENCRYPTION_KEY is missing/);
    expect(() => encryptSecret("x")).toThrow(/SECRETS_ENCRYPTION_KEY is missing/);
  });

  it("throws when the key is not 32 bytes", () => {
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    __resetKeyCacheForTests();
    expect(() => assertEncryptionConfigured()).toThrow(/32 bytes/);
  });
});
