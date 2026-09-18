import { describe, expect, it } from "vitest";
import { readAiMode, resolveAiCompletionRuntime } from "../../../src/lib/ai/ai-mode";
import type { AiCompletionRuntime } from "../../../src/lib/ai/facade-core";

const mockRuntime: AiCompletionRuntime = {
  prepare: async () => ({ kind: "ready", hops: [] }),
  invokeHop: async () => ({ text: "", invocationId: null, model: null }),
  recordValidationOutcome: async () => {},
};
const liveRuntime: AiCompletionRuntime = {
  prepare: async () => ({ kind: "ready", hops: [] }),
  invokeHop: async () => ({ text: "", invocationId: null, model: null }),
  recordValidationOutcome: async () => {},
};
const runtimes = { mock: mockRuntime, live: liveRuntime };

describe("readAiMode", () => {
  it("defaults to live when AI_MODE is unset", () => {
    expect(readAiMode({})).toBe("live");
  });

  it("treats AI_MODE=live as the production runtime", () => {
    expect(readAiMode({ AI_MODE: "live" })).toBe("live");
  });

  it("ignores unknown AI_MODE values (production runtime unchanged)", () => {
    expect(readAiMode({ AI_MODE: "recorded" })).toBe("live");
    expect(readAiMode({ AI_MODE: "MOCK" })).toBe("live");
    expect(readAiMode({ AI_MODE: "" })).toBe("live");
  });

  it("selects mock outside production", () => {
    expect(readAiMode({ AI_MODE: "mock", NODE_ENV: "development" })).toBe("mock");
    expect(readAiMode({ AI_MODE: "mock", NODE_ENV: "test" })).toBe("mock");
    expect(readAiMode({ AI_MODE: " mock ", NODE_ENV: "test" })).toBe("mock");
  });

  it("throws when selecting mock under NODE_ENV=production", () => {
    expect(() => readAiMode({ AI_MODE: "mock", NODE_ENV: "production" })).toThrow(
      /unset AI_MODE \(or set AI_MODE=live\)/i,
    );
  });
});

describe("resolveAiCompletionRuntime", () => {
  it("uses the live runtime unless AI_MODE=mock", () => {
    expect(resolveAiCompletionRuntime(runtimes, {})).toBe(liveRuntime);
    expect(resolveAiCompletionRuntime(runtimes, { AI_MODE: "live" })).toBe(liveRuntime);
  });

  it("uses the mock runtime when AI_MODE=mock outside production", () => {
    expect(resolveAiCompletionRuntime(runtimes, { AI_MODE: "mock", NODE_ENV: "test" })).toBe(
      mockRuntime,
    );
  });

  it("throws when selecting mock under NODE_ENV=production", () => {
    expect(() =>
      resolveAiCompletionRuntime(runtimes, { AI_MODE: "mock", NODE_ENV: "production" }),
    ).toThrow(/not allowed when NODE_ENV=production/);
  });
});
