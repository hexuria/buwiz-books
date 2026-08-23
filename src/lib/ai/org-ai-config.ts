// ============================================================================
// Per-org AI credential + settings ADMINISTRATION (the write half of BYOK).
//
// credentials.ts and settings.ts are the read paths the router consumes; this
// module is what the settings surface calls to change them. It lives in lib/
// rather than the route module so the two invariants it exists to hold are
// testable without a request:
//
//   1. NO KEY MATERIAL EVER LEAVES. Reads return `••••<last4>` masks derived
//      server-side; the ciphertext and the plaintext both stay here.
//   2. A SETTINGS WRITE CANNOT WIDEN OCR EGRESS. Every taskChains entry for a
//      DOCUMENT_TASK is run through enforceOcrPolicy BEFORE it is persisted,
//      so a document task cannot be pointed off Gemini even by a direct API
//      call that bypasses the UI.
//
// Every mutation lands an activity_logs row with a field-level diff.
// ============================================================================

import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import {
  organizationAiCredentials,
  organizationAiSettings,
  type AiAutonomyLevel,
  type AiProposalKind,
} from "../../db/schema/ai";
import { decryptSecret, encryptSecret } from "../crypto";
import { maskGeminiKeys, maskSecret } from "../mask-secret";
import { getOrganizationSecrets } from "../org-secrets";
import { insertActivityLog } from "../insert-activity-log";
import { createLogger } from "../logger";
import { DEFAULT_CHAINS, DOCUMENT_TASKS, enforceOcrPolicy, type ChainEntry } from "./chains";
import { invalidateOrgAiSettings, isProviderAllowed, type OrgAiSettings } from "./settings";
import {
  AUTONOMY_ALLOWED_KINDS,
  STRUCTURAL_MANUAL_KINDS,
  computeAutonomyEligibility,
  shouldDemote,
  type AutonomyEligibility,
} from "./autonomy";
import type { AiProvider } from "./errors";
import { AI_TASK_CATEGORY, type AiTaskName } from "./types";
import type { AITaskCategory } from "../ai-models";

const logger = createLogger("ai.org-config");

export const AI_PROVIDERS = ["gemini", "anthropic", "openai", "openai_compatible"] as const;

/** Every shipped task, in a stable display order (document tasks first). */
export const AI_TASK_NAMES = Object.keys(DEFAULT_CHAINS) as AiTaskName[];

const PROVIDER_SET = new Set<string>(AI_PROVIDERS);
const TASK_SET = new Set<string>(AI_TASK_NAMES);

function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

function isAiTaskName(value: unknown): value is AiTaskName {
  return typeof value === "string" && TASK_SET.has(value);
}

// ── Activity-log entity identity ─────────────────────────────────────────────
//
// activity_logs.entity_id is `uuid NOT NULL` while organization_id is `text`
// (Better Auth org ids are not UUIDs), so the org id CANNOT be the entity id.
// We derive a deterministic RFC-4122 v5 UUID from it instead: every AI-config
// log row for an org shares one stable surrogate, so the audit trail is still
// queryable as (entity_type, entity_id) without a schema change, and the same
// org always maps to the same id across processes and deploys.
const AI_CONFIG_UUID_NAMESPACE = "6f5c1f0e-2b4a-4d3c-9f21-7a4e5c8b0d11";

