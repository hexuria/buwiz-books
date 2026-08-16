// ============================================================================
// aiComplete — the ONE way the app talks to a model.
//
// Zod in / Zod out, plus every cross-cutting guardrail in one choke point:
//
//   kill switch → task allowlist → chain resolution (OCR policy, provider
//   allowlist, credential presence) → PII redaction → hop loop → Zod
//   validation → telemetry.
//
// The hop loop advances on provider exhaustion, bad credentials, schema
// rejection, or output that fails validation; the first hop producing
// schema-valid output wins. Callers only ever see the discriminated result —
// no SDK types, no raw text, no fence parsing, no provider awareness.
// ============================================================================

import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../db";
import { organization } from "../../db/schema/auth";
import type { AiTaskName, AiCallContext } from "./types";
import { getTaskEntry } from "./prompts/index";
import { generateStructured } from "./adapters/gemini";
import { generateStructuredAnthropic } from "./adapters/anthropic";
import { generateStructuredOpenAi } from "./adapters/openai";
import { parseModelJson } from "./parse-model-json";
import { recordValidationOutcome, logProviderInvocation } from "./invoke";
import { resolveChain } from "./router";
import { getOrgAiSettings, isTaskAllowed } from "./settings";
import { getOrgCredentials } from "./credentials";
import { toRedactedPrompt, type RedactedPrompt } from "./redact";
import { assertWithinSpendCap } from "./spend";
import { enforceGrounding, TASK_GROUNDING } from "./grounding";
import { AiProviderError } from "./errors";
import * as health from "./provider-health";
import { createLogger } from "../logger";

const logger = createLogger("ai.facade");

export class AiDisabledError extends Error {
  constructor(orgId: string) {
    super("AI is currently disabled for this organization.");
    this.name = "AiDisabledError";
    void orgId;
  }
}

export class AiTaskNotAllowedError extends Error {
  constructor(task: AiTaskName) {
    super(`AI task "${task}" is not enabled for this organization.`);
    this.name = "AiTaskNotAllowedError";
  }
}

export class AiNoCredentialsError extends Error {
  constructor(task: AiTaskName) {
    super(
      `No usable AI provider is configured for "${task}". Add an API key in Settings → AI Credentials.`,
    );
    this.name = "AiNoCredentialsError";
  }
}

export interface AiCompleteArgs<TOut = unknown> {
  task: AiTaskName;
  input: unknown;
  schema?: z.ZodType<TOut>;
  ctx: AiCallContext;
  media?: Array<{ mimeType: string; dataBase64: string }>;
  modelOverride?: string;
  generation?: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
  /**
   * Allowed entity IDs per grounding set (see grounding.ts). Callers MUST
   * read these server-side; anything the model returns outside these sets is
   * blanked.
   */
  allowedIds?: Record<string, Set<string>>;
}

export type AiCompleteResult<TOut> =
  | { ok: true; data: TOut; invocationId: string | null; model: string | null }
  | { ok: false; needsReview: true; invocationId: string | null; issues: string[] };

async function loadOrgMetadata(orgId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    return row?.metadata ?? null;
  } catch {
    return null;
  }
}

export async function aiComplete<TOut = unknown>(
  args: AiCompleteArgs<TOut>,
): Promise<AiCompleteResult<TOut>> {
  const entry = getTaskEntry(args.task);
  const schema = (args.schema ?? entry.schema) as z.ZodType<TOut>;
  const { orgId } = args.ctx;

  // ── Guardrails, before any spend ──────────────────────────────────────
  const settings = await getOrgAiSettings(orgId);
  if (settings.killSwitch) throw new AiDisabledError(orgId);
  if (!isTaskAllowed(settings, args.task)) throw new AiTaskNotAllowedError(args.task);
  // One check per logical call, before any hop spends money.
  await assertWithinSpendCap(orgId, settings.monthlySpendCapUsd);

  const orgMetadata = await loadOrgMetadata(orgId);
  const { hops, filtered } = await resolveChain({
    task: args.task,
    orgId,
    settings,
    orgMetadata,
    modelOverride: args.modelOverride,
  });
  if (hops.length === 0) {
    logger.warn("No usable provider hop for task", {
      orgId: orgId.slice(0, 8),
      task: args.task,
      filtered,
    });
    throw new AiNoCredentialsError(args.task);
  }

  // ── Prompt + MANDATORY redaction ──────────────────────────────────────
  // The branded type means an adapter cannot be called with unredacted text.
  const { prompt, hits } = toRedactedPrompt(entry.prompt.build(args.input as never));

  const issues: string[] = [];
  let lastInvocationId: string | null = null;
  let escalationReason: string | undefined;

  for (let position = 0; position < hops.length; position++) {
    const hop = hops[position];

    try {
      const { text, invocationId, model } = await callHop({
        hop,
        position,
        escalationReason,
        task: args.task,
        prompt,
        schema,
        media: args.media,
        ctx: args.ctx,
        generation: args.generation ?? entry.generation,
        entry,
        redactionHits: hits.length,
      });
      lastInvocationId = invocationId;

      const parsed = parseModelJson(schema, text);
      if (parsed.ok) {
        // Grounding: blank any entity ID the caller did not supply, so a
        // hallucinated account can never reach a write path.
        const rules = TASK_GROUNDING[args.task] ?? [];
        const { output, blanked } = enforceGrounding(parsed.data, rules, args.allowedIds ?? {});
        if (blanked.length > 0) {
          logger.warn("Blanked ungrounded ids from model output", {
            orgId: orgId.slice(0, 8),
            task: args.task,
            blanked,
          });
        }
        await recordValidationOutcome(invocationId, "valid");
        return { ok: true, data: output, invocationId, model };
      }

      // Schema-invalid output: try the next hop rather than failing outright.
      await recordValidationOutcome(invocationId, "failed");
      issues.push(...parsed.issues);
      escalationReason = "validation_failed";
      logger.warn("Hop produced schema-invalid output — escalating", {
        orgId: orgId.slice(0, 8),
        task: args.task,
        provider: hop.provider,
        position,
      });
    } catch (err) {
      const providerError =
        err instanceof AiProviderError
          ? err
          : new AiProviderError({
              class: "unknown",
              provider: hop.provider,
              cause: err,
              message: err instanceof Error ? err.message : String(err),
            });

      if (!providerError.escalateChain) throw providerError;

      escalationReason = providerError.errorClass;
      issues.push(`${hop.provider}: ${providerError.errorClass}`);
      logger.warn("Hop failed — escalating", {
        orgId: orgId.slice(0, 8),
        task: args.task,
        provider: hop.provider,
        position,
        errorClass: providerError.errorClass,
      });
    }
  }

  return {
    ok: false,
    needsReview: true,
    invocationId: lastInvocationId,
    issues: issues.length > 0 ? issues : ["All configured providers failed."],
  };
}

