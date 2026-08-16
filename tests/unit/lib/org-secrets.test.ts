import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrganizationSecrets, updateOrganizationSecrets } from "../../../src/lib/org-secrets";
import { decryptSecret, encryptSecret, isEncrypted } from "../../../src/lib/crypto";

// ── Minimal Drizzle mock — captures writes, serves reads ─────────────────────
type Row = Record<string, unknown>;
let storedRow: Row | null = null;
let lastInsertValues: Row | null = null;
let lastConflictSet: Row | null = null;

const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => (storedRow ? [storedRow] : [])),
      })),
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn((values: Row) => {
      lastInsertValues = values;
      return {
        onConflictDoUpdate: vi.fn(async ({ set }: { set: Row }) => {
          lastConflictSet = set;
        }),
      };
    }),
  })),
} as never;

describe("org-secrets — encryption at rest", () => {
  beforeEach(() => {
    storedRow = null;
    lastInsertValues = null;
    lastConflictSet = null;
    vi.clearAllMocks();
  });

  it("encrypts every secret on write", async () => {
    await updateOrganizationSecrets(mockDb, "org-1", {
      geminiApiKeys: ["gem-key-1", "gem-key-2"],
      resendApiKey: "re_123",
      stripeSecretKey: "sk_live_abc",
    });

    const written = lastInsertValues!;
    const keys = written.geminiApiKeys as string[];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(isEncrypted(k)).toBe(true);
    expect(decryptSecret(keys[0])).toBe("gem-key-1");
    expect(isEncrypted(written.resendApiKey as string)).toBe(true);
    expect(decryptSecret(written.resendApiKey as string)).toBe("re_123");
    expect(isEncrypted(written.stripeSecretKey as string)).toBe(true);
    // Conflict branch only carries the patched fields.
    expect(lastConflictSet).not.toHaveProperty("paypalClientSecret");
  });

  it("preserves explicit nulls (clearing a secret)", async () => {
    await updateOrganizationSecrets(mockDb, "org-1", { resendApiKey: null });
    expect(lastConflictSet!.resendApiKey).toBeNull();
  });

  it("decrypts encrypted values on read", async () => {
    storedRow = {
      geminiApiKeys: [encryptSecret("gem-a"), encryptSecret("gem-b")],
      resendApiKey: encryptSecret("re_x"),
      stripeSecretKey: null,
      stripeWebhookSecret: encryptSecret("whsec_y"),
      paypalClientSecret: null,
    };

    const secrets = await getOrganizationSecrets(mockDb, "org-1");
    expect(secrets.geminiApiKeys).toEqual(["gem-a", "gem-b"]);
    expect(secrets.resendApiKey).toBe("re_x");
    expect(secrets.stripeSecretKey).toBeNull();
    expect(secrets.stripeWebhookSecret).toBe("whsec_y");
  });

  it("reads legacy plaintext rows unchanged (lazy migration)", async () => {
    storedRow = {
      geminiApiKeys: ["plain-key"],
      resendApiKey: "re_plain",
      stripeSecretKey: null,
      stripeWebhookSecret: null,
      paypalClientSecret: null,
    };

    const secrets = await getOrganizationSecrets(mockDb, "org-1");
    expect(secrets.geminiApiKeys).toEqual(["plain-key"]);
    expect(secrets.resendApiKey).toBe("re_plain");
  });

  it("supports the masked-key round-trip (mask post-decrypt, re-encrypt on save)", async () => {
    // Read: stored encrypted → decrypted for masking.
    storedRow = {
      geminiApiKeys: [encryptSecret("AIzaSyExample1234")],
      resendApiKey: null,
      stripeSecretKey: null,
      stripeWebhookSecret: null,
      paypalClientSecret: null,
    };
    const secrets = await getOrganizationSecrets(mockDb, "org-1");
    const mask = `••••${secrets.geminiApiKeys[0].slice(-4)}`;
    expect(mask).toBe("••••1234");

    // Save: the settings route maps masks back to the decrypted real key,
    // then updateOrganizationSecrets re-encrypts it.
    const byMask = new Map(secrets.geminiApiKeys.map((k) => [`••••${k.slice(-4)}`, k]));
    const nextKeys = [byMask.get(mask)!];
    await updateOrganizationSecrets(mockDb, "org-1", { geminiApiKeys: nextKeys });
    const written = (lastInsertValues!.geminiApiKeys as string[])[0];
    expect(isEncrypted(written)).toBe(true);
    expect(decryptSecret(written)).toBe("AIzaSyExample1234");
  });

  it("propagates DB errors instead of masking them as 'not configured'", async () => {
    // A config-load failure must stay distinguishable from an org that
    // genuinely has no keys (ai_findings #11) — the swallow-and-log decision
    // belongs to callers like gemini-client, never to this accessor.
    const failingDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              throw new Error("connection refused");
            }),
          })),
        })),
      })),
    } as never;

    await expect(getOrganizationSecrets(failingDb, "org-1")).rejects.toThrow("connection refused");
  });

  it("returns empty secrets when no row exists", async () => {
    const secrets = await getOrganizationSecrets(mockDb, "missing-org");
    expect(secrets.geminiApiKeys).toEqual([]);
    expect(secrets.resendApiKey).toBeNull();
  });
});
