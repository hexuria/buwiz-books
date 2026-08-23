// ============================================================================
// Chain resolution: which hops may actually run for this org and task.
//
// Precedence: explicit override → org taskChains → legacy per-category
// org model preference (so an org that picked a Gemini model in settings
// keeps getting it) → DEFAULT_CHAINS.
//
// Then three filters, in order:
//   1. OCR policy — document tasks are Gemini-only, always (chains.ts)
//   2. Provider allowlist — absent ⇒ Gemini only
//   3. Credential presence — a hop with no key is skipped, not an error
//
// The result is that Phase 4 is a no-op for existing orgs: they have Gemini
// keys only, so every chain resolves to exactly the Gemini hop they use now.
// ============================================================================

import type { AiTaskName } from "./types";
import { withOrgContext } from "../../db";
import { hasCredentialsFor } from "./credentials";
import type { OrgAiSettings } from "./settings-policy";
import { resolveChainPolicy, type ResolvedChain } from "./router-policy";

export { resolveChainPolicy } from "./router-policy";
export type { ResolvedChain, ResolveChainPolicyInput } from "./router-policy";

export interface ResolveChainInput {
  task: AiTaskName;
  orgId: string;
  settings: OrgAiSettings;
  /** Raw auth_organizations.metadata, for the legacy model preference. */
  orgMetadata?: string | null;
  /** Caller-supplied model override (tests, one-off re-runs). */
  modelOverride?: string;
}

export function resolveChain(input: ResolveChainInput): Promise<ResolvedChain> {
  return resolveChainPolicy({
    ...input,
    hasCredentialsFor: (provider) =>
      withOrgContext(input.orgId, "system", "admin", (tx) =>
        hasCredentialsFor(tx, input.orgId, provider),
      ),
  });
}
