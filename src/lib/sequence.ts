import { eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@/db";
import { numberSequences } from "@/db/schema/number-sequences";

async function allocateSequenceValue(scope: string, tx?: DbExecutor): Promise<number> {
  const executor = tx ?? db;
  const [row] = await executor
    .insert(numberSequences)
    .values({
      scope,
      currentValue: 1,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: numberSequences.scope,
      set: {
        currentValue: sql`${numberSequences.currentValue} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ currentValue: numberSequences.currentValue });

  return row.currentValue;
}

export async function allocateJournalTransactionNumber(
  orgId: string,
  tx?: DbExecutor,
): Promise<string> {
  const nextValue = await allocateSequenceValue(`journal:${orgId}`, tx);
  return `TXN-${String(nextValue).padStart(6, "0")}`;
}

export async function allocateInvoiceNumber(orgId: string, tx?: DbExecutor): Promise<string> {
  const nextValue = await allocateSequenceValue(`invoice:${orgId}`, tx);
  return `INV-${String(nextValue).padStart(4, "0")}`;
}

export async function seedSequenceFromExistingMax(scope: string, value: number): Promise<void> {
  const [existing] = await db
    .select({ currentValue: numberSequences.currentValue })
    .from(numberSequences)
    .where(eq(numberSequences.scope, scope))
    .limit(1);

  if (!existing || existing.currentValue < value) {
    await db
      .insert(numberSequences)
      .values({
        scope,
        currentValue: value,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: numberSequences.scope,
        set: {
          currentValue: value,
          updatedAt: new Date(),
        },
      });
  }
}
