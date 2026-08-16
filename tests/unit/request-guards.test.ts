import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllowedMutationOrigin, enforceRateLimit } from "@/lib/request-guards";

describe("request guards", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalAuthUrl = process.env.BETTER_AUTH_URL;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.BETTER_AUTH_URL = originalAuthUrl;
  });

  it("allows trusted mutation origins", () => {
    process.env.BETTER_AUTH_URL = "https://app.example.com";
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
      },
    });

    expect(() => assertAllowedMutationOrigin(request)).not.toThrow();
  });

  it("rejects untrusted mutation origins", () => {
    process.env.BETTER_AUTH_URL = "https://app.example.com";
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
      headers: {
        origin: "https://evil.example.com",
      },
    });

    expect(() => assertAllowedMutationOrigin(request)).toThrow(Response);
  });

  it("allows trusted referer when origin is absent", () => {
    process.env.BETTER_AUTH_URL = "https://app.example.com";
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
      headers: {
        referer: "https://app.example.com/transactions",
      },
    });

    expect(() => assertAllowedMutationOrigin(request)).not.toThrow();
  });

  it("ignores origin checks for safe methods", () => {
    const request = new Request("https://app.example.com/api/test", {
      method: "GET",
    });

    expect(() => assertAllowedMutationOrigin(request)).not.toThrow();
  });

  it("rejects missing origin headers in production", () => {
    process.env.NODE_ENV = "production";
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
    });

    expect(() => assertAllowedMutationOrigin(request)).toThrow(Response);
  });

  it("enforces route scoped rate limits", () => {
    vi.useFakeTimers();
    const base = {
      routeKey: `test:${Date.now()}`,
      orgId: "org-1",
      userId: "user-1",
      limit: 2,
      windowMs: 1_000,
    } as const;

    expect(() => enforceRateLimit(base)).not.toThrow();
    expect(() => enforceRateLimit(base)).not.toThrow();
    expect(() => enforceRateLimit(base)).toThrow(Response);

    vi.advanceTimersByTime(1_001);
    expect(() => enforceRateLimit(base)).not.toThrow();
    vi.useRealTimers();
  });
});
