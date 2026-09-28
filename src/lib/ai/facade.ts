import { withOrgContext } from "../../db";
import { resolveAiCompletionRuntime } from "./ai-mode";
import { createAiComplete } from "./facade-core";
import { productionAiCompletionRuntime } from "./facade-runtime";
import { createMockAiCompletionRuntime } from "./mock-runtime";
import { getOrgAiSettings, isProviderAllowed } from "./settings";

export { AiDisabledError, AiNoCredentialsError, AiTaskNotAllowedError } from "./facade-core";
export type { AiCompleteArgs, AiCompleteResult } from "./facade-core";

/** AI_MODE=mock mirrors the org's real Jev opt-in, read the way the router reads it. */
async function isJevOptedIn(orgId: string): Promise<boolean> {
  const settings = await withOrgContext(orgId, "system", "admin", (tx) =>
    getOrgAiSettings(tx, orgId),
  );
  return isProviderAllowed(settings, "jev");
}

/** The production AI interface used by routes, jobs, and domain modules. */
export const aiComplete = createAiComplete(
  resolveAiCompletionRuntime({
    mock: createMockAiCompletionRuntime({ isJevOptedIn }),
    live: productionAiCompletionRuntime,
  }),
);
