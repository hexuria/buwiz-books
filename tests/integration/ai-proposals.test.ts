// ============================================================================
// Proposal primitive — lifecycle, two-key permission model, feedback labels.
//
// The service assumes a transactional caller in production (ctx.db inside
// withOrgContext); these tests run on the raw test client, which is exactly
// why permission denial is asserted to leave the row pending WITHOUT relying
// on a rollback (the pre-claim check).
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { aiActionProposals, aiRunFeedback } from "../../src/db/schema/ai";
import { parties } from "../../src/db/schema/parties";
import { documents } from "../../src/db/schema/documents";
import {
  createProposal,
  approveProposal,
  correctProposal,
  rejectProposal,
  expireStaleProposals,
} from "../../src/lib/ai/proposals";
import { AuthorizationError } from "../../src/lib/auth-errors";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const vendorPayload = (name: string) => ({
  entity: {
    entityType: "vendor" as const,
    name,
    identifier: "",
    accountType: "",
    matchedPartyId: "",
  },
});

describeDb("AI proposals — lifecycle and two-key permissions", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  const ctx = (orgId: string, role: string) => ({
    orgId,
    userId: `user-${role}`,
    role,
    db,
  });

  it("rejects an invalid payload at create time", async () => {
    const orgId = crypto.randomUUID();
    await expect(
      createProposal(db, {
        orgId,
        kind: "create_party",
        payload: { entity: { entityType: "spaceship", name: "X" } },
      }),
    ).rejects.toThrow();
  });

  it("rejects not-yet-implemented kinds at create time", async () => {
    const orgId = crypto.randomUUID();
    await expect(
      createProposal(db, { orgId, kind: "categorize", payload: { anything: true } }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("approve as admin creates the party, records accepted feedback, and is double-approve safe", async () => {
    const orgId = crypto.randomUUID();
    const vendorName = `Vendor-${crypto.randomUUID().slice(0, 8)}`;
    const proposal = await createProposal(db, {
      orgId,
      kind: "create_party",
      payload: vendorPayload(vendorName),
      confidence: 0.9,
    });
    expect(proposal.status).toBe("pending");

    const { result } = await approveProposal(ctx(orgId, "admin"), proposal.id);
    expect(result?.partyName).toBe(vendorName);
    expect(result?.wasCreated).toBe(true);

    const [party] = await db
      .select()
      .from(parties)
      .where(eq(parties.id, result!.partyId as string));
    expect(party?.organizationId).toBe(orgId);

    const [row] = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.id, proposal.id));
    expect(row.status).toBe("approved");
    expect(row.approvedBy).toBe("user-admin");

    const feedback = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.proposalId, proposal.id));
    expect(feedback).toHaveLength(1);
    expect(feedback[0].verdict).toBe("accepted");

    // Double-approve: the status-guarded claim makes the second call fail
    await expect(approveProposal(ctx(orgId, "admin"), proposal.id)).rejects.toThrow(
      /no longer pending/i,
    );
  });

  it("approve as member is denied by the underlying party:create permission and leaves the proposal pending", async () => {
    const orgId = crypto.randomUUID();
    const proposal = await createProposal(db, {
      orgId,
      kind: "create_party",
      payload: vendorPayload(`Vendor-${crypto.randomUUID().slice(0, 8)}`),
    });

    // member holds aiTask:run (endpoint gate) but NOT party:create —
    // aiTask:run alone must never launder a write.
    await expect(approveProposal(ctx(orgId, "member"), proposal.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const [row] = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.id, proposal.id));
    expect(row.status).toBe("pending");

    const feedback = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.proposalId, proposal.id));
    expect(feedback).toHaveLength(0);
  });

  it("reject records rejected feedback and never writes", async () => {
    const orgId = crypto.randomUUID();
    const vendorName = `Vendor-${crypto.randomUUID().slice(0, 8)}`;
    const proposal = await createProposal(db, {
      orgId,
      kind: "create_party",
      payload: vendorPayload(vendorName),
    });

    await rejectProposal(ctx(orgId, "member"), proposal.id, "not a real vendor");

    const [row] = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.id, proposal.id));
    expect(row.status).toBe("rejected");

    const created = await db.select().from(parties).where(eq(parties.name, vendorName));
    expect(created).toHaveLength(0);

    const feedback = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.proposalId, proposal.id));
    expect(feedback[0].verdict).toBe("rejected");
    expect(feedback[0].correction).toEqual({ reason: "not a real vendor" });
  });

  it("correct applies the USER's payload and records the field diff", async () => {
    const orgId = crypto.randomUUID();
    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "mystery.pdf",
        storagePath: `test/${crypto.randomUUID()}.pdf`,
      })
      .returning();
    expect(doc.documentType).toBe("other");

    const proposal = await createProposal(db, {
      orgId,
      kind: "document_type",
      payload: { documentId: doc.id, documentType: "receipt", confidence: 0.8 },
    });

    // Human disagrees: it's a bill, not a receipt.
    const { result } = await correctProposal(ctx(orgId, "admin"), proposal.id, {
      documentId: doc.id,
      documentType: "bill",
      confidence: 0.8,
    });
    expect(result?.applied).toBe(true);

    const [updated] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(updated.documentType).toBe("bill");

    const feedback = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.proposalId, proposal.id));
    expect(feedback[0].verdict).toBe("corrected");
    expect(feedback[0].correction).toMatchObject({
      documentType: { old: "receipt", new: "bill" },
    });
  });

  it("document_type applier never overwrites a human-set type", async () => {
    const orgId = crypto.randomUUID();
    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "typed.pdf",
        storagePath: `test/${crypto.randomUUID()}.pdf`,
        documentType: "invoice",
      })
      .returning();

    const proposal = await createProposal(db, {
      orgId,
      kind: "document_type",
      payload: { documentId: doc.id, documentType: "receipt", confidence: 0.9 },
    });

    const { result } = await approveProposal(ctx(orgId, "admin"), proposal.id);
    expect(result?.applied).toBe(false);

    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.documentType).toBe("invoice");
  });

  it("create_txn is acknowledge-only and gated on journal:create", async () => {
    const orgId = crypto.randomUUID();
    const payload = {
      statementLineId: crypto.randomUUID(),
      reconciliationId: crypto.randomUUID(),
      transaction: { transactionType: "pay_out", amount: "42.50" },
    };

    // clientApprover holds aiTask:run but not journal:create.
    const denied = await createProposal(db, { orgId, kind: "create_txn", payload });
    await expect(approveProposal(ctx(orgId, "client_approver"), denied.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const proposal = await createProposal(db, { orgId, kind: "create_txn", payload });
    const { result } = await approveProposal(ctx(orgId, "member"), proposal.id);
    // Acknowledge-only: no ledger write happens here, the label is the point.
    expect(result).toMatchObject({ acknowledged: true });

    const feedback = await db
      .select()
      .from(aiRunFeedback)
      .where(eq(aiRunFeedback.proposalId, proposal.id));
    expect(feedback[0].verdict).toBe("accepted");
  });

  it("rejects match/split/date_fix kinds — they live in reconciliation_suggestions", async () => {
    const orgId = crypto.randomUUID();
    for (const kind of ["match", "split", "date_fix"] as const) {
      await expect(
        createProposal(db, { orgId, kind, payload: { anything: true } }),
      ).rejects.toThrow(/reconciliation_suggestions/i);
    }
  });

  it("cross-org approval cannot see the proposal", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const proposal = await createProposal(db, {
      orgId: orgA,
      kind: "create_party",
      payload: vendorPayload("Cross Org Vendor"),
    });
    await expect(approveProposal(ctx(orgB, "admin"), proposal.id)).rejects.toThrow(
      /not found|no longer pending/i,
    );
  });

  it("expires stale pending proposals, scoped by org when requested", async () => {
    const orgId = crypto.randomUUID();
    const stale = await createProposal(db, {
      orgId,
      kind: "create_party",
      payload: vendorPayload("Stale Vendor"),
      expiresInDays: -1,
    });
    const fresh = await createProposal(db, {
      orgId,
      kind: "create_party",
      payload: vendorPayload("Fresh Vendor"),
    });

    const count = await expireStaleProposals(db, { orgId });
    expect(count).toBeGreaterThanOrEqual(1);

    const [staleRow] = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.id, stale.id));
    expect(staleRow.status).toBe("expired");

    const [freshRow] = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.id, fresh.id));
    expect(freshRow.status).toBe("pending");
  });
});
