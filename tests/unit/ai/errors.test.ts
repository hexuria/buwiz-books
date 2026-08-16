import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  classifyByStatus,
  classifyGeminiError,
  toAiProviderError,
} from "../../../src/lib/ai/errors";

describe("classifyGeminiError", () => {
  it.each([
    ["[429] Too Many Requests", "rate_limited"],
    ["Resource has been exhausted (e.g. check quota)", "rate_limited"],
    ["[503] The model is overloaded", "overloaded"],
    ["The service is currently experiencing high demand", "overloaded"],
    ["request timed out", "timeout"],
    ["The operation was aborted", "timeout"],
    ["API key not valid. Please pass a valid API key.", "invalid_key"],
    ["[403] Permission denied", "invalid_key"],
    ["fetch failed", "network"],
    ["Candidate was blocked due to safety", "content_filter"],
    ["something entirely novel", "unknown"],
  ])("%s → %s", (message, expected) => {
    expect(classifyGeminiError(new Error(message))).toBe(expected);
  });

  it("classifies non-Error values as unknown", () => {
    expect(classifyGeminiError("a string")).toBe("unknown");
    expect(classifyGeminiError(null)).toBe("unknown");
  });

  it("prioritizes credential failures over rate limits when both words appear", () => {
    // A 403 that also mentions quota is a credential problem, not throughput.
    expect(classifyGeminiError(new Error("403 Forbidden: quota project not set"))).toBe(
      "invalid_key",
    );
  });
});

describe("classifyByStatus", () => {
  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [429, "rate_limited"],
    [529, "overloaded"],
    [500, "overloaded"],
    [504, "timeout"],
    [400, "invalid_request"],
    [418, "unknown"],
  ])("%s → %s", (status, expected) => {
    expect(classifyByStatus(status)).toBe(expected);
  });
});

describe("AiProviderError routing decisions", () => {
  const err = (cls: Parameters<typeof classifyByStatus> extends never ? never : string) =>
    new AiProviderError({ class: cls as never, provider: "gemini" });

  it("retries the same provider for transient classes", () => {
    for (const cls of ["rate_limited", "overloaded", "timeout", "network"]) {
      expect(err(cls).retryableSameProvider).toBe(true);
    }
  });

  it("does not retry the same provider for terminal classes", () => {
    for (const cls of ["invalid_key", "invalid_request", "content_filter"]) {
      expect(err(cls).retryableSameProvider).toBe(false);
    }
  });

  it("escalates the chain on exhaustion, bad credentials, and schema rejection", () => {
    for (const cls of ["rate_limited", "invalid_key", "schema_rejection", "timeout"]) {
      expect(err(cls).escalateChain).toBe(true);
    }
  });

  it("does NOT escalate on invalid_request or content_filter (a retry elsewhere fails too)", () => {
    expect(err("invalid_request").escalateChain).toBe(false);
    expect(err("content_filter").escalateChain).toBe(false);
  });

  it("marks only invalid_key as a credential failure", () => {
    expect(err("invalid_key").isCredentialFailure).toBe(true);
    expect(err("rate_limited").isCredentialFailure).toBe(false);
  });
});

describe("toAiProviderError", () => {
  it("wraps a raw error with a classified type", () => {
    const wrapped = toAiProviderError(new Error("[429] rate limit"), "gemini", classifyGeminiError);
    expect(wrapped).toBeInstanceOf(AiProviderError);
    expect(wrapped.errorClass).toBe("rate_limited");
    expect(wrapped.provider).toBe("gemini");
  });

  it("passes an already-typed error through unchanged", () => {
    const original = new AiProviderError({ class: "timeout", provider: "anthropic" });
    expect(toAiProviderError(original, "gemini", classifyGeminiError)).toBe(original);
  });
});
