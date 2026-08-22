import { describe, it, expect } from "vitest";
import {
  DatFieldMissingError,
  DatFieldWidthError,
  encodeDat,
  PROVISIONAL_CONFIG,
  transliterate,
  validateLayout,
  type DatLayout,
} from "@/lib/tax/dat-encoder";

const LAYOUT: DatLayout = {
  formCode: "1604C",
  scheduleNumber: 1,
  recordType: "detail",
  fields: [
    { pos: 1, name: "recordType", type: "literal", value: "D1" },
    { pos: 2, name: "tin", type: "text", width: 9 },
    { pos: 3, name: "lastName", type: "text", width: 50 },
    { pos: 4, name: "firstName", type: "text", width: 50 },
    { pos: 5, name: "middleName", type: "text", width: 50 },
    { pos: 6, name: "grossCompensation", type: "numeric", width: 14 },
  ],
};

const record = (over: Record<string, string> = {}) => ({
  tin: "123456789",
  lastName: "SANTOS",
  firstName: "JUAN",
  middleName: "P",
  grossCompensation: "600000.00",
  ...over,
});

describe("transliterate", () => {
  it("maps Ñ to N and reports the change", () => {
    // ñ is common in Filipino names and RMC 5-2014 bans it from alphalist
    // data, so the substitution must be explicit and visible — never
    // incidental.
    expect(transliterate("PEÑA")).toEqual({ value: "PENA", changed: true });
    expect(transliterate("peña")).toEqual({ value: "pena", changed: true });
  });

  it("drops the other banned characters", () => {
    expect(transliterate("A&B").value).toBe("AB");
    expect(transliterate("WHAT?").value).toBe("WHAT");
  });

  it("leaves a clean value untouched", () => {
    expect(transliterate("SANTOS")).toEqual({ value: "SANTOS", changed: false });
  });
});

