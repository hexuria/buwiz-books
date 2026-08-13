import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertWithinSpendCapMock, generateStructuredMock, getOrgAiSettingsMock, resolveChainMock } =
  vi.hoisted(() => ({
    assertWithinSpendCapMock: vi.fn(),
    generateStructuredMock: vi.fn(),
    getOrgAiSettingsMock: vi.fn(),
    resolveChainMock: vi.fn(),
  }));

vi.mock("../../../src/db", () => ({ db: {} }));
vi.mock("../../../src/lib/ai/adapters/gemini", () => ({
  generateStructured: generateStructuredMock,
}));
vi.mock("../../../src/lib/ai/adapters/anthropic", () => ({
  generateStructuredAnthropic: vi.fn(),
}));
vi.mock("../../../src/lib/ai/adapters/openai", () => ({
  generateStructuredOpenAi: vi.fn(),
}));
vi.mock("../../../src/lib/ai/credentials", () => ({ getOrgCredentials: vi.fn() }));
vi.mock("../../../src/lib/ai/invoke", () => ({
  logProviderInvocation: vi.fn(),
  recordValidationOutcome: vi.fn(),
}));
vi.mock("../../../src/lib/ai/provider-health", () => ({}));
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
