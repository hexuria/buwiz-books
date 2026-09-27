// ============================================================================
// In-process mock AiCompletionRuntime for AI_MODE=mock.
//
// prepare() never reads org credentials or spend — a synthetic hop is always
// ready so callers cannot hit AiNoCredentialsError. The one org setting it
// mirrors is the Jev opt-in, through an injected reader so this module stays
// free of the database: an opted-in org gets a Jev mock hop first on
// JEV_TASKS, like the live chain, with the Gemini mock hop as the fallback.
// invokeHop() returns canned JSON from fixtures/mock-responses.ts and never
// calls a provider adapter. OCR/DOCUMENT_TASKS are covered here on purpose:
// those tasks are Gemini-only in production, so an OpenAI-compatible HTTP
// mock cannot serve them.
// ============================================================================

import { JEV_TASKS } from "./chains";
import type { AiCompletionRuntime, AiHopInvocation } from "./facade-core";
import { getMockResponseText } from "./fixtures/mock-responses";
import type { AiTaskName } from "./types";

/** Labelled hop so logs show mock without inventing a new AiProvider. */
const MOCK_HOP = { provider: "gemini" as const, model: "mock" };
/** Jev's mock hop, placed first only for an opted-in org on a JEV_TASK. */
const MOCK_JEV_HOP = { provider: "jev" as const, model: "jev-mock" };

export interface MockAiCompletionRuntimeOptions {
  /**
   * Mirrors the live Jev opt-in ("jev" on the org's provider allowlist).
   * Omitted ⇒ never opted in. A failing read counts as not opted in, because
   * mock mode must keep answering.
   */
  isJevOptedIn?: (orgId: string) => Promise<boolean>;
}

export function createMockAiCompletionRuntime(
  options: MockAiCompletionRuntimeOptions = {},
): AiCompletionRuntime {
  async function jevFirst(task: AiTaskName, orgId: string): Promise<boolean> {
    if (!JEV_TASKS.has(task) || !options.isJevOptedIn) return false;
    try {
      return await options.isJevOptedIn(orgId);
    } catch {
      return false;
    }
  }

  return {
    async prepare({ task, orgId }) {
      const hops = (await jevFirst(task, orgId)) ? [MOCK_JEV_HOP, MOCK_HOP] : [MOCK_HOP];
      return { kind: "ready", hops };
    },

    async invokeHop<TOut>(input: AiHopInvocation<TOut>) {
      const jev = input.hop.provider === "jev";
      return {
        text: getMockResponseText(input.task, input.hop.provider),
        invocationId: jev ? `mock:jev:${input.task}` : `mock:${input.task}`,
        model: jev ? MOCK_JEV_HOP.model : MOCK_HOP.model,
      };
    },

    async recordValidationOutcome() {
      // Mock invocations are not persisted.
    },
  };
}

/** Never opted in to Jev: every task answers from the shared mock hop. */
export const mockAiCompletionRuntime = createMockAiCompletionRuntime();
