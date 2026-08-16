// ============================================================================
// Gemini adapter — the façade's only Gemini-specific code.
//
// Wraps invokeModelText (which wraps gemini-client's callWithRetry UNCHANGED:
// key rotation, cooldowns, per-org model resolution, telemetry all intact).
// Owns: content-part assembly (prompt + inline media) and generationConfig.
// Phase 4 adds sibling Anthropic/OpenAI adapters behind the same shape.
// ============================================================================

import type { ResponseSchema } from "@google/generative-ai";
import type { AiTaskName, AiCallContext } from "../types";
import { AI_TASK_CATEGORY } from "../types";
import type { GeminiSchema } from "../zod-to-gemini-schema";
import { invokeModelText } from "../invoke";

export interface GenerateStructuredArgs {
  task: AiTaskName;
  promptText: string;
  geminiSchema: GeminiSchema;
  ctx: AiCallContext;
  media?: Array<{ mimeType: string; dataBase64: string }>;
  modelOverride?: string;
  generation?: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
  promptName: string;
  promptVersion: string;
  schemaHash: string;
}

export interface GenerateStructuredResult {
  text: string;
  invocationId: string | null;
  model: string | null;
}

export async function generateStructured(
  args: GenerateStructuredArgs,
): Promise<GenerateStructuredResult> {
  const inlineParts = (args.media ?? []).map((m) => ({
    inlineData: { data: m.dataBase64, mimeType: m.mimeType },
  }));

  const { text, invocationId, model } = await invokeModelText(
    {
      orgId: args.ctx.orgId,
      task: AI_TASK_CATEGORY[args.task],
      taskName: args.task,
      model: args.modelOverride,
      promptName: args.promptName,
      promptVersion: args.promptVersion,
      schemaHash: args.schemaHash,
      requestId: args.ctx.requestId,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: args.geminiSchema as unknown as ResponseSchema,
        ...(args.generation?.temperature !== undefined
          ? { temperature: args.generation.temperature }
          : {}),
        ...(args.generation?.maxOutputTokens !== undefined
          ? { maxOutputTokens: args.generation.maxOutputTokens }
          : {}),
        // Bound reasoning tokens so they cannot consume the whole
        // maxOutputTokens budget and truncate the JSON. See the note on
        // `thinkingBudget` in prompts/index.ts.
        //
        // NOTE: @google/generative-ai's GenerationConfig does not declare
        // thinkingConfig, but the SDK serializes the config object as-is, so
        // the field does reach the API (verified against the wire). If that
        // SDK is ever replaced, re-check that this still arrives.
        ...(args.generation?.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: args.generation.thinkingBudget } }
          : {}),
      },
    },
    async (model) =>
      model.generateContent(
        inlineParts.length > 0 ? [args.promptText, ...inlineParts] : args.promptText,
      ),
  );

  return { text, invocationId, model };
}
