// ============================================================================
// In-process mock AiCompletionRuntime for AI_MODE=mock.
//
// prepare() never reads org credentials, spend, or settings — a synthetic
// hop is always ready so callers cannot hit AiNoCredentialsError. invokeHop()
// returns canned JSON from fixtures/mock-responses.ts and never calls a
// provider adapter. OCR/DOCUMENT_TASKS are covered here on purpose: those
// tasks are Gemini-only in production, so an OpenAI-compatible HTTP mock
// cannot serve them.
// ============================================================================

import type { AiCompletionRuntime, AiHopInvocation } from "./facade-core";
import { getMockResponseText } from "./fixtures/mock-responses";

/** Labelled hop so logs show mock without inventing a new AiProvider. */
const MOCK_HOP = { provider: "gemini" as const, model: "mock" };

export const mockAiCompletionRuntime: AiCompletionRuntime = {
  async prepare() {
    return { kind: "ready", hops: [MOCK_HOP] };
  },

  async invokeHop<TOut>(input: AiHopInvocation<TOut>) {
    return {
      text: getMockResponseText(input.task),
      invocationId: `mock:${input.task}`,
      model: "mock",
    };
  },

  async recordValidationOutcome() {
    // Mock invocations are not persisted.
  },
};
