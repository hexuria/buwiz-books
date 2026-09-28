// ============================================================================
// Did an inbound email come from who it says it did? (Inbox v2 §8, step 11)
//
// Jev approves an emailed paper on its own only when the message passed
// sender authentication at the server that received it, and its From is one
// the paper's party already uses. Resend's `email.received` webhook carries no
// verdict at all, and its parsed `headers` map keeps one value per name, so it
// cannot say which of several Authentication-Results headers came first. The
// email job therefore reads the message's original header section (Resend's
// raw download), and this module decides once, at ingest. The verdict is
// stored on the email's source record (`raw_data.senderAuthentication`) and
// judged again for each paper by the Jev approval loader
// (./jev-approval/sender.ts).
//
// WHICH HEADER IS BELIEVED. A sender can write any header it likes, including
// an `Authentication-Results: …; dmarc=pass` of its own. The receiving server
// prepends its trace headers, so its verdict is the TOPMOST
// Authentication-Results; everything below it came from upstream, the sender
// included. Only the topmost one is read, and only when its authserv-id is
// the receiving server's (TRUSTED_AUTHSERV_IDS). That is sound only while the
// receiving server stamps EVERY message: one it let through unstamped would
// leave a forged header on top.
//
// PASSED means one of these, judged against the message's single From header:
//   dmarc=pass  with header.from equal to the From domain
//   dkim=pass   with a signing domain (header.d, else header.i's) aligned with it
//   spf=pass    with an envelope-from domain (smtp.mailfrom) aligned with it
// "Aligned" is DMARC's relaxed alignment without a public-suffix list: the two
// names are equal, or one is a subdomain of the other. ARC results are not
// read: a chain is worth only its seals, and nothing here verifies them.
//
// Anything missing, repeated or unreadable is NOT passed.
// ============================================================================

import { extractEmailAddress } from "@/lib/party-match/normalize";

export const SENDER_AUTHENTICATION_VERSION = 1;

/**
 * The authserv-id the receiving server stamps on its Authentication-Results.
 *
 * ASSUMPTION, not yet confirmed against a live message: Resend receives mail
 * on Amazon SES, which writes `Authentication-Results: amazonses.com; …`. If
 * Resend stamps another id, every emailed paper is held (never the reverse),
 * and each recorded verdict names the id it saw (`authservId`).
 */
export const TRUSTED_AUTHSERV_IDS: readonly string[] = ["amazonses.com"];

export type SenderAuthenticationReason =
  | "passed"
  /** The message's original header section could not be read. */
  | "no_headers"
  /** No single, plain From address: missing, repeated, or a list. */
  | "no_from"
  /** The From Resend reported is not the From in the headers. */
  | "from_mismatch"
  /** No Authentication-Results header at all. */
  | "no_results"
  /** The topmost Authentication-Results is not the receiving server's. */
  | "untrusted_results"
  /** The topmost Authentication-Results could not be read. */
  | "unparseable"
  /** Read, and nothing passed aligned with the From domain. */
  | "failed";

const REASONS: ReadonlySet<string> = new Set<SenderAuthenticationReason>([
  "passed",
  "no_headers",
  "no_from",
  "from_mismatch",
  "no_results",
  "untrusted_results",
  "unparseable",
  "failed",
]);

export type SenderAuthenticationMethod = "dmarc" | "dkim" | "spf";

export interface SenderAuthentication {
  version: typeof SENDER_AUTHENTICATION_VERSION;
  passed: boolean;
  reason: SenderAuthenticationReason;
  /** What passed: DMARC first, then aligned DKIM, then aligned SPF. */
  method: SenderAuthenticationMethod | null;
  /** The header's From address, lower-cased. */
  fromAddress: string | null;
  fromDomain: string | null;
  /** The topmost Authentication-Results' authserv-id, trusted or not. */
  authservId: string | null;
  /** Each method's first result word, as the receiving server wrote it. */
  results: { dmarc: string | null; dkim: string | null; spf: string | null };
}

// ── Header section ───────────────────────────────────────────────────────────

export interface MessageHeader {
  /** Lower-cased. */
  name: string;
  /** Unfolded and trimmed. */
  value: string;
}

