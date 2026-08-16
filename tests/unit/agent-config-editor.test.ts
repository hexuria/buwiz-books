import { describe, expect, it } from "vitest";
import {
  buildAgentConfigPayload,
  getAgentSchema,
  splitStoredConfig,
  validateAgentConfig,
  type AgentConfigSchema,
} from "../../src/lib/review-agents/agent-config-schema";
import { keys } from "../../src/lib/query-keys";

const duplicate = getAgentSchema("possible_duplicate")!;
const materialExpense = getAgentSchema("material_expense")!;
const missingReceipt = getAgentSchema("missing_receipt")!;

/**
 * The stored config the duplicate engine actually reads, including the key that has no visible
 * field. This is the shape the old JSON textarea round-tripped only because the user could see it.
 */
const STORED_DUPLICATE = {
  mode: "enforce",
  matchWindowDays: 3,
  blockingScore: 70,
  shadowScore: 50,
  relatedAmountToleranceBps: 200,
  algorithmVersion: 4,
};

describe("splitStoredConfig", () => {
  it("seeds every visible field from the stored value", () => {
    const { values } = splitStoredConfig(duplicate, STORED_DUPLICATE);
    expect(values.mode).toBe("enforce");
    expect(values.blockingScore).toBe("70");
    expect(values.shadowScore).toBe("50");
  });

  it("falls back to the schema default for a key the stored config omits", () => {
    const { values } = splitStoredConfig(duplicate, { mode: "shadow" });
    expect(values.mode).toBe("shadow");
    expect(values.blockingScore).toBe("70");
  });

  it("keeps algorithmVersion in passthrough and out of the visible fields", () => {
    const { values, passthrough, hiddenAdvanced } = splitStoredConfig(duplicate, STORED_DUPLICATE);
    expect(values.algorithmVersion).toBeUndefined();
    expect(passthrough.algorithmVersion).toBe(4);
    // The schema declares it, so it is not surfaced as "written by a newer release".
    expect(hiddenAdvanced).toHaveLength(0);
  });

  it("surfaces a key written by a newer release as advanced, still preserved", () => {
    const { passthrough, hiddenAdvanced } = splitStoredConfig(duplicate, {
      ...STORED_DUPLICATE,
      futureKnob: "on",
    });
    expect(passthrough.futureKnob).toBe("on");
    expect(hiddenAdvanced).toEqual([["futureKnob", "on"]]);
  });

  it("treats every stored key as passthrough when there is no schema", () => {
    const { values, passthrough, hiddenAdvanced } = splitStoredConfig(undefined, {
      anything: 1,
      else: "two",
    });
    expect(values).toEqual({});
    expect(passthrough).toEqual({ anything: 1, else: "two" });
    expect(hiddenAdvanced).toHaveLength(2);
  });
});

describe("buildAgentConfigPayload", () => {
  it("round-trips an unknown key untouched", () => {
    const stored = { ...STORED_DUPLICATE, futureKnob: "on" };
    const { values, passthrough } = splitStoredConfig(duplicate, stored);
    const payload = buildAgentConfigPayload(duplicate, values, passthrough);
    expect(payload.futureKnob).toBe("on");
  });

  /** The specific regression: a field-driven editor must not drop what it cannot render. */
  it("preserves algorithmVersion across a save", () => {
    const { values, passthrough } = splitStoredConfig(duplicate, STORED_DUPLICATE);
    const payload = buildAgentConfigPayload(duplicate, values, passthrough);
    expect(payload.algorithmVersion).toBe(4);
  });

  it("coerces numeric fields to numbers and leaves enum and currency as strings", () => {
    const { values, passthrough } = splitStoredConfig(duplicate, STORED_DUPLICATE);
    const payload = buildAgentConfigPayload(
      duplicate,
      { ...values, blockingScore: "80" },
      passthrough,
    );
    expect(payload.blockingScore).toBe(80);
    expect(payload.mode).toBe("enforce");

    const receipt = splitStoredConfig(missingReceipt, { threshold: 75, currency: "EUR" });
    const receiptPayload = buildAgentConfigPayload(
      missingReceipt,
      receipt.values,
      receipt.passthrough,
    );
    expect(receiptPayload.threshold).toBe(75);
    expect(receiptPayload.currency).toBe("EUR");
  });

  it("lets a visible field win over a colliding passthrough entry", () => {
    const payload = buildAgentConfigPayload(
      duplicate,
      { ...splitStoredConfig(duplicate, STORED_DUPLICATE).values, blockingScore: "90" },
      { blockingScore: 10 },
    );
    expect(payload.blockingScore).toBe(90);
  });
});

