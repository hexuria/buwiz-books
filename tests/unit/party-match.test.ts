// ============================================================================
// Entity matching (inbox v2 §5): tier ordering, the closed-enum model pick,
// "new" as a proposal draft, and the payment-details comparison. The database
// lookups and the model are fakes; nothing here opens a connection.
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { createPartyProposalSchema } from "@/lib/ai/proposal-types";
import { toStrictJsonSchema } from "@/lib/ai/schema-strict";
import { zodToGeminiSchema } from "@/lib/ai/zod-to-gemini-schema";
import { pickPartyWithModel, type AiCompleteFn } from "@/lib/party-match/model-pick";
import {
  PARTY_TYPES_FOR_ENTITY,
  detectPaymentDetailsChange,
  extractEmailAddress,
  normalizeTaxId,
  taxIdsMatch,
} from "@/lib/party-match/normalize";
import {
  EXACT_TIER_ORDER,
  matchParty,
  type ExactTier,
  type PartyCandidate,
  type PartyLookups,
  type PartyMatchQuery,
  type PartyPickResult,
} from "@/lib/party-match/pipeline";

const ACME: PartyCandidate = { id: "p-acme", name: "Acme Supply Co", partyType: "vendor" };
const ACME_WEST: PartyCandidate = { id: "p-west", name: "Acme Supply West", partyType: "vendor" };
const ACMEX: PartyCandidate = { id: "p-acmex", name: "Acmex Logistics", partyType: "vendor" };

const QUERY: PartyMatchQuery = {
  name: "ACME SUPPLY",
  entityType: "vendor",
  taxId: "123-456-789-000",
  emails: ["billing@acme.test"],
  description: "Office supplies",
};

function fakes(
  exact: Partial<Record<ExactTier, PartyCandidate[]>>,
  lookalikes: PartyCandidate[] = [],
  pick: PartyPickResult = { kind: "new", confidence: 0.9, invocationId: "inv" },
) {
  const lookups = {
    exact: vi.fn<PartyLookups["exact"]>(async (tier) => exact[tier] ?? []),
    hint: vi.fn<NonNullable<PartyLookups["hint"]>>(async () => null),
    lookalikes: vi.fn<PartyLookups["lookalikes"]>(async (_query, limit, excludeIds) =>
      lookalikes.filter((candidate) => !excludeIds.includes(candidate.id)).slice(0, limit),
    ),
    pick: vi.fn(async (_query: PartyMatchQuery, _candidates: PartyCandidate[]) => pick),
  };
  return lookups;
}