/** The header section of a message, unfolded, in order, duplicates kept. */
export function parseHeaderSection(raw: string): MessageHeader[] {
  const end = raw.search(/\r?\n\r?\n/u);
  const section = end === -1 ? raw : raw.slice(0, end);
  const headers: MessageHeader[] = [];
  for (const line of section.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line)) {
      const last = headers.at(-1);
      if (last) last.value = `${last.value} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    // Obsolete syntax allows blanks before the colon (`From : …`): it is still
    // that field, so a second From written that way still counts as a second.
    const name = line
      .slice(0, colon)
      .replace(/[ \t]+$/u, "")
      .toLowerCase();
    // A field name is printable ASCII without spaces or a colon; anything else
    // (an mbox "From " line, garbage) is not a header.
    if (!/^[\x21-\x39\x3b-\x7e]+$/u.test(name)) continue;
    headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return headers;
}

// ── Addresses and domains ────────────────────────────────────────────────────

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`, "u");
const ADDRESS_PATTERN = new RegExp(`^[^\\s@<>()",;:\\\\\\[\\]]+@(${LABEL}(?:\\.${LABEL})+)$`, "u");

export interface SenderAddress {
  /** Lower-cased. */
  address: string;
  domain: string;
}

/** A host name with at least two labels, lower-cased; null otherwise. */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = value.trim().toLowerCase().replace(/^<|>$/gu, "");
  const at = text.lastIndexOf("@");
  if (at !== -1) text = text.slice(at + 1);
  if (text.endsWith(".")) text = text.slice(0, -1);
  return DOMAIN_PATTERN.test(text) ? text : null;
}

function parseAddress(value: string | null | undefined): SenderAddress | null {
  if (!value) return null;
  let address = value.trim().toLowerCase();
  if (address.endsWith(".")) address = address.slice(0, -1);
  const match = address.match(ADDRESS_PATTERN);
  return match ? { address, domain: match[1] } : null;
}

/**
 * Drop quoted strings and comments, the parts of an address header that may
 * hold anything. Null when one is left open or an escape stands outside them.
 */
function stripQuotedAndComments(value: string): string | null {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted || depth > 0) {
      if (char === "\\") {
        index += 1;
      } else if (quoted && char === '"') {
        quoted = false;
        out += " ";
      } else if (!quoted && char === "(") {
        depth += 1;
      } else if (!quoted && char === ")") {
        depth -= 1;
        if (depth === 0) out += " ";
      }
      continue;
    }
    if (char === "\\" || char === ")") return null;
    if (char === '"') quoted = true;
    else if (char === "(") depth = 1;
    else out += char;
  }
  return quoted || depth > 0 ? null : out;
}

/**
 * The one mailbox of a From header: `"Acme, Inc." <billing@acme.com>` or a bare
 * address. Null for a list, a group, or anything that is not plainly one
 * address — a message whose From could be read two ways is not verified.
 */
export function parseMailbox(value: string | null | undefined): SenderAddress | null {
  if (!value) return null;
  const bare = stripQuotedAndComments(value);
  if (bare === null) return null;
  const angles = bare.match(/<[^<>]*>/gu) ?? [];
  if (angles.length > 1) return null;
  if (angles.length === 1) {
    const rest = bare.replace(angles[0], " ");
    if (/[<>@,;:]/u.test(rest)) return null;
    return parseAddress(angles[0].slice(1, -1));
  }
  if (/[<>,;:]/u.test(bare)) return null;
  return parseAddress(bare);
}

/**
 * A From as the app stored it (Resend's `from`, a party's email): strictly
 * parsed, else the one bracketed address in it. For facts a person or the
 * verdict already stands behind, never for the verdict itself.
 */
export function senderAddressOf(value: string | null | undefined): SenderAddress | null {
  return parseMailbox(value) ?? parseAddress(extractEmailAddress(value));
}

/** Every address in a free-text email field (`ap@acme.com; billing@acme.com`). */
export function senderAddressesIn(value: string | null | undefined): SenderAddress[] {
  if (!value) return [];
  return value.split(/[\s,;]+/u).flatMap((part) => {
    const parsed = senderAddressOf(part);
    return parsed ? [parsed] : [];
  });
}