interface CallHopArgs<TOut> {
  hop: { provider: string; model: string };
  position: number;
  escalationReason?: string;
  task: AiTaskName;
  prompt: RedactedPrompt;
  schema: z.ZodType<TOut>;
  media?: Array<{ mimeType: string; dataBase64: string }>;
  ctx: AiCallContext;
  generation?: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
  entry: ReturnType<typeof getTaskEntry>;
  redactionHits: number;
}

/** Dispatch one hop to its adapter, recording provenance. */
async function callHop<TOut>(
  args: CallHopArgs<TOut>,
): Promise<{ text: string; invocationId: string | null; model: string | null }> {
  const { hop, ctx, entry } = args;

  // Gemini keeps its own key rotation and telemetry inside gemini-client.
  if (hop.provider === "gemini") {
    const result = await generateStructured({
      task: args.task,
      promptText: String(args.prompt),
      geminiSchema: entry.geminiSchema,
      ctx,
      media: args.media,
      modelOverride: hop.model,
      generation: args.generation,
      promptName: entry.prompt.id,
      promptVersion: entry.prompt.version,
      schemaHash: entry.schemaHash,
    });
    return result;
  }

  // Non-Gemini providers: pick a healthy credential, call, record health.
  const credentials = await getOrgCredentials(ctx.orgId, hop.provider as never);
  if (credentials.length === 0) {
    throw new AiProviderError({
      class: "invalid_key",
      provider: hop.provider as never,
      message: `No credential configured for ${hop.provider}`,
    });
  }
  const snapshots = await health.loadHealth(
    ctx.orgId,
    credentials.map((c) => c.fingerprint),
  );
  const credential =
    credentials.find((c) => health.isAvailable(snapshots.get(c.fingerprint))) ?? null;
  if (!credential) {
    throw new AiProviderError({
      class: "rate_limited",
      provider: hop.provider as never,
      message: `All ${hop.provider} credentials are cooling down`,
    });
  }

  const started = Date.now();
  try {
    const result =
      hop.provider === "anthropic"
        ? await generateStructuredAnthropic({
            apiKey: credential.apiKey,
            model: hop.model,
            prompt: args.prompt,
            schema: args.schema,
            temperature: args.generation?.temperature,
            maxOutputTokens: args.generation?.maxOutputTokens,
          })
        : await generateStructuredOpenAi({
            apiKey: credential.apiKey,
            model: hop.model,
            baseURL: credential.baseUrl,
            prompt: args.prompt,
            schema: args.schema,
            schemaName: entry.prompt.id.replace(/-/g, "_"),
            temperature: args.generation?.temperature,
            maxOutputTokens: args.generation?.maxOutputTokens,
          });

    await health.recordSuccess(ctx.orgId, credential.fingerprint);
    const invocationId = await logProviderInvocation({
      orgId: ctx.orgId,
      task: args.task,
      provider: hop.provider,
      model: hop.model,
      chainPosition: args.position,
      escalationReason: args.escalationReason,
      promptName: entry.prompt.id,
      promptVersion: entry.prompt.version,
      schemaHash: entry.schemaHash,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      latencyMs: Date.now() - started,
      requestId: ctx.requestId,
      configSnapshot: { redactionHits: args.redactionHits },
    });
    return { text: result.text, invocationId, model: hop.model };
  } catch (err) {
    if (err instanceof AiProviderError && err.isCredentialFailure) {
      await health.markInvalid(ctx.orgId, credential.fingerprint);
    } else if (err instanceof AiProviderError && err.retryableSameProvider) {
      await health.recordFailure(ctx.orgId, credential.fingerprint, err.errorClass);
    }
    await logProviderInvocation({
      orgId: ctx.orgId,
      task: args.task,
      provider: hop.provider,
      model: hop.model,
      chainPosition: args.position,
      escalationReason: args.escalationReason,
      promptName: entry.prompt.id,
      promptVersion: entry.prompt.version,
      schemaHash: entry.schemaHash,
      latencyMs: Date.now() - started,
      requestId: ctx.requestId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
