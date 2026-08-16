// ============================================================================
// aiComplete façade — registry resolution, output validation, telemetry
// outcome recording (adapter mocked; no network, no DB).
// ============================================================================
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  generateStructuredMock,
  recordValidationOutcomeMock,
  logProviderInvocationMock,
  resolveChainMock,
  getOrgAiSettingsMock,
} = vi.hoisted(() => ({
  generateStructuredMock: vi.fn(),
  recordValidationOutcomeMock: vi.fn(),
  logProviderInvocationMock: vi.fn(),
  resolveChainMock: vi.fn(),
  getOrgAiSettingsMock: vi.fn(),
}));

vi.mock("../../../src/lib/ai/adapters/gemini", () => ({
  generateStructured: generateStructuredMock,
}));

vi.mock("../../../src/lib/ai/invoke", () => ({
  recordValidationOutcome: recordValidationOutcomeMock,
  logProviderInvocation: logProviderInvocationMock,
}));

// The router/settings/credentials layer has its own tests; here we pin the
// façade's own behavior with a single Gemini hop resolved.
vi.mock("../../../src/lib/ai/router", () => ({ resolveChain: resolveChainMock }));
vi.mock("../../../src/lib/ai/settings", () => ({
  getOrgAiSettings: getOrgAiSettingsMock,
  isTaskAllowed: () => true,
}));
vi.mock("../../../src/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));

import { aiComplete } from "../../../src/lib/ai/facade";

const CTX = { orgId: "org-1" };

describe("aiComplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordValidationOutcomeMock.mockResolvedValue(undefined);
    logProviderInvocationMock.mockResolvedValue(null);
    getOrgAiSettingsMock.mockResolvedValue({
      taskChains: null,
      confidenceThresholds: {},
      autonomy: {},
      taskAllowlist: null,
      providerAllowlist: null,
      monthlySpendCapUsd: null,
      killSwitch: false,
    });
    resolveChainMock.mockResolvedValue({
      hops: [{ provider: "gemini", model: "gemini-test" }],
      filtered: [],
    });
  });

  it("throws for a task with no registry entry", async () => {
    await expect(
      // Every real AiTaskName is registered now — force an unknown one.
      aiComplete({ task: "nonexistent_task" as never, input: {}, ctx: CTX }),
    ).rejects.toThrow(/no task registry entry/i);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("renders the registered prompt, validates output, and records 'valid'", async () => {
    generateStructuredMock.mockResolvedValue({
      text: JSON.stringify({
        type: "single",
        start_date: "2026-07-25",
        interpretation: "today",
        confidence: 0.99,
      }),
      invocationId: "inv-1",
      model: "gemini-test",
    });

    const result = await aiComplete<{ start_date: string }>({
      task: "date_parse",
      input: { query: "today", currentDate: "2026-07-25" },
      ctx: CTX,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.start_date).toBe("2026-07-25");
      expect(result.model).toBe("gemini-test");
    }

    const call = generateStructuredMock.mock.calls[0][0];
    expect(call.task).toBe("date_parse");
    expect(call.promptText).toContain('QUERY: "today"');
    expect(call.promptName).toBe("date-parse");
    expect(call.promptVersion).toBe("1.0.0");
    expect(call.schemaHash).toMatch(/^[0-9a-f]{16}$/);
    expect(call.geminiSchema.type).toBe("object");

    expect(recordValidationOutcomeMock).toHaveBeenCalledWith("inv-1", "valid");
  });

  it("returns ok:false with issues and records 'failed' on schema-invalid output", async () => {
    generateStructuredMock.mockResolvedValue({
      text: JSON.stringify({ type: "someday", interpretation: 1 }),
      invocationId: "inv-2",
      model: "gemini-test",
    });

    const result = await aiComplete({
      task: "date_parse",
      input: { query: "someday", currentDate: "2026-07-25" },
      ctx: CTX,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.needsReview).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.invocationId).toBe("inv-2");
    }
    expect(recordValidationOutcomeMock).toHaveBeenCalledWith("inv-2", "failed");
  });

  it("passes registry generation defaults through to the adapter", async () => {
    generateStructuredMock.mockResolvedValue({
      text: JSON.stringify({ documentType: "receipt", confidence: 0.9 }),
      invocationId: null,
      model: null,
    });

    await aiComplete({
      task: "classify_document",
      input: { filename: "receipt.png" },
      ctx: CTX,
    });

    expect(generateStructuredMock.mock.calls[0][0].generation).toEqual({ temperature: 0.1 });
  });
});
