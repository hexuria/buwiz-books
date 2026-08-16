import { getRequest } from "@tanstack/react-start/server";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface MutationGuardOptions {
  routeKey: string;
  orgId: string;
  userId?: string;
  limit?: number;
  windowMs?: number;
}

// WARNING: process-local — buckets are not shared across multiple instances.
// Rate limiting is ineffective under horizontal scaling (e.g. multiple Cloud Run replicas).
// Replace with a Redis/Upstash counter when scaling past a single instance.
// In single-instance deployments, upstream rate limiting (Cloud Run, Cloudflare) is preferred.
const buckets = new Map<string, RateLimitBucket>();

// NOT a stale brand string: this is the live production origin. The Cloud Run
// service and its domain mapping are still named `digits`, and dropping this
// entry would fail origin checks in prod. It changes when the deployment moves
// to books.buwiz.com, not when the product name changes.
export function getTrustedOrigins(): string[] {
  return [
    process.env.BETTER_AUTH_URL,
    "https://digits.mvgreenland.com",
    process.env.VITE_APP_URL,
  ].filter((value): value is string => Boolean(value));
}

function isTrustedOrigin(origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    return getTrustedOrigins().some((candidate) => {
      try {
        return new URL(candidate).origin === originUrl.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function getMutationRequestOrThrow() {
  const request = getRequest();
  if (!request) {
    throw new Error("Mutation request context is unavailable");
  }
  return request;
}

export function assertAllowedMutationOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (origin) {
    if (!isTrustedOrigin(origin)) {
      throw new Response(JSON.stringify({ error: "Untrusted origin" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return;
  }

  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (!isTrustedOrigin(refererOrigin)) {
        throw new Response(JSON.stringify({ error: "Untrusted referer" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return;
    } catch {
      throw new Response(JSON.stringify({ error: "Invalid referer" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Response(JSON.stringify({ error: "Missing origin headers" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export function enforceRateLimit({
  routeKey,
  orgId,
  userId = "anonymous",
  limit = 30,
  windowMs = 60_000,
}: MutationGuardOptions): void {
  // Bypass rate limiting during E2E testing to prevent false-positive Playwright timeouts
  // across parallel workers. Hard-gated to non-production so the flag can never disable
  // rate limiting in prod even if the env var is set by mistake.
  if (process.env.NODE_ENV !== "production" && process.env.BYPASS_RATE_LIMITS === "true") {
    return;
  }

  const key = `${routeKey}:${orgId}:${userId}`;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (existing.count >= limit) {
    throw new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil((existing.resetAt - now) / 1000)),
      },
    });
  }

  existing.count += 1;
  buckets.set(key, existing);
}

export function guardMutationRequest(options: MutationGuardOptions): Request {
  const request = getMutationRequestOrThrow();
  assertAllowedMutationOrigin(request);
  enforceRateLimit(options);
  return request;
}
