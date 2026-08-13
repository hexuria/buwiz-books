import { AI_MODEL_META_KEYS } from "../ai-models";
import { parseOrgMetadata } from "../org-metadata";
import { DEFAULT_CHAINS, enforceOcrPolicy, type ChainEntry } from "./chains";
import type { AiProvider } from "./errors";
import { isProviderAllowed, type OrgAiSettings } from "./settings-policy";
import { AI_TASK_CATEGORY, type AiTaskName } from "./types";

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
  filtered: Array<{ provider: AiProvider; model: string; reason: string }>;
}

export interface ResolveChainPolicyInput {
  task: AiTaskName;
  settings: OrgAiSettings;
  orgMetadata?: string | null;
  modelOverride?: string;
  hasCredentialsFor: (provider: AiProvider) => boolean | Promise<boolean>;
}

/** Resolve ordered provider hops without importing credentials or database adapters. */
export async function resolveChainPolicy(input: ResolveChainPolicyInput): Promise<ResolvedChain> {
  const { task, settings } = input;

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
  const afterPolicy = enforceOcrPolicy(task, chain);
  for (const hop of chain) {
    if (!afterPolicy.includes(hop)) {
      filtered.push({ ...hop, reason: "ocr_policy_gemini_only" });
    }
  }

  const hops: ChainEntry[] = [];
  for (const hop of afterPolicy) {
    if (!isProviderAllowed(settings, hop.provider)) {
      filtered.push({ ...hop, reason: "provider_not_allowlisted" });
      continue;
    }
    if (!(await input.hasCredentialsFor(hop.provider))) {
      filtered.push({ ...hop, reason: "no_credentials" });
      continue;
    }
    hops.push(hop);
  }

  return { hops, filtered };
}
