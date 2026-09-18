import { resolveAiCompletionRuntime } from "./ai-mode";
import { createAiComplete } from "./facade-core";
import { productionAiCompletionRuntime } from "./facade-runtime";
import { mockAiCompletionRuntime } from "./mock-runtime";

export { AiDisabledError, AiNoCredentialsError, AiTaskNotAllowedError } from "./facade-core";
export type { AiCompleteArgs, AiCompleteResult } from "./facade-core";

/** The production AI interface used by routes, jobs, and domain modules. */
export const aiComplete = createAiComplete(
  resolveAiCompletionRuntime({
    mock: mockAiCompletionRuntime,
    live: productionAiCompletionRuntime,
  }),
);