/** RFC 4122 §4.3 name-based (SHA-1) UUID. */
function uuidV5(name: string, namespaceUuid: string): string {
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** The stable surrogate entity id for an org's AI configuration log rows. */
export function aiConfigEntityId(orgId: string): string {
  return uuidV5(`ai-config:${orgId}`, AI_CONFIG_UUID_NAMESPACE);
}

// ── Credentials ──────────────────────────────────────────────────────────────

export interface OrgAiCredentialView {
  id: string;
  provider: AiProvider;
  label: string | null;
  /** `••••<last4>`. The only form key material takes in a response. */
  mask: string;
  baseUrl: string | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /**
   * True for Gemini keys still living in organization_secrets.geminiApiKeys.
   * Shown read-only here so admins see every credential in one place; they are
   * edited through the existing Gemini key editor.
   */
  legacy: boolean;
}

/**
 * Every credential the org has, masked. Revoked rows are included (flagged) so
 * the surface doubles as a revocation history.
 */
export async function listOrgAiCredentials(
  db: DbExecutor,
  orgId: string,
): Promise<OrgAiCredentialView[]> {
  const rows = await db
    .select()
    .from(organizationAiCredentials)
    .where(eq(organizationAiCredentials.organizationId, orgId))
    .orderBy(desc(organizationAiCredentials.createdAt));

  const views: OrgAiCredentialView[] = rows.map((row) => {
    let mask: string;
    try {
      mask = maskSecret(decryptSecret(row.encryptedKey));
    } catch (err) {
      // A key encrypted under a retired SECRETS_ENCRYPTION_KEY still has a row
      // identity worth showing (so it can be revoked) — it just has no mask.
      logger.warn("Credential could not be decrypted for masking", {
        orgId: orgId.slice(0, 8),
        credentialId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      mask = "•••• (unreadable)";
    }
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      mask,
      baseUrl: row.baseUrl,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      legacy: false,
    };
  });

  // Legacy Gemini keys (organization_secrets.geminiApiKeys) as read-only rows.
  const secrets = await getOrganizationSecrets(db, orgId);
  const legacyMasks = maskGeminiKeys(secrets.geminiApiKeys);
  legacyMasks.forEach((mask, index) => {
    views.push({
      id: `legacy:gemini:${index}`,
      provider: "gemini",
      label: "Legacy Gemini key",
      mask,
      baseUrl: null,
      lastUsedAt: null,
      revokedAt: null,
      legacy: true,
    });
  });

  return views;
}

export interface AddOrgAiCredentialInput {
  orgId: string;
  actorId: string;
  provider: string;
  apiKey: string;
  label?: string;
  baseUrl?: string;
}

/** Validate + normalize an openai_compatible base URL, or throw. */
function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("baseUrl must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export async function addOrgAiCredential(
  db: DbExecutor,
  input: AddOrgAiCredentialInput,
): Promise<{ id: string; provider: AiProvider; mask: string }> {
  const { orgId, actorId } = input;
  if (!isAiProvider(input.provider)) {
    throw new Error(`Unsupported provider "${input.provider}"`);
  }
  const provider = input.provider;

  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey) throw new Error("apiKey is required");

  const rawBaseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  // A base URL is the endpoint identity for an OpenAI-compatible gateway and
  // meaningless (and misleading) for the first-party providers.
  if (provider === "openai_compatible" && !rawBaseUrl) {
    throw new Error("baseUrl is required for openai_compatible credentials");
  }
  if (provider !== "openai_compatible" && rawBaseUrl) {
    throw new Error(`baseUrl is only supported for openai_compatible credentials`);
  }
  const baseUrl = rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : null;

  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : null;

  const [row] = await db
    .insert(organizationAiCredentials)
    .values({
      organizationId: orgId,
      provider,
      encryptedKey: encryptSecret(apiKey),
      baseUrl,
      label,
    })
    .returning({ id: organizationAiCredentials.id });

  const mask = maskSecret(apiKey);

  await insertActivityLog(
    {
      orgId,
      entityType: "ai_credential",
      entityId: row.id,
      action: "ai_credential_added",
      actorId,
      // Diff carries the mask, never the key.
      changes: {
        provider: { old: null, new: provider },
        label: { old: null, new: label },
        baseUrl: { old: null, new: baseUrl },
        mask: { old: null, new: mask },
      },
    },
    db,
  );

  return { id: row.id, provider, mask };
}

/**
 * Soft-delete: revocation sets revokedAt rather than deleting the row, so the
 * audit trail survives. ai_provider_health keys on a fingerprint of the key
 * material rather than the row, so nothing is orphaned by this.
 */
export async function revokeOrgAiCredential(
  db: DbExecutor,
  input: { orgId: string; actorId: string; credentialId: string },
): Promise<{ success: true }> {
  const { orgId, actorId, credentialId } = input;
  if (!credentialId || credentialId.startsWith("legacy:")) {
    throw new Error("Legacy Gemini keys are removed from the Gemini key list");
  }

  const now = new Date();
  const [updated] = await db
    .update(organizationAiCredentials)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(organizationAiCredentials.id, credentialId),
        eq(organizationAiCredentials.organizationId, orgId),
        isNull(organizationAiCredentials.revokedAt),
      ),
    )
    .returning({ id: organizationAiCredentials.id, provider: organizationAiCredentials.provider });

  if (!updated) throw new Error("Credential not found");

  await insertActivityLog(
    {
      orgId,
      entityType: "ai_credential",
      entityId: updated.id,
      action: "ai_credential_revoked",
      actorId,
      changes: {
        provider: { old: updated.provider, new: updated.provider },
        revokedAt: { old: null, new: now.toISOString() },
      },
    },
    db,
  );

  return { success: true };
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface EffectiveChainHop extends ChainEntry {
  /** False when the provider is not on the org's allowlist — shown, not run. */
  allowed: boolean;
}

