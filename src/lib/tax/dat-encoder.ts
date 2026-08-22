/**
 * BIR `.DAT` alphalist encoder.
 *
 * The highest-leverage deliverable in the project: the `.DAT` is the artifact a
 * bookkeeper cannot produce by hand, and it is what the BIR's Alphalist Data
 * Entry and Validation Module ingests.
 *
 * ── FIVE FACTS ARE STILL UNKNOWN, AND THEY ARE ISOLATED HERE ─────────────────
 * RMC 5-2014 establishes the file is "CSV data file format" and stops. Nobody
 * publishes whether text fields are quoted, what the line terminator is, how
 * empty fields are written, the encoding, or whether numerics are padded. They
 * are answerable only by running the module and reading its output — the spike
 * in docs/tax/dat-spike-wizard.md.
 *
 * So every one of them lives in `DatEncoderConfig` and nowhere else. When the
 * spike returns, the answer is a change to ONE object literal, not a rewrite.
 * `PROVISIONAL_CONFIG` below encodes the most likely reading and is marked so
 * it cannot be mistaken for a verified one.
 *
 * WHY THE UNKNOWNS MATTER: a wrong quoting rule does not fail loudly. A
 * registered name containing a comma — "ACME HOLDINGS, INC." — splits into two
 * fields and shifts every field after it, loading wrong amounts against wrong
 * payees into the BIR data warehouse. Invisible until an assessment.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LAYOUTS ARE DECLARATIVE. Field ORDER differs between 1601-EQ and 1601-FQ for
 * identically-named fields, and schedule numbers are global across the 1604
 * family — so a per-form hand-written serializer would encode those differences
 * as code that looks right and is wrong. A layout is an ordered table of field
 * descriptors, and the encoder is one function over it.
 */

/**
 * Field names that real `.DAT` output wraps in double quotes.
 *
 * An ENUMERATION, not a type rule, and that is deliberate. Both obvious
 * generalisations are falsified by observed bytes: "quote every TEXT field"
 * fails because TIN, BRANCH_CODE and RDO_CODE are typed TEXT in RMC 7-2021
 * Annex A and appear BARE; "quote every X(n)-pictured field" fails because ATC
 * is pictured X(5) and also appears bare.
 *
 * So the rule is these names and nothing else. A field not on this list that
 * has never been seen in real output is a guess, which is why extending the
 * list should demand the same evidence that built it.
 */
export const QUOTED_NAME_FIELDS: ReadonlySet<string> = new Set([
  "registeredNameWa",
  "registeredNamePayee",
  "lastName",
  "lastNamePayee",
  "firstName",
  "firstNamePayee",
  "middleName",
  "middleNamePayee",
]);

/** The five facts the Stage 0.5 spike resolves. */
export interface DatEncoderConfig {
  /**
   * Which fields are wrapped in double quotes.
   *
   * `name-fields-only` is what the evidence supports. `all-text` exists only so
   * the contradicted reading stays expressible and testable — it is not a
   * supported choice.
   */
  quotedFields: "name-fields-only" | "all-text" | "none";
  lineTerminator: "CRLF" | "LF";
  /**
   * Retained as a LABEL. Output is asserted 7-bit ASCII, and cp1252, ASCII,
   * UTF-8 and CP850 are byte-identical over [\x20-\x7E] — so this setting is
   * unobservable by construction and cannot silently be wrong. See
   * `assertAsciiOnly`.
   */
  encoding: "cp1252" | "ascii" | "utf8";
  /** How an omitted optional field is written. */
  emptyField: "adjacent-commas" | "empty-quoted";
  /** Whether numerics are padded to the layout's stated width. */
  padNumerics: boolean;
  /** Set once a human has run the spike and read real output. */
  verified: boolean;
}

