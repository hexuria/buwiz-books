// ============================================================================
// Classification memory match keys (Inbox v2 §7). Pure.
//
// A memory is stored under ONE key, normalized here at write time; a paper
// produces the keys it can be found by, normalized by the same functions. A
// lookup is then an exact index probe on (organization, kind, key) — nothing
// is fuzzy, so the same paper always finds the same memory.
//
//   file_hash    sha256 of the source document bytes (documents.content_hash,
//                written by ensureDocument). A paper may carry several files.
//   sender_party normalized sender email + normalized printed party tax id.
//                The sender is the email's From address; a paper that did not
//                arrive by email falls back to the party email printed on it.
//   party        the matched party id.
//   line_text    the paper's extracted description, run through the vendor
//                alias normalizer (src/lib/match-assist/normalize.ts), then
//                deduplicated and sorted, so word order and per-paper noise
//                (dates, long numbers, card words) do not split one key.
//
// Descriptions come only from what the extraction read off the paper. The
// filename and the generic "Inbound email attachment" fallbacks are never a
// line_text key: every paper without a description would share one.
// ============================================================================

import { createHash } from "node:crypto";
import { normalizeDescriptor } from "@/lib/match-assist/normalize";
import { extractEmailAddress, normalizeTaxId } from "@/lib/party-match/normalize";

/** Most specific first. The order IS the lookup policy. */
export const MEMORY_MATCH_KINDS = ["file_hash", "sender_party", "party", "line_text"] as const;

export type MemoryMatchKind = (typeof MEMORY_MATCH_KINDS)[number];

/** match_key is varchar(255). */
export const MATCH_KEY_MAX_CHARS = 255;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A line_text key needs at least this many letters or digits to mean anything. */
const MIN_LINE_TEXT_CHARS = 3;

