import { describe, expect, it } from "vitest";
import { resolveChainPolicy } from "../../../src/lib/ai/router-policy";
import type { OrgAiSettings } from "../../../src/lib/ai/settings-policy";

const baseSettings: OrgAiSettings = {
  taskChains: null,
  confidenceThresholds: {},
  autonomy: {},
  taskAllowlist: null,
  providerAllowlist: null,
  monthlySpendCapUsd: null,
  killSwitch: false,
};

describe("resolveChainPolicy", () => {
  const geminiOnly = (provider: string) => provider === "gemini";

  it("is a no-op for a Gemini-only organization", async () => {
    const { hops, filtered } = await resolveChainPolicy({
      task: "transaction_parse",
      settings: baseSettings,
      hasCredentialsFor: geminiOnly,
    });

    expect(hops).toEqual([{ provider: "gemini", model: expect.any(String) }]);
    expect(filtered.some((entry) => entry.provider === "anthropic")).toBe(true);
  });

  it("keeps an allowlisted and credentialed provider", async () => {
    const { hops } = await resolveChainPolicy({
      task: "transaction_parse",
      settings: { ...baseSettings, providerAllowlist: ["gemini", "anthropic"] },
      hasCredentialsFor: () => true,
    });

    expect(hops.map((hop) => hop.provider)).toEqual(["gemini", "anthropic"]);
  });

  it("drops an allowlisted provider without credentials", async () => {
    const { hops, filtered } = await resolveChainPolicy({
      task: "transaction_parse",
      settings: { ...baseSettings, providerAllowlist: ["gemini", "anthropic"] },
      hasCredentialsFor: geminiOnly,
    });

    expect(hops.map((hop) => hop.provider)).toEqual(["gemini"]);
    expect(filtered.find((entry) => entry.provider === "anthropic")?.reason).toBe("no_credentials");
  });

  it("never routes a document task away from Gemini", async () => {
    const { hops, filtered } = await resolveChainPolicy({
      task: "statement_ocr",
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
      hasCredentialsFor: () => true,
    });

    expect(hops.every((hop) => hop.provider === "gemini")).toBe(true);
    expect(filtered.find((entry) => entry.provider === "openai")?.reason).toBe(
      "ocr_policy_gemini_only",
    );
  });

  it("honors an organization chain override for a text task", async () => {
    const { hops } = await resolveChainPolicy({
      task: "match_assist",
      settings: {
        ...baseSettings,
        providerAllowlist: ["gemini", "anthropic"],
        taskChains: { match_assist: [{ provider: "anthropic", model: "claude-custom" }] },
      },
      hasCredentialsFor: () => true,
    });

    expect(hops).toEqual([{ provider: "anthropic", model: "claude-custom" }]);
  });

  it("falls back to the legacy per-category model preference", async () => {
    const { hops } = await resolveChainPolicy({
      task: "statement_ocr",
      settings: baseSettings,
      orgMetadata: JSON.stringify({ aiModelOcr: "gemini-legacy-choice" }),
      hasCredentialsFor: geminiOnly,
    });

    expect(hops[0]).toEqual({ provider: "gemini", model: "gemini-legacy-choice" });
  });

  it("lets an explicit model override win", async () => {
    const { hops } = await resolveChainPolicy({
      task: "statement_ocr",
      settings: baseSettings,
      orgMetadata: JSON.stringify({ aiModelOcr: "ignored" }),
      modelOverride: "explicit-model",
      hasCredentialsFor: geminiOnly,
    });

    expect(hops).toEqual([{ provider: "gemini", model: "explicit-model" }]);
  });

  it("returns no hops when the organization has no credentials", async () => {
    const { hops } = await resolveChainPolicy({
      task: "date_parse",
      settings: baseSettings,
      hasCredentialsFor: () => false,
    });

    expect(hops).toEqual([]);
  });
});
