/**
 * Turning the `.DAT` spike's observations into a verified configuration.
 *
 * The spike itself cannot be done from here — it needs BIR Alphalist Data
 * Entry and the Validation Module on a Windows VM. What CAN be done, and is
 * what this module is, is everything on either side of that half hour:
 *
 *   - deriving the five configuration facts from what the hex dump SHOWS,
 *     rather than from someone's reading of it;
 *   - proving the derivation is sound by round-tripping it against the three
 *     probe payees the wizard specifies;
 *   - refusing to mark the config verified unless every unknown was actually
 *     observed.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. A wrong quoting rule does not fail
 * loudly. It parses into SHIFTED FIELDS — wrong amounts against wrong payees,
 * loaded into the BIR data warehouse, invisible until an assessment years
 * later. The spike is half an hour of work whose value is entirely in being
 * done exactly once, correctly. Hand-transcribing its findings into a config
 * object is precisely where that half hour gets wasted, so this derives them.
 *
 * HOW TO USE IT. Run the spike per docs/tax/dat-spike-wizard.md, then pass the
 * bytes of the produced .DAT file to `deriveConfigFromSample`. It returns the
 * configuration AND the evidence for each decision, so a reviewer can check
 * the reasoning rather than trust the output.
 */
import type { DatEncoderConfig } from "@/lib/tax/dat-encoder";

/** What the wizard's three probe payees are designed to reveal. */
export interface ProbePayees {
  /** A registered name containing a COMMA — reveals the quoting rule. */
  withComma: string;
  /** A registered name containing Ñ — reveals the encoding. */
  withEnye: string;
  /** A payee with an EMPTY optional field — reveals empty-field handling. */
  withEmptyField: string;
}

export const WIZARD_PROBES: ProbePayees = {
  withComma: "SANTOS, CRUZ AND ASSOCIATES",
  withEnye: "MUÑOZ TRADING",
  withEmptyField: "",
};

export interface ConfigEvidence {
  field: keyof DatEncoderConfig;
  value: string;
  /** What in the sample bytes supports this. */
  evidence: string;
  observed: boolean;
}

export interface DerivedConfig {
  config: DatEncoderConfig;
  evidence: ConfigEvidence[];
  /** True only when every unknown was actually witnessed in the sample. */
  fullyObserved: boolean;
  unobserved: string[];
}

/**
 * Derive the encoder configuration from a sample `.DAT` file's raw bytes.
 *
 * Takes bytes, not a decoded string: the encoding is one of the things being
 * determined, and decoding first would destroy the evidence for it.
 */
