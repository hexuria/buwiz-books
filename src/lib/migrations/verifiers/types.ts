import type { MigrationVerification, VerificationContext, VerificationEvidence } from "../engine";
import type { MigrationId } from "../manifest";

export interface VerificationQuery {
  unsafe<T>(sql: string): Promise<T[]>;
}

export interface MigrationVerifier {
  id: MigrationId;
  verify(query: VerificationQuery, context: VerificationContext): Promise<MigrationVerification>;
}

export function evidence(
  key: string,
  passed: boolean,
  expected: string,
  observed?: string,
): VerificationEvidence {
  return {
    key,
    status: passed ? "pass" : "fail",
    expected,
    ...(observed === undefined ? {} : { observed }),
  };
}

export function classifyVerification(
  footprintPresent: boolean,
  checks: readonly VerificationEvidence[],
  shape?: string,
): MigrationVerification {
  if (!footprintPresent) {
    return {
      state: "absent",
      shape: "absent",
      evidence: checks,
    };
  }
  return {
    state: checks.every((check) => check.status !== "fail") ? "complete" : "partial",
    ...(shape === undefined ? {} : { shape }),
    evidence: checks,
  };
}
