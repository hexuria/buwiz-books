export interface ProjectionStateView {
  organizationId: string;
  status: "missing" | "pending" | "building" | "ready" | "failed";
  requestedVersion: number;
  appliedVersion: number;
  lastLedgerEventAt: Date | null;
  lastProjectedAt: Date | null;
  initialBackfillCompletedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}