/** DMARC relaxed alignment without a public-suffix list: equal, or one is under the other. */
export function domainsAligned(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

// ── Authentication-Results (RFC 8601) ───────────────────────────────────────

export interface AuthenticationResult {
  /** Lower-cased, without a method version. */
  method: string;
  /** Lower-cased. */
  result: string;
  /** Property keys lower-cased (`header.from`, `smtp.mailfrom`, …). */
  properties: ReadonlyMap<string, string>;
}

export interface ParsedAuthenticationResults {
  authservId: string | null;
  results: AuthenticationResult[];
}

const METHODS = new Set([
  "arc",
  "auth",
  "bimi",
  "compauth",
  "dkim",
  "dkim-adsp",
  "dkim-atps",
  "dmarc",
  "dnswl",
  "iprev",
  "rrvs",
  "sender-id",
  "smime",
  "spf",
  "vbr",
]);

const PAIR = /([a-z0-9][a-z0-9._/-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s";]+)/giu;

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/gu, "$1")
    : value;
}

/** Remove comments, keep quoted strings. Null when either is left open. */
function stripComments(value: string): string | null {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && (quoted || depth > 0)) {
      if (quoted) out += value.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (quoted) {
      out += char;
      if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) out += " ";
      }
      continue;
    }
    if (char === "(") depth = 1;
    else if (char === ")") return null;
    else {
      if (char === '"') quoted = true;
      out += char;
    }
  }
  return quoted || depth > 0 ? null : out;
}

function splitOutsideQuotes(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted && char === "\\") {
      current += value.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * One Authentication-Results value: its authserv-id and each result. Null when
 * a comment or quoted string is left open. A header that starts with a result
 * instead of an authserv-id has none (null), and so is never trusted.
 */
export function parseAuthenticationResults(value: string): ParsedAuthenticationResults | null {
  const text = stripComments(value);
  if (text === null) return null;
  const segments = splitOutsideQuotes(text).map((segment) => segment.trim());
  const head = segments[0] ?? "";
  const id = head.match(/^("(?:[^"\\]|\\.)*"|[^\s="]+)(?:\s+\d+)?$/u);
  const authservId = id ? unquote(id[1]).toLowerCase() : null;
  const results: AuthenticationResult[] = [];
  for (const segment of id ? segments.slice(1) : segments) {
    if (!segment || segment.toLowerCase() === "none") continue;
    const pairs = [...segment.matchAll(PAIR)].map(
      (match) => [match[1].toLowerCase(), unquote(match[2])] as const,
    );
    if (pairs.length === 0) continue;
    const [first, ...rest] = pairs;
    const method = first[0].split("/")[0];
    if (METHODS.has(method) || method.startsWith("x-")) {
      results.push({ method, result: first[1].toLowerCase(), properties: new Map(rest) });
      continue;
    }
    // A receiver's own key=value continuation of the result before it: Amazon
    // SES writes `envelope-from=…;` and `helo=…;` as segments after spf.
    const previous = results.at(-1);
    if (!previous) continue;
    const properties = previous.properties as Map<string, string>;
    for (const [key, pairValue] of pairs) {
      if (!properties.has(key)) properties.set(key, pairValue);
    }
  }
  return { authservId, results };
}

// ── The verdict ──────────────────────────────────────────────────────────────

function verdict(
  reason: SenderAuthenticationReason,
  fields: Partial<Omit<SenderAuthentication, "version" | "passed" | "reason">> = {},
): SenderAuthentication {
  return {
    version: SENDER_AUTHENTICATION_VERSION,
    passed: reason === "passed",
    reason,
    method: fields.method ?? null,
    fromAddress: fields.fromAddress ?? null,
    fromDomain: fields.fromDomain ?? null,
    authservId: fields.authservId ?? null,
    results: fields.results ?? { dmarc: null, dkim: null, spf: null },
  };
}

function firstResult(results: readonly AuthenticationResult[], method: string): string | null {
  return results.find((result) => result.method === method)?.result ?? null;
}

/**
 * Decide, from the message's original header section and the From the provider
 * reported, whether the sender is authenticated. Pure.
 */