describe("encodeDat", () => {
  it("emits fields in layout position order, not object order", () => {
    // Records are keyed by NAME precisely so a layout change cannot silently
    // re-map values; the encoder is what imposes the order.
    const { content } = encodeDat(LAYOUT, [record()]);
    // TIN is BARE. Real output quotes name fields only — TIN, branch code, RDO
    // code and ATC all appear unquoted even though Annex A types several of
    // them TEXT.
    expect(content.trimEnd()).toBe('D1,123456789,"SANTOS","JUAN","P",600000.00');
  });

  it("reports every transliteration it performed", () => {
    const { content, transliterations } = encodeDat(LAYOUT, [record({ lastName: "PEÑA" })]);
    expect(content).toContain("PENA");
    expect(transliterations).toEqual([{ field: "lastName", from: "PEÑA", to: "PENA" }]);
  });

  it("refuses to truncate an over-long field", () => {
    // Truncating shifts every field after it — the silent corruption the whole
    // module exists to avoid. Failing loudly is the point.
    expect(() => encodeDat(LAYOUT, [record({ tin: "1234567890123" })])).toThrow(DatFieldWidthError);
  });

  it("refuses a record missing a field the layout declares", () => {
    const incomplete = { ...record() } as Record<string, string>;
    delete incomplete.middleName;
    expect(() => encodeDat(LAYOUT, [incomplete])).toThrow(DatFieldMissingError);
  });

  it("REFUSES a name containing a comma rather than quoting around it", () => {
    // CORRECTED. The original assumption was that quoting solves the embedded
    // comma. Research found it does not: the format has NO escape mechanism —
    // neither observed implementation escapes anything, and BIR's validator
    // rejects commas, apostrophes and periods inside name fields outright
    // ("Invalid character on field Registered Name").
    //
    // So "ACME HOLDINGS, INC." must be SANITISED upstream. Emitting it quoted
    // would produce a file unlike anything that has ever been validated, and
    // silently stripping it here would hide a data problem. Failing is right.
    expect(() => encodeDat(LAYOUT, [record({ lastName: "ACME HOLDINGS, INC." })])).toThrow(
      /no escape mechanism/,
    );

    const clean = encodeDat(LAYOUT, [record({ lastName: "SANTOS" })]);
    expect(clean.content.trimEnd().split(",")).toHaveLength(6);
  });

  it("terminates lines per the configured rule", () => {
    const crlf = encodeDat(LAYOUT, [record()], { ...PROVISIONAL_CONFIG, lineTerminator: "CRLF" });
    expect(crlf.content.endsWith("\r\n")).toBe(true);

    const lf = encodeDat(LAYOUT, [record()], { ...PROVISIONAL_CONFIG, lineTerminator: "LF" });
    expect(lf.content.endsWith("\n")).toBe(true);
    expect(lf.content).not.toContain("\r");
  });

  it("writes an empty field per the configured rule", () => {
    const adjacent = encodeDat(LAYOUT, [record({ middleName: "" })], PROVISIONAL_CONFIG);
    expect(adjacent.content).toContain('"JUAN",,600000.00');

    const quoted = encodeDat(LAYOUT, [record({ middleName: "" })], {
      ...PROVISIONAL_CONFIG,
      emptyField: "empty-quoted",
    });
    expect(quoted.content).toContain('"JUAN","",600000.00');
  });

  it("pads numerics only when configured to", () => {
    const unpadded = encodeDat(LAYOUT, [record({ grossCompensation: "600.00" })]);
    expect(unpadded.content).toContain(",600.00");

    const padded = encodeDat(LAYOUT, [record({ grossCompensation: "600.00" })], {
      ...PROVISIONAL_CONFIG,
      padNumerics: true,
    });
    expect(padded.content).toContain(",00000000600.00");
  });

  it("switches the whole file's shape from ONE config object", () => {
    // The property that makes the spike a one-line change rather than a
    // rewrite: every unresolved fact is in this object and nowhere else.
    const alternate = encodeDat(LAYOUT, [record()], {
      quotedFields: "none",
      lineTerminator: "LF",
      encoding: "ascii",
      emptyField: "adjacent-commas",
      padNumerics: false,
      verified: true,
    });
    expect(alternate.content.trimEnd()).toBe("D1,123456789,SANTOS,JUAN,P,600000.00");
  });

  it("emits nothing for no records rather than a stray terminator", () => {
    expect(encodeDat(LAYOUT, []).content).toBe("");
  });
});

describe("the provisional config", () => {
  it("is marked unverified until the spike runs", () => {
    // Guards against the config being quietly blessed. Flipping `verified`
    // should require having actually read the module's output.
    expect(PROVISIONAL_CONFIG.verified).toBe(false);
  });

  it("quotes NAME fields only — not every text field", () => {
    // CORRECTED after research found real bytes. The earlier value ("quote
    // every TEXT field") was contradicted by two independent primary sources:
    // a module-produced file and a shipped third-party generator both emit TIN,
    // branch code, RDO code and ATC BARE, and Annex A types several of those as
    // TEXT. Quoting them is not a "safe direction" — it is simply not what real
    // files look like.
    expect(PROVISIONAL_CONFIG.quotedFields).toBe("name-fields-only");
  });
});

describe("validateLayout", () => {
  it("accepts contiguous 1..n positions", () => {
    expect(validateLayout(LAYOUT)).toEqual([]);
  });

  it("rejects a gap in the positions", () => {
    const gapped: DatLayout = {
      ...LAYOUT,
      fields: [
        { pos: 1, name: "a", type: "text" },
        { pos: 3, name: "b", type: "text" },
      ],
    };
    expect(validateLayout(gapped)).not.toEqual([]);
  });

  it("rejects duplicate field names", () => {
    const duplicated: DatLayout = {
      ...LAYOUT,
      fields: [
        { pos: 1, name: "a", type: "text" },
        { pos: 2, name: "a", type: "text" },
      ],
    };
    expect(validateLayout(duplicated).join(" ")).toMatch(/duplicate field names/);
  });
});