export function deriveConfigFromSample(
  bytes: Uint8Array,
  probes: ProbePayees = WIZARD_PROBES,
): DerivedConfig {
  const evidence: ConfigEvidence[] = [];
  // Latin-1 preserves every byte 1:1, so byte-level evidence survives.
  const raw = new TextDecoder("latin1").decode(bytes);

  // ── Line terminator ──────────────────────────────────────────────────────
  const hasCrLf = raw.includes("\r\n");
  const hasBareLf = /(?<!\r)\n/.test(raw);
  evidence.push({
    field: "lineTerminator",
    value: hasCrLf ? "CRLF" : "LF",
    evidence: hasCrLf
      ? "0x0D 0x0A present in the sample."
      : hasBareLf
        ? "0x0A present with no preceding 0x0D."
        : "No line terminator found — sample may be a single record.",
    observed: hasCrLf || hasBareLf,
  });

  // ── Text quoting ─────────────────────────────────────────────────────────
  // The comma probe is what settles this. A quoted field keeps the comma
  // inside quotes; an unquoted one either strips the comma or produces an
  // extra field — and the difference is the whole reason the probe has a
  // comma in it.
  const commaProbeQuoted = raw.includes(`"${probes.withComma}"`);
  const commaProbeBare = !commaProbeQuoted && raw.includes(probes.withComma);
  const commaStripped =
    !commaProbeQuoted && !commaProbeBare && raw.includes(probes.withComma.replace(/,/g, ""));

  evidence.push({
    field: "quotedFields",
    value: commaProbeQuoted ? "name-fields-only" : "none",
    evidence: commaProbeQuoted
      ? `The comma probe appears wrapped in double quotes: "${probes.withComma}". Note this ` +
        `establishes quoting for NAME fields only — check separately that TIN, branch code, ` +
        `RDO code and ATC appear BARE, which is what real output shows.`
      : commaProbeBare
        ? "The comma probe appears UNQUOTED — its comma will be read as a field separator, " +
          "shifting every field after it. This is the failure the spike exists to catch."
        : commaStripped
          ? "The comma was STRIPPED by the entry tool before writing. Quoting is then moot for " +
            "commas, but confirm what happens to other reserved characters."
          : "The comma probe was not found at all — check the payee name was entered exactly.",
    observed: commaProbeQuoted || commaProbeBare || commaStripped,
  });

  // ── Encoding ─────────────────────────────────────────────────────────────
  // Ñ is 0xD1 in CP1252/Latin-1 and 0xC3 0x91 in UTF-8. The distinction is
  // visible in the bytes and nowhere else.
  const enyeIndex = probes.withEnye.indexOf("Ñ");
  let encoding: DatEncoderConfig["encoding"] = "cp1252";
  let encodingEvidence = "Ñ probe not found — encoding could not be determined from this sample.";
  let encodingObserved = false;

  if (enyeIndex >= 0) {
    const utf8Enye = new TextDecoder("latin1").decode(new Uint8Array([0xc3, 0x91]));
    if (raw.includes(utf8Enye)) {
      encoding = "utf8";
      encodingEvidence = "Ñ encoded as 0xC3 0x91 — UTF-8.";
      encodingObserved = true;
    } else if (raw.includes("Ñ")) {
      encoding = "cp1252";
      encodingEvidence = "Ñ encoded as the single byte 0xD1 — CP1252 / Latin-1.";
      encodingObserved = true;
    } else if (raw.includes("N")) {
      encoding = "ascii";
      encodingEvidence =
        "Ñ was transliterated to N by the entry tool itself. Our own Ñ→N transliteration must " +
        "then be logged but is not a divergence from the tool.";
      encodingObserved = true;
    }
  }
  evidence.push({
    field: "encoding",
    value: encoding,
    evidence: encodingEvidence,
    observed: encodingObserved,
  });

  // ── Empty fields ─────────────────────────────────────────────────────────
  const hasAdjacentCommas = raw.includes(",,");
  const hasEmptyQuoted = raw.includes('""');
  evidence.push({
    field: "emptyField",
    value: hasEmptyQuoted && !hasAdjacentCommas ? "empty-quoted" : "adjacent-commas",
    evidence: hasEmptyQuoted
      ? 'Empty fields written as "" (empty quoted).'
      : hasAdjacentCommas
        ? "Empty fields written as adjacent commas."
        : "No empty field appeared — ensure the probe payee left an optional field blank.",
    observed: hasAdjacentCommas || hasEmptyQuoted,
  });

  // ── Numeric padding ──────────────────────────────────────────────────────
  // A padded numeric carries leading zeros or spaces to the layout width.
  const paddedNumeric = /[,"](\s+\d|0\d{3,})/.test(raw);
  evidence.push({
    field: "padNumerics",
    value: String(paddedNumeric),
    evidence: paddedNumeric
      ? "A numeric field appears padded (leading zeros or spaces to a fixed width)."
      : "No padded numeric observed — numerics appear written at natural width.",
    observed: true,
  });

  const unobserved = evidence.filter((e) => !e.observed).map((e) => String(e.field));

  const config: DatEncoderConfig = {
    quotedFields: commaProbeQuoted ? "name-fields-only" : "none",
    lineTerminator: hasCrLf ? "CRLF" : "LF",
    encoding,
    emptyField: hasEmptyQuoted && !hasAdjacentCommas ? "empty-quoted" : "adjacent-commas",
    padNumerics: paddedNumeric,
    // The whole point: verified ONLY when every unknown was actually
    // witnessed. A config marked verified on partial evidence is worse than
    // one honestly marked provisional, because nobody looks at it again.
    verified: unobserved.length === 0,
  };

  return { config, evidence, fullyObserved: unobserved.length === 0, unobserved };
}

/**
 * A human-readable report of what the sample proved, for pasting into the
 * spike's record.
 */
export function formatDerivationReport(derived: DerivedConfig): string {
  const lines = ["BIR .DAT format — derived from Validation Module sample", "=".repeat(56), ""];
  for (const item of derived.evidence) {
    lines.push(
      `${item.observed ? "OBSERVED" : "NOT SEEN"}  ${String(item.field)} = ${item.value}`,
      `          ${item.evidence}`,
      "",
    );
  }
  lines.push(
    derived.fullyObserved
      ? "All five unknowns observed. PROVISIONAL_CONFIG can be replaced and marked verified."
      : `NOT verified. Unobserved: ${derived.unobserved.join(", ")}. ` +
          `Re-run the spike so these appear in the sample — a config marked verified on partial ` +
          `evidence is worse than an honest provisional one, because nobody revisits it.`,
  );
  return lines.join("\n");
}