export function isMemoryMatchKind(value: unknown): value is MemoryMatchKind {
  return typeof value === "string" && (MEMORY_MATCH_KINDS as readonly string[]).includes(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Keys longer than the column are stored as their digest; equal inputs still collide. */
function boundedKey(key: string): string {
  return key.length <= MATCH_KEY_MAX_CHARS ? key : `sha256:${sha256Hex(key)}`;
}

/** A document content hash, or null when it is not a sha256 hex digest. */
export function fileHashKey(contentHash: string | null | undefined): string | null {
  const normalized = contentHash?.trim().toLowerCase() ?? "";
  return SHA256_HEX.test(normalized) ? normalized : null;
}

/**
 * `<email>|<tax id>`, either side empty when absent, or null when both are.
 * The email is lower-cased and pulled out of `"Name" <address>`; the tax id
 * keeps letters and digits only (party-match normalizeTaxId).
 */
export function senderPartyKey(input: {
  senderEmail?: string | null;
  partyTaxId?: string | null;
}): string | null {
  const email = extractEmailAddress(input.senderEmail);
  const taxId = normalizeTaxId(input.partyTaxId);
  if (!email && !taxId) return null;
  return boundedKey(`${email ?? ""}|${taxId ?? ""}`);
}

/** A party id, lower-cased, or null when it is not a uuid. */
export function partyKey(partyId: string | null | undefined): string | null {
  const normalized = partyId?.trim().toLowerCase() ?? "";
  return UUID.test(normalized) ? normalized : null;
}

/** The description's alias-normalized tokens, deduplicated and sorted, or null. */
export function lineTextKey(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const tokens = [
    ...new Set(
      normalizeDescriptor(text)
        .split(" ")
        .filter((token) => token.length >= 2),
    ),
  ].sort();
  const key = tokens.join(" ");
  if (key.replace(/[^A-Z0-9]/gu, "").length < MIN_LINE_TEXT_CHARS) return null;
  return boundedKey(key);
}

/** What the extraction read off one document, as the key functions need it. */
export interface PaperDocumentFacts {
  contentHash: string | null;
  description: string | null;
  partyTaxId: string | null;
  printedEmails: readonly string[];
}

/**
 * The raw extraction fields one document contributes. Read either from the
 * document row's metadata (documentExtractionFromRow) or selected straight
 * out of the JSON in SQL for a batch — both end in paperDocumentFacts, so
 * the precedence lives in exactly one place.
 */
export interface PaperDocumentExtraction {
  contentHash: string | null;
  inboxDescription: string | null;
  transactionMemo: string | null;
  billNotes: string | null;
  inboxPartyTaxId: string | null;
  inboxPartyEmail: string | null;
  billVendorEmail: string | null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Precedence mirrors deriveDocumentSourceFacts: the inbox extraction, then the
 * transaction parse cache, then the bill OCR's notes — minus the filename.
 */
export function paperDocumentFacts(extraction: PaperDocumentExtraction): PaperDocumentFacts {
  return {
    contentHash: extraction.contentHash,
    description:
      text(extraction.inboxDescription) ??
      text(extraction.transactionMemo) ??
      text(extraction.billNotes),
    partyTaxId: text(extraction.inboxPartyTaxId),
    printedEmails: [text(extraction.inboxPartyEmail), text(extraction.billVendorEmail)].filter(
      (email): email is string => email !== null,
    ),
  };
}

/** The extraction fields of a loaded document row. */
export function documentExtractionFromRow(row: {
  contentHash?: string | null;
  metadata: unknown;
  aiTransactionCache: unknown;
}): PaperDocumentExtraction {
  const metadata = record(row.metadata);
  const inbox = record(record(metadata?.inboxExtraction)?.result);
  const bill = record(record(metadata?.billOcr)?.result);
  const parsed = record(record(row.aiTransactionCache)?.result);
  return {
    contentHash: row.contentHash ?? null,
    inboxDescription: text(inbox?.description),
    transactionMemo: text(parsed?.memo),
    billNotes: text(record(bill?.invoice)?.notes),
    inboxPartyTaxId: text(inbox?.partyTaxId),
    inboxPartyEmail: text(inbox?.partyEmail),
    billVendorEmail: text(record(bill?.vendor)?.email),
  };
}

export interface PaperKeyInput {
  /** The paper's documents, primary first. */
  documents: readonly PaperDocumentFacts[];
  /** The From header of the email the paper arrived in, if it did. */
  from: string | null;
  /** A document-less paper's description (an email body's). Ignored when documents exist. */
  fallbackDescription: string | null;
  /** The paper's party, when one is known without a model. */
  partyId: string | null;
}

export type PaperKeys = Record<MemoryMatchKind, string[]>;

export function emptyPaperKeys(): PaperKeys {
  return { file_hash: [], sender_party: [], party: [], line_text: [] };
}

/** Every key this paper can be found by, per kind. */
export function derivePaperKeys(input: PaperKeyInput): PaperKeys {
  const fileHashes = [
    ...new Set(
      input.documents
        .map((document) => fileHashKey(document.contentHash))
        .filter((hash): hash is string => hash !== null),
    ),
  ];
  const printedEmail =
    input.documents
      .flatMap((document) => document.printedEmails)
      .map((email) => extractEmailAddress(email))
      .find((email): email is string => email !== null) ?? null;
  const senderEmail = extractEmailAddress(input.from) ?? printedEmail;
  const partyTaxId =
    input.documents
      .map((document) => document.partyTaxId)
      .find((taxId) => normalizeTaxId(taxId) !== null) ?? null;
  const sender = senderPartyKey({ senderEmail, partyTaxId });
  const party = partyKey(input.partyId);
  const description =
    input.documents.length > 0
      ? (input.documents.map((document) => text(document.description)).find(Boolean) ?? null)
      : text(input.fallbackDescription);
  const line = lineTextKey(description);
  return {
    file_hash: fileHashes,
    sender_party: sender ? [sender] : [],
    party: party ? [party] : [],
    line_text: line ? [line] : [],
  };
}

/** Keys recorded on a classification event, when the value has the right shape. */
export function parsePaperKeys(value: unknown): PaperKeys | null {
  const candidate = record(value);
  if (!candidate) return null;
  const keys = emptyPaperKeys();
  for (const kind of MEMORY_MATCH_KINDS) {
    const list = candidate[kind];
    if (!Array.isArray(list) || !list.every((key) => typeof key === "string")) return null;
    keys[kind] = [...(list as string[])];
  }
  return keys;
}

/**
 * The key a memory saved at `kind` scope gets from this paper: the first
 * (primary) one. Null when the paper has nothing to be remembered by.
 */
export function scopeKey(keys: PaperKeys, kind: MemoryMatchKind): string | null {
  return keys[kind][0] ?? null;
}

/** A short, human-readable form of a key for lists and prompts. */
export function describeMatchKey(kind: MemoryMatchKind, key: string): string {
  if (key.startsWith("sha256:") && kind !== "file_hash") return "Long key (stored as a digest)";
  if (kind === "file_hash") return `File ${key.slice(0, 12)}…`;
  if (kind === "sender_party") {
    const [email, taxId] = key.split("|");
    return [email || null, taxId ? `tax id ${taxId}` : null].filter(Boolean).join(" · ");
  }
  if (kind === "line_text") return key.toLowerCase();
  return key;
}

/** Digest of a key for records that should not repeat it (eval cases). */
export function matchKeyDigest(key: string): string {
  return sha256Hex(key);
}
