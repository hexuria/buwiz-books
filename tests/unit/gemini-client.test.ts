import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callWithRetry, GeminiRateLimitError } from "../../src/lib/gemini-client";
import { encryptSecret } from "../../src/lib/crypto";

// ── Hoisted mocks (must be declared before vi.mock) ─────────────────────────
const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

// ── Mock DB — prevents any real PostgreSQL connection ────────────────────────
vi.mock("@/db", () => ({
  db: {
    select: selectMock,
  },
}));

vi.mock("@/db/schema/auth", () => ({
  organization: {
    id: "id",
    metadata: "metadata",
  },
  organizationSecrets: {
    organizationId: "organization_id",
    geminiApiKeys: "gemini_api_keys",
    resendApiKey: "resend_api_key",
    stripeSecretKey: "stripe_secret_key",
    stripeWebhookSecret: "stripe_webhook_secret",
    paypalClientSecret: "paypal_client_secret",
  },
}));

// ── Mock @google/generative-ai ──────────────────────────────────────────────
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: class {
      apiKey: string;
      constructor(apiKey: string) {
        this.apiKey = apiKey;
      }
      getGenerativeModel(opts: any) {
        return {
          ...opts,
          apiKey: this.apiKey,
        };
      }
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Configures the selectMock to serve both queries in getOrgGeminiConfig:
 * the org-metadata select and the organization_secrets select (via
 * getOrganizationSecrets). Keys are stored encrypted, exercising the
 * decrypt-on-read path. Mirrors the chain: select().from().where().limit(1).
 */
function mockOrgWithKeys(keys: string[]) {
  const row = {
    metadata: JSON.stringify({}),
    geminiApiKeys: keys.map((key) => encryptSecret(key)),
    resendApiKey: null,
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    paypalClientSecret: null,
  };
  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  selectMock.mockReturnValue({ from });
}

describe("Gemini Client - Smart Per-Key Rotation & Backoff", () => {
  // Each test gets a unique ORG_ID to avoid cross-test contamination of
  // the module-level healthMap and rrIndexMap (keyed by orgId).
  let ORG_ID: string;

  beforeEach(() => {
    ORG_ID = crypto.randomUUID();
    // Seed the mock to return an org with 3 API keys
    mockOrgWithKeys(["key-1", "key-2", "key-3"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should successfully call the function with the first key", async () => {
    let usedKey = "";

    const result = await callWithRetry({ orgId: ORG_ID }, async (model: any) => {
      usedKey = model.apiKey;
      return "success";
    });

    expect(result).toBe("success");
    expect(usedKey).toBe("key-1");
  });

  it("should rotate to the next key after MAX_RETRIES_PER_KEY (3) failures", async () => {
    let callCount = 0;
    const usedKeys: string[] = [];

    const result = await callWithRetry({ orgId: ORG_ID }, async (model: any) => {
      callCount++;
      usedKeys.push(model.apiKey);

      // Fail exactly 3 times (exhausting the first key)
      if (callCount <= 3) {
        throw new Error("429 Too Many Requests"); // Transient error
      }

      return "success-on-key-2";
    });

    expect(result).toBe("success-on-key-2");
    expect(callCount).toBe(4);

    // First 3 tries should use the same key
    const firstKey = usedKeys[0];
    expect(usedKeys[1]).toBe(firstKey);
    expect(usedKeys[2]).toBe(firstKey);

    // 4th try should rotate to a different key
    expect(usedKeys[3]).not.toBe(firstKey);
  });

  it("should throw non-transient errors immediately without retrying", async () => {
    let callCount = 0;

    const promise = callWithRetry({ orgId: ORG_ID }, async () => {
      callCount++;
      throw new Error("Invalid Request or Bad Config"); // Not a 429
    });

    await expect(promise).rejects.toThrow("Invalid Request or Bad Config");
    expect(callCount).toBe(1); // Should not retry
  });

  it("should throw GeminiRateLimitError when ALL keys are exhausted", async () => {
    let callCount = 0;

    const promise = callWithRetry({ orgId: ORG_ID }, async () => {
      callCount++;
      throw new Error("Resource Exhausted 429");
    });

    // 3 keys * 3 retries = 9 total attempts
    await expect(promise).rejects.toThrow(GeminiRateLimitError);
    expect(callCount).toBe(9);
  }, 30000); // Allow time for the sleep() backoffs (1s, 2s per key * 3 keys)

  it("disables an invalid key and rotates to the next (no per-key retries)", async () => {
    const usedKeys: string[] = [];

    const result = await callWithRetry({ orgId: ORG_ID }, async (model: any) => {
      usedKeys.push(model.apiKey);
      if (model.apiKey === "key-1") {
        throw new Error("[400 Bad Request] API key not valid. Please pass a valid API key.");
      }
      return "ok-on-key-2";
    });

    expect(result).toBe("ok-on-key-2");
    expect(usedKeys[0]).toBe("key-1");
    // Invalid key is disabled immediately — tried once, never retried
    expect(usedKeys.filter((k) => k === "key-1").length).toBe(1);
    // Rotated to some other (valid) key to succeed
    expect(usedKeys.some((k) => k !== "key-1")).toBe(true);
  });

  it("throws a clear 'invalid' error when ALL keys are rejected", async () => {
    let callCount = 0;

    const promise = callWithRetry({ orgId: ORG_ID }, async () => {
      callCount++;
      throw new Error("API_KEY_INVALID: API key not valid");
    });

    await expect(promise).rejects.toThrow(/rejected as invalid/i);
    // Each of the 3 keys tried exactly once — invalid keys get no per-key retries
    expect(callCount).toBe(3);
  });
});
