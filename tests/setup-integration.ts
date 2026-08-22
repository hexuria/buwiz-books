import { loadTestEnv } from "./load-test-env";

loadTestEnv();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

// TEST_DATABASE_URL is the only accepted database input for this project.
// Normalize both legacy runtime variables before application modules are
// imported so an unrelated developer or production URL can never be used.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_ADMIN = testDatabaseUrl;

// Integration tests exercise local adapters, not live email or encryption
// providers. These deterministic, test-owned values satisfy eager constructors
// without enabling any external provider suite.
process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 42).toString("base64");
process.env.RESEND_API_KEY ??= "re_test_integration_only";
