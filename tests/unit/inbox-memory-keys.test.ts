import { describe, expect, it } from "vitest";
import {
  MATCH_KEY_MAX_CHARS,
  MEMORY_MATCH_KINDS,
  derivePaperKeys,
  describeMatchKey,
  documentExtractionFromRow,
  fileHashKey,
  lineTextKey,
  paperDocumentFacts,
  parsePaperKeys,
  partyKey,
  scopeKey,
  senderPartyKey,
  type PaperDocumentFacts,
} from "../../src/lib/inbox/memory/keys";

/**
 * Memory keys are normalized once, at write time, by the same functions that
 * derive a paper's keys at lookup time — so a lookup is an exact probe and the
 * same paper always finds the same memory.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function doc(overrides: Partial<PaperDocumentFacts> = {}): PaperDocumentFacts {
  return {
    contentHash: HASH_A,
    description: "Printer paper and toner",
    partyTaxId: null,
    printedEmails: [],
    ...overrides,
  };
}

describe("specificity order", () => {
  it("is file, sender, party, words — the lookup policy", () => {
    expect(MEMORY_MATCH_KINDS).toEqual(["file_hash", "sender_party", "party", "line_text"]);
  });
});

describe("fileHashKey", () => {
  it("keeps a sha256 hex digest, lower-cased", () => {
    expect(fileHashKey(HASH_A)).toBe(HASH_A);
    expect(fileHashKey(` ${"AB".repeat(32)} `)).toBe("ab".repeat(32));
  });

  it("refuses anything that is not a sha256 digest", () => {
    expect(fileHashKey(null)).toBeNull();
    expect(fileHashKey("")).toBeNull();
    expect(fileHashKey("a".repeat(63))).toBeNull();
    expect(fileHashKey("g".repeat(64))).toBeNull();
  });
});

describe("senderPartyKey", () => {
  it("joins the normalized address and tax id", () => {
    expect(
      senderPartyKey({
        senderEmail: '"Acme Billing" <Billing@ACME.test>',
        partyTaxId: "123-456-789-000",
      }),
    ).toBe("billing@acme.test|123456789000");
  });

  it("formats the same sender the same way", () => {
    const a = senderPartyKey({ senderEmail: "billing@acme.test", partyTaxId: "123456789000" });
    const b = senderPartyKey({
      senderEmail: "Acme <BILLING@acme.test>",
      partyTaxId: " 123 456 789 000 ",
    });
    expect(a).toBe(b);
  });

  it("keeps either half alone, and nothing when both are missing", () => {
    expect(senderPartyKey({ senderEmail: "billing@acme.test" })).toBe("billing@acme.test|");
    expect(senderPartyKey({ partyTaxId: "123-456-789" })).toBe("|123456789");
    expect(senderPartyKey({ senderEmail: "not an address", partyTaxId: "12" })).toBeNull();
    expect(senderPartyKey({})).toBeNull();
  });

  it("stores an over-long key as its digest", () => {
    const local = "x".repeat(300);
    const key = senderPartyKey({ senderEmail: `${local}@acme.test` });
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(key!.length).toBeLessThanOrEqual(MATCH_KEY_MAX_CHARS);
    expect(senderPartyKey({ senderEmail: `${local}@acme.test` })).toBe(key);
  });
});

describe("partyKey", () => {
  it("keeps a uuid, lower-cased", () => {
    expect(partyKey("5F2B3C4D-1111-4222-8333-444455556666")).toBe(
      "5f2b3c4d-1111-4222-8333-444455556666",
    );
  });

  it("refuses anything else", () => {
    expect(partyKey("acme")).toBeNull();
    expect(partyKey(null)).toBeNull();
  });
});

describe("lineTextKey (vendor alias normalization)", () => {
  it("ignores word order, case, and punctuation", () => {
    expect(lineTextKey("Printer paper, and toner!")).toBe("AND PAPER PRINTER TONER");
    expect(lineTextKey("toner AND printer-paper")).toBe(lineTextKey("Printer paper and toner"));
  });

  it("drops per-paper noise the alias normalizer drops", () => {
    expect(lineTextKey("AMZN Mktp US*2K3AB817 05/12 POS 0042317")).toBe(
      lineTextKey("amzn mktp us"),
    );
  });

  it("deduplicates repeated words", () => {
    expect(lineTextKey("coffee coffee beans")).toBe("BEANS COFFEE");
  });

  it("has no key for text that normalizes to (almost) nothing", () => {
    expect(lineTextKey("")).toBeNull();
    expect(lineTextKey("   ")).toBeNull();
    expect(lineTextKey(null)).toBeNull();
    expect(lineTextKey("POS DEBIT 12345678")).toBeNull();
    expect(lineTextKey("A b")).toBeNull();
  });

  it("stores an over-long description as its digest", () => {
    const words = Array.from(
      { length: 80 },
      (_, index) => `word${String.fromCharCode(97 + (index % 26))}${index}`,
    );
    const key = lineTextKey(words.join(" "));
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe("paperDocumentFacts", () => {
  it("reads the inbox extraction first, then the parse cache, then bill notes", () => {
    const facts = paperDocumentFacts(
      documentExtractionFromRow({
        contentHash: HASH_A,
        metadata: {
          inboxExtraction: {
            result: { description: " Printer paper ", partyTaxId: "123", partyEmail: "a@b.test" },
          },
          billOcr: {
            result: { invoice: { notes: "Bill notes" }, vendor: { email: "vendor@b.test" } },
          },
        },
        aiTransactionCache: { result: { memo: "Parsed memo" } },
      }),
    );
    expect(facts).toEqual({
      contentHash: HASH_A,
      description: "Printer paper",
      partyTaxId: "123",
      printedEmails: ["a@b.test", "vendor@b.test"],
    });
    expect(
      paperDocumentFacts(
        documentExtractionFromRow({
          contentHash: null,
          metadata: { billOcr: { result: { invoice: { notes: "Bill notes" } } } },
          aiTransactionCache: { result: { memo: "Parsed memo" } },
        }),
      ).description,
    ).toBe("Parsed memo");
  });

  it("never falls back to the filename", () => {
    const facts = paperDocumentFacts(
      documentExtractionFromRow({
        contentHash: HASH_A,
        metadata: { extractedVendor: "Acme" },
        aiTransactionCache: null,
      }),
    );
    expect(facts.description).toBeNull();
  });
});

describe("derivePaperKeys", () => {
  it("derives one key per kind from the paper", () => {
    const keys = derivePaperKeys({
      documents: [doc({ partyTaxId: "123-456-789-000" })],
      from: '"Staples" <Receipts@Staples.test>',
      fallbackDescription: "ignored when documents exist",
      partyId: "5f2b3c4d-1111-4222-8333-444455556666",
    });
    expect(keys).toEqual({
      file_hash: [HASH_A],
      sender_party: ["receipts@staples.test|123456789000"],
      party: ["5f2b3c4d-1111-4222-8333-444455556666"],
      line_text: ["AND PAPER PRINTER TONER"],
    });
  });

  it("carries every file of a multi-file paper, primary first, once", () => {
    const keys = derivePaperKeys({
      documents: [doc(), doc({ contentHash: HASH_B }), doc()],
      from: null,
      fallbackDescription: null,
      partyId: null,
    });
    expect(keys.file_hash).toEqual([HASH_A, HASH_B]);
    expect(scopeKey(keys, "file_hash")).toBe(HASH_A);
  });

  it("uses the printed email when the paper did not arrive by email", () => {
    const keys = derivePaperKeys({
      documents: [doc({ printedEmails: ["not-an-email", "Billing@Acme.test"] })],
      from: null,
      fallbackDescription: null,
      partyId: null,
    });
    expect(keys.sender_party).toEqual(["billing@acme.test|"]);
  });

  it("prefers the email sender over a printed address", () => {
    const keys = derivePaperKeys({
      documents: [doc({ printedEmails: ["billing@acme.test"] })],
      from: "forwarder@books.test",
      fallbackDescription: null,
      partyId: null,
    });
    expect(keys.sender_party).toEqual(["forwarder@books.test|"]);
  });

  it("takes the first tax id that normalizes", () => {
    const keys = derivePaperKeys({
      documents: [doc({ partyTaxId: "12" }), doc({ contentHash: HASH_B, partyTaxId: "987654321" })],
      from: null,
      fallbackDescription: null,
      partyId: null,
    });
    expect(keys.sender_party).toEqual(["|987654321"]);
  });

  it("gives a document-less paper (an email body) its own description", () => {
    const keys = derivePaperKeys({
      documents: [],
      from: "orders@shop.test",
      fallbackDescription: "Order confirmation for desk chairs",
      partyId: null,
    });
    expect(keys.file_hash).toEqual([]);
    expect(keys.line_text).toEqual([lineTextKey("Order confirmation for desk chairs")]);
  });

  it("has no line_text key for documents that were never described", () => {
    const keys = derivePaperKeys({
      documents: [doc({ description: null })],
      from: null,
      fallbackDescription: "receipt-2026.pdf",
      partyId: null,
    });
    expect(keys.line_text).toEqual([]);
  });

  it("has nothing to offer for an empty paper", () => {
    const keys = derivePaperKeys({
      documents: [],
      from: null,
      fallbackDescription: null,
      partyId: null,
    });
    for (const kind of MEMORY_MATCH_KINDS) expect(scopeKey(keys, kind)).toBeNull();
  });
});

describe("parsePaperKeys", () => {
  it("reads keys a classification event recorded", () => {
    const keys = { file_hash: [HASH_A], sender_party: [], party: [], line_text: ["A B C"] };
    expect(parsePaperKeys(keys)).toEqual(keys);
  });

  it("refuses anything else", () => {
    expect(parsePaperKeys(null)).toBeNull();
    expect(parsePaperKeys({ file_hash: [HASH_A] })).toBeNull();
    expect(
      parsePaperKeys({ file_hash: [1], sender_party: [], party: [], line_text: [] }),
    ).toBeNull();
  });
});

describe("describeMatchKey", () => {
  it("reads naturally", () => {
    expect(describeMatchKey("file_hash", HASH_A)).toBe("File aaaaaaaaaaaa…");
    expect(describeMatchKey("sender_party", "billing@acme.test|123456789000")).toBe(
      "billing@acme.test · tax id 123456789000",
    );
    expect(describeMatchKey("sender_party", "|123456789")).toBe("tax id 123456789");
    expect(describeMatchKey("line_text", "PAPER PRINTER")).toBe("paper printer");
  });
});
