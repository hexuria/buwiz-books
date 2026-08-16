import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAiComplete,
  type AiCompletionRuntime,
  type AiHopInvocation,
} from "../../../src/lib/ai/facade-core";

const prepare = vi.fn<AiCompletionRuntime["prepare"]>();
const invokeHop = vi.fn<AiCompletionRuntime["invokeHop"]>(
  async <TOut>(_input: AiHopInvocation<TOut>) => ({
    text: "",
    invocationId: null,
    model: null,
  }),
);
const recordValidationOutcome = vi.fn<AiCompletionRuntime["recordValidationOutcome"]>();
const runtime: AiCompletionRuntime = {
  prepare,
  invokeHop,
  recordValidationOutcome,
};
const aiComplete = createAiComplete(runtime);
const CTX = { orgId: "org-1" };

describe("aiComplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepare.mockResolvedValue({
      kind: "ready",
      hops: [{ provider: "gemini", model: "gemini-test" }],
    });
    recordValidationOutcome.mockResolvedValue(undefined);
  });

  it("throws for a task with no registry entry", async () => {
    await expect(
      aiComplete({ task: "nonexistent_task" as never, input: {}, ctx: CTX }),
    ).rejects.toThrow(/no task registry entry/i);
    expect(prepare).not.toHaveBeenCalled();
    expect(invokeHop).not.toHaveBeenCalled();
  });

  it("renders the registered prompt, validates output, and records valid", async () => {
    invokeHop.mockResolvedValueOnce({
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

    const call = invokeHop.mock.calls[0][0];
    expect(call.task).toBe("date_parse");
    expect(String(call.prompt)).toContain('QUERY: "today"');
    expect(call.entry.prompt.id).toBe("date-parse");
    expect(call.entry.prompt.version).toBe("1.0.0");
    expect(call.entry.schemaHash).toMatch(/^[0-9a-f]{16}$/);
    expect(call.entry.geminiSchema.type).toBe("object");
    expect(recordValidationOutcome).toHaveBeenCalledWith("inv-1", "valid");
  });

  it("returns review issues and records failed for schema-invalid output", async () => {
    invokeHop.mockResolvedValueOnce({
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
    expect(recordValidationOutcome).toHaveBeenCalledWith("inv-2", "failed");
  });

  it("passes registry generation defaults to the runtime adapter", async () => {
    invokeHop.mockResolvedValueOnce({
      text: JSON.stringify({ documentType: "receipt", confidence: 0.9 }),
      invocationId: null,
      model: null,
    });

    await aiComplete({
      task: "classify_document",
      input: { filename: "receipt.png" },
      ctx: CTX,
    });

    expect(invokeHop.mock.calls[0][0].generation).toEqual({ temperature: 0.1 });
  });

  it("returns successful output without retrying when telemetry persistence fails", async () => {
    prepare.mockResolvedValueOnce({
      kind: "ready",
      hops: [
        { provider: "gemini", model: "gemini-test" },
        { provider: "anthropic", model: "anthropic-test" },
      ],
    });
    invokeHop.mockResolvedValueOnce({
      text: JSON.stringify({
        type: "single",
        start_date: "2026-07-25",
        interpretation: "today",
        confidence: 0.99,
      }),
      invocationId: "inv-telemetry",
      model: "gemini-test",
    });
    recordValidationOutcome.mockRejectedValueOnce(new Error("telemetry unavailable"));

    await expect(
      aiComplete({
        task: "date_parse",
        input: { query: "today", currentDate: "2026-07-25" },
        ctx: CTX,
      }),
    ).resolves.toMatchObject({ ok: true, invocationId: "inv-telemetry" });
    expect(invokeHop).toHaveBeenCalledOnce();
  });
});
