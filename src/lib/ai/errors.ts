// ============================================================================
// Provider error taxonomy.
//
// Replaces message-substring matching with a typed union the router can act
// on uniformly across providers (AI_NATIVE_ARCHITECTURE §5). Two decisions
// hang off every error:
//   • retryableSameProvider — try another key / back off within this provider
//   • escalateChain          — give up here and advance to the next hop
//
// The Gemini classifier still inspects messages: the legacy
// @google/generative-ai SDK exposes nothing else. That is a documented SDK
// limitation, quarantined behind this shared union so the router never sees
// it. Anthropic/OpenAI classifiers use typed SDK errors when those adapters
// land.
// ============================================================================

export type AiErrorClass =
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "invalid_key"
  | "invalid_request"
  | "schema_rejection"
  | "content_filter"
  | "network"
  | "unknown";

export type AiProvider = "gemini" | "anthropic" | "openai" | "openai_compatible";

export interface AiProviderErrorInit {
  class: AiErrorClass;
  provider: AiProvider;
  status?: number;
  cause?: unknown;
  message?: string;
}

export class AiProviderError extends Error {
  readonly errorClass: AiErrorClass;
  readonly provider: AiProvider;
  readonly status?: number;

  constructor(init: AiProviderErrorInit) {
    super(init.message ?? `${init.provider} error: ${init.class}`);
    this.name = "AiProviderError";
    this.errorClass = init.class;
    this.provider = init.provider;
    this.status = init.status;
    this.cause = init.cause;
  }

  /** Another key or a backoff may succeed with this same provider. */
  get retryableSameProvider(): boolean {
    return (
      this.errorClass === "rate_limited" ||
      this.errorClass === "overloaded" ||
      this.errorClass === "timeout" ||
      this.errorClass === "network"
    );
  }

  /** This provider cannot serve the call — advance to the next chain hop. */
  get escalateChain(): boolean {
    return (
      this.errorClass === "rate_limited" ||
      this.errorClass === "overloaded" ||
      this.errorClass === "timeout" ||
      this.errorClass === "invalid_key" ||
      this.errorClass === "schema_rejection" ||
      this.errorClass === "network"
    );
  }

  /** The credential itself is bad — take it out of rotation. */
  get isCredentialFailure(): boolean {
    return this.errorClass === "invalid_key";
  }
}

/**
 * Classify a Gemini SDK error.
 *
 * KNOWN LIMITATION: @google/generative-ai surfaces only message strings, so
 * this is substring matching by necessity. Kept here (not in the router) so
 * the rest of the system deals in typed classes only.
 */
export function classifyGeminiError(err: unknown): AiErrorClass {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();

  if (
    msg.includes("api key not valid") ||
    msg.includes("api_key_invalid") ||
    msg.includes("invalid api key") ||
    msg.includes("permission denied") ||
    msg.includes("permission_denied") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("unregistered callers") ||
    msg.includes("api key expired")
  ) {
    return "invalid_key";
  }

  if (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("resource exhausted")
  ) {
    return "rate_limited";
  }

  if (
    msg.includes("503") ||
    msg.includes("service unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("500") ||
    msg.includes("internal error")
  ) {
    return "overloaded";
  }

  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("aborted") ||
    msg.includes("deadline")
  ) {
    return "timeout";
  }

  if (msg.includes("safety") || msg.includes("blocked") || msg.includes("content filter")) {
    return "content_filter";
  }

  if (msg.includes("fetch failed") || msg.includes("econnreset") || msg.includes("enotfound")) {
    return "network";
  }

  if (msg.includes("invalid json") || msg.includes("schema")) {
    return "schema_rejection";
  }

  if (msg.includes("400") || msg.includes("invalid argument")) {
    return "invalid_request";
  }

  return "unknown";
}

/**
 * Classify by HTTP status — the shared fallback for OpenAI-compatible
 * gateways whose bodies are nonstandard.
 */
export function classifyByStatus(status: number): AiErrorClass {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status === 529) return "overloaded";
  if (status >= 500) return "overloaded";
  if (status === 400 || status === 422) return "invalid_request";
  return "unknown";
}

/** Wrap any thrown value as a typed provider error. */
export function toAiProviderError(
  err: unknown,
  provider: AiProvider,
  classify: (err: unknown) => AiErrorClass,
): AiProviderError {
  if (err instanceof AiProviderError) return err;
  return new AiProviderError({
    class: classify(err),
    provider,
    cause: err,
    message: err instanceof Error ? err.message : String(err),
  });
}