describe("entity pipeline ordering: exact beats look-alikes beats the model", () => {
  it("asks the tiers strongest first", () => {
    expect(EXACT_TIER_ORDER).toEqual(["tax_id", "email", "alias", "name"]);
  });

  it("a single tax-id hit wins before any other lookup or the model runs", async () => {
    const deps = fakes({ tax_id: [ACME], name: [ACMEX] }, [ACME_WEST]);
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toEqual({ kind: "exact", tier: "tax_id", party: ACME });
    expect(deps.exact).toHaveBeenCalledTimes(1);
    expect(deps.lookalikes).not.toHaveBeenCalled();
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it("falls through the tiers in order: email before alias before name", async () => {
    const deps = fakes({ email: [ACME_WEST], name: [ACME] });
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toMatchObject({ kind: "exact", tier: "email", party: ACME_WEST });
    expect(deps.exact.mock.calls.map(([tier]) => tier)).toEqual(["tax_id", "email"]);
  });

  it("skips a tier it has no input for", async () => {
    const deps = fakes({ name: [ACME] });
    const outcome = await matchParty({ name: "Acme Supply Co", entityType: "vendor" }, deps, {
      minConfidence: 0.8,
    });
    expect(outcome).toMatchObject({ kind: "exact", tier: "name" });
    expect(deps.exact.mock.calls.map(([tier]) => tier)).toEqual(["alias", "name"]);
  });

  it("an exact name beats a trigram look-alike without asking the model", async () => {
    const deps = fakes({ name: [ACME] }, [ACME_WEST, ACMEX]);
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toMatchObject({ kind: "exact", tier: "name", party: ACME });
    expect(deps.lookalikes).not.toHaveBeenCalled();
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it("with no exact hit, the model picks among the trigram look-alikes", async () => {
    const deps = fakes({}, [ACME, ACME_WEST, ACMEX], {
      kind: "picked",
      partyId: ACME.id,
      confidence: 0.91,
      invocationId: "inv-7",
    });
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(deps.lookalikes).toHaveBeenCalledWith(QUERY, 5, []);
    expect(deps.pick).toHaveBeenCalledWith(QUERY, [ACME, ACME_WEST, ACMEX]);
    expect(outcome).toMatchObject({
      kind: "model",
      party: ACME,
      confidence: 0.91,
      invocationId: "inv-7",
    });
  });

  it("treats an ambiguous exact tier as look-alikes, never as a match", async () => {
    const deps = fakes({ tax_id: [ACME, ACME_WEST] }, [ACMEX]);
    await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(deps.pick).toHaveBeenCalledWith(QUERY, [ACME, ACME_WEST, ACMEX]);
  });

  it("does not let a weaker tier overrule an ambiguous stronger one", async () => {
    // Two parties share the printed tax id; the name names a third. Conflict:
    // all three go to the model rather than the name winning outright.
    const deps = fakes({ tax_id: [ACME, ACME_WEST], name: [ACMEX] });
    await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(deps.pick).toHaveBeenCalledWith(QUERY, [ACME, ACME_WEST, ACMEX]);
  });

  it("accepts a weaker tier's hit when it resolves the ambiguity", async () => {
    const deps = fakes({ tax_id: [ACME, ACME_WEST], name: [ACME] });
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toMatchObject({ kind: "exact", tier: "name", party: ACME });
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it("nothing alike is new without a model call", async () => {
    const deps = fakes({}, []);
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toEqual({ kind: "new", candidates: [], confidence: null, invocationId: null });
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it('the model\'s "new" stays new', async () => {
    const deps = fakes({}, [ACMEX], { kind: "new", confidence: 0.86, invocationId: "inv-2" });
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toEqual({
      kind: "new",
      candidates: [ACMEX],
      confidence: 0.86,
      invocationId: "inv-2",
    });
  });

  it("a below-threshold pick is a hint for a human, not a match", async () => {
    const deps = fakes({}, [ACME, ACME_WEST], {
      kind: "picked",
      partyId: ACME_WEST.id,
      confidence: 0.6,
      invocationId: null,
    });
    const outcome = await matchParty(QUERY, deps, { minConfidence: 0.8 });
    expect(outcome).toMatchObject({
      kind: "unresolved",
      reason: "low_confidence",
      suggestion: ACME_WEST,
    });
  });

  it("a pick outside the candidates, or a failed call, resolves nothing", async () => {
    const unknown = await matchParty(
      QUERY,
      fakes({}, [ACME], {
        kind: "picked",
        partyId: "p-elsewhere",
        confidence: 1,
        invocationId: null,
      }),
      { minConfidence: 0.8 },
    );
    expect(unknown).toMatchObject({ kind: "unresolved", reason: "unknown_choice" });
    const failed = await matchParty(
      QUERY,
      fakes({}, [ACME], { kind: "failed", reason: "needs_review", invocationId: null }),
      { minConfidence: 0.8 },
    );
    expect(failed).toMatchObject({ kind: "unresolved", reason: "model_failed" });
  });
});

describe("the model pick is a closed enum of minted refs", () => {
  const candidates = [ACME, ACME_WEST];

  function stubbedComplete(text: string) {
    const runtime: AiCompletionRuntime = {
      prepare: vi.fn(async () => ({
        kind: "ready" as const,
        hops: [{ provider: "jev" as const, model: "jev-1" }],
      })),
      invokeHop: vi.fn(async () => ({ text, invocationId: "inv-9", model: "jev-1" })),
      recordValidationOutcome: vi.fn(async () => undefined),
    };
    return { runtime, complete: createAiComplete(runtime) as AiCompleteFn };
  }

  it("shows the model refs, never party ids, and maps the answer back", async () => {
    const { runtime, complete } = stubbedComplete(
      JSON.stringify({ choice: "P2", confidence: 0.9, reason: "Same business, West branch" }),
    );
    const pick = await pickPartyWithModel(QUERY, candidates, { orgId: "org-1", complete });
    expect(pick).toEqual({
      kind: "picked",
      partyId: ACME_WEST.id,
      confidence: 0.9,
      invocationId: "inv-9",
    });

    const hop = vi.mocked(runtime.invokeHop).mock.calls[0][0];
    const prompt = String(hop.prompt);
    expect(prompt).toContain('"ref":"P1"');
    expect(prompt).toContain('"ref":"P2"');
    expect(prompt).not.toContain(ACME.id);
    // No emails, tax ids, or bank details reach the model.
    expect(prompt).not.toContain("billing@acme.test");
    expect(prompt).not.toContain("123-456-789");

    const strict = toStrictJsonSchema(hop.schema) as { properties: { choice: { enum: string[] } } };
    expect(strict.properties.choice.enum).toEqual(["P1", "P2", "new"]);
    expect(zodToGeminiSchema(hop.schema).properties?.choice).toMatchObject({
      format: "enum",
      enum: ["P1", "P2", "new"],
    });
  });

  it('"new" comes back as new, with the unit-scale confidence', async () => {
    const { complete } = stubbedComplete(
      JSON.stringify({ choice: "new", confidence: 1, reason: "" }),
    );
    expect(await pickPartyWithModel(QUERY, candidates, { orgId: "org-1", complete })).toEqual({
      kind: "new",
      confidence: 1,
      invocationId: "inv-9",
    });
  });

  it("rejects a ref outside the enum instead of guessing", async () => {
    const { complete } = stubbedComplete(
      JSON.stringify({ choice: "P7", confidence: 0.99, reason: "" }),
    );
    expect(await pickPartyWithModel(QUERY, candidates, { orgId: "org-1", complete })).toMatchObject(
      {
        kind: "failed",
        reason: "needs_review",
      },
    );
  });

  it("a façade error (kill switch, no credentials) is a failed pick, not a crash", async () => {
    const complete = vi.fn(async () => {
      throw new Error("AI is currently disabled for this organization.");
    }) as unknown as AiCompleteFn;
    expect(await pickPartyWithModel(QUERY, candidates, { orgId: "org-1", complete })).toMatchObject(
      {
        kind: "failed",
      },
    );
  });
});

describe('"new" drafts a create_party proposal', () => {
  it("the draft carries name, type, tax id, and email, and never bank details", () => {
    const parsed = createPartyProposalSchema.parse({
      entity: {
        entityType: "vendor",
        name: "Blue Bottle Roasters",
        identifier: "",
        accountType: "",
        matchedPartyId: "",
        taxId: "123-456-789-000",
        email: "billing@bluebottle.test",
        bankAccountNumber: "000123456789",
      },
    });
    expect(parsed.entity).toEqual({
      entityType: "vendor",
      name: "Blue Bottle Roasters",
      identifier: "",
      accountType: "",
      matchedPartyId: "",
      taxId: "123-456-789-000",
      email: "billing@bluebottle.test",
    });
  });

  it("older drafts without the new fields still parse", () => {
    const parsed = createPartyProposalSchema.parse({
      entity: { entityType: "vendor", name: "Staples" },
    });
    expect(parsed.entity).toMatchObject({ taxId: "", email: "" });
  });
});

describe("normalizers", () => {
  it("normalizes tax ids and refuses values too short to identify anyone", () => {
    expect(normalizeTaxId("123-456-789-000")).toBe("123456789000");
    expect(normalizeTaxId("gb 123 4567 89")).toBe("GB123456789");
    expect(normalizeTaxId("12-34")).toBeNull();
    expect(normalizeTaxId("ABCDEFGH")).toBeNull();
  });

  it("matches a nine-digit PH TIN against the same TIN with a branch code", () => {
    expect(taxIdsMatch("123456789", "123456789000")).toBe(true);
    expect(taxIdsMatch("123456789000", "123456789")).toBe(true);
    expect(taxIdsMatch("123456789", "123456780000")).toBe(false);
    expect(taxIdsMatch("GB123456789", "GB123456789")).toBe(true);
  });

  it("pulls the address out of a From header", () => {
    expect(extractEmailAddress('"Acme Billing" <Billing@Acme.test>')).toBe("billing@acme.test");
    expect(extractEmailAddress("ap@acme.test")).toBe("ap@acme.test");
    expect(extractEmailAddress("Acme Billing")).toBeNull();
  });

  it("never matches a vendor to a customer-only party", () => {
    expect(PARTY_TYPES_FOR_ENTITY.vendor).toEqual(["vendor", "both"]);
    expect(PARTY_TYPES_FOR_ENTITY.customer).toEqual(["customer", "both"]);
    expect(PARTY_TYPES_FOR_ENTITY.employee).toEqual(["employee"]);
  });
});

describe("payment details comparison", () => {
  const stored = { bankAccountNumber: "0001-2345-6789", bankRoutingNumber: "021000021" };

  it("reports nothing when the printed details are the stored ones", () => {
    expect(
      detectPaymentDetailsChange(stored, {
        accountNumber: "000123456789",
        routingNumber: "021 000 021",
      }),
    ).toBeNull();
    // A masked printout that agrees on the visible tail.
    expect(
      detectPaymentDetailsChange(stored, { accountNumber: "****6789", routingNumber: null }),
    ).toBeNull();
  });

  it("reports a different account, with last-four digits only", () => {
    expect(
      detectPaymentDetailsChange(stored, {
        accountNumber: "9876543210",
        routingNumber: "021000021",
      }),
    ).toEqual({
      fields: ["bank_account_number"],
      stored: { accountLast4: "6789", routingLast4: "0021" },
      document: { accountLast4: "3210", routingLast4: "0021" },
    });
    expect(
      detectPaymentDetailsChange(stored, { accountNumber: "XXXX-XXXX-1111", routingNumber: null })
        ?.fields,
    ).toEqual(["bank_account_number"]);
  });

  it("reports a different routing number", () => {
    expect(
      detectPaymentDetailsChange(stored, { accountNumber: null, routingNumber: "026009593" })
        ?.fields,
    ).toEqual(["bank_routing_number"]);
  });

  it("treats an IBAN wrapping the stored account, and BIC8 vs BIC11 XXX, as the same", () => {
    expect(
      detectPaymentDetailsChange(
        { bankAccountNumber: "31926819", bankRoutingNumber: "NWBKGB2L" },
        { accountNumber: "GB29 NWBK 6016 1331 9268 19", routingNumber: "NWBKGB2LXXX" },
      ),
    ).toBeNull();
  });

  it("has nothing to compare when either side is missing", () => {
    expect(
      detectPaymentDetailsChange(
        { bankAccountNumber: null, bankRoutingNumber: null },
        { accountNumber: "9876543210", routingNumber: "026009593" },
      ),
    ).toBeNull();
    expect(
      detectPaymentDetailsChange(stored, { accountNumber: null, routingNumber: null }),
    ).toBeNull();
  });
});

describe("entity resolver wiring", () => {
  const source = readFileSync(
    join(__dirname, "../../src/routes/api/-ai-entity-resolver.ts"),
    "utf-8",
  );

  it("matches through the shared pipeline, model step included", () => {
    expect(source).toContain("matchParty(");
    expect(source).toContain("partyLookups(db, orgId)");
    expect(source).toContain("pickPartyWithModel(");
  });

  it("stays write-free: creation is only ever a create_party proposal", () => {
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toContain("createPartyFromEntity");
    expect(source).toContain('kind: "create_party"');
  });
});
