/**
 * `triggerWorker` used to have two silent holes: an unset INBOX_WORKER_SECRET
 * returned without a word, and any non-2xx response RESOLVED and was
 * discarded. Between them, a completely unconfigured worker was
 * indistinguishable from a healthy one — nothing logged, nothing failed, and
 * every enqueued job simply stayed `queued` forever.
 *
 * These cases pin the observable consequence of closing both holes: the
 * trigger-health record. `fetch` is stubbed throughout; nothing here talks to
 * a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTriggerHealth,
  resetTriggerHealthForTests,
  setInlineNudge,
} from "@/lib/jobs/drain-state";
import { triggerWorker } from "@/lib/jobs/trigger";

const MUTATED_ENV_KEYS = ["JOB_DRAIN_MODE", "INBOX_WORKER_SECRET", "INTERNAL_WORKER_URL"] as const;

describe("triggerWorker", () => {
  const savedEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of MUTATED_ENV_KEYS) savedEnv.set(key, process.env[key]);
    resetTriggerHealthForTests();
    setInlineNudge(null);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // The trigger logs its own misconfiguration; keep the suite output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of MUTATED_ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    globalThis.fetch = originalFetch;
    setInlineNudge(null);
    resetTriggerHealthForTests();
    vi.restoreAllMocks();
  });

  it("records itself unconfigured, and never fetches, when the secret is missing", async () => {
    process.env.JOB_DRAIN_MODE = "off";
    delete process.env.INBOX_WORKER_SECRET;

    triggerWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    const health = getTriggerHealth();
    expect(health.configured).toBe(false);
    expect(health.mode).toBe("off");
    expect(health.lastError).toContain("INBOX_WORKER_SECRET");
    // No request was even attempted — the health record must not pretend one was.
    expect(health.lastAttemptAt).toBeNull();
    expect(health.lastSuccessAt).toBeNull();
  });

  it("records a 401 as a failure instead of discarding it", async () => {
    process.env.JOB_DRAIN_MODE = "off";
    process.env.INBOX_WORKER_SECRET = "wrong-secret";
    process.env.INTERNAL_WORKER_URL = "http://127.0.0.1:9999";
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);

    triggerWorker();

    // The old code awaited a resolved promise and threw the result away, so
    // this is the assertion that would have failed before the fix.
    await vi.waitFor(() => expect(getTriggerHealth().consecutiveFailures).toBe(1));
    const health = getTriggerHealth();
    expect(health.lastError).toBe("worker responded 401");
    expect(health.lastAttemptAt).not.toBeNull();
    expect(health.lastSuccessAt).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9999/api/internal/worker");
  });

  it("records a rejected request as a failure", async () => {
    process.env.JOB_DRAIN_MODE = "off";
    process.env.INBOX_WORKER_SECRET = "worker-secret";
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    triggerWorker();

    await vi.waitFor(() => expect(getTriggerHealth().consecutiveFailures).toBe(1));
    expect(getTriggerHealth().lastError).toBe("ECONNREFUSED");
  });

  it("records a 2xx as a success and clears the failure state", async () => {
    process.env.JOB_DRAIN_MODE = "off";
    process.env.INBOX_WORKER_SECRET = "worker-secret";
    process.env.INTERNAL_WORKER_URL = "http://127.0.0.1:9999/";
    fetchMock.mockResolvedValue({ ok: true, status: 202 } as Response);

    triggerWorker(["statement_ocr"]);

    await vi.waitFor(() => expect(getTriggerHealth().lastSuccessAt).not.toBeNull());
    const health = getTriggerHealth();
    expect(health.configured).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBeNull();

    // The trailing slash must not produce a double slash in the worker path.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/api/internal/worker");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer worker-secret");
    expect(JSON.parse(init.body as string)).toEqual({ jobTypes: ["statement_ocr"] });
  });

  it("nudges the in-process drain in inline mode and never fetches", () => {
    process.env.JOB_DRAIN_MODE = "inline";
    process.env.INBOX_WORKER_SECRET = "worker-secret";
    const nudge = vi.fn();
    setInlineNudge(nudge);

    triggerWorker(["bbox_scan"]);

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledWith(["bbox_scan"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTriggerHealth().mode).toBe("inline");
  });

  it("passes an untyped nudge straight through so the drain sweeps everything", () => {
    process.env.JOB_DRAIN_MODE = "inline";
    const nudge = vi.fn();
    setInlineNudge(nudge);

    triggerWorker();

    expect(nudge).toHaveBeenCalledWith(undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
