import { createAiComplete } from "./facade-core";
import { productionAiCompletionRuntime } from "./facade-runtime";

export { AiDisabledError, AiNoCredentialsError, AiTaskNotAllowedError } from "./facade-core";
export type { AiCompleteArgs, AiCompleteResult } from "./facade-core";

/** The production AI interface used by routes, jobs, and domain modules. */
export const aiComplete = createAiComplete(productionAiCompletionRuntime);