export interface EffectiveChainView {
  task: AiTaskName;
  category: AITaskCategory;
  /** Document tasks send bytes to the model and are Gemini-only by policy. */
  documentTask: boolean;
  source: "default" | "override";
  hops: EffectiveChainHop[];
}

export interface AutonomyKindView {
  kind: AiProposalKind;
  /** Whether the org currently has auto-apply flipped on for this kind. */
  enabled: boolean;
  eligibility: AutonomyEligibility;
}

export interface OrgAiConfigView {
  providerAllowlist: AiProvider[] | null;
  taskChains: Record<string, ChainEntry[]> | null;
  confidenceThresholds: Record<string, number>;
  taskAllowlist: string[] | null;
  monthlySpendCapUsd: number | null;
  killSwitch: boolean;
  updatedAt: Date | null;
  /** What will actually run per task, derived from DEFAULT_CHAINS + overrides. */
  effectiveChains: EffectiveChainView[];
  /** Per-kind auto-apply state (allowlisted kinds only). */
  autonomy: Record<string, string>;
  autonomyKinds: AutonomyKindView[];
  /** Kinds a human must always apply — shown disabled in the UI, with the reason. */
  walledKinds: AiProposalKind[];
}

function parseChain(value: unknown): ChainEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: ChainEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const hop = raw as { provider?: unknown; model?: unknown };
    if (!isAiProvider(hop.provider)) continue;
    if (typeof hop.model !== "string" || !hop.model.trim()) continue;
    entries.push({ provider: hop.provider, model: hop.model.trim() });
  }
  return entries.length > 0 ? entries : null;
}

async function readSettingsRow(db: DbExecutor, orgId: string) {
  const [row] = await db
    .select()
    .from(organizationAiSettings)
    .where(eq(organizationAiSettings.organizationId, orgId))
    .limit(1);
  return row ?? null;
}

function toOrgAiSettings(row: Awaited<ReturnType<typeof readSettingsRow>>): OrgAiSettings {
  return {
    taskChains: row?.taskChains ?? null,
    confidenceThresholds: row?.confidenceThresholds ?? {},
    autonomy: row?.autonomy ?? {},
    taskAllowlist: row?.taskAllowlist ?? null,
    providerAllowlist: (row?.providerAllowlist as AiProvider[] | null) ?? null,
    monthlySpendCapUsd: row?.monthlySpendCapUsd != null ? Number(row.monthlySpendCapUsd) : null,
    killSwitch: row?.killSwitch ?? false,
  };
}

/**
 * Read settings (or defaults) PLUS the effective chain per task, so the UI can
 * show what will actually run rather than only what was overridden.
 *
 * Mirrors router.ts precedence minus the async credential-presence check: the
 * override (already OCR-policy-clean at rest) else DEFAULT_CHAINS, with each
 * hop flagged against the provider allowlist.
 */
export async function getOrgAiConfig(db: DbExecutor, orgId: string): Promise<OrgAiConfigView> {
  const row = await readSettingsRow(db, orgId);
  const settings = toOrgAiSettings(row);

  const autonomyKinds: AutonomyKindView[] = [];
  for (const kind of AUTONOMY_ALLOWED_KINDS) {
    autonomyKinds.push({
      kind,
      enabled: settings.autonomy[kind] === AUTONOMY_MODE,
      eligibility: await computeAutonomyEligibility(db, orgId, kind),
    });
  }

  const effectiveChains: EffectiveChainView[] = AI_TASK_NAMES.map((task) => {
    const override = parseChain(settings.taskChains?.[task]);
    const chain = enforceOcrPolicy(task, override ?? DEFAULT_CHAINS[task]);
    return {
      task,
      category: AI_TASK_CATEGORY[task],
      documentTask: DOCUMENT_TASKS.has(task),
      source: override ? "override" : "default",
      hops: chain.map((hop) => ({ ...hop, allowed: isProviderAllowed(settings, hop.provider) })),
    };
  });

  const normalizedChains = settings.taskChains
    ? Object.fromEntries(
        Object.entries(settings.taskChains).flatMap(([task, value]) => {
          const parsed = parseChain(value);
          return parsed ? [[task, parsed] as const] : [];
        }),
      )
    : null;

  return {
    providerAllowlist: settings.providerAllowlist,
    taskChains: normalizedChains,
    confidenceThresholds: settings.confidenceThresholds,
    taskAllowlist: settings.taskAllowlist,
    monthlySpendCapUsd: settings.monthlySpendCapUsd,
    killSwitch: settings.killSwitch,
    updatedAt: row?.updatedAt ?? null,
    effectiveChains,
    autonomy: settings.autonomy,
    autonomyKinds,
    walledKinds: [...STRUCTURAL_MANUAL_KINDS],
  };
}

