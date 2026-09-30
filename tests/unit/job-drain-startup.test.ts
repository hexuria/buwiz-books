/**
 * Fail-loud worker wiring (Inbox v2 §3).
 *
 * Production with the HTTP drain and no INBOX_WORKER_SECRET used to log an
 * error and come up healthy — accepting webhooks and uploads whose jobs could
 * never run. It must now refuse to start. Dev, test, and production with the
 * inline drain are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenerStarted = vi.hoisted(() => ({ count: 0 }));
const inlineStarted = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/lib/jobs/projection-listener", () => ({
  startProjectionNotificationListener: () => {
    listenerStarted.count += 1;
  },
}));
vi.mock("../../src/lib/jobs/inline-drain", () => ({
  startInlineJobDrain: () => {
    inlineStarted.count += 1;
  },
}));

import jobDrainPlugin from "../../server/plugins/job-drain";

const MUTATED_ENV_KEYS = ["NODE_ENV", "JOB_DRAIN_MODE", "INBOX_WORKER_SECRET"] as const;

describe("job drain plugin startup", () => {
  const saved = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of MUTATED_ENV_KEYS) saved.set(key, process.env[key]);
    listenerStarted.count = 0;
    inlineStarted.count = 0;
    globalThis.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of MUTATED_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws in production when the HTTP drain has no worker secret", () => {
    process.env.NODE_ENV = "production";
    process.env.JOB_DRAIN_MODE = "off";
    delete process.env.INBOX_WORKER_SECRET;

    expect(() => jobDrainPlugin()).toThrow(/INBOX_WORKER_SECRET is not set/);
    // Nothing else starts on a process that is refusing to serve.
    expect(listenerStarted.count).toBe(0);
  });

  it("starts normally in production once the secret is set", () => {
    process.env.NODE_ENV = "production";
    process.env.JOB_DRAIN_MODE = "off";
    process.env.INBOX_WORKER_SECRET = "worker-secret";

    expect(() => jobDrainPlugin()).not.toThrow();
    expect(listenerStarted.count).toBe(1);
  });

  it("does not require the secret for an explicit inline drain in production", () => {
    process.env.NODE_ENV = "production";
    process.env.JOB_DRAIN_MODE = "inline";
    delete process.env.INBOX_WORKER_SECRET;

    expect(() => jobDrainPlugin()).not.toThrow();
    expect(inlineStarted.count).toBe(1);
  });

  it("leaves dev and test untouched without a secret", () => {
    delete process.env.INBOX_WORKER_SECRET;
    process.env.JOB_DRAIN_MODE = "off";
    for (const env of ["development", "test"]) {
      process.env.NODE_ENV = env;
      expect(() => jobDrainPlugin()).not.toThrow();
    }
  });
});
