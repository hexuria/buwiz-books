import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Deterministic secret-encryption key for tests, so the crypto / org-secrets /
// financial-account-secrets suites are hermetic — they don't depend on a
// (gitignored) .env.test providing SECRETS_ENCRYPTION_KEY. A real key in the
// environment still wins.
if (!process.env.SECRETS_ENCRYPTION_KEY) {
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});
