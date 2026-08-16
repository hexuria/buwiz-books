import { and, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { fxRates } from "@/db/schema/inbox";
import { parseRateToScaled } from "./money";

const SOURCE_PRIORITY: Record<string, number> = {
  manual: 0,
  source: 1,
  open_exchange_rates: 2,
};

export async function resolveFxRate(input: {
  db: DbExecutor;
  orgId: string;
  transactionDate: string;
  originalCurrency: string;
  functionalCurrency: string;
  suppliedRate?: string | null;
  suppliedRateId?: string | null;
  suppliedBySource?: boolean;
  actorId?: string | null;
}): Promise<{ id: string | null; rate: string; source: string }> {
  if (input.originalCurrency === input.functionalCurrency) {
    return { id: null, rate: "1", source: "identity" };
  }

  if (input.suppliedRateId) {
    const [stored] = await input.db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.id, input.suppliedRateId),
          eq(fxRates.organizationId, input.orgId),
          eq(fxRates.baseCurrency, input.originalCurrency),
          eq(fxRates.quoteCurrency, input.functionalCurrency),
        ),
      )
      .limit(1);
    if (!stored) throw new Error("The selected exchange rate is unavailable.");
    return { id: stored.id, rate: stored.rate, source: stored.source };
  }

  if (input.suppliedRate) {
    if (parseRateToScaled(input.suppliedRate) <= 0n) {
      throw new Error("Exchange rate must be positive.");
    }
    const source = input.suppliedBySource ? "source" : "manual";
    const [stored] = await input.db
      .insert(fxRates)
      .values({
        organizationId: input.orgId,
        baseCurrency: input.originalCurrency,
        quoteCurrency: input.functionalCurrency,
        effectiveDate: input.transactionDate,
        rate: input.suppliedRate,
        source,
        isManualOverride: source === "manual",
        overrideReason: source === "manual" ? "Transaction entry override" : null,
        createdBy: input.actorId ?? null,
      })
      .onConflictDoUpdate({
        target: [
          fxRates.organizationId,
          fxRates.baseCurrency,
          fxRates.quoteCurrency,
          fxRates.effectiveDate,
          fxRates.source,
        ],
        set: {
          rate: input.suppliedRate,
          retrievedAt: new Date(),
          createdBy: input.actorId ?? null,
        },
      })
      .returning();
    return { id: stored.id, rate: stored.rate, source };
  }

  const storedRates = await input.db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.organizationId, input.orgId),
        eq(fxRates.baseCurrency, input.originalCurrency),
        eq(fxRates.quoteCurrency, input.functionalCurrency),
        eq(fxRates.effectiveDate, input.transactionDate),
      ),
    )
    .orderBy(desc(fxRates.isManualOverride), desc(fxRates.retrievedAt));
  const preferred = storedRates.sort(
    (left, right) => (SOURCE_PRIORITY[left.source] ?? 99) - (SOURCE_PRIORITY[right.source] ?? 99),
  )[0];
  if (preferred) return { id: preferred.id, rate: preferred.rate, source: preferred.source };

  const appId = process.env.OPEN_EXCHANGE_RATES_APP_ID;
  if (!appId) {
    throw new Error(
      `No ${input.originalCurrency}/${input.functionalCurrency} rate is available. Enter a manual rate or configure Open Exchange Rates.`,
    );
  }
  const response = await fetch(
    `https://openexchangerates.org/api/historical/${input.transactionDate}.json?app_id=${encodeURIComponent(appId)}`,
  );
  if (!response.ok) {
    throw new Error(`Open Exchange Rates returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as {
    rates?: Record<string, number>;
  };
  const originalPerUsd = payload.rates?.[input.originalCurrency];
  const functionalPerUsd = payload.rates?.[input.functionalCurrency];
  if (!originalPerUsd || !functionalPerUsd) {
    throw new Error("The FX provider did not return the requested currency pair.");
  }
  const rate = (functionalPerUsd / originalPerUsd).toFixed(10);
  const [stored] = await input.db
    .insert(fxRates)
    .values({
      organizationId: input.orgId,
      baseCurrency: input.originalCurrency,
      quoteCurrency: input.functionalCurrency,
      effectiveDate: input.transactionDate,
      rate,
      source: "open_exchange_rates",
      providerReference: input.transactionDate,
    })
    .onConflictDoUpdate({
      target: [
        fxRates.organizationId,
        fxRates.baseCurrency,
        fxRates.quoteCurrency,
        fxRates.effectiveDate,
        fxRates.source,
      ],
      set: { rate, retrievedAt: new Date() },
    })
    .returning();
  return { id: stored.id, rate: stored.rate, source: stored.source };
}