export function evaluateSenderAuthentication(input: {
  headerSection: string | null;
  providerFrom: string | null;
  trustedAuthservIds?: readonly string[];
}): SenderAuthentication {
  const reported = senderAddressOf(input.providerFrom);
  if (!input.headerSection?.trim()) {
    return verdict("no_headers", {
      fromAddress: reported?.address ?? null,
      fromDomain: reported?.domain ?? null,
    });
  }
  const headers = parseHeaderSection(input.headerSection);
  const froms = headers.filter((header) => header.name === "from");
  const from = froms.length === 1 ? parseMailbox(froms[0].value) : null;
  if (!from) return verdict("no_from");
  const sender = { fromAddress: from.address, fromDomain: from.domain };
  if (!reported || reported.address !== from.address) return verdict("from_mismatch", sender);

  const top = headers.find((header) => header.name === "authentication-results");
  if (!top) return verdict("no_results", sender);
  const parsed = parseAuthenticationResults(top.value);
  if (!parsed) return verdict("unparseable", sender);
  const trusted = (input.trustedAuthservIds ?? TRUSTED_AUTHSERV_IDS).map((id) => id.toLowerCase());
  const read = {
    ...sender,
    authservId: parsed.authservId,
    results: {
      dmarc: firstResult(parsed.results, "dmarc"),
      dkim: firstResult(parsed.results, "dkim"),
      spf: firstResult(parsed.results, "spf"),
    },
  };
  if (!parsed.authservId || !trusted.includes(parsed.authservId)) {
    return verdict("untrusted_results", read);
  }

  const passes = (method: string) =>
    parsed.results.filter((result) => result.method === method && result.result === "pass");
  const dmarc = passes("dmarc").some(
    (result) => normalizeDomain(result.properties.get("header.from")) === from.domain,
  );
  if (dmarc) return verdict("passed", { ...read, method: "dmarc" });
  const dkim = passes("dkim").some((result) =>
    domainsAligned(
      normalizeDomain(result.properties.get("header.d") ?? result.properties.get("header.i")),
      from.domain,
    ),
  );
  if (dkim) return verdict("passed", { ...read, method: "dkim" });
  const spf = passes("spf").some((result) =>
    domainsAligned(
      normalizeDomain(
        result.properties.get("smtp.mailfrom") ?? result.properties.get("envelope-from"),
      ),
      from.domain,
    ),
  );
  if (spf) return verdict("passed", { ...read, method: "spf" });
  return verdict("failed", read);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** A stored verdict, or null when it is missing or not one this version wrote. */
export function readSenderAuthentication(value: unknown): SenderAuthentication | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  const results = stored.results as Record<string, unknown> | null | undefined;
  if (
    stored.version !== SENDER_AUTHENTICATION_VERSION ||
    typeof stored.passed !== "boolean" ||
    typeof stored.reason !== "string" ||
    !REASONS.has(stored.reason) ||
    !nullableString(stored.fromAddress) ||
    !nullableString(stored.fromDomain) ||
    !nullableString(stored.authservId) ||
    !results ||
    typeof results !== "object" ||
    !nullableString(results.dmarc) ||
    !nullableString(results.dkim) ||
    !nullableString(results.spf)
  ) {
    return null;
  }
  const method =
    stored.method === "dmarc" || stored.method === "dkim" || stored.method === "spf"
      ? stored.method
      : null;
  // A pass is believed only whole: the reason, the method and the sender all say so.
  const passed =
    stored.passed &&
    stored.reason === "passed" &&
    method !== null &&
    parseAddress(stored.fromAddress)?.domain === stored.fromDomain;
  return {
    version: SENDER_AUTHENTICATION_VERSION,
    passed,
    reason: passed ? "passed" : stored.reason === "passed" ? "failed" : stored.reason,
    method: passed ? method : null,
    fromAddress: stored.fromAddress,
    fromDomain: stored.fromDomain,
    authservId: stored.authservId,
    results: { dmarc: results.dmarc, dkim: results.dkim, spf: results.spf },
  } as SenderAuthentication;
}