/**
 * The reading the evidence supports, and explicitly NOT a verified one.
 *
 * REVISED after a research sweep found real bytes. The previous value
 * (`quoteTextFields: true`, meaning every TEXT field) was contradicted by two
 * independent primary sources — a Notepad capture of a module-produced file and
 * a shipped third-party generator — which agree that only name fields carry
 * quotes. Quoting a TIN or an ATC is not the "safe direction" it was assumed to
 * be; it is simply not what real files look like.
 *
 * Remaining confidence, from that sweep:
 *   quotedFields    ~90%  two independent primary sources agree
 *   padNumerics     ~88%  two independent primary sources agree
 *   lineTerminator  ~85%  consistent from several weak angles, contradicted by none
 *   emptyField      ~70%  DISPUTED — the two sources actively disagree
 *   encoding          —   no evidence; made moot by the ASCII assertion instead
 */
export const PROVISIONAL_CONFIG: DatEncoderConfig = {
  quotedFields: "name-fields-only",
  lineTerminator: "CRLF",
  encoding: "cp1252",
  // The one value the sources actively disagree on. Isolated here so flipping
  // it is a one-line change when the spike settles it.
  emptyField: "adjacent-commas",
  padNumerics: false,
  verified: false,
};

/**
 * Reject any non-ASCII byte before it reaches a file.
 *
 * THE FORMAT HAS NO ESCAPE MECHANISM. Neither observed implementation doubles
 * or escapes an embedded quote or comma — both DELETE the offending character,
 * and BIR's validator rejects commas, apostrophes and periods inside name
 * fields outright ("Invalid character on field Registered Name"). So a name
 * like `DELA CRUZ, JR.` must be SANITISED upstream, never quoted around.
 *
 * That makes this a hard boundary rather than a nicety: anything that reaches
 * the encoder still carrying a reserved or non-ASCII character is a defect in
 * the pre-flight, and failing here is how it gets found before submission
 * rather than after.
 */