export interface UpdateOrgAiConfigInput {
  orgId: string;
  actorId: string;
  providerAllowlist?: unknown;
  taskChains?: unknown;
  confidenceThresholds?: unknown;
  monthlySpendCapUsd?: unknown;
  killSwitch?: unknown;
  taskAllowlist?: unknown;
  autonomy?: unknown;
}

function sanitizeProviderAllowlist(value: unknown): AiProvider[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("providerAllowlist must be an array");
  const list = [...new Set(value.filter(isAiProvider))];
  // Empty ⇒ null, which isProviderAllowed reads as "Gemini only" — the same
  // posture, expressed as the default rather than as an explicit empty set.
  if (list.length === 0) return null;
  // Gemini is load-bearing: document tasks are Gemini-only by policy, so an
  // allowlist that omits it would silently disable every OCR path.
  if (!list.includes("gemini")) list.unshift("gemini");
  return list;
}

function sanitizeTaskChains(value: unknown): Record<string, ChainEntry[]> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("taskChains must be an object keyed by task name");
  }
  const out: Record<string, ChainEntry[]> = {};
  for (const [task, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isAiTaskName(task)) continue;
    const parsed = parseChain(raw);
    if (!parsed) continue;
    // THE choke point: a document task's chain is filtered to Gemini here, at
    // rest, so no later read can resurrect a non-Gemini hop.
    const policed = enforceOcrPolicy(task, parsed);
    if (policed.length === 0) {
      // Every hop was stripped (e.g. an all-Anthropic OCR chain). Fall back to
      // the Gemini default rather than persisting an unusable empty chain.
      if (DOCUMENT_TASKS.has(task)) out[task] = [...DEFAULT_CHAINS[task]];
      continue;
    }
    out[task] = policed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeThresholds(value: unknown): Record<string, number> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("confidenceThresholds must be an object keyed by task name");
  }
  const out: Record<string, number> = {};
  for (const [task, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isAiTaskName(task)) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) continue;
    out[task] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeTaskAllowlist(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("taskAllowlist must be an array");
  const list = [...new Set(value.filter(isAiTaskName))];
  return list.length > 0 ? list : null;
}

/** The only autonomy mode that exists. */
export const AUTONOMY_MODE = "auto_apply_high_confidence";

function sanitizeAutonomy(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("autonomy must be an object keyed by proposal kind");
  }
  const out: Record<string, string> = {};
  for (const [kind, mode] of Object.entries(value as Record<string, unknown>)) {
    // Falsy mode = "off" for that kind — expressed by omission at rest.
    if (mode == null || mode === false || mode === "") continue;
    if (mode !== AUTONOMY_MODE) {
      throw new Error(`Unsupported autonomy mode for "${kind}" — only "${AUTONOMY_MODE}" exists`);
    }
    if (STRUCTURAL_MANUAL_KINDS.has(kind as AiProposalKind)) {
      throw new Error(`"${kind}" is always applied by a human and can never be automated`);
    }
    if (!AUTONOMY_ALLOWED_KINDS.has(kind as AiProposalKind)) {
      throw new Error(
        `"${kind}" cannot be auto-applied — approving it is the human feedback signal`,
      );
    }
    out[kind] = AUTONOMY_MODE;
  }
  return out;
}

function sanitizeSpendCap(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("monthlySpendCapUsd must be a positive number");
  return n;
}

function diffField(
  changes: Record<string, { old: unknown; new: unknown }>,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  if (JSON.stringify(oldValue ?? null) === JSON.stringify(newValue ?? null)) return;
  changes[field] = { old: oldValue ?? null, new: newValue ?? null };
}

/**
 * Upsert the org's AI settings. Only the fields present in `input` are
 * touched; everything else keeps its stored value.
 */
