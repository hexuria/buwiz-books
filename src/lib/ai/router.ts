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
import { AI_TASK_CATEGORY } from "./types";
import type { AiProvider } from "./errors";
import { DEFAULT_CHAINS, enforceOcrPolicy, type ChainEntry } from "./chains";
import { hasCredentialsFor } from "./credentials";
import { isProviderAllowed, type OrgAiSettings } from "./settings";
import { parseOrgMetadata } from "../org-metadata";
import { AI_MODEL_META_KEYS } from "../ai-models";

export interface ResolveChainInput {
  task: AiTaskName;
  orgId: string;
  settings: OrgAiSettings;
  /** Raw auth_organizations.metadata, for the legacy model preference. */
  orgMetadata?: string | null;
  /** Caller-supplied model override (tests, one-off re-runs). */
  modelOverride?: string;
}

function parseOrgChain(value: unknown): ChainEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: ChainEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const hop = raw as { provider?: unknown; model?: unknown };
    if (typeof hop.provider !== "string" || typeof hop.model !== "string") continue;
    entries.push({ provider: hop.provider as AiProvider, model: hop.model });
  }
  return entries.length > 0 ? entries : null;
}

/** The org's legacy single-model preference for this task's category. */
function legacyChain(task: AiTaskName, orgMetadata?: string | null): ChainEntry[] | null {
  if (!orgMetadata) return null;
  const parsed = parseOrgMetadata(orgMetadata);
  const key = AI_MODEL_META_KEYS[AI_TASK_CATEGORY[task]];
  const model = (parsed as Record<string, unknown>)[key];
  if (typeof model !== "string" || !model) return null;
  return [{ provider: "gemini", model }];
}

export interface ResolvedChain {
  hops: ChainEntry[];
  /** Hops dropped, and why — recorded on the invocation for debuggability. */
  filtered: Array<{ provider: AiProvider; model: string; reason: string }>;
}

/**
 * Resolve the ordered, permitted hops for a task.
 * An empty `hops` means the org cannot run this task at all (no credentials).
 */
export async function resolveChain(input: ResolveChainInput): Promise<ResolvedChain> {
  const { task, orgId, settings } = input;

  let chain: ChainEntry[];
  if (input.modelOverride) {
    chain = [{ provider: "gemini", model: input.modelOverride }];
  } else {
    chain =
      parseOrgChain(settings.taskChains?.[task]) ??
      legacyChain(task, input.orgMetadata) ??
      DEFAULT_CHAINS[task];
  }

  const filtered: ResolvedChain["filtered"] = [];

  // 1. OCR egress policy — non-negotiable.
  const afterPolicy = enforceOcrPolicy(task, chain);
  for (const hop of chain) {
    if (!afterPolicy.includes(hop)) {
      filtered.push({ ...hop, reason: "ocr_policy_gemini_only" });
    }
  }

  // 2 + 3. Allowlist, then credential presence.
  const hops: ChainEntry[] = [];
  for (const hop of afterPolicy) {
    if (!isProviderAllowed(settings, hop.provider)) {
      filtered.push({ ...hop, reason: "provider_not_allowlisted" });
      continue;
    }
    if (!(await hasCredentialsFor(orgId, hop.provider))) {
      filtered.push({ ...hop, reason: "no_credentials" });
      continue;
    }
    hops.push(hop);
  }

  return { hops, filtered };
}