export function assertAsciiOnly(value: string, fieldName: string): void {
  const offending = [...value].find((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e);
  if (offending !== undefined) {
    throw new Error(
      `Field ${fieldName} contains a non-ASCII character ${JSON.stringify(offending)} ` +
        `(U+${offending.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}). ` +
        `The .DAT format has no escape mechanism and the BIR validator rejects such ` +
        `characters — sanitise upstream (Ñ→N and strip) rather than encoding it here.`,
    );
  }
}

export type DatFieldType = "text" | "numeric" | "date" | "literal";

export interface DatField {
  /** 1-based position, matching the published layout tables. */
  pos: number;
  name: string;
  type: DatFieldType;
  /** Maximum characters. Enforced — an over-long field shifts the record. */
  width?: number;
  /** For `literal` fields: the fixed value, such as a record-type marker. */
  value?: string;
}

export interface DatLayout {
  formCode: string;
  /** Schedule number, which is global across a form family rather than per-form. */
  scheduleNumber: number;
  recordType: "header" | "control" | "detail";
  fields: readonly DatField[];
}

export class DatFieldWidthError extends Error {
  constructor(field: string, value: string, width: number) {
    super(
      `field "${field}" is ${value.length} characters but the layout allows ${width} — ` +
        `truncating would shift every field after it, so this is refused`,
    );
    this.name = "DatFieldWidthError";
  }
}

export class DatFieldMissingError extends Error {
  constructor(field: string) {
    super(`layout declares field "${field}" but the record does not supply it`);
    this.name = "DatFieldMissingError";
  }
}

/**
 * Characters RMC 5-2014 bans from alphalist data.
 *
 * `ñ` is the one that matters: it is common in Filipino names, so the
 * transliteration must be explicit and logged rather than incidental.
 */
const BANNED = /[ñÑ*?&]/;

export interface TransliterationEvent {
  field: string;
  from: string;
  to: string;
}

/** Ñ → N, ñ → n, and the other banned characters dropped. */
export function transliterate(value: string): { value: string; changed: boolean } {
  if (!BANNED.test(value)) return { value, changed: false };
  const out = value.replace(/ñ/g, "n").replace(/Ñ/g, "N").replace(/[*?&]/g, "");
  return { value: out, changed: true };
}

export interface EncodeResult {
  content: string;
  /** Every Ñ→N substitution, so the change is visible rather than incidental. */
  transliterations: TransliterationEvent[];
}

function encodeField(
  field: DatField,
  raw: string | undefined,
  config: DatEncoderConfig,
  events: TransliterationEvent[],
): string {
  if (field.type === "literal") return field.value ?? "";

  if (raw === undefined || raw === null) {
    throw new DatFieldMissingError(field.name);
  }

  let value = raw;

  if (field.type === "text") {
    const t = transliterate(value);
    if (t.changed) events.push({ field: field.name, from: value, to: t.value });
    value = t.value;
  }

  if (field.width != null && value.length > field.width) {
    // Truncation would shift every subsequent field, which is the silent
    // corruption this whole module is built to avoid.
    throw new DatFieldWidthError(field.name, value, field.width);
  }

  if (field.type === "numeric" && config.padNumerics && field.width != null) {
    value = value.padStart(field.width, "0");
  }

  if (value === "") {
    return config.emptyField === "empty-quoted" ? '""' : "";
  }

  const shouldQuote =
    config.quotedFields === "all-text"
      ? field.type === "text"
      : config.quotedFields === "name-fields-only" && QUOTED_NAME_FIELDS.has(field.name);

  if (shouldQuote) {
    // NO ESCAPING. The previous implementation doubled an embedded quote the
    // CSV way, which is invented behaviour: neither observed implementation
    // escapes anything, and the BIR validator rejects reserved characters in
    // name fields rather than accepting an escaped form. Emitting `""` here
    // would produce a file unlike anything that has ever been validated, so a
    // reserved character is a hard failure instead.
    if (value.includes('"') || value.includes(",")) {
      throw new Error(
        `Field ${field.name} contains ${value.includes('"') ? "a double quote" : "a comma"}, ` +
          `which this format cannot represent — it has no escape mechanism and the BIR ` +
          `validator rejects the character outright. Sanitise upstream.`,
      );
    }
    return `"${value}"`;
  }

  return value;
}

/**
 * Encode records against a layout.
 *
 * Records are keyed by field NAME, not position — a positional API would make a
 * layout change silently re-map every value.
 */
export function encodeDat(
  layout: DatLayout,
  records: ReadonlyArray<Record<string, string>>,
  config: DatEncoderConfig = PROVISIONAL_CONFIG,
): EncodeResult {
  const ordered = [...layout.fields].sort((a, b) => a.pos - b.pos);
  const events: TransliterationEvent[] = [];
  const terminator = config.lineTerminator === "CRLF" ? "\r\n" : "\n";

  const lines = records.map((record) =>
    ordered.map((field) => encodeField(field, record[field.name], config, events)).join(","),
  );

  return {
    // A trailing terminator: line-oriented readers generally expect a final
    // newline, and its presence is one of the things the spike confirms.
    content: lines.join(terminator) + (lines.length > 0 ? terminator : ""),
    transliterations: events,
  };
}

/** Positions must be 1..n with no gaps and no duplicates. */
export function validateLayout(layout: DatLayout): string[] {
  const problems: string[] = [];
  const positions = layout.fields.map((f) => f.pos).sort((a, b) => a - b);
  positions.forEach((pos, index) => {
    if (pos !== index + 1) {
      problems.push(
        `${layout.formCode} schedule ${layout.scheduleNumber}: positions must run 1..n with no ` +
          `gaps; found ${pos} at index ${index}`,
      );
    }
  });
  const names = layout.fields.map((f) => f.name);
  if (new Set(names).size !== names.length) {
    problems.push(`${layout.formCode} schedule ${layout.scheduleNumber}: duplicate field names`);
  }
  return problems;
}