export async function updateOrgAiConfig(
  db: DbExecutor,
  input: UpdateOrgAiConfigInput,
): Promise<{ success: true; changes: Record<string, { old: unknown; new: unknown }> }> {
  const { orgId, actorId } = input;

  const existing = await readSettingsRow(db, orgId);
  const current = toOrgAiSettings(existing);

  const patch: Record<string, unknown> = {};
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  if (input.providerAllowlist !== undefined) {
    const next = sanitizeProviderAllowlist(input.providerAllowlist);
    patch.providerAllowlist = next;
    diffField(changes, "providerAllowlist", current.providerAllowlist, next);
  }
  if (input.taskChains !== undefined) {
    const next = sanitizeTaskChains(input.taskChains);
    patch.taskChains = next;
    diffField(changes, "taskChains", current.taskChains, next);
  }
  if (input.confidenceThresholds !== undefined) {
    const next = sanitizeThresholds(input.confidenceThresholds);
    patch.confidenceThresholds = next;
    diffField(
      changes,
      "confidenceThresholds",
      Object.keys(current.confidenceThresholds).length > 0 ? current.confidenceThresholds : null,
      next,
    );
  }
  if (input.taskAllowlist !== undefined) {
    const next = sanitizeTaskAllowlist(input.taskAllowlist);
    patch.taskAllowlist = next;
    diffField(changes, "taskAllowlist", current.taskAllowlist, next);
  }
  if (input.monthlySpendCapUsd !== undefined) {
    const next = sanitizeSpendCap(input.monthlySpendCapUsd);
    // numeric column — drizzle takes the decimal as a string.
    patch.monthlySpendCapUsd = next == null ? null : String(next);
    diffField(changes, "monthlySpendCapUsd", current.monthlySpendCapUsd, next);
  }
  if (input.killSwitch !== undefined) {
    const next = Boolean(input.killSwitch);
    patch.killSwitch = next;
    diffField(changes, "killSwitch", current.killSwitch, next);
  }
  if (input.autonomy !== undefined) {
    const next = sanitizeAutonomy(input.autonomy);
    // Promotion is earned AND human-initiated: every kind being turned ON is
    // re-verified against eligibility at the moment of the flip. Kinds
    // already on stay on — narrowing belongs to the demotion loop.
    for (const kind of Object.keys(next)) {
      if (current.autonomy[kind] === AUTONOMY_MODE) continue;
      const eligibility = await computeAutonomyEligibility(db, orgId, kind as AiProposalKind);
      if (!eligibility.eligible) {
        throw new Error(`Auto-apply for "${kind}" is not earned yet. ${eligibility.reason}`);
      }
    }
    patch.autonomy = next;
    diffField(
      changes,
      "autonomy",
      Object.keys(current.autonomy).length > 0 ? current.autonomy : null,
      Object.keys(next).length > 0 ? next : null,
    );
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("No AI settings fields supplied");
  }

  const now = new Date();
  await db
    .insert(organizationAiSettings)
    .values({ organizationId: orgId, ...patch, updatedBy: actorId, updatedAt: now })
    .onConflictDoUpdate({
      target: organizationAiSettings.organizationId,
      set: { ...patch, updatedBy: actorId, updatedAt: now },
    });

  // The 30s read cache would otherwise hide the change from the hot path.
  invalidateOrgAiSettings(orgId);

  await insertActivityLog(
    {
      orgId,
      entityType: "ai_settings",
      entityId: aiConfigEntityId(orgId),
      action: "ai_settings_updated",
      actorId,
      changes,
    },
    db,
  );

  return { success: true, changes };
}

/**
 * Auto-demotion: evaluated on every negative feedback row (reject/correct).
 * Narrows authority only — flips a kind's auto-apply OFF when the trailing
 * window's acceptance slips below the demotion floor, with an activity-log
 * row attributing the flip to the user whose feedback tripped it. Promotion
 * is never automatic.
 */
export async function demoteAutonomyIfSlipped(
  db: DbExecutor,
  orgId: string,
  kind: AiProposalKind,
  actorId: string,
): Promise<boolean> {
  const row = await readSettingsRow(db, orgId);
  const autonomy: Record<string, AiAutonomyLevel> = { ...(row?.autonomy ?? {}) };
  if (autonomy[kind] !== AUTONOMY_MODE) return false;
  if (!(await shouldDemote(db, orgId, kind))) return false;

  const before = { ...autonomy };
  delete autonomy[kind];
  await db
    .update(organizationAiSettings)
    .set({ autonomy, updatedAt: new Date() })
    .where(eq(organizationAiSettings.organizationId, orgId));
  invalidateOrgAiSettings(orgId);
  await insertActivityLog(
    {
      orgId,
      entityType: "ai_settings",
      entityId: aiConfigEntityId(orgId),
      action: "ai_autonomy_demoted",
      actorId,
      changes: { autonomy: { old: before, new: autonomy } },
    },
    db,
  );
  return true;
}
