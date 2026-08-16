// ============================================================================
// Chain resolution: precedence and the three filters. The critical property
// is that Phase 4 is a NO-OP for an existing Gemini-only org.
// ============================================================================
import { describe, expect, it, vi, beforeEach } from "vitest";

const { hasCredentialsForMock } = vi.hoisted(() => ({ hasCredentialsForMock: vi.fn() }));
vi.mock("../../../src/lib/ai/credentials", () => ({
  hasCredentialsFor: hasCredentialsForMock,
}));

import { resolveChain } from "../../../src/lib/ai/router";
import type { OrgAiSettings } from "../../../src/lib/ai/settings";

const baseSettings: OrgAiSettings = {
  taskChains: null,
  confidenceThresholds: {},
  autonomy: {},
  taskAllowlist: null,
  providerAllowlist: null,
  monthlySpendCapUsd: null,
  killSwitch: false,
};

describe("resolveChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the org has Gemini keys only — today's reality.
    hasCredentialsForMock.mockImplementation(async (_org: string, p: string) => p === "gemini");
  });

  it("is a no-op for a Gemini-only org: one Gemini hop, everything else filtered", async () => {
    const { hops, filtered } = await resolveChain({
      task: "transaction_parse",
      orgId: "org-1",
      settings: baseSettings,
    });
    expect(hops).toEqual([{ provider: "gemini", model: expect.any(String) }]);
    // The Anthropic hop is dropped for lack of allowlisting, not silently kept.
    expect(filtered.some((f) => f.provider === "anthropic")).toBe(true);
  });

  it("keeps the Anthropic hop once allowlisted AND credentialed", async () => {
    hasCredentialsForMock.mockResolvedValue(true);
    const { hops } = await resolveChain({
      task: "transaction_parse",
      orgId: "org-1",
      settings: { ...baseSettings, providerAllowlist: ["gemini", "anthropic"] },
    });
    expect(hops.map((h) => h.provider)).toEqual(["gemini", "anthropic"]);
  });

  it("drops an allowlisted provider that has no credentials", async () => {
    hasCredentialsForMock.mockImplementation(async (_o: string, p: string) => p === "gemini");
    const { hops, filtered } = await resolveChain({
      task: "transaction_parse",
      orgId: "org-1",
      settings: { ...baseSettings, providerAllowlist: ["gemini", "anthropic"] },
    });
    expect(hops.map((h) => h.provider)).toEqual(["gemini"]);
    expect(filtered.find((f) => f.provider === "anthropic")?.reason).toBe("no_credentials");
  });

  it("NEVER routes a document task off Gemini, even if an org override says so", async () => {
    hasCredentialsForMock.mockResolvedValue(true);
    const { hops, filtered } = await resolveChain({
      task: "statement_ocr",
      orgId: "org-1",
      settings: {
        ...baseSettings,
        providerAllowlist: ["gemini", "openai"],
        taskChains: {
          statement_ocr: [
            { provider: "openai", model: "gpt-4o" },
            { provider: "gemini", model: "gemini-ocr" },
          ],
        },
      },
    });
    expect(hops.every((h) => h.provider === "gemini")).toBe(true);
    expect(filtered.find((f) => f.provider === "openai")?.reason).toBe("ocr_policy_gemini_only");
  });

  it("honors an org chain override for a text task", async () => {
    hasCredentialsForMock.mockResolvedValue(true);
    const { hops } = await resolveChain({
      task: "match_assist",
      orgId: "org-1",
      settings: {
        ...baseSettings,
        providerAllowlist: ["gemini", "anthropic"],
        taskChains: { match_assist: [{ provider: "anthropic", model: "claude-custom" }] },
      },
    });
    expect(hops).toEqual([{ provider: "anthropic", model: "claude-custom" }]);
  });

  it("falls back to the org's legacy per-category model preference", async () => {
    const { hops } = await resolveChain({
      task: "statement_ocr",
      orgId: "org-1",
      settings: baseSettings,
      orgMetadata: JSON.stringify({ aiModelOcr: "gemini-legacy-choice" }),
    });
    expect(hops[0]).toEqual({ provider: "gemini", model: "gemini-legacy-choice" });
  });

  it("an explicit model override wins over everything", async () => {
    const { hops } = await resolveChain({
      task: "statement_ocr",
      orgId: "org-1",
      settings: baseSettings,
      orgMetadata: JSON.stringify({ aiModelOcr: "ignored" }),
      modelOverride: "explicit-model",
    });
    expect(hops).toEqual([{ provider: "gemini", model: "explicit-model" }]);
  });

  it("returns no hops when the org has no credentials at all", async () => {
    hasCredentialsForMock.mockResolvedValue(false);
    const { hops } = await resolveChain({
      task: "date_parse",
      orgId: "org-1",
      settings: baseSettings,
    });
    expect(hops).toEqual([]);
  });
});
