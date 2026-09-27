import { eq } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "../../db";
import { organization } from "../../db/schema/auth";
import { generateStructuredAnthropic } from "./adapters/anthropic";
import { generateStructured } from "./adapters/gemini";
import { generateStructuredJev } from "./adapters/jev";
import { generateStructuredOpenAi } from "./adapters/openai";
import { getOrgCredentials, type ResolvedCredential } from "./credentials";
import { AiProviderError, classifyGeminiError, toAiProviderError } from "./errors";
import type { AiCompletionRuntime, AiHopInvocation } from "./facade-core";
import { logProviderInvocation, recordValidationOutcome } from "./invoke";
import * as health from "./provider-health";
import { resolveChain } from "./router";
import { getOrgAiSettings, isTaskAllowed } from "./settings";
import { assertWithinSpendCap } from "./spend";
import { zodToGeminiSchema } from "./zod-to-gemini-schema";

async function loadOrgMetadata(executor: DbExecutor, orgId: string): Promise<string | null> {
  try {
    const [row] = await executor
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    return row?.metadata ?? null;
  } catch {
    return null;
  }
}

/** One non-Gemini text hop. Every adapter receives the RedactedPrompt only. */
async function callTextProvider<TOut>(
  args: AiHopInvocation<TOut>,
  credential: ResolvedCredential,
): Promise<{
  text: string;
  usage: { tokensIn: number | null; tokensOut: number | null };
  usageEstimated?: boolean;
}> {
  const common = {
    apiKey: credential.apiKey,
    model: args.hop.model,
    prompt: args.prompt,
    schema: args.schema,
    temperature: args.generation?.temperature,
    maxOutputTokens: args.generation?.maxOutputTokens,
  };
  const schemaName = args.entry.prompt.id.replace(/-/g, "_");
  switch (args.hop.provider) {
    case "anthropic":
      return generateStructuredAnthropic(common);
    case "jev":
      // The Jev adapter has no media parameter: document bytes attached to
      // this call never reach Jev, whatever the caller passed.
      return generateStructuredJev({ ...common, baseURL: credential.baseUrl, schemaName });
    default:
      return generateStructuredOpenAi({ ...common, baseURL: credential.baseUrl, schemaName });
  }
}

async function invokeHop<TOut>(
  args: AiHopInvocation<TOut>,
): Promise<{ text: string; invocationId: string | null; model: string | null }> {
  const { hop, ctx, entry } = args;

  if (hop.provider === "gemini") {
    try {
      return await generateStructured({
        task: args.task,
        promptText: String(args.prompt),
        // A caller-supplied schema (the closed per-request enums of
        // categorize_lines / match_party) must constrain Gemini's decoding
        // too, not only the app-side parse — the other adapters already send
        // args.schema. Without an override this is the precomputed schema.
        geminiSchema:
          args.schema === entry.schema ? entry.geminiSchema : zodToGeminiSchema(args.schema),
        ctx,
        media: args.media,
        modelOverride: hop.model,
        generation: args.generation,
        promptName: entry.prompt.id,
        promptVersion: entry.prompt.version,
        schemaHash: entry.schemaHash,
      });
    } catch (error) {
      throw toAiProviderError(error, "gemini", classifyGeminiError);
    }
  }

  const credentials = await withOrgContext(ctx.orgId, "system", "admin", (tx) =>
    getOrgCredentials(tx, ctx.orgId, hop.provider),
  );
  if (credentials.length === 0) {
    throw new AiProviderError({
      class: "invalid_key",
      provider: hop.provider,
      message: `No credential configured for ${hop.provider}`,
    });
  }
  const snapshots = await health.loadHealth(
    ctx.orgId,
    credentials.map((credential) => credential.fingerprint),
  );
  const credential =
    credentials.find((candidate) => health.isAvailable(snapshots.get(candidate.fingerprint))) ??
    null;
  if (!credential) {
    throw new AiProviderError({
      class: "rate_limited",
      provider: hop.provider,
      message: `All ${hop.provider} credentials are cooling down`,
    });
  }

  const started = Date.now();
  try {
    const result = await callTextProvider(args, credential);

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
      configSnapshot: {
        redactionHits: args.redactionHits,
        // Token counts were estimated because the provider omitted usage.
        ...(result.usageEstimated ? { usageEstimated: true } : {}),
      },
    });
    return { text: result.text, invocationId, model: hop.model };
  } catch (error) {
    if (error instanceof AiProviderError && error.isCredentialFailure) {
      await health.markInvalid(ctx.orgId, credential.fingerprint);
    } else if (error instanceof AiProviderError && error.retryableSameProvider) {
      await health.recordFailure(ctx.orgId, credential.fingerprint, error.errorClass);
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
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export const productionAiCompletionRuntime: AiCompletionRuntime = {
  async prepare({ task, orgId, modelOverride }) {
    // The runtime interface only carries orgId; ONE short org-context
    // transaction covers the three prepare reads (settings, spend, metadata)
    // instead of the module connection (P9, completing P12's conversion).
    const { settings, orgMetadata } = await withOrgContext(orgId, "system", "admin", async (tx) => {
      const loadedSettings = await getOrgAiSettings(tx, orgId);
      if (!loadedSettings.killSwitch && isTaskAllowed(loadedSettings, task)) {
        await assertWithinSpendCap(tx, orgId, loadedSettings.monthlySpendCapUsd);
      }
      return {
        settings: loadedSettings,
        orgMetadata: await loadOrgMetadata(tx, orgId),
      };
    });
    if (settings.killSwitch) return { kind: "disabled" };
    if (!isTaskAllowed(settings, task)) return { kind: "task_not_allowed" };
    const { hops, filtered } = await resolveChain({
      task,
      orgId,
      settings,
      orgMetadata,
      modelOverride,
    });
    if (hops.length === 0) return { kind: "no_credentials", filtered };
    return { kind: "ready", hops };
  },
  invokeHop,
  recordValidationOutcome,
};
