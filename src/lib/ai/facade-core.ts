import type { z } from "zod";
import type { AiProvider } from "./errors";
import { AiProviderError } from "./errors";
import { enforceGrounding, TASK_GROUNDING } from "./grounding";
import { parseModelJson } from "./parse-model-json";
import { getTaskEntry } from "./prompts/index";
import { toRedactedPrompt, type RedactedPrompt } from "./redact";
import type { AiCallContext, AiTaskName } from "./types";
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
   * Allowed entity IDs per grounding set. Callers must read these server-side;
   * model output outside these sets is blanked before it reaches a write path.
   */
  allowedIds?: Record<string, Set<string>>;
}

export type AiCompleteResult<TOut> =
  | { ok: true; data: TOut; invocationId: string | null; model: string | null }
  | { ok: false; needsReview: true; invocationId: string | null; issues: string[] };

export interface AiCompletionHop {
  provider: AiProvider;
  model: string;
}

export type AiCompletionPreparation =
  | { kind: "disabled" }
  | { kind: "task_not_allowed" }
  | { kind: "no_credentials"; filtered: Array<AiCompletionFilteredHop> }
  | { kind: "ready"; hops: AiCompletionHop[] };

export interface AiCompletionFilteredHop extends AiCompletionHop {
  reason: string;
}

export interface AiHopInvocation<TOut> {
  hop: AiCompletionHop;
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

export interface AiCompletionRuntime {
  /** Resolve all database-backed guardrails and the usable provider chain. */
  prepare(input: {
    task: AiTaskName;
    orgId: string;
    modelOverride?: string;
  }): Promise<AiCompletionPreparation>;
  /** Invoke one provider hop and own provider credentials, health, and telemetry. */
  invokeHop<TOut>(
    input: AiHopInvocation<TOut>,
  ): Promise<{ text: string; invocationId: string | null; model: string | null }>;
  /** Persist output-validation telemetry without exposing its storage to the orchestrator. */
  recordValidationOutcome(
    invocationId: string | null,
    outcome: "valid" | "repaired" | "failed",
  ): Promise<void>;
}

export function createAiComplete(runtime: AiCompletionRuntime) {
  return async function aiComplete<TOut = unknown>(
    args: AiCompleteArgs<TOut>,
  ): Promise<AiCompleteResult<TOut>> {
    const entry = getTaskEntry(args.task);
    const schema = (args.schema ?? entry.schema) as z.ZodType<TOut>;
    const { orgId } = args.ctx;

    const preparation = await runtime.prepare({
      task: args.task,
      orgId,
      modelOverride: args.modelOverride,
    });
    if (preparation.kind === "disabled") throw new AiDisabledError(orgId);
    if (preparation.kind === "task_not_allowed") throw new AiTaskNotAllowedError(args.task);
    if (preparation.kind === "no_credentials") {
      logger.warn("No usable provider hop for task", {
        orgId: orgId.slice(0, 8),
        task: args.task,
        filtered: preparation.filtered,
      });
      throw new AiNoCredentialsError(args.task);
    }

    const { prompt, hits } = toRedactedPrompt(entry.prompt.build(args.input as never));
    const issues: string[] = [];
    let lastInvocationId: string | null = null;
    let escalationReason: string | undefined;

    for (let position = 0; position < preparation.hops.length; position++) {
      const hop = preparation.hops[position];

      let invocation:
        | { text: string; invocationId: string | null; model: string | null }
        | undefined;
      try {
        invocation = await runtime.invokeHop({
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
      } catch (error) {
        const providerError =
          error instanceof AiProviderError
            ? error
            : new AiProviderError({
                class: "unknown",
                provider: hop.provider,
                cause: error,
                message: error instanceof Error ? error.message : String(error),
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
        continue;
      }

      const { text, invocationId, model } = invocation;
      lastInvocationId = invocationId;
      const parsed = parseModelJson(schema, text);
      if (parsed.ok) {
        const rules = TASK_GROUNDING[args.task] ?? [];
        const { output, blanked } = enforceGrounding(parsed.data, rules, args.allowedIds ?? {});
        if (blanked.length > 0) {
          logger.warn("Blanked ungrounded ids from model output", {
            orgId: orgId.slice(0, 8),
            task: args.task,
            blanked,
          });
        }
        await recordValidationOutcome(runtime, invocationId, "valid");
        return { ok: true, data: output, invocationId, model };
      }

      await recordValidationOutcome(runtime, invocationId, "failed");
      issues.push(...parsed.issues);
      escalationReason = "validation_failed";
      logger.warn("Hop produced schema-invalid output — escalating", {
        orgId: orgId.slice(0, 8),
        task: args.task,
        provider: hop.provider,
        position,
      });
    }

    return {
      ok: false,
      needsReview: true,
      invocationId: lastInvocationId,
      issues: issues.length > 0 ? issues : ["All configured providers failed."],
    };
  };
}

async function recordValidationOutcome(
  runtime: AiCompletionRuntime,
  invocationId: string | null,
  outcome: "valid" | "repaired" | "failed",
): Promise<void> {
  try {
    await runtime.recordValidationOutcome(invocationId, outcome);
  } catch (error) {
    logger.error("Failed to record AI validation outcome", {
      invocationId,
      outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
