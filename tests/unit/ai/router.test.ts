import { describe, expect, it } from "vitest";
import { DEFAULT_CHAINS, DOCUMENT_TASKS, JEV_MODEL, JEV_TASKS } from "../../../src/lib/ai/chains";
import { resolveChainPolicy } from "../../../src/lib/ai/router-policy";
import type { OrgAiSettings } from "../../../src/lib/ai/settings-policy";
import type { AiTaskName } from "../../../src/lib/ai/types";

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

  it("keeps both Gemini hops for ingest_triage and classify_document", async () => {
    for (const task of ["ingest_triage", "classify_document"] as const) {
      const { hops, filtered } = await resolveChainPolicy({
        task,
        settings: baseSettings,
        hasCredentialsFor: geminiOnly,
      });
      expect(hops).toEqual([
        { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
        { provider: "gemini", model: "gemini-3-flash-preview" },
      ]);
      expect(filtered).toEqual([]);
    }
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

  it("never routes form_2307_ocr away from Gemini", async () => {
    const { hops, filtered } = await resolveChainPolicy({
      task: "form_2307_ocr",
      settings: {
        ...baseSettings,
        providerAllowlist: ["gemini", "openai", "openai_compatible"],
        taskChains: {
          form_2307_ocr: [
            { provider: "openai", model: "gpt-4o" },
            { provider: "openai_compatible", model: "local-vlm" },
            { provider: "gemini", model: "gemini-ocr" },
          ],
        },
      },
      hasCredentialsFor: () => true,
    });

    expect(hops).toEqual([{ provider: "gemini", model: "gemini-ocr" }]);
    expect(filtered.map((entry) => entry.reason)).toEqual([
      "ocr_policy_gemini_only",
      "ocr_policy_gemini_only",
    ]);
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

// ── Jev chain selection ─────────────────────────────────────────────────────
describe("resolveChainPolicy — Jev opt-in", () => {
  const optedIn: OrgAiSettings = { ...baseSettings, providerAllowlist: ["gemini", "jev"] };
  const everyoneHasKeys = () => true;
  const ALL_TASKS = Object.keys(DEFAULT_CHAINS) as AiTaskName[];
  const JEV_HOP = { provider: "jev", model: JEV_MODEL };

  it("not opted in: every task resolves exactly as before, whatever else is allowlisted", async () => {
    for (const providerAllowlist of [null, ["gemini", "anthropic", "openai"]] as const) {
      for (const task of ALL_TASKS) {
        const settings = {
          ...baseSettings,
          providerAllowlist: providerAllowlist ? [...providerAllowlist] : null,
        };
        const withJevKeys = await resolveChainPolicy({
          task,
          settings,
          hasCredentialsFor: everyoneHasKeys,
        });
        expect(
          withJevKeys.hops.some((hop) => hop.provider === "jev"),
          task,
        ).toBe(false);
        expect(
          withJevKeys.filtered.some((hop) => hop.provider === "jev"),
          task,
        ).toBe(false);
      }
    }
  });

  it("opted in: Jev is the first hop for ingest_triage and classify_document, Gemini the fallback", async () => {
    for (const task of JEV_TASKS) {
      const { hops, filtered } = await resolveChainPolicy({
        task,
        settings: optedIn,
        hasCredentialsFor: everyoneHasKeys,
      });
      expect(hops).toEqual([JEV_HOP, ...DEFAULT_CHAINS[task]]);
      expect(filtered).toEqual([]);
    }
  });

  it("opted in without a usable Jev key or endpoint: Jev is skipped and Gemini serves", async () => {
    const { hops, filtered } = await resolveChainPolicy({
      task: "ingest_triage",
      settings: optedIn,
      hasCredentialsFor: (provider) => provider === "gemini",
    });
    expect(hops).toEqual(DEFAULT_CHAINS.ingest_triage);
    expect(filtered).toEqual([{ ...JEV_HOP, reason: "no_credentials" }]);
  });

  it("opted in: Jev never joins any other task, even when an override names it", async () => {
    for (const task of ALL_TASKS.filter((t) => !JEV_TASKS.has(t))) {
      const { hops, filtered } = await resolveChainPolicy({
        task,
        settings: {
          ...optedIn,
          taskChains: { [task]: [JEV_HOP, ...DEFAULT_CHAINS[task]] },
        },
        hasCredentialsFor: everyoneHasKeys,
      });
      expect(
        hops.some((hop) => hop.provider === "jev"),
        task,
      ).toBe(false);
      expect(filtered.find((hop) => hop.provider === "jev")?.reason, task).toBe("jev_task_scope");
    }
  });

  it("Jev can never appear in an OCR task chain, even when opted in", async () => {
    for (const task of DOCUMENT_TASKS) {
      for (const taskChains of [null, { [task]: [JEV_HOP, ...DEFAULT_CHAINS[task]] }]) {
        const { hops } = await resolveChainPolicy({
          task,
          settings: { ...optedIn, taskChains },
          hasCredentialsFor: everyoneHasKeys,
        });
        expect(hops.length, task).toBeGreaterThan(0);
        expect(
          hops.every((hop) => hop.provider === "gemini"),
          `${task} resolved ${JSON.stringify(hops)}`,
        ).toBe(true);
      }
    }
  });

  it("an explicit caller model override is never preceded by Jev", async () => {
    const { hops } = await resolveChainPolicy({
      task: "classify_document",
      settings: optedIn,
      modelOverride: "gemini-pinned",
      hasCredentialsFor: everyoneHasKeys,
    });
    expect(hops).toEqual([{ provider: "gemini", model: "gemini-pinned" }]);
  });

  it("an org override that places Jev itself keeps that order", async () => {
    const { hops } = await resolveChainPolicy({
      task: "ingest_triage",
      settings: {
        ...optedIn,
        taskChains: {
          ingest_triage: [
            { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
            { provider: "jev", model: "jev-2" },
          ],
        },
      },
      hasCredentialsFor: everyoneHasKeys,
    });
    expect(hops.map((hop) => `${hop.provider}:${hop.model}`)).toEqual([
      "gemini:gemini-3.1-flash-lite-preview",
      "jev:jev-2",
    ]);
  });

  it("not opted in: an override naming Jev cannot send it anything", async () => {
    const { hops, filtered } = await resolveChainPolicy({
      task: "ingest_triage",
      settings: {
        ...baseSettings,
        taskChains: { ingest_triage: [JEV_HOP, ...DEFAULT_CHAINS.ingest_triage] },
      },
      hasCredentialsFor: everyoneHasKeys,
    });
    expect(hops).toEqual(DEFAULT_CHAINS.ingest_triage);
    expect(filtered).toEqual([{ ...JEV_HOP, reason: "provider_not_allowlisted" }]);
  });

  it("the legacy per-category model preference still follows Jev when opted in", async () => {
    const { hops } = await resolveChainPolicy({
      task: "classify_document",
      settings: optedIn,
      orgMetadata: JSON.stringify({ aiModelTextAnalysis: "gemini-legacy-text" }),
      hasCredentialsFor: everyoneHasKeys,
    });
    expect(hops).toEqual([JEV_HOP, { provider: "gemini", model: "gemini-legacy-text" }]);
  });
});
