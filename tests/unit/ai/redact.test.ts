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

describe("redactPII — Philippine government IDs", () => {
  const cases: Array<{ name: string; input: string; output: string; kind: string }> = [
    // TIN: dashed shape, with or without a label, with 3- or 5-digit branch
    {
      name: "TIN, dashed",
      input: "Seller TIN 123-456-789",
      output: "Seller TIN *****6789",
      kind: "ph_tin",
    },
    {
      name: "TIN, 3-digit branch",
      input: "VAT REG. TIN: 008-123-456-000",
      output: "VAT REG. TIN: ********6000",
      kind: "ph_tin",
    },
    {
      name: "TIN, 5-digit branch",
      input: "TIN 008-123-456-00000",
      output: "TIN **********0000",
      kind: "ph_tin",
    },
    {
      name: "TIN, dashed with no label",
      input: "Payee: Dela Cruz Trading 123-456-789",
      output: "Payee: Dela Cruz Trading *****6789",
      kind: "ph_tin",
    },
    {
      name: "TIN, mistyped 4-digit branch still masks the TIN",
      input: "TIN 123-456-789-0123",
      output: "TIN *********0123",
      kind: "ph_tin",
    },
    // TIN: unseparated / space-separated forms need the label
    {
      name: "TIN, labeled, unseparated",
      input: "TIN: 123456789",
      output: "TIN: *****6789",
      kind: "ph_tin",
    },
    {
      name: "TIN, labeled, unseparated with branch",
      input: "TIN#123456789000",
      output: "TIN#********9000",
      kind: "ph_tin",
    },
    {
      name: "TIN, labeled, space-separated",
      input: "TIN No.: 123 456 789",
      output: "TIN No.: *****6789",
      kind: "ph_tin",
    },
    {
      name: "TIN, dotted label",
      input: "T.I.N.: 123 456 789",
      output: "T.I.N.: *****6789",
      kind: "ph_tin",
    },
    {
      name: "TIN, long-form label",
      input: "Tax Identification Number (TIN): 123456789",
      output: "Tax Identification Number (TIN): *****6789",
      kind: "ph_tin",
    },
    { name: "TIN, label glued on", input: "TIN123456789", output: "TIN*****6789", kind: "ph_tin" },
    // SSS
    {
      name: "SSS, dashed",
      input: "SSS No. 34-1234567-8",
      output: "SSS No. ******5678",
      kind: "ph_sss",
    },
    {
      name: "SSS, dashed with no label",
      input: "34-1234567-8",
      output: "******5678",
      kind: "ph_sss",
    },
    {
      name: "SSS, labeled, unseparated",
      input: "SSS: 3412345678",
      output: "SSS: ******5678",
      kind: "ph_sss",
    },
    {
      name: "SSS, labeled, space-separated",
      input: "SSS# 34 1234567 8",
      output: "SSS# ******5678",
      kind: "ph_sss",
    },
    {
      name: "SSS, long-form label",
      input: "Social Security System No. 3412345678",
      output: "Social Security System No. ******5678",
      kind: "ph_sss",
    },
    // PhilHealth PIN
    {
      name: "PhilHealth, dashed",
      input: "PhilHealth No. 12-345678901-2",
      output: "PhilHealth No. ********9012",
      kind: "ph_philhealth",
    },
    {
      name: "PhilHealth, dashed with no label",
      input: "12-345678901-2",
      output: "********9012",
      kind: "ph_philhealth",
    },
    {
      name: "PhilHealth, labeled, unseparated",
      input: "PhilHealth PIN: 123456789012",
      output: "PhilHealth PIN: ********9012",
      kind: "ph_philhealth",
    },
    {
      name: "PhilHealth, labeled, space-separated",
      input: "PhilHealth Identification Number (PIN): 12 345678901 2",
      output: "PhilHealth Identification Number (PIN): ********9012",
      kind: "ph_philhealth",
    },
    {
      name: "PhilHealth, PHIC label",
      input: "PHIC 123456789012",
      output: "PHIC ********9012",
      kind: "ph_philhealth",
    },
    // Pag-IBIG / HDMF MID
    {
      name: "Pag-IBIG, dashed",
      input: "Pag-IBIG MID No.: 1234-5678-9012",
      output: "Pag-IBIG MID No.: ********9012",
      kind: "ph_pagibig",
    },
    {
      name: "Pag-IBIG, dashed with no label",
      input: "1234-5678-9012",
      output: "********9012",
      kind: "ph_pagibig",
    },
    {
      name: "Pag-IBIG, labeled, space-separated",
      input: "Pag-IBIG MID 1234 5678 9012",
      output: "Pag-IBIG MID ********9012",
      kind: "ph_pagibig",
    },
    {
      name: "Pag-IBIG, HDMF label, unseparated",
      input: "HDMF 121012345678",
      output: "HDMF ********5678",
      kind: "ph_pagibig",
    },
  ];

  it.each(cases)("masks $name", ({ input, output, kind }) => {
    const { text, hits } = redactPII(input);
    expect(text).toBe(output);
    expect(hits.map((hit) => hit.kind)).toContain(kind);
  });

  it("masks every ID in an unlabeled payroll-register row and keeps the amount", () => {
    const row =
      "Juan Dela Cruz | 123-456-789 | 34-1234567-8 | 12-345678901-2 | 1234-5678-9012 | 25,000.00";
    const { text, hits } = redactPII(row);
    expect(text).toBe(
      "Juan Dela Cruz | *****6789 | ******5678 | ********9012 | ********9012 | 25,000.00",
    );
    expect(hits.map((hit) => hit.kind)).toEqual([
      "ph_tin",
      "ph_sss",
      "ph_philhealth",
      "ph_pagibig",
    ]);
  });

  it("masks IDs in a comma-separated row without touching the amount", () => {
    const { text } = redactPII(
      "Juan,123-456-789,34-1234567-8,12-345678901-2,1234-5678-9012,25000.00",
    );
    expect(text).toBe("Juan,*****6789,******5678,********9012,********9012,25000.00");
  });

  it("never lets an ID mask swallow the amount beside it", () => {
    expect(redactPII("TIN: 123 456 789 500.00").text).toBe("TIN: *****6789 500.00");
    expect(redactPII("Juan 123-456-789 25000.00").text).toBe("Juan *****6789 25000.00");
    expect(redactPII("SSS 34-1234567-8 12,500.00").text).toBe("SSS ******5678 12,500.00");
    // Pre-existing masks get the same protection: the partially-masked
    // account rule used to merge this into "SSN ****1250.00".
    expect(redactPII("SSN 123-45-6789 1250.00").text).toBe("SSN *****6789 1250.00");
  });

  it("leaves the 16-digit card rule in charge of dashed 4-4-4-4 runs", () => {
    // Masking only the first 12 digits as an MID would leave 8 digits of a
    // PAN visible; the card rule masks all but the last 4.
    const card = redactPII("Card 4111-1111-1111-1111");
    expect(card.text).toBe("Card ************1111");
    expect(card.hits.map((hit) => hit.kind)).toEqual(["card"]);
    // Not a card (fails Luhn) and not an ID shape: no partial mask either.
    expect(redactPII("Ref 1234-5678-9012-3456").text).toBe("Ref 1234-5678-9012-3456");
  });
});

