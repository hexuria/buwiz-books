import { describe, expect, it } from "vitest";
import {
  deriveConfigFromSample,
  formatDerivationReport,
  WIZARD_PROBES,
} from "@/lib/tax/dat-spike-verification";

/**
 * The spike itself needs a Windows VM and cannot be run from here. What can be
 * built is everything either side of it — so that when the half hour IS spent,
 * its findings are derived from the bytes rather than hand-transcribed.
 *
 * A wrong quoting rule does not fail loudly. It parses into SHIFTED FIELDS —
 * wrong amounts against wrong payees, invisible until an assessment.
 */
function sample(text: string, encoding: "latin1" | "utf8" = "latin1"): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(text);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

describe("deriveConfigFromSample", () => {
  it("detects quoted text fields from the comma probe", () => {
    const derived = deriveConfigFromSample(sample(`"H","${WIZARD_PROBES.withComma}","123"\r\n`));
    expect(derived.config.quotedFields).toBe("name-fields-only");
    expect(derived.evidence.find((e) => e.field === "quotedFields")?.evidence).toMatch(
      /wrapped in double quotes/,
    );
  });

  it("detects UNQUOTED fields and names the consequence", () => {
    // This is the failure the whole spike exists to catch: the comma is read
    // as a separator and every field after it shifts.
    const derived = deriveConfigFromSample(sample(`H,${WIZARD_PROBES.withComma},123\r\n`));
    expect(derived.config.quotedFields).toBe("none");
    expect(derived.evidence.find((e) => e.field === "quotedFields")?.evidence).toMatch(
      /shifting every field after it/,
    );
  });

  it("recognises when the entry tool stripped the comma itself", () => {
    const stripped = WIZARD_PROBES.withComma.replace(/,/g, "");
    const derived = deriveConfigFromSample(sample(`H,${stripped},123\r\n`));
    expect(derived.evidence.find((e) => e.field === "quotedFields")?.evidence).toMatch(
      /STRIPPED by the entry tool/,
    );
  });

  describe("encoding, from the Ñ probe", () => {
    it("identifies CP1252 from the single byte 0xD1", () => {
      const derived = deriveConfigFromSample(sample(`"${WIZARD_PROBES.withEnye}"\r\n`));
      expect(derived.config.encoding).toBe("cp1252");
      expect(derived.evidence.find((e) => e.field === "encoding")?.evidence).toMatch(/0xD1/);
    });

    it("identifies UTF-8 from the two-byte sequence", () => {
      const derived = deriveConfigFromSample(sample(`"${WIZARD_PROBES.withEnye}"\r\n`, "utf8"));
      expect(derived.config.encoding).toBe("utf8");
      expect(derived.evidence.find((e) => e.field === "encoding")?.evidence).toMatch(/0xC3 0x91/);
    });

    it("notices the tool transliterating Ñ to N by itself", () => {
      // If the BIR tool does it too, our transliteration is not a divergence.
      const derived = deriveConfigFromSample(sample(`"MUNOZ TRADING"\r\n`));
      expect(derived.config.encoding).toBe("ascii");
      expect(derived.evidence.find((e) => e.field === "encoding")?.evidence).toMatch(
        /transliterated to N by the entry tool/,
      );
    });
  });

  it("detects the line terminator", () => {
    // The config names the convention ("CRLF"/"LF") rather than carrying the
    // literal bytes — the encoder is what turns the name into bytes.
    expect(deriveConfigFromSample(sample("a,b\r\n")).config.lineTerminator).toBe("CRLF");
    expect(deriveConfigFromSample(sample("a,b\n")).config.lineTerminator).toBe("LF");
  });

  it("distinguishes empty-quoted from adjacent commas", () => {
    expect(deriveConfigFromSample(sample('"a","","b"\r\n')).config.emptyField).toBe("empty-quoted");
    expect(deriveConfigFromSample(sample("a,,b\r\n")).config.emptyField).toBe("adjacent-commas");
  });

  describe("the honesty gate", () => {
    it("refuses to mark a config verified on partial evidence", () => {
      // A config marked verified on partial evidence is WORSE than an honest
      // provisional one, because nobody revisits it.
      const derived = deriveConfigFromSample(sample("a,b\r\n"));
      expect(derived.config.verified).toBe(false);
      expect(derived.fullyObserved).toBe(false);
      expect(derived.unobserved.length).toBeGreaterThan(0);
    });

    it("marks verified only when every unknown was witnessed", () => {
      // All five probes present: comma quoted, Ñ, an empty field, CRLF.
      const complete = `"H","${WIZARD_PROBES.withComma}","",'"\r\n"${WIZARD_PROBES.withEnye}","x",""\r\n`;
      const derived = deriveConfigFromSample(sample(complete));
      expect(derived.unobserved).toEqual([]);
      expect(derived.config.verified).toBe(true);
    });

    it("names exactly which unknowns were not seen", () => {
      const derived = deriveConfigFromSample(sample("a,b\r\n"));
      // The comma probe and the Ñ probe are both absent from this sample.
      expect(derived.unobserved).toContain("quotedFields");
      expect(derived.unobserved).toContain("encoding");
      // The terminator WAS visible, so it must not be listed.
      expect(derived.unobserved).not.toContain("lineTerminator");
    });
  });

  it("takes bytes rather than a string", () => {
    // Decoding first would destroy the very evidence that determines the
    // encoding.
    const utf8 = deriveConfigFromSample(sample(`"${WIZARD_PROBES.withEnye}"\r\n`, "utf8"));
    const latin1 = deriveConfigFromSample(sample(`"${WIZARD_PROBES.withEnye}"\r\n`));
    expect(utf8.config.encoding).not.toBe(latin1.config.encoding);
  });
});

describe("formatDerivationReport", () => {
  it("shows the evidence for every decision, not just the answer", () => {
    // A reviewer should be able to check the reasoning rather than trust the
    // output.
    const report = formatDerivationReport(
      deriveConfigFromSample(sample(`"${WIZARD_PROBES.withComma}"\r\n`)),
    );
    expect(report).toMatch(/quotedFields/);
    expect(report).toMatch(/OBSERVED|NOT SEEN/);
  });

  it("says plainly when the config cannot be marked verified", () => {
    const report = formatDerivationReport(deriveConfigFromSample(sample("a,b\r\n")));
    expect(report).toMatch(/NOT verified/);
    expect(report).toMatch(/nobody revisits it/);
  });
});
