// ============================================================================
// Pre-façade model invocation wrapper (Phase 0).
//
// Delegates to gemini-client's callWithRetry unchanged, but owns what every
// call site previously hand-rolled: response-text extraction, usage metadata,
// timing, and the ai_invocations telemetry row. Phase 1's aiComplete façade
// absorbs this module as the Gemini adapter's internals.
//
// Telemetry writes use the RAW pool db, never ctx.db: a row must survive the
// caller's transaction rollback, and a telemetry failure must never fail the
// user's call (insert errors are logged and swallowed).
// ============================================================================

import type { GenerateContentResult, GenerativeModel } from "@google/generative-ai";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { aiInvocations } from "../../db/schema/ai";
import { callWithRetry, type GeminiCallOptions } from "../gemini-client";
import { createLogger } from "../logger";
import { estimateCostUsd } from "./pricing";

const logger = createLogger("ai.invoke");

export interface InvokeModelOptions extends GeminiCallOptions {
  /** Fine-grained task name recorded in telemetry (e.g. "statement_ocr"). */
  taskName: string;
  promptName?: string;
  promptVersion?: string;
  schemaHash?: string;
  requestId?: string;
}

export interface ModelUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  totalTokens: number | null;
}

export interface InvokeModelTextResult {
  text: string;
  model: string | null;
  usage: ModelUsage;
  invocationId: string | null;
  latencyMs: number;
}

export interface InvokeModelRawResult<T> {
  result: T;
  model: string | null;
  usage: ModelUsage;
  invocationId: string | null;
  latencyMs: number;
}

function extractUsage(result: GenerateContentResult): ModelUsage {
  const meta = result.response.usageMetadata;
  return {
    tokensIn: meta?.promptTokenCount ?? null,
    tokensOut: meta?.candidatesTokenCount ?? null,
    totalTokens: meta?.totalTokenCount ?? null,
  };
}

interface LogRowInput {
  opts: InvokeModelOptions;
  model: string | null;
  usage: ModelUsage | null;
  latencyMs: number;
  errorMessage?: string;
}

/** Insert the telemetry row on the raw pool; never throws. */
async function logInvocation({
  opts,
  model,
  usage,
  latencyMs,
  errorMessage,
}: LogRowInput): Promise<string | null> {
  try {
    const [row] = await db
      .insert(aiInvocations)
      .values({
        organizationId: opts.orgId,
        task: opts.taskName,
        promptName: opts.promptName,
        promptVersion: opts.promptVersion,
        schemaHash: opts.schemaHash,
        provider: "gemini",
        model,
        tokensIn: usage?.tokensIn ?? null,
        tokensOut: usage?.tokensOut ?? null,
        costUsd: (() => {
          const cost = estimateCostUsd({
            model,
            tokensIn: usage?.tokensIn,
            tokensOut: usage?.tokensOut,
          });
          return cost != null ? String(cost) : null;
        })(),
        latencyMs,
        errorMessage,
        requestId: opts.requestId,
      })
      .returning({ id: aiInvocations.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error("Failed to write ai_invocations row", {
      task: opts.taskName,
      orgId: opts.orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Record how schema validation of this invocation's output went.
 * Called by routes after parseModelJson; fire-and-forget semantics.
 */
export async function recordValidationOutcome(
  invocationId: string | null,
  outcome: "valid" | "repaired" | "failed",
): Promise<void> {
  if (!invocationId) return;
  try {
    await db
      .update(aiInvocations)
      .set({ validationOutcome: outcome })
      .where(eq(aiInvocations.id, invocationId));
  } catch (err) {
    logger.error("Failed to record validation outcome", {
      invocationId,
      outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Execute a text-returning Gemini call with telemetry.
 * The callback returns the raw GenerateContentResult; this wrapper (not each
 * call site) extracts `.response.text()` and usage metadata.
 */
export async function invokeModelText(
  opts: InvokeModelOptions,
  request: (model: GenerativeModel) => Promise<GenerateContentResult>,
): Promise<InvokeModelTextResult> {
  const { result, model, usage, invocationId, latencyMs } = await invokeModelRaw(opts, request);
  return { text: result.response.text(), model, usage, invocationId, latencyMs };
}

/**
 * Execute any Gemini call with telemetry, returning the raw result.
 * For non-text outputs (image generation / thumbnails).
 */
export async function invokeModelRaw<T extends GenerateContentResult>(
  opts: InvokeModelOptions,
  request: (model: GenerativeModel) => Promise<T>,
): Promise<InvokeModelRawResult<T>> {
  const started = Date.now();
  let resolvedModel: string | null = null;

  try {
    const result = await callWithRetry(
      {
        ...opts,
        onAttempt: (info) => {
          resolvedModel = info.model;
          opts.onAttempt?.(info);
        },
      },
      request,
    );
    const latencyMs = Date.now() - started;
    const usage = extractUsage(result);
    const invocationId = await logInvocation({ opts, model: resolvedModel, usage, latencyMs });
    return { result, model: resolvedModel, usage, invocationId, latencyMs };
  } catch (err) {
    await logInvocation({
      opts,
      model: resolvedModel,
      usage: null,
      latencyMs: Date.now() - started,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export interface ProviderInvocationLog {
  orgId: string;
  task: string;
  provider: string;
  model: string;
  chainPosition?: number;
  escalationReason?: string;
  promptName?: string;
  promptVersion?: string;
  schemaHash?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number;
  requestId?: string;
  errorMessage?: string;
  configSnapshot?: Record<string, unknown>;
}

/**
 * Telemetry for a NON-Gemini provider hop. (Gemini calls are logged inside
 * invokeModelRaw, which also owns key rotation.) Raw pool, log-and-continue —
 * telemetry never fails a user call.
 */
export async function logProviderInvocation(input: ProviderInvocationLog): Promise<string | null> {
  try {
    const [row] = await db
      .insert(aiInvocations)
      .values({
        organizationId: input.orgId,
        task: input.task,
        provider: input.provider,
        model: input.model,
        chainPosition: input.chainPosition,
        escalationReason: input.escalationReason,
        promptName: input.promptName,
        promptVersion: input.promptVersion,
        schemaHash: input.schemaHash,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        costUsd: (() => {
          const cost = estimateCostUsd({
            model: input.model,
            tokensIn: input.tokensIn,
            tokensOut: input.tokensOut,
          });
          return cost != null ? String(cost) : null;
        })(),
        latencyMs: input.latencyMs,
        requestId: input.requestId,
        errorMessage: input.errorMessage,
        configSnapshot: input.configSnapshot,
      })
      .returning({ id: aiInvocations.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error("Failed to write provider ai_invocations row", {
      task: input.task,
      provider: input.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
