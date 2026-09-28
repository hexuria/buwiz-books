import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertWithinSpendCapMock,
  generateStructuredMock,
  generateStructuredJevMock,
  generateStructuredOpenAiMock,
  getOrgAiSettingsMock,
  getOrgCredentialsMock,
  logProviderInvocationMock,
  resolveChainMock,
} = vi.hoisted(() => ({
  assertWithinSpendCapMock: vi.fn(),
  generateStructuredMock: vi.fn(),
  generateStructuredJevMock: vi.fn(),
  generateStructuredOpenAiMock: vi.fn(),
  getOrgAiSettingsMock: vi.fn(),
  getOrgCredentialsMock: vi.fn(),
  logProviderInvocationMock: vi.fn(),
  resolveChainMock: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  db: {},
  // Pass the mocked settings read straight through; the runtime only uses
  // the context wrapper as a scoping envelope.
  withOrgContext: (_orgId: string, _userId: string, _role: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));
vi.mock("../../../src/lib/ai/adapters/gemini", () => ({
  generateStructured: generateStructuredMock,
}));
vi.mock("../../../src/lib/ai/adapters/anthropic", () => ({
  generateStructuredAnthropic: vi.fn(),
}));
vi.mock("../../../src/lib/ai/adapters/openai", () => ({
  generateStructuredOpenAi: generateStructuredOpenAiMock,
}));
vi.mock("../../../src/lib/ai/adapters/jev", () => ({
  generateStructuredJev: generateStructuredJevMock,
}));
vi.mock("../../../src/lib/ai/credentials", () => ({ getOrgCredentials: getOrgCredentialsMock }));
vi.mock("../../../src/lib/ai/invoke", () => ({
  logProviderInvocation: logProviderInvocationMock,
  recordValidationOutcome: vi.fn(),
}));
vi.mock("../../../src/lib/ai/provider-health", () => ({
  loadHealth: vi.fn(async () => new Map()),
  isAvailable: vi.fn(() => true),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  markInvalid: vi.fn(),
}));
vi.mock("../../../src/lib/ai/router", () => ({ resolveChain: resolveChainMock }));
vi.mock("../../../src/lib/ai/settings", () => ({
  getOrgAiSettings: getOrgAiSettingsMock,
  isTaskAllowed: vi.fn(),
}));
vi.mock("../../../src/lib/ai/spend", () => ({
  assertWithinSpendCap: assertWithinSpendCapMock,
}));

import { AiProviderError } from "../../../src/lib/ai/errors";
import { productionAiCompletionRuntime } from "../../../src/lib/ai/facade-runtime";
import { getTaskEntry } from "../../../src/lib/ai/prompts";
import { toRedactedPrompt } from "../../../src/lib/ai/redact";

describe("production AI completion runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops before spend or provider resolution when settings cannot be read", async () => {
    const settingsFailure = new Error("settings database unavailable");
    getOrgAiSettingsMock.mockRejectedValueOnce(settingsFailure);

    await expect(
      productionAiCompletionRuntime.prepare({ task: "date_parse", orgId: "org-a" }),
    ).rejects.toBe(settingsFailure);
    expect(assertWithinSpendCapMock).not.toHaveBeenCalled();
    expect(resolveChainMock).not.toHaveBeenCalled();
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("normalizes a Gemini rate limit into an escalating provider error", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"));
    const entry = getTaskEntry("date_parse");

    let error: unknown;
    try {
      await productionAiCompletionRuntime.invokeHop({
        hop: { provider: "gemini", model: "gemini-test" },
        position: 0,
        task: "date_parse",
        prompt: toRedactedPrompt("today").prompt,
        schema: entry.schema,
        ctx: { orgId: "org-a" },
        entry,
        redactionHits: 0,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({
      name: "AiProviderError",
      errorClass: "rate_limited",
      provider: "gemini",
    });
  });
});

describe("production AI completion runtime — Jev hop", () => {
  const JEV_CREDENTIAL = {
    fingerprint: "fp-jev",
    apiKey: "jev-TESTONLY-key",
    baseUrl: "https://jev.example.test/v1",
    credentialId: "cred-jev",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgCredentialsMock.mockResolvedValue([JEV_CREDENTIAL]);
    logProviderInvocationMock.mockResolvedValue("inv-jev");
  });

  it("routes a jev hop to the Jev adapter with the redacted prompt and the operator endpoint", async () => {
    generateStructuredJevMock.mockResolvedValueOnce({
      text: '{"docKind":"bill","confidence":0.9}',
      usage: { tokensIn: 40, tokensOut: 12 },
      usageEstimated: true,
    });
    const entry = getTaskEntry("ingest_triage");
    const { prompt } = toRedactedPrompt("Filename: acme-bill.pdf");

    const result = await productionAiCompletionRuntime.invokeHop({
      hop: { provider: "jev", model: "jev-1" },
      position: 0,
      task: "ingest_triage",
      prompt,
      schema: entry.schema,
      ctx: { orgId: "org-jev" },
      entry,
      generation: { temperature: 0.1 },
      redactionHits: 0,
    });

    expect(result).toEqual({
      text: '{"docKind":"bill","confidence":0.9}',
      invocationId: "inv-jev",
      model: "jev-1",
    });
    expect(getOrgCredentialsMock).toHaveBeenCalledWith(expect.anything(), "org-jev", "jev");
    expect(generateStructuredJevMock).toHaveBeenCalledWith({
      apiKey: JEV_CREDENTIAL.apiKey,
      baseURL: JEV_CREDENTIAL.baseUrl,
      model: "jev-1",
      prompt,
      schema: entry.schema,
      schemaName: "ingest_triage",
      temperature: 0.1,
      maxOutputTokens: undefined,
    });
    expect(generateStructuredOpenAiMock).not.toHaveBeenCalled();
    expect(generateStructuredMock).not.toHaveBeenCalled();

    // Telemetry carries the jev provider (so pricing applies its placeholder)
    // and flags the estimated usage.
    expect(logProviderInvocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "jev",
        model: "jev-1",
        tokensIn: 40,
        tokensOut: 12,
        configSnapshot: { redactionHits: 0, usageEstimated: true },
      }),
    );
  });

  it("never hands document bytes to the Jev adapter", async () => {
    generateStructuredJevMock.mockResolvedValueOnce({
      text: "{}",
      usage: { tokensIn: 1, tokensOut: 1 },
      usageEstimated: false,
    });
    const entry = getTaskEntry("classify_document");

    await productionAiCompletionRuntime.invokeHop({
      hop: { provider: "jev", model: "jev-1" },
      position: 0,
      task: "classify_document",
      prompt: toRedactedPrompt("Filename: scan.pdf").prompt,
      schema: entry.schema,
      media: [{ mimeType: "application/pdf", dataBase64: "JVBERi0xLjQK" }],
      ctx: { orgId: "org-jev" },
      entry,
      redactionHits: 0,
    });

    const [call] = generateStructuredJevMock.mock.calls[0];
    expect(JSON.stringify(call)).not.toContain("JVBERi0xLjQK");
    expect(call).not.toHaveProperty("media");
  });

  it("a Jev refusal is logged and rethrown for the façade to escalate", async () => {
    generateStructuredJevMock.mockRejectedValueOnce(
      new AiProviderError({ class: "egress_refused", provider: "jev", message: "refused" }),
    );
    const entry = getTaskEntry("ingest_triage");

    await expect(
      productionAiCompletionRuntime.invokeHop({
        hop: { provider: "jev", model: "jev-1" },
        position: 0,
        task: "ingest_triage",
        prompt: toRedactedPrompt("Filename: a.pdf").prompt,
        schema: entry.schema,
        ctx: { orgId: "org-jev" },
        entry,
        redactionHits: 0,
      }),
    ).rejects.toMatchObject({ errorClass: "egress_refused", escalateChain: true });
    expect(logProviderInvocationMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "jev", errorMessage: "refused" }),
    );
  });
});
