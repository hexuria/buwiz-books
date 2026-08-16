// ============================================================================
// Pre-egress PII redaction. Posture: over-masking is safe, under-masking is
// a breach — the false-positive tests assert we tolerate over-masking, and
// the property test asserts no card-shaped number ever survives.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  redactPII,
  toRedactedPrompt,
  isLuhnValid,
  isAbaRoutingValid,
} from "../../../src/lib/ai/redact";

describe("checksums", () => {
  it("validates Luhn", () => {
    expect(isLuhnValid("4111111111111111")).toBe(true);
    expect(isLuhnValid("4111111111111112")).toBe(false);
  });

  it("validates ABA routing", () => {
    expect(isAbaRoutingValid("021000021")).toBe(true);
    expect(isAbaRoutingValid("021000022")).toBe(false);
  });
});

describe("redactPII — masks sensitive identifiers", () => {
  it("masks a dashed SSN keeping the last 4", () => {
    const { text, hits } = redactPII("Employee SSN 123-45-6789 on file");
    expect(text).not.toContain("123-45-6789");
    expect(text).toContain("6789");
    expect(hits[0].kind).toBe("ssn");
  });

  it("masks a labeled undashed SSN", () => {
    const { text } = redactPII("SSN: 123456789");
    expect(text).not.toContain("123456789");
    expect(text).toContain("6789");
  });

  it("masks a card PAN (Luhn-valid) with and without separators", () => {
    expect(redactPII("Visa 4111 1111 1111 1111").text).not.toContain("4111 1111 1111 1111");
    const spaced = redactPII("card 4111-1111-1111-1111 charged");
    expect(spaced.text).not.toContain("4111-1111-1111-1111");
    expect(spaced.text).toContain("1111");
  });

  it("masks a labeled ABA routing number", () => {
    const { text, hits } = redactPII("Routing Number: 021000021");
    expect(text).not.toContain("021000021");
    expect(hits.some((h) => h.kind === "routing")).toBe(true);
  });

  it("masks labeled account numbers", () => {
    const { text } = redactPII("Account #12345678901 at Mercury");
    expect(text).not.toContain("12345678901");
    expect(text).toContain("8901");
  });

  it("masks partially-masked account forms", () => {
    const { text } = redactPII("Paid from ****123456789");
    expect(text).not.toContain("123456789");
  });

  it("masks IBANs", () => {
    const { text, hits } = redactPII("IBAN GB33BUKB20201555555555 please");
    expect(text).not.toContain("GB33BUKB20201555555555");
    expect(hits.some((h) => h.kind === "iban")).toBe(true);
  });

  it("keeps the last 4 so humans can still reconcile", () => {
    const { text } = redactPII("Account #12345678901");
    expect(text).toMatch(/8901/);
  });
});

describe("redactPII — leaves benign text alone", () => {
  it("does not mask ISO dates", () => {
    const input = "Statement period 2026-01-01 to 2026-01-31";
    expect(redactPII(input).text).toBe(input);
  });

  it("does not mask money amounts", () => {
    const input = "Total 1,234,567.89 USD and 42.50";
    expect(redactPII(input).text).toBe(input);
  });

  it("does not mask short reference numbers", () => {
    const input = "Invoice INV-1047 check 1042";
    expect(redactPII(input).text).toBe(input);
  });

  it("accepts over-masking of a long unlabeled digit run that passes Luhn", () => {
    // 4111111111111111 in an invoice-number position is still masked.
    // Deliberate: a false positive costs context, a false negative leaks a PAN.
    const { text } = redactPII("Reference 4111111111111111");
    expect(text).not.toContain("4111111111111111");
  });
});

describe("redactPII — invariants", () => {
  it("is idempotent", () => {
    const once = redactPII("SSN 123-45-6789 acct #98765432109").text;
    const twice = redactPII(once).text;
    expect(twice).toBe(once);
  });

  it("never leaves a Luhn-valid 13+ digit run in the output", () => {
    const samples = [
      "card 4111111111111111",
      "pay 5500005555555559 now",
      "4012 8888 8888 1881 billed",
      "Account #12345678901 and card 4111111111111111",
    ];
    for (const sample of samples) {
      const { text } = redactPII(sample);
      const runs = text.match(/\d{13,19}/g) ?? [];
      for (const run of runs) {
        expect(isLuhnValid(run)).toBe(false);
      }
    }
  });

  it("handles empty and PII-free input", () => {
    expect(redactPII("").text).toBe("");
    expect(redactPII("hello world").hits).toEqual([]);
  });
});

describe("toRedactedPrompt", () => {
  it("returns a branded prompt plus the hit list", () => {
    const { prompt, hits } = toRedactedPrompt("SSN 123-45-6789");
    expect(String(prompt)).not.toContain("123-45-6789");
    expect(hits).toHaveLength(1);
  });
});
