import { createHash } from "node:crypto";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeCurrency,
  normalizeDuplicateMatchInput,
} from "./duplicate-matcher";
import type { DocumentSourceFacts } from "./email-attachment-source";

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

function stripHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#39;/giu, "'")
    .replace(/&quot;/giu, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function senderParty(from: string): string | null {
  const displayName = from.match(/^\s*"?([^"<]+?)"?\s*</u)?.[1]?.trim();
  if (displayName && !/^(?:no[-_. ]?reply|orders?|receipts?|support)$/iu.test(displayName)) {
    return displayName;
  }
  const address = from.match(/<?([^<>\s]+@[^<>\s]+)>?/u)?.[1] ?? from;
  const domain = address.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  const labels = domain.split(".");
  const candidate =
    labels.length > 2 && ["mail", "email", "receipts", "orders"].includes(labels[0])
      ? labels[1]
      : labels[0];
  if (!candidate) return null;
  return candidate
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function validDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function bodyDate(value: string, fallbackDate?: string | null): string | null {
  const iso = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  return validDate(iso) ?? validDate(fallbackDate);
}

function bodyReference(value: string): string | null {
  return (
    value.match(
      /\b(?:order|receipt|invoice|reference|transaction)\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})\b/iu,
    )?.[1] ??
    value.match(
      /\b(?:order|payment|purchase)\s+confirmation\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})\b/iu,
    )?.[1] ??
    value.match(
      /\b(?:confirmation|reference|transaction)\s*(?:number|no\.?|#|id)?\s*[:#-]\s*([A-Z0-9][A-Z0-9._/-]{2,})\b/iu,
    )?.[1] ??
    null
  );
}

function bodyAmount(
  value: string,
  fallbackCurrency?: string | null,
): { amount: string | null; currency: string | null } {
  const labeled = value.match(
    /\b(?:grand\s+total|order\s+total|total|amount(?:\s+(?:paid|charged))?|charged|paid)\s*[:=-]?\s*(?:([A-Z]{3})\s*)?([$€£¥])?\s*([0-9][0-9,]*(?:\.\d{1,3})?)(?:\s*([A-Z]{3}))?/iu,
  );
  const general =
    labeled ??
    value.match(/(?:\b([A-Z]{3})\s*|([$€£¥])\s*)([0-9][0-9,]*(?:\.\d{1,3})?)(?:\s*([A-Z]{3}))?/u);
  if (!general) {
    return { amount: null, currency: normalizeCurrency(fallbackCurrency) };
  }
  const amount = general[3]?.replaceAll(",", "") ?? null;
  const explicitCurrency = normalizeCurrency(general[1] ?? general[4]);
  const symbolCurrency = general[2] ? CURRENCY_BY_SYMBOL[general[2]] : null;
  return {
    amount,
    currency: explicitCurrency ?? symbolCurrency ?? normalizeCurrency(fallbackCurrency) ?? null,
  };
}

function bodyClassification(value: string): {
  economicEventClass: DocumentSourceFacts["economicEventClass"];
  direction: DocumentSourceFacts["direction"];
} {
  if (
    /\b(?:payment\s+received|customer\s+payment|sale\s+confirmation|you\s+received)\b/iu.test(value)
  ) {
    return { economicEventClass: "sale", direction: "inflow" };
  }
  if (
    /\b(?:bill|invoice)\b/iu.test(value) &&
    /\b(?:amount\s+due|due\s+date|please\s+pay|balance\s+due)\b/iu.test(value) &&
    !/\b(?:paid|charged|receipt|order\s+confirmation)\b/iu.test(value)
  ) {
    return { economicEventClass: "bill_accrual", direction: "outflow" };
  }
  if (
    /\b(?:order\s+confirmation|purchase|receipt|charged|amount\s+paid|payment\s+confirmation|thank\s+you\s+for\s+your\s+order)\b/iu.test(
      value,
    )
  ) {
    return { economicEventClass: "purchase", direction: "outflow" };
  }
  return { economicEventClass: "other", direction: "unknown" };
}

export function emailBodyExternalId(emailId: string): string {
  return `resend-body:${createHash("sha256").update(emailId).digest("hex")}`;
}

/**
 * Conservatively extracts the deterministic fields commonly present in purchase,
 * bill, and payment-confirmation email bodies. Ambiguous bodies remain
 * `other/unknown`, which keeps their Inbox item quarantined for a reviewer.
 */
export function deriveEmailBodySourceFacts(input: {
  emailId: string;
  from: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  fallbackDate?: string | null;
  originalCurrency?: string | null;
  functionalCurrency?: string | null;
}): DocumentSourceFacts {
  const body = input.text?.trim() || (input.html ? stripHtml(input.html) : "");
  const searchable = `${input.subject ?? ""} ${body}`.trim();
  const classification = bodyClassification(searchable);
  const { amount, currency } = bodyAmount(searchable, input.originalCurrency);
  const transactionDate = bodyDate(searchable, input.fallbackDate);
  const party = senderParty(input.from);
  const reference = bodyReference(searchable);
  const description = input.subject?.trim() || body.slice(0, 180).trim() || "Inbound email body";
  const normalized = normalizeDuplicateMatchInput({
    economicEventClass: classification.economicEventClass,
    direction: classification.direction,
    originalAmount: amount,
    originalCurrency: currency,
    effectiveDate: transactionDate,
    party,
    reference,
    description,
    provider: "resend",
  });
  const functionalCurrency = normalizeCurrency(input.functionalCurrency);
  const functionalAmount =
    normalized.originalAmount &&
    normalized.originalCurrency &&
    normalized.originalCurrency === functionalCurrency
      ? normalized.originalAmount
      : null;
  return {
    externalId: emailBodyExternalId(input.emailId),
    externalVersion: `sha256:${createHash("sha256").update(searchable).digest("hex")}`,
    transactionDate,
    description,
    amount: normalized.originalAmount,
    currency: normalized.originalCurrency,
    economicEventClass: classification.economicEventClass,
    direction: classification.direction,
    originalAmount: normalized.originalAmount,
    originalCurrency: normalized.originalCurrency,
    functionalAmount,
    functionalCurrency,
    effectiveDate: normalized.effectiveDate,
    normalizedParty: normalized.normalizedParty,
    normalizedReference: normalized.normalizedReference,
    sourceAccountRef: null,
    matcherInputHash: normalized.inputHash,
    matcherVersion: DUPLICATE_MATCHER_VERSION,
    extractedFrom: ["email_body_deterministic"],
  };
}

export function factsCorroborateSameEconomicEvent(
  left: DocumentSourceFacts,
  right: DocumentSourceFacts,
): boolean {
  if (
    !left.originalAmount ||
    !right.originalAmount ||
    left.originalAmount !== right.originalAmount ||
    left.originalCurrency !== right.originalCurrency ||
    left.direction !== right.direction ||
    left.effectiveDate !== right.effectiveDate
  ) {
    return false;
  }
  return Boolean(
    (left.normalizedReference &&
      right.normalizedReference &&
      left.normalizedReference === right.normalizedReference) ||
    (left.normalizedParty &&
      right.normalizedParty &&
      left.normalizedParty === right.normalizedParty),
  );
}
