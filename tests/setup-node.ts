// Unit tests exercise the encryption boundary with a deterministic local key.
// This is test-owned configuration, not a provider or developer environment
// requirement. Individual tests remain free to delete or replace it.
if (!process.env.SECRETS_ENCRYPTION_KEY) {
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
}