/** Why a verdict did not pass, for the hold's detail. */
export function describeSenderAuthentication(value: SenderAuthentication | null): string {
  if (!value) return "it was not checked when it arrived";
  const words = (result: string | null) => result ?? "none";
  switch (value.reason) {
    case "passed":
      return `${value.fromAddress} passed ${value.method?.toUpperCase()}`;
    case "no_headers":
      return "its original headers were not available";
    case "no_from":
      return "it has no single From address";
    case "from_mismatch":
      return "its From address does not match its headers";
    case "no_results":
      return "it carries no authentication results";
    case "untrusted_results":
      return `its authentication results are from ${value.authservId ?? "an unnamed server"}, not the receiving server`;
    case "unparseable":
      return "its authentication results could not be read";
    case "failed":
      return `nothing passed for ${value.fromDomain} (DMARC ${words(value.results.dmarc)}, DKIM ${words(value.results.dkim)}, SPF ${words(value.results.spf)})`;
  }
}

// ── Is this sender one the party already uses? ──────────────────────────────

/** Mailbox providers anyone can sign up at: a domain match there says nothing. */
const SHARED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  "163.com",
  "126.com",
  "att.net",
  "btinternet.com",
  "comcast.net",
  "fastmail.com",
  "free.fr",
  "gmail.com",
  "googlemail.com",
  "hey.com",
  "icloud.com",
  "laposte.net",
  "libero.it",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "naver.com",
  "orange.fr",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "rocketmail.com",
  "sbcglobal.net",
  "t-online.de",
  "tuta.io",
  "tutanota.com",
  "verizon.net",
  "web.de",
  "ymail.com",
  "zoho.com",
  "zohomail.com",
]);

/** One brand across many country domains: yahoo.com.ph, hotmail.co.uk, outlook.fr … */
const SHARED_MAILBOX_BRANDS: ReadonlySet<string> = new Set([
  "aol",
  "gmx",
  "hotmail",
  "live",
  "msn",
  "outlook",
  "yahoo",
  "yandex",
]);

/** Over-matching is safe: a shared domain only makes the match stricter (address, not domain). */
export function isSharedMailboxDomain(domain: string): boolean {
  return SHARED_MAILBOX_DOMAINS.has(domain) || SHARED_MAILBOX_BRANDS.has(domain.split(".")[0]);
}

/**
 * The sender is one the party already uses: its domain is a domain the party
 * has used, or a subdomain of one — never a parent, which could be a public
 * suffix (`com.ph`) any registrant sits under. At a shared mailbox provider
 * only the exact address counts.
 */
export function isSenderKnownToParty(
  sender: SenderAddress,
  known: readonly SenderAddress[],
): boolean {
  const shared = isSharedMailboxDomain(sender.domain);
  return known.some((entry) =>
    shared || isSharedMailboxDomain(entry.domain)
      ? entry.address === sender.address
      : sender.domain === entry.domain || sender.domain.endsWith(`.${entry.domain}`),
  );
}

export interface EmailSenderJudgement {
  verified: boolean;
  /** Why not; null when verified. */
  detail: string | null;
}

/**
 * An emailed paper's sender is verified when EVERY inbound message behind it
 * passed sender authentication and came from a sender its party already uses.
 * `known` is null when the paper has no party to compare with. Pure.
 */
export function judgeEmailSenders(input: {
  /** Each message's stored verdict, unread (anything unreadable fails). */
  verdicts: readonly unknown[];
  known: readonly SenderAddress[] | null;
}): EmailSenderJudgement {
  if (input.verdicts.length === 0) {
    return { verified: false, detail: "no inbound message is on record" };
  }
  for (const stored of input.verdicts) {
    const read = readSenderAuthentication(stored);
    if (!read?.passed) return { verified: false, detail: describeSenderAuthentication(read) };
    const sender = { address: read.fromAddress!, domain: read.fromDomain! };
    if (!input.known) {
      return {
        verified: false,
        detail: `no vendor or customer to check ${sender.address} against`,
      };
    }
    if (!isSenderKnownToParty(sender, input.known)) {
      return {
        verified: false,
        detail: isSharedMailboxDomain(sender.domain)
          ? `${sender.address} is not an address this party has used`
          : `${sender.domain} is not a domain this party has used`,
      };
    }
  }
  return { verified: true, detail: null };
}
