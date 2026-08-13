import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { aiInvocations, organizationAiSettings } from "../../src/db/schema/ai";
import { organization } from "../../src/db/schema/auth";
import { productionAiCompletionRuntime } from "../../src/lib/ai/facade-runtime";
import { invalidateOrgAiSettings } from "../../src/lib/ai/settings";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("production AI completion runtime", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedOrg(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(organization).values({
      id,
      name: `AI Runtime Org ${id.slice(0, 8)}`,
      slug: `ai-runtime-${id.slice(0, 8)}`,
    });
    return id;
  }

  it("fails closed when the database-backed organization kill switch is enabled", async () => {
    const orgId = await seedOrg();
    await db.insert(organizationAiSettings).values({ organizationId: orgId, killSwitch: true });
    invalidateOrgAiSettings(orgId);

    await expect(
      productionAiCompletionRuntime.prepare({ task: "date_parse", orgId }),
    ).resolves.toEqual({ kind: "disabled" });
  });

  it("returns no credentials after resolving an enabled organization from the database", async () => {
    const orgId = await seedOrg();
    await db.insert(organizationAiSettings).values({ organizationId: orgId });
    invalidateOrgAiSettings(orgId);

    const result = await productionAiCompletionRuntime.prepare({ task: "date_parse", orgId });

    expect(result.kind).toBe("no_credentials");
    if (result.kind === "no_credentials") {
      expect(result.filtered).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "gemini", reason: "no_credentials" }),
        ]),
      );
    }
  });

  it("enforces the database-backed task allowlist before provider resolution", async () => {
    const orgId = await seedOrg();
    await db.insert(organizationAiSettings).values({
      organizationId: orgId,
      taskAllowlist: ["classify_document"],
    });
    invalidateOrgAiSettings(orgId);

    await expect(
      productionAiCompletionRuntime.prepare({ task: "date_parse", orgId }),
    ).resolves.toEqual({ kind: "task_not_allowed" });
  });

  it("persists validation telemetry without invoking a provider", async () => {
    const orgId = await seedOrg();
    const [invocation] = await db
      .insert(aiInvocations)
      .values({ organizationId: orgId, task: "date_parse", provider: "gemini" })
      .returning({ id: aiInvocations.id });

    await productionAiCompletionRuntime.recordValidationOutcome(invocation.id, "valid");

    const [stored] = await db
      .select({ validationOutcome: aiInvocations.validationOutcome })
      .from(aiInvocations)
      .where(eq(aiInvocations.id, invocation.id));
    expect(stored.validationOutcome).toBe("valid");
  });

  it("treats null and unknown invocation ids as harmless telemetry no-ops", async () => {
    await expect(
      productionAiCompletionRuntime.recordValidationOutcome(null, "failed"),
    ).resolves.toBeUndefined();
    await expect(
      productionAiCompletionRuntime.recordValidationOutcome(crypto.randomUUID(), "failed"),
    ).resolves.toBeUndefined();
  });
});
