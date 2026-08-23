import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Audit PR-20 — inbound email hardening. The webhook is a Nitro route and
 * the download sits behind provider mocks in the worker suite, so the
 * load-bearing shapes are pinned wiring-style.
 */
describe("inbound email hardening wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

  it("the webhook delivers to EVERY matched organization (C9)", () => {
    const source = read("server/routes/api/inbound-email/resend.post.ts");
    // The settings lookup fans out — no arbitrary first-match pick.
    expect(source).toContain("const matchedSettings = await db");
    expect(source).toContain("for (const settings of matchedSettings)");
    expect(source).toContain("deliveries.push({ organizationId: settings.organizationId");
    expect(source).not.toMatch(/matchedSettings[\s\S]{0,400}\.limit\(1\)/);
  });

  it("attachment downloads are size-capped and time-bounded", () => {
    const source = read("src/lib/jobs/handlers/inbound-email.ts");
    expect(source).toContain("MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024");
    expect(source).toContain("AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS)");
    // Both the declared length and the actual buffer are checked.
    expect(source.match(/MAX_INBOUND_ATTACHMENT_BYTES/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("the sender-authentication decision is recorded, allowlists are backlog", () => {
    const doc = read("docs/inbox-workflow.md");
    expect(doc).toContain("Sender authentication (recorded decision)");
    expect(doc).toContain("delivered to every matched organization");
    const backlog = read("docs/audit-backlog.md");
    expect(backlog).toContain("Per-organization sender allowlists");
  });
});
