// ============================================================================
// Earned autonomy, end to end against a real database:
//
//   • The flip is SERVER-verified: updateOrgAiConfig refuses walled kinds,
//     acknowledge-only kinds, and any kind that has not earned eligibility
//     (200+ reviewed at 98%+ accepted) — the UI toggle is not the guard.
//   • createProposalWithAutonomy applies a high-confidence document_type
//     proposal under the acting user's own permissions, and only then.
//   • Demotion is automatic and narrowing-only: negative feedback that drops
//     the trailing window below 95% flips the kind back off, with an
//     activity-log row attributing the flip.
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { aiActionProposals, aiRunFeedback, organizationAiSettings } from "../../src/db/schema/ai";
import { documents } from "../../src/db/schema/documents";
import { activityLogs } from "../../src/db/schema/activity-logs";
import { updateOrgAiConfig, getOrgAiConfig } from "../../src/lib/ai/org-ai-config";
import { computeAutonomyEligibility, AUTONOMY_CRITERIA } from "../../src/lib/ai/autonomy";
import { createProposalWithAutonomy, rejectProposal } from "../../src/lib/ai/proposals";
import { invalidateOrgAiSettings } from "../../src/lib/ai/settings";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("earned autonomy (flip, auto-apply, demotion)", () => {
  let db: any;
  let sql: postgres.Sql;
  const actorId = "user-autonomy-admin";

  async function seedOrg(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(organization).values({
      id,
      name: `Autonomy Org ${id.slice(0, 8)}`,
      slug: `autonomy-${id.slice(0, 8)}`,
    });
    return id;
  }

  /**
   * Seed reviewed proposals + feedback for a kind. `createdAt` pins the
   * feedback timestamps explicitly — shouldDemote's trailing window orders by
   * createdAt DESC, and batch-inserted defaultNow() rows would tie, making
   * "the last 50" arbitrary.
   */
  async function seedFeedback(
    orgId: string,
    kind: string,
    counts: { accepted: number; rejected: number },
    createdAt: Date = new Date(Date.now() - 60 * 60 * 1000),
  ): Promise<void> {
    const rows: { verdict: "accepted" | "rejected" }[] = [
      ...Array.from({ length: counts.accepted }, () => ({ verdict: "accepted" as const })),
      ...Array.from({ length: counts.rejected }, () => ({ verdict: "rejected" as const })),
    ];
    const proposals = await db
      .insert(aiActionProposals)
      .values(
        rows.map((r, i) => ({
          organizationId: orgId,
          kind,
          proposal: { seeded: i },
          status: r.verdict === "accepted" ? "approved" : "rejected",
        })),
      )
      .returning({ id: aiActionProposals.id });
    await db.insert(aiRunFeedback).values(
      rows.map((r, i) => ({
        organizationId: orgId,
        proposalId: proposals[i].id,
        verdict: r.verdict,
        userId: actorId,
        createdAt,
      })),
    );
  }

  async function seedDocument(orgId: string): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "autonomy-fixture.pdf",
        storagePath: `test/autonomy/${crypto.randomUUID()}.pdf`,
      })
      .returning({ id: documents.id });
    return doc.id;
  }

  function docTypeInput(documentId: string, confidence: number) {
    return {
      kind: "document_type" as const,
      payload: { documentId, documentType: "invoice", confidence, reasoning: "test" },
      confidence,
      sourceRef: { entityType: "document", entityId: documentId },
      createdBy: actorId,
    };
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  // ── The flip is server-verified ────────────────────────────────────────────

  it("refuses to flip a structurally-manual kind, ever", async () => {
    const orgId = await seedOrg();
    await expect(
      updateOrgAiConfig(db, {
        orgId,
        actorId,
        autonomy: { match: "auto_apply_high_confidence" },
      }),
    ).rejects.toThrow(/always applied by a human/);
  });

  it("refuses acknowledge-only kinds whose approval IS the feedback signal", async () => {
    const orgId = await seedOrg();
    await expect(
      updateOrgAiConfig(db, {
        orgId,
        actorId,
        autonomy: { create_txn: "auto_apply_high_confidence" },
      }),
    ).rejects.toThrow(/human feedback signal/);
  });

  it("refuses unknown autonomy modes", async () => {
    const orgId = await seedOrg();
    await expect(
      updateOrgAiConfig(db, { orgId, actorId, autonomy: { document_type: "yolo" } }),
    ).rejects.toThrow(/Unsupported autonomy mode/);
  });

  it("refuses an allowed kind that has not earned eligibility", async () => {
    const orgId = await seedOrg();
    await seedFeedback(orgId, "document_type", { accepted: 10, rejected: 0 });
    await expect(
      updateOrgAiConfig(db, {
        orgId,
        actorId,
        autonomy: { document_type: "auto_apply_high_confidence" },
      }),
    ).rejects.toThrow(/not earned yet/);
  });

  it("flips on once earned, records the audit row, and surfaces in the config view", async () => {
    const orgId = await seedOrg();
    await seedFeedback(orgId, "document_type", {
      accepted: AUTONOMY_CRITERIA.minProposals,
      rejected: 0,
    });

    const eligibility = await computeAutonomyEligibility(db, orgId, "document_type");
    expect(eligibility.eligible).toBe(true);

    const result = await updateOrgAiConfig(db, {
      orgId,
      actorId,
      autonomy: { document_type: "auto_apply_high_confidence" },
    });
    expect(result.changes.autonomy).toBeDefined();

    const view = await getOrgAiConfig(db, orgId);
    expect(view.autonomy).toEqual({ document_type: "auto_apply_high_confidence" });
    const kindView = view.autonomyKinds.find((k: any) => k.kind === "document_type");
    expect(kindView?.enabled).toBe(true);

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.organizationId, orgId), eq(activityLogs.action, "ai_settings_updated")),
      );
    expect(logs.length).toBeGreaterThan(0);
  });

  // ── Auto-apply under the acting user's permissions ─────────────────────────

  it("auto-applies a high-confidence document_type proposal for a flipped-on org", async () => {
    const orgId = await seedOrg();
    await seedFeedback(orgId, "document_type", {
      accepted: AUTONOMY_CRITERIA.minProposals,
      rejected: 0,
    });
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      autonomy: { document_type: "auto_apply_high_confidence" },
    });
    const documentId = await seedDocument(orgId);

    const { proposal, autoApplied } = await createProposalWithAutonomy(
      { orgId, userId: actorId, role: "admin", db },
      docTypeInput(documentId, 0.97),
    );

    expect(autoApplied).toBe(true);
    expect(proposal.status).toBe("auto_applied");
    expect(proposal.appliedAt).not.toBeNull();

    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.documentType).toBe("invoice");
  });

  it("leaves a below-threshold proposal pending and the document untouched", async () => {
    const orgId = await seedOrg();
    await seedFeedback(orgId, "document_type", {
      accepted: AUTONOMY_CRITERIA.minProposals,
      rejected: 0,
    });
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      autonomy: { document_type: "auto_apply_high_confidence" },
    });
    const documentId = await seedDocument(orgId);

    const { proposal, autoApplied } = await createProposalWithAutonomy(
      { orgId, userId: actorId, role: "admin", db },
      docTypeInput(documentId, 0.5),
    );

    expect(autoApplied).toBe(false);
    expect(proposal.status).toBe("pending");
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.documentType).toBe("other");
  });

  it("never auto-applies past the acting user's own permissions", async () => {
    const orgId = await seedOrg();
    await seedFeedback(orgId, "document_type", {
      accepted: AUTONOMY_CRITERIA.minProposals,
      rejected: 0,
    });
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      autonomy: { document_type: "auto_apply_high_confidence" },
    });
    const documentId = await seedDocument(orgId);

    // report_viewer holds document:view but NOT document:upload.
    const { proposal, autoApplied } = await createProposalWithAutonomy(
      { orgId, userId: actorId, role: "report_viewer", db },
      docTypeInput(documentId, 0.97),
    );

    expect(autoApplied).toBe(false);
    expect(proposal.status).toBe("pending");
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.documentType).toBe("other");
  });

  it("stays pending for an org that never flipped autonomy on", async () => {
    const orgId = await seedOrg();
    const documentId = await seedDocument(orgId);
    const { autoApplied, proposal } = await createProposalWithAutonomy(
      { orgId, userId: actorId, role: "admin", db },
      docTypeInput(documentId, 0.99),
    );
    expect(autoApplied).toBe(false);
    expect(proposal.status).toBe("pending");
  });

  // ── Automatic demotion ─────────────────────────────────────────────────────

  it("flips autonomy back off when the trailing window slips, with an audit row", async () => {
    const orgId = await seedOrg();
    // Earn the flip first.
    await seedFeedback(orgId, "document_type", {
      accepted: AUTONOMY_CRITERIA.minProposals,
      rejected: 0,
    });
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      autonomy: { document_type: "auto_apply_high_confidence" },
    });

    // Sour the trailing window: with demotionWindow=50 and demotionRate=0.95,
    // 4 rejections in the last 50 (46/50 = 92%) must demote. Seed 3 rejections
    // strictly NEWER than the earning-phase rows; the 4th arrives live through
    // rejectProposal below (defaultNow — newest of all).
    await seedFeedback(
      orgId,
      "document_type",
      { accepted: 0, rejected: 3 },
      new Date(Date.now() - 60 * 1000),
    );

    const documentId = await seedDocument(orgId);
    const { proposal } = await createProposalWithAutonomy(
      { orgId, userId: actorId, role: "admin", db },
      docTypeInput(documentId, 0.5), // below threshold: stays pending, rejectable
    );

    await rejectProposal({ orgId, userId: actorId, role: "admin", db }, proposal.id, "wrong type");

    invalidateOrgAiSettings(orgId);
    const view = await getOrgAiConfig(db, orgId);
    expect(view.autonomy.document_type).toBeUndefined();

    const [settingsRow] = await db
      .select()
      .from(organizationAiSettings)
      .where(eq(organizationAiSettings.organizationId, orgId));
    expect(settingsRow.autonomy ?? {}).toEqual({});

    const demotionLogs = await db
      .select()
      .from(activityLogs)
      .where(
        and(eq(activityLogs.organizationId, orgId), eq(activityLogs.action, "ai_autonomy_demoted")),
      );
    expect(demotionLogs.length).toBe(1);
    expect(demotionLogs[0].actorId).toBe(actorId);
  });

  it("does not demote while the window is still healthy", async () => {
    const orgId = await seedOrg();
    await seedFeedback(orgId, "document_type", {
      accepted: AUTONOMY_CRITERIA.minProposals,
      rejected: 0,
    });
    await updateOrgAiConfig(db, {
      orgId,
      actorId,
      autonomy: { document_type: "auto_apply_high_confidence" },
    });

    const documentId = await seedDocument(orgId);
    const { proposal } = await createProposalWithAutonomy(
      { orgId, userId: actorId, role: "admin", db },
      docTypeInput(documentId, 0.5),
    );
    // One rejection against 200 accepted: trailing 50 = 49 accepted + 1
    // rejected = 98% — above the 95% demotion floor.
    await rejectProposal({ orgId, userId: actorId, role: "admin", db }, proposal.id);

    invalidateOrgAiSettings(orgId);
    const view = await getOrgAiConfig(db, orgId);
    expect(view.autonomy.document_type).toBe("auto_apply_high_confidence");
  });
});