describe("validateAgentConfig", () => {
  const valid = splitStoredConfig(duplicate, STORED_DUPLICATE).values;

  it("accepts the seeded defaults", () => {
    expect(validateAgentConfig(duplicate.fields, valid, "3", duplicate.usesLookback)).toEqual({});
  });

  it("blocks a cleared number instead of sending NaN", () => {
    const errors = validateAgentConfig(
      duplicate.fields,
      { ...valid, blockingScore: "" },
      "3",
      false,
    );
    expect(errors.blockingScore).toBe("Enter a number.");
  });

  it("enforces the same bounds the server does", () => {
    expect(
      validateAgentConfig(duplicate.fields, { ...valid, matchWindowDays: "99" }, "3", false)
        .matchWindowDays,
    ).toMatch(/at most 31/);
    expect(
      validateAgentConfig(duplicate.fields, { ...valid, blockingScore: "0" }, "3", false)
        .blockingScore,
    ).toMatch(/at least 1/);
  });

  it("rejects a shadow score at or above the blocking score, in the server's words", () => {
    const errors = validateAgentConfig(
      duplicate.fields,
      { ...valid, shadowScore: "70" },
      "3",
      false,
    );
    expect(errors.shadowScore).toBe("Shadow score must be lower than the blocking score.");
  });

  /**
   * The denial-of-close guard: 0 makes every expense material, and blocking findings gate
   * setClosedThrough.
   */
  it("rejects a zero materiality threshold", () => {
    const errors = validateAgentConfig(
      materialExpense.fields,
      { annualizedExpensePercent: "0" },
      "3",
      true,
    );
    expect(errors.annualizedExpensePercent).toMatch(/at least/);
  });

  it("requires a 3-letter currency code", () => {
    const receipt = splitStoredConfig(missingReceipt, { threshold: 75, currency: "EUR" });
    expect(
      validateAgentConfig(missingReceipt.fields, receipt.values, "3", false).currency,
    ).toBeUndefined();
    expect(
      validateAgentConfig(missingReceipt.fields, { ...receipt.values, currency: "EU" }, "3", false)
        .currency,
    ).toMatch(/3-letter/);
  });

  it("rejects an out-of-range enum value", () => {
    const errors = validateAgentConfig(
      duplicate.fields,
      { ...valid, mode: "nonsense" },
      "3",
      false,
    );
    expect(errors.mode).toMatch(/listed options/);
  });

  it("only validates the lookback when the agent actually reads one", () => {
    expect(validateAgentConfig([], {}, "not a number", false).lookbackMonths).toBeUndefined();
    expect(validateAgentConfig([], {}, "not a number", true).lookbackMonths).toMatch(/1 and 24/);
    expect(validateAgentConfig([], {}, "0", true).lookbackMonths).toMatch(/1 and 24/);
    expect(validateAgentConfig([], {}, "25", true).lookbackMonths).toMatch(/1 and 24/);
    expect(validateAgentConfig([], {}, "12", true).lookbackMonths).toBeUndefined();
  });
});

describe("agents with no UI schema", () => {
  it("renders read-only rather than falling back to an editable blob", () => {
    // getAgentSchema returning undefined is the signal the component branches on; the split then
    // keeps everything as passthrough so a save could not drop it either.
    const unknown: AgentConfigSchema | undefined = getAgentSchema("some_future_agent");
    expect(unknown).toBeUndefined();
    const { values, passthrough } = splitStoredConfig(unknown, { knob: 1 });
    expect(values).toEqual({});
    expect(buildAgentConfigPayload(unknown, values, passthrough)).toEqual({ knob: 1 });
  });
});

describe("query keys", () => {
  it("keeps every inbox builder under the all() prefix", () => {
    const prefix = keys.inbox.all();
    for (const key of [
      keys.inbox.list({ state: "open" }),
      keys.inbox.detail("abc"),
      keys.inbox.duplicateCase("abc"),
      keys.inbox.settings(),
    ]) {
      expect(key.slice(0, prefix.length)).toEqual(prefix);
    }
  });

  it("keeps every reviewAgents builder under the all() prefix", () => {
    const prefix = keys.reviewAgents.all();
    for (const key of [
      keys.reviewAgents.list(),
      keys.reviewAgents.findings("unusual_spend", { state: "open" }),
      keys.reviewAgents.runs("unusual_spend"),
      keys.reviewAgents.runs(),
    ]) {
      expect(key.slice(0, prefix.length)).toEqual(prefix);
    }
  });

  it("gives different filters different keys so the cache cannot merge them", () => {
    expect(keys.inbox.list({ state: "open" })).not.toEqual(keys.inbox.list({ state: "approved" }));
    expect(keys.reviewAgents.findings("a")).not.toEqual(keys.reviewAgents.findings("b"));
  });
});
