const confirmation = "gemini-ocr";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (process.env.AI_EVALS_MODE !== "live") {
  throw new Error("Live AI eval setup requires AI_EVALS_MODE=live");
}
if (process.env.AI_LIVE_PROVIDER_CONFIRM !== confirmation) {
  throw new Error(`Live AI evals require AI_LIVE_PROVIDER_CONFIRM=${confirmation}`);
}
if (!process.env.GEMINI_API_KEY) {
  throw new Error("Live AI evals require GEMINI_API_KEY");
}
if (!process.env.AI_OCR_FIXTURES_DIR) {
  throw new Error("Live AI evals require an explicit AI_OCR_FIXTURES_DIR");
}
if (!testDatabaseUrl) {
  throw new Error("Live AI evals require an explicit TEST_DATABASE_URL");
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_ADMIN = testDatabaseUrl;
process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 42).toString("base64");

export {};