describe("redactPII — Philippine text that must survive", () => {
  const benign: Array<{ name: string; input: string }> = [
    { name: "grouped amounts", input: "Total PHP 1,234,567.89 and ₱42.50" },
    { name: "ungrouped amounts", input: "Net pay 1234567.89" },
    { name: "amounts beside ID labels", input: "SSS contribution 1,125.00 PhilHealth 450.00" },
    {
      name: "undecorated amounts beside ID labels",
      input: "SSS EE 1125.00 ER 2375.00 Pag-IBIG 200.00 HDMF 100",
    },
    { name: "ISO dates", input: "Statement period 2026-01-01 to 2026-01-31" },
    { name: "a date after a TIN label", input: "TIN issued 2019-05-01" },
    { name: "US-style dates", input: "Due 01-31-2026" },
    { name: "PH mobile numbers", input: "Call 0917-123-4567 or 0917 123 4567" },
    { name: "international mobile formats", input: "+63 917 123 4567 / +63-917-123-4567" },
    { name: "Metro Manila landlines", input: "(02) 8123-4567 or 02-8123-4567" },
    {
      name: "invoice numbers",
      input: "Invoice INV-2026-0001, SI No. 0012345, OR# 000123456, INV-1047",
    },
    { name: "prefixed invoice numbers in an ID shape", input: "Paid INV-2026-0001-0042 in full" },
    { name: "an unlabeled 9-digit run", input: "Check 123456789 cleared" },
    { name: "unlabeled space-separated digit groups", input: "Ref 123 456 789 000" },
    { name: "a PIN code", input: "PIN code 1234" },
    { name: "the word mid", input: "mid-year bonus 1234 5678 9012" },
  ];

  it.each(benign)("leaves $name intact", ({ input }) => {
    const { text, hits } = redactPII(input);
    expect(text).toBe(input);
    expect(hits).toEqual([]);
  });
});

describe("redactPII — fixed point", () => {
  it("masks PII glued to a run that an earlier pass masked", () => {
    // The SSN ends in a word character (X), so `\b` only appears once the
    // masked-account rule has replaced "XXXX-5620-1278" with stars.
    const { text, hits } = redactPII("219-44-2138XXXX-5620-1278");
    expect(text).toBe("*****2138****1278");
    expect(hits.map((hit) => hit.kind).sort()).toEqual(["account", "ssn"]);
  });

  it("does the same for a TIN glued to a masked run", () => {
    expect(redactPII("123-456-789XXXX-5620-1278").text).toBe("*****6789****1278");
  });

  it("masks IDs whose labels are glued to the previous value", () => {
    expect(redactPII("TIN:123-456-789SSS:34-1234567-8").text).toBe("TIN:*****6789SSS:******5678");
  });

  it("returns a fixed point: a second run changes nothing and reports no hits", () => {
    const samples = [
      "219-44-2138XXXX-5620-1278",
      "Juan Dela Cruz | 123-456-789 | 34-1234567-8 | 12-345678901-2 | 1234-5678-9012",
      "TIN No.: 123 456 789 000 SSN 123-45-6789 acct #98765432109",
    ];
    for (const sample of samples) {
      const once = redactPII(sample).text;
      const again = redactPII(once);
      expect(again.text).toBe(once);
      expect(again.hits).toEqual([]);
    }
  });
});
