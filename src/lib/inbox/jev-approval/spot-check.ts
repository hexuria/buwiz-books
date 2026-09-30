// ============================================================================
// Spot check = hold-back, not recall (Inbox v2 spec §8).
//
// A share of the papers Jev would approve is NOT posted: it stays in the Inbox
// as "Spot check" and a person decides it. That decision is an unbiased label
// for the lane — the person sees the same paper Jev would have posted — and
// nothing ever has to be reversed.
//
// The sample is decided BEFORE posting and is deterministic: SHA-256 of the
// organization's salt and the candidate id, read as a fraction of 2^53 and
// compared with the org's rate. The same paper always gets the same answer
// (a retried job cannot re-roll it), and the per-org salt keeps the sample
// from being predictable from an id alone.
// ============================================================================

import { createHash } from "node:crypto";

/** Default share of would-be approvals held back (organization_ai_settings default). */
export const DEFAULT_SPOT_CHECK_RATE = 0.1;

const TWO_POW_53 = 2 ** 53;

/** A uniform value in [0, 1) for this candidate under this salt. */
export function spotCheckDraw(input: { candidateId: string; salt: string }): number {
  const digest = createHash("sha256").update(`${input.salt}:${input.candidateId}`).digest();
  // 53 bits: the most a double holds exactly, so the fraction is exact.
  const high = digest.readUInt32BE(0) & 0x1fffff;
  const low = digest.readUInt32BE(4);
  return (high * 2 ** 32 + low) / TWO_POW_53;
}

/** Clamp a stored rate to 0..1; anything unreadable holds everything back. */
export function normalizeSpotCheckRate(rate: string | number | null | undefined): number {
  const value = typeof rate === "number" ? rate : Number(rate ?? DEFAULT_SPOT_CHECK_RATE);
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

/** Whether this candidate is held back as a spot check. */
export function isSpotCheckSampled(input: {
  candidateId: string;
  salt: string;
  rate: string | number | null | undefined;
}): boolean {
  const rate = normalizeSpotCheckRate(input.rate);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return spotCheckDraw(input) < rate;
}
