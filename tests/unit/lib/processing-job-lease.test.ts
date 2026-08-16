import { describe, expect, it } from "vitest";
import {
  isProcessingJobClaimable,
  isProcessingJobExpiredAndExhausted,
} from "@/lib/inbox/processing-job-lease";

const now = new Date("2026-07-24T00:00:00.000Z");

function job(
  overrides: Partial<Parameters<typeof isProcessingJobClaimable>[0]> = {},
): Parameters<typeof isProcessingJobClaimable>[0] {
  return {
    status: "queued",
    runAt: new Date("2026-07-23T23:59:00.000Z"),
    lockedUntil: null,
    attempts: 0,
    maxAttempts: 8,
    ...overrides,
  };
}

describe("processing job lease recovery", () => {
  it("claims due queued jobs but not future jobs", () => {
    expect(isProcessingJobClaimable(job(), now)).toBe(true);
    expect(
      isProcessingJobClaimable(job({ runAt: new Date("2026-07-24T00:01:00.000Z") }), now),
    ).toBe(false);
  });

  it("reclaims an expired running lease but not an active lease", () => {
    expect(
      isProcessingJobClaimable(
        job({
          status: "running",
          lockedUntil: new Date("2026-07-23T23:59:59.999Z"),
          attempts: 1,
        }),
        now,
      ),
    ).toBe(true);
    expect(
      isProcessingJobClaimable(
        job({
          status: "running",
          lockedUntil: new Date("2026-07-24T00:00:00.001Z"),
          attempts: 1,
        }),
        now,
      ),
    ).toBe(false);
  });

  it("recovers legacy running jobs with no lease", () => {
    expect(
      isProcessingJobClaimable(job({ status: "running", lockedUntil: null, attempts: 1 }), now),
    ).toBe(true);
  });

  it("never reclaims a job that exhausted its attempts", () => {
    const exhausted = job({
      status: "running",
      lockedUntil: new Date("2026-07-23T23:59:00.000Z"),
      attempts: 8,
      maxAttempts: 8,
    });
    expect(isProcessingJobClaimable(exhausted, now)).toBe(false);
    expect(isProcessingJobExpiredAndExhausted(exhausted, now)).toBe(true);
  });

  it("does not terminally expire an active final-attempt lease", () => {
    expect(
      isProcessingJobExpiredAndExhausted(
        job({
          status: "running",
          lockedUntil: new Date("2026-07-24T00:00:00.001Z"),
          attempts: 8,
          maxAttempts: 8,
        }),
        now,
      ),
    ).toBe(false);
  });

  it("does not claim completed or failed jobs even with an expired timestamp", () => {
    expect(isProcessingJobClaimable(job({ status: "completed" }), now)).toBe(false);
    expect(isProcessingJobClaimable(job({ status: "failed" }), now)).toBe(false);
  });
});
